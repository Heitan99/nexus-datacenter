"""Motor de IA predictiva con Amazon Chronos-2.

Escucha la telemetría MQTT y publica diagnósticos en
datacenter/rack/<nn>/ia y datacenter/global/ia.
"""

import json
import os
import time
import queue
import signal
import sys
from collections import deque
from dataclasses import dataclass, field

# Consola en UTF-8: en Windows cp1252 falla al imprimir "°C" o emojis.
for _flujo in (sys.stdout, sys.stderr):
    try:
        _flujo.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

import numpy as np
import torch
import paho.mqtt.client as mqtt
from chronos import Chronos2Pipeline

import historico_db

# Configuración general (alineada con D:\DataCenter\js\mqtt.js)
MQTT_HOST = "127.0.0.1"
MQTT_PORT = 1883

RACKS = ["01", "02", "03", "04"]
UMBRAL_TEMP_ALARMA = 30.0      # Mismo UMBRALES.tempAlarma de la web (°C)
UMBRAL_TEMP_PREVENTIVO = 28.0  # Advertencia temprana ASHRAE (°C)
HISTORIAL_MAX = 120            # Ventana máxima de contexto por rack
MIN_PUNTOS_IA = 12             # Mínimo de lecturas para empezar a predecir
HORIZONTE_PRED = 12            # Pasos futuros a predecir
COOLDOWN_INFERENCIA_S = 1.0    # Evita saturar si llegan ráfagas muy rápidas

# Autenticación MQTT. Sin credenciales se mantiene el acceso
# anónimo actual; con ellas se envía usuario/contraseña en el CONNECT.
ARCHIVO_CREDENCIALES = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "mqtt_credenciales.json"
)


def cargar_credenciales() -> tuple[str, str]:
    """
    Devuelve (usuario, contraseña) para el broker.

    Prioridad:
      1. Variables de entorno NEXUS_MQTT_USER / NEXUS_MQTT_PASS.
      2. Archivo local cps_ia/mqtt_credenciales.json:
         {"usuario": "nexus", "password": "..."}
      3. Sin credenciales -> conexión anónima (allow_anonymous true).
    """
    usuario = os.environ.get("NEXUS_MQTT_USER", "").strip()
    if usuario:
        return usuario, os.environ.get("NEXUS_MQTT_PASS", "")

    try:
        with open(ARCHIVO_CREDENCIALES, "r", encoding="utf-8") as archivo:
            datos = json.load(archivo)
        return str(datos.get("usuario", "")).strip(), str(datos.get("password", ""))
    except FileNotFoundError:
        return "", ""
    except Exception as error:
        print(f"[MQTT] No se pudieron leer {ARCHIVO_CREDENCIALES}: {error}")
        return "", ""


@dataclass
class EstadoRack:
    numero: str
    temp: deque = field(default_factory=lambda: deque(maxlen=HISTORIAL_MAX))
    tiempos: deque = field(default_factory=lambda: deque(maxlen=HISTORIAL_MAX))
    hum: deque = field(default_factory=lambda: deque(maxlen=HISTORIAL_MAX))
    pdu: deque = field(default_factory=lambda: deque(maxlen=HISTORIAL_MAX))

    # Últimos valores conocidos para alinear covariables cuando llegue nueva temp
    ultimo_hum: float = 45.0
    ultimo_pdu: float = 1200.0
    ultimo_ups: float = 100.0
    agua: int = 0
    puerta: int = 0

    # Último pronóstico emitido (para detectar anomalías al llegar la siguiente lectura)
    ult_pred_p10: float | None = None
    ult_pred_p50: float | None = None
    ult_pred_p90: float | None = None
    ultima_inferencia_ts: float = 0.0
    ultimo_reporte: dict | None = None


UNIDADES = {
    "temp": "°C",
    "hum": "%",
    "ups": "%",
    "pdu": "W",
    "agua": None,
    "puerta": None,
}

# Rangos físicos razonables (mismos criterios que js/mqtt.js).
RANGOS = {
    "temp": (-10.0, 100.0),
    "hum": (0.0, 100.0),
    "ups": (0.0, 100.0),
    "pdu": (0.0, 20000.0),
    "agua": (0.0, 1.0),
    "puerta": (0.0, 1.0),
}


def normalizar_fuente(valor) -> str:
    texto = str(valor or "").strip().lower()
    if texto in ("simulated", "simulado", "simulacion", "simulación", "sim", "fake", "synthetic"):
        return "simulated"
    return "physical"


def normalizar_calidad(valor) -> str:
    texto = str(valor or "").strip().lower()
    if texto in ("invalid", "invalida", "inválida", "bad", "error", "corrupto", "corrupt"):
        return "invalid"
    return "valid"


def en_rango(metrica: str, valor: float | None) -> bool:
    if valor is None or not np.isfinite(valor):
        return False
    minimo, maximo = RANGOS.get(metrica, (-1e18, 1e18))
    return minimo <= valor <= maximo


def parsear_lectura(payload_bytes: bytes, metrica: str) -> dict | None:
    """
    Replica el parseo flexible de mqtt.js y conserva los metadatos del JSON
    extendido: { value/valor, unit/unidad, source/fuente, quality/calidad,
    timestamp }. Devuelve siempre un dict (o None si el payload es vacío),
    con `valida` ya calculado según rango y calidad.
    """
    try:
        texto = payload_bytes.decode("utf-8", errors="ignore").strip()
    except Exception:
        return None
    if not texto:
        return None

    def base(valor, unidad=None, source="physical", quality="valid", timestamp=None):
        valido = valor is not None and quality == "valid" and en_rango(metrica, valor)
        return {
            "valor": valor,
            "unidad": unidad if unidad is not None else UNIDADES.get(metrica),
            "source": source,
            "quality": quality,
            "valida": valido,
            "timestamp": timestamp,
        }

    low = texto.lower()
    if low in ("true", "on"):
        return base(1.0)
    if low in ("false", "off"):
        return base(0.0)

    # Número plano → origen físico por defecto (ESP32 real).
    try:
        val = float(texto)
        if np.isfinite(val):
            return base(val)
    except ValueError:
        pass

    try:
        datos = json.loads(texto)
    except Exception:
        return base(None, quality="invalid")

    if isinstance(datos, (int, float)) and np.isfinite(datos):
        return base(float(datos))

    if isinstance(datos, dict):
        valor = None
        for clave in ("value", "valor", metrica):
            if clave in datos and datos[clave] is not None:
                try:
                    candidato = float(datos[clave])
                except (TypeError, ValueError):
                    continue
                if np.isfinite(candidato):
                    valor = candidato
                    break

        return base(
            valor,
            unidad=datos.get("unit", datos.get("unidad")),
            source=normalizar_fuente(datos.get("source", datos.get("fuente"))),
            quality=normalizar_calidad(datos.get("quality", datos.get("calidad"))),
            timestamp=datos.get("timestamp", datos.get("ts")),
        )

    return base(None, quality="invalid")


def parsear_valor(payload_bytes: bytes, metrica: str) -> float | None:
    """Compatibilidad: devuelve solo el número de una lectura."""
    lectura = parsear_lectura(payload_bytes, metrica)
    return lectura["valor"] if lectura else None


def cargar_chronos() -> Chronos2Pipeline:
    """Carga amazon/chronos-2 en GPU priorizando caché local (modo offline)."""
    print("[IA] Cargando amazon/chronos-2 en RTX 3050...")
    t0 = time.perf_counter()
    try:
        pipe = Chronos2Pipeline.from_pretrained(
            "amazon/chronos-2",
            device_map="cuda",
            local_files_only=True,
        )
    except Exception:
        pipe = Chronos2Pipeline.from_pretrained(
            "amazon/chronos-2",
            device_map="cuda",
        )
    vram_mb = torch.cuda.memory_allocated() / (1024 ** 2)
    print(f"[IA] Modelo listo en {time.perf_counter() - t0:.2f} s | VRAM: {vram_mb:.1f} MB")
    return pipe


def calcular_dt_promedio(tiempos: deque) -> float:
    """Calcula segundos promedio entre lecturas de temperatura."""
    if len(tiempos) < 2:
        return 2.0
    diffs = np.diff(np.array(tiempos, dtype=np.float64))
    diffs = diffs[(diffs > 0.1) & (diffs < 120.0)]
    return float(np.median(diffs)) if len(diffs) > 0 else 2.0


def evaluar_salud_empresarial(
    rack: EstadoRack,
    temp_actual: float,
    p10: np.ndarray,
    p50: np.ndarray,
    p90: np.ndarray,
    dt_seg: float,
) -> dict:
    """Genera los KPIs accionables para operación de Data Center."""
    # 1) Detección de anomalía frente al intervalo [p10, p90] esperado por Chronos-2
    anomalia = False
    desviacion_c = 0.0
    if rack.ult_pred_p50 is not None and rack.ult_pred_p90 is not None and rack.ult_pred_p10 is not None:
        desviacion_c = round(temp_actual - rack.ult_pred_p50, 2)
        if temp_actual > (rack.ult_pred_p90 + 0.35) or temp_actual < (rack.ult_pred_p10 - 0.8):
            anomalia = True

    # 2) Tiempo estimado hasta cruzar 30.0 °C (ETA)
    eta_pasos = None
    for idx, val in enumerate(p50, start=1):
        if val >= UMBRAL_TEMP_ALARMA:
            eta_pasos = idx
            break
    eta_seg = round(eta_pasos * dt_seg, 1) if eta_pasos is not None else None

    # 3) Tendencia térmica (°C / minuto)
    horizonte_min = (HORIZONTE_PRED * dt_seg) / 60.0
    tendencia_c_min = round((float(p50[-1]) - temp_actual) / max(horizonte_min, 0.05), 2)

    temp_pred_max = round(float(np.max(p50)), 2)

    # 4) Cálculo de Health Score (0-100) basado en criterios reales DCIM / ASHRAE
    score = 100.0

    # Penalización por temperatura actual vs umbral
    if temp_actual >= UMBRAL_TEMP_ALARMA:
        score -= min(45.0, 25.0 + (temp_actual - UMBRAL_TEMP_ALARMA) * 5.0)
    elif temp_actual >= UMBRAL_TEMP_PREVENTIVO:
        score -= (temp_actual - UMBRAL_TEMP_PREVENTIVO) * 8.0

    # Penalización por predicción futura (riesgo anticipado)
    if eta_pasos is not None and temp_actual < UMBRAL_TEMP_ALARMA:
        urgencia = max(0.2, 1.0 - (eta_pasos - 1) / HORIZONTE_PRED)
        score -= 22.0 * urgencia
    elif temp_pred_max >= UMBRAL_TEMP_PREVENTIVO:
        score -= 8.0

    # Penalización por anomalía térmica inesperada
    if anomalia:
        score -= 15.0

    # Penalización por humedad fuera de rango seguro ASHRAE (ESD <20% / condensación >75%)
    if rack.ultimo_hum < 20.0 or rack.ultimo_hum > 75.0:
        score -= 12.0
    elif rack.ultimo_hum < 30.0 or rack.ultimo_hum > 65.0:
        score -= 4.0

    # Penalización eléctrica (UPS baja) y eventos físicos críticos
    if rack.ultimo_ups < 40.0:
        score -= 15.0
    if rack.agua == 1:
        score -= 45.0
    if rack.puerta == 1:
        score -= 5.0

    health_score = int(max(0, min(100, round(score))))

    # 5) Nivel de riesgo y recomendación operativa clara
    if rack.agua == 1:
        riesgo = "CRITICO"
        recomendacion = "Fuga de agua detectada: aislar alimentación del rack e inspeccionar de inmediato."
    elif temp_actual >= UMBRAL_TEMP_ALARMA:
        riesgo = "CRITICO"
        recomendacion = f"Umbral de {UMBRAL_TEMP_ALARMA:.0f} °C superado. Activar ventilación máxima / migrar carga."
    elif eta_pasos is not None:
        riesgo = "PREVENTIVO"
        recomendacion = (
            f"Cruce estimado de {UMBRAL_TEMP_ALARMA:.0f} °C en ~{eta_seg:.0f} s "
            f"({tendencia_c_min:+.2f} °C/min). Incrementar flujo de aire."
        )
    elif anomalia:
        riesgo = "ANOMALIA"
        recomendacion = (
            f"Desviación térmica ({desviacion_c:+.2f} °C vs esperado) para carga de "
            f"{rack.ultimo_pdu:.0f} W. Revisar ventiladores o puerta."
        )
    elif rack.ultimo_hum < 20.0 or rack.ultimo_hum > 75.0:
        riesgo = "PREVENTIVO"
        recomendacion = f"Humedad fuera de rango ASHRAE ({rack.ultimo_hum:.1f}%). Riesgo eléctrico/condensación."
    else:
        riesgo = "OPTIMO"
        recomendacion = "Operación estable dentro de envolvente térmica ASHRAE."

    return {
        "rack": f"rack-{rack.numero}",
        "temp_actual": round(temp_actual, 2),
        "pdu_actual_w": round(rack.ultimo_pdu, 1),
        "hum_actual": round(rack.ultimo_hum, 1),
        "pronostico": {
            "p10": [round(float(x), 2) for x in p10],
            "p50": [round(float(x), 2) for x in p50],
            "p90": [round(float(x), 2) for x in p90],
        },
        "temp_pred_max": temp_pred_max,
        "tendencia_c_min": tendencia_c_min,
        "eta_alarma_pasos": eta_pasos,
        "eta_alarma_seg": eta_seg,
        "anomalia": anomalia,
        "desviacion_c": desviacion_c,
        "health_score": health_score,
        "riesgo": riesgo,
        "recomendacion": recomendacion,
        "timestamp": int(time.time() * 1000),
    }


def construir_resumen_global(estados: dict[str, EstadoRack]) -> dict | None:
    """Consolida KPIs ejecutivos de toda la sala para datacenter/global/ia."""
    reportes = [e.ultimo_reporte for e in estados.values() if e.ultimo_reporte is not None]
    if not reportes:
        return None

    salud_global = round(sum(r["health_score"] for r in reportes) / len(reportes))
    mas_critico = min(reportes, key=lambda r: r["health_score"])
    en_riesgo = sum(1 for r in reportes if r["riesgo"] != "OPTIMO")
    anomalias = sum(1 for r in reportes if r["anomalia"])
    potencia_total_w = round(sum(r["pdu_actual_w"] for r in reportes), 1)

    if any(r["riesgo"] == "CRITICO" for r in reportes):
        estado_sala = "CRITICO"
    elif en_riesgo > 0:
        estado_sala = "PREVENTIVO"
    else:
        estado_sala = "OPTIMO"

    # KPIs agregados con el MISMO esquema que el reporte por rack, para que el
    # HUD (js/mqtt.js -> parsearIA) los pinte directamente en la barra global.
    etas = [r["eta_alarma_seg"] for r in reportes if r.get("eta_alarma_seg") is not None]
    tendencias = [
        r["tendencia_c_min"] for r in reportes if r.get("tendencia_c_min") is not None
    ]

    return {
        # Contrato común con la web (idéntico al de datacenter/rack/+/ia)
        "health_score": int(salud_global),
        "riesgo": estado_sala,
        "eta_alarma_seg": min(etas) if etas else None,
        "anomalia": anomalias > 0,
        "tendencia_c_min": max(tendencias) if tendencias else None,
        "recomendacion": mas_critico.get("recomendacion"),
        "pronostico": mas_critico.get("pronostico"),
        # KPIs ejecutivos de la sala
        "estado_sala": estado_sala,
        "health_score_global": int(salud_global),
        "rack_mas_critico": mas_critico["rack"],
        "rack_critico_score": mas_critico["health_score"],
        "racks_en_riesgo": en_riesgo,
        "anomalias_activas": anomalias,
        "potencia_total_w": potencia_total_w,
        "racks_monitoreados": len(reportes),
        "timestamp": int(time.time() * 1000),
    }


def main():
    # Persistencia SQLite (solo stdlib): crea tablas si no existen.
    historico_db.inicializar_db()
    print(f"[DB] Histórico SQLite listo: {historico_db.DB_PATH}")

    pipeline = cargar_chronos()
    estados = {num: EstadoRack(numero=num) for num in RACKS}
    cola_eventos: queue.Queue = queue.Queue()

    cliente = mqtt.Client(
        mqtt.CallbackAPIVersion.VERSION2,
        client_id="nexus-chronos2-ia",
    )

    # Si hay usuario configurado, el CONNECT lleva credenciales.
    usuario_mqtt, pass_mqtt = cargar_credenciales()
    if usuario_mqtt:
        cliente.username_pw_set(usuario_mqtt, pass_mqtt)
        print(f"[MQTT] Autenticación activada (usuario '{usuario_mqtt}').")

    def on_connect(client, userdata, flags, reason_code, properties):
        if not reason_code.is_failure:
            print(f"[MQTT] Conectado a {MQTT_HOST}:{MQTT_PORT}. Suscribiendo a racks...")
            client.subscribe("datacenter/rack/+/+", qos=0)
        else:
            print(f"[MQTT] Error de conexión: {reason_code}")
            print

    def on_message(client, userdata, msg):
        partes = msg.topic.split("/")
        # Esperado: datacenter/rack/<nn>/<metrica>
        if len(partes) != 4 or partes[0] != "datacenter" or partes[1] != "rack":
            return
        rack_num, metrica = partes[2], partes[3].lower()
        if rack_num not in estados or metrica == "ia":
            return
        lectura = parsear_lectura(msg.payload, metrica)
        if lectura is None:
            return
        cola_eventos.put((rack_num, metrica, lectura, time.time()))

    cliente.on_connect = on_connect
    cliente.on_message = on_message

    try:
        cliente.connect(MQTT_HOST, MQTT_PORT, keepalive=30)
    except Exception as e:
        print(f"[ERROR] No se pudo conectar a Mosquitto en {MQTT_HOST}:{MQTT_PORT} -> {e}")
        print("Verifica que el servicio Mosquitto esté iniciado en Windows.")
        sys.exit(1)

    cliente.loop_start()

    ejecutando = True

    def detener(sig, frame):
        nonlocal ejecutando
        ejecutando = False

    signal.signal(signal.SIGINT, detener)
    signal.signal(signal.SIGTERM, detener)

    print("[IA] Motor predictivo activo. Esperando datos MQTT (Ctrl+C para salir)...")

    try:
        while ejecutando:
            try:
                rack_num, metrica, lectura, ts = cola_eventos.get(timeout=0.5)
            except queue.Empty:
                continue

            rack = estados[rack_num]
            valor = lectura.get("valor")

            # Persistencia SQLite: toda lectura (válida o inválida) queda auditada
            # con su source/quality y su marca de tiempo.
            try:
                historico_db.registrar_lectura(
                    rack=f"rack-{rack_num}",
                    metrica=metrica,
                    valor=valor,
                    unidad=lectura.get("unidad"),
                    source=lectura.get("source"),
                    quality="valid" if lectura.get("valida") else "invalid",
                    timestamp=int(ts * 1000),
                )
            except Exception as e_db:
                print(f"[DB] Error guardando lectura: {e_db}")

            # Las lecturas inválidas (fuera de rango o quality invalid) no se
            # usan para el diagnóstico de IA.
            if not lectura.get("valida"):
                continue

            if metrica == "hum":
                rack.ultimo_hum = valor
                continue
            if metrica == "pdu":
                rack.ultimo_pdu = valor
                continue
            if metrica == "ups":
                rack.ultimo_ups = valor
                continue
            if metrica == "agua":
                rack.agua = 1 if valor >= 0.5 else 0
                continue
            if metrica == "puerta":
                rack.puerta = 1 if valor >= 0.5 else 0
                continue

            if metrica != "temp":
                continue

            # Guardamos punto alineado de temperatura y sus covariables
            rack.temp.append(valor)
            rack.tiempos.append(ts)
            rack.hum.append(rack.ultimo_hum)
            rack.pdu.append(rack.ultimo_pdu)

            n = len(rack.temp)
            if n < MIN_PUNTOS_IA:
                print(f"[rack-{rack_num}] Recopilando contexto ({n}/{MIN_PUNTOS_IA}) -> {valor:.2f} °C")
                continue

            if (ts - rack.ultima_inferencia_ts) < COOLDOWN_INFERENCIA_S:
                continue

            rack.ultima_inferencia_ts = ts

            # Entrada multivariada con covariables para Chronos-2
            entrada = {
                "target": np.array(rack.temp, dtype=np.float32),
                "past_covariates": {
                    "pdu": np.array(rack.pdu, dtype=np.float32),
                    "hum": np.array(rack.hum, dtype=np.float32),
                },
            }

            t_inf = time.perf_counter()
            quantiles, _ = pipeline.predict_quantiles(
                inputs=[entrada],
                prediction_length=HORIZONTE_PRED,
                quantile_levels=[0.1, 0.5, 0.9],
            )
            ms = (time.perf_counter() - t_inf) * 1000.0

            q_arr = quantiles[0].detach().cpu().numpy()
            if q_arr.ndim == 3:
                q_arr = q_arr[0]  # (HORIZONTE_PRED, 3)

            p10, p50, p90 = q_arr[:, 0], q_arr[:, 1], q_arr[:, 2]
            dt_seg = calcular_dt_promedio(rack.tiempos)

            reporte = evaluar_salud_empresarial(rack, valor, p10, p50, p90, dt_seg)
            rack.ultimo_reporte = reporte

            # Guardamos la predicción de t+1 para validar anomalías en la próxima lectura
            rack.ult_pred_p10 = float(p10[0])
            rack.ult_pred_p50 = float(p50[0])
            rack.ult_pred_p90 = float(p90[0])

            # Publicar reporte por rack y resumen global
            cliente.publish(
                f"datacenter/rack/{rack_num}/ia",
                json.dumps(reporte, ensure_ascii=False),
                qos=0,
            )

            # Persistencia SQLite del diagnóstico de IA (auditoría académica).
            try:
                historico_db.registrar_diagnostico(
                    reporte,
                    source="chronos-2",
                    payload=json.dumps(reporte, ensure_ascii=False),
                )
            except Exception as e_diag:
                print(f"[DB] Error guardando diagnóstico: {e_diag}")

            resumen = construir_resumen_global(estados)
            if resumen:
                cliente.publish(
                    "datacenter/global/ia",
                    json.dumps(resumen, ensure_ascii=False),
                    qos=0,
                )

            eta_txt = f" | ETA 30°C: {reporte['eta_alarma_seg']}s" if reporte["eta_alarma_seg"] else ""
            print(
                f"[rack-{rack_num}] {valor:.2f}°C | Salud: {reporte['health_score']}% "
                f"({reporte['riesgo']}){eta_txt} | {ms:.0f} ms"
            )

    finally:
        print("\n[IA] Cerrando conexión MQTT limpiamente...")
        cliente.loop_stop()
        cliente.disconnect()


if __name__ == "__main__":
    main()