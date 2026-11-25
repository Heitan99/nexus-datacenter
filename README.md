# NEXUS · Gemelo Digital de Data Center

HUD 3D en el navegador para monitorizar racks de un data center en tiempo real:
telemetría MQTT, simulación de sensores, histórico en SQLite, predicción con
**Amazon Chronos-2** y alertas por **Telegram**.

![Estado](https://img.shields.io/badge/estado-prot%C3%B3tipo-blue)

## Qué incluye

- Escena 3D con `three.js`: racks, puertas y ventiladores del modelo
  `assets/datacenter.glb`.
- Telemetría por MQTT sobre WebSocket, con un simulador para trabajar sin
  hardware conectado.
- Métricas por rack: temperatura, humedad, UPS, PDU, inundación y puerta.
- Motor de IA en Python con Chronos-2: Health Score, riesgo, ETA de alarma y
  banda P10/P50/P90, publicado por MQTT.
- Histórico en SQLite y exportación a CSV desde el HUD.
- Alertas de Telegram con histéresis y cooldown por rack.
- Credenciales de MQTT y Telegram en el HUD, guardadas en `localStorage`.

## Estructura del proyecto

```text
nexus-datacenter/
├─ index.html              HUD (punto de entrada)
├─ css/                    Estilos del HUD
├─ js/                     Lógica del frontend (módulos ES)
│  ├─ main.js              Orquestador
│  ├─ scene.js             Escena, cámara y render
│  ├─ model.js             Carga del GLB, componentes y puertas
│  ├─ ui.js                DOM, paneles, gráficas y modales
│  ├─ mqtt.js              Cliente MQTT (telemetría real)
│  ├─ mqtt-config.js       Credenciales MQTT locales
│  ├─ simulator.js         Telemetría sintética
│  ├─ ai-predictor.js      Health Score y predicción
│  ├─ history.js           Bitácora y CSV
│  └─ telegram.js          Alertas (token en localStorage)
├─ assets/
│  └─ datacenter.glb       Modelo 3D (Git LFS)
├─ cps_ia/                 Motor de IA en Python
│  ├─ ia_chronos_mqtt.py   Inferencia + publicación MQTT
│  ├─ historico_db.py      Persistencia SQLite
│  ├─ exportar_historico.py
│  ├─ iniciar_ia.cmd
│  └─ requirements.txt
├─ scripts/
│  ├─ nexus.ps1            Arranque/parada/estado
│  └─ auth-mosquitto.ps1   Usuario y contraseña del broker
└─ ARRANQUE.md             Guía de operación
```

## Requisitos

| Componente | Versión / notas |
|---|---|
| Windows 10/11 | Scripts de PowerShell |
| Python | 3.10+ (probado con 3.13) |
| Mosquitto | Servicio local con `1883/TCP` y `9001/WS` |
| GPU NVIDIA | Opcional; Chronos-2 funciona también en CPU |
| Navegador | Chrome/Edge/Firefox recientes (usa módulos ES) |

El HUD carga `three.js`, `Chart.js`, `mqtt.js` y las fuentes desde CDN, así que
el primer arranque necesita conexión a internet.

## Instalación

### 1. Clonar (con Git LFS para el modelo 3D)

```powershell
git lfs install
git clone https://github.com/Heitan99/nexus-datacenter.git
cd nexus-datacenter
```

> Sin `git lfs install`, `assets/datacenter.glb` se descarga como un puntero de
> texto y el HUD no podrá cargar el modelo.

### 2. Entorno de Python

```powershell
python -m venv cps_ia/.venv
cps_ia\.venv\Scripts\python.exe -m pip install --upgrade pip
cps_ia\.venv\Scripts\python.exe -m pip install torch --index-url https://download.pytorch.org/whl/cu134
cps_ia\.venv\Scripts\python.exe -m pip install -r cps_ia/requirements.txt
```

Sin GPU, cambia `cu134` por `cpu` y omite el último paso si no vas a usar IA.

### 3. Mosquitto

Instala Mosquitto y asegúrate de que el servicio está activo y escucha en
`1883` (MQTT) y `9001` (WebSocket). El script lo arranca si está parado.

## Uso

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\nexus.ps1
```

El script:

1. arranca Mosquitto si hace falta,
2. sirve el HUD en <http://127.0.0.1:8123/>,
3. lanza el motor Chronos-2 en su propia consola,
4. abre el navegador.

Para parar: `.\scripts\nexus.ps1 -Detener` (Mosquitto sigue como servicio de
Windows).

Opciones: `-SinIA`, `-SinNavegador`, `-Detener`, `-Estado`. El resto
(contraseña de Mosquitto, ESP32 y fallos habituales) está en
[ARRANQUE.md](ARRANQUE.md).

## Configuración de credenciales

| Qué | Dónde se configura |
|---|---|
| Broker MQTT (usuario/contraseña) | HUD → **CREDENCIALES MQTT** (botón del panel derecho) |
| Bot de Telegram (token/chat_id) | HUD → **ALERTAS TG** |
| Motor de IA ↔ broker | `cps_ia/mqtt_credenciales.json` (ignorado por git) o variables `NEXUS_MQTT_USER` / `NEXUS_MQTT_PASS` |

Para el motor de IA, copia el ejemplo y rellena los valores:

```powershell
Copy-Item cps_ia\mqtt_credenciales.example.json cps_ia\mqtt_credenciales.json
```

Crea el bot con **@BotFather** en Telegram y obtén el `chat_id` hablando con él.

## ESP32

El nodo publica JSON en topics `datacenter/rack/<nn>/<metrica>`:

```json
{"device_id":"esp32-rack01","variable":"temp","value":23.4,"timestamp":1700000000000}
```

Con hardware real conectado, desactiva el switch **SIM** del HUD para que el
simulador no compita con el ESP32 en los mismos topics.
