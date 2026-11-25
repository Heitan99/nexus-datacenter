// Generador de telemetría sintética para demos y pruebas.

// true: datos falsos para la demo. false: espera datos reales por MQTT.

export const USAR_SIMULADOR = true;

// Configuración

const CONFIG = {
  intervalo: 3000, // ms entre paquetes
  tempMin: 20,
  tempMax: 34,
  tempObjetivo: 23.5,
  pduMin: 700,
  pduMax: 3200,
  pduObjetivo: 1450,
  upsMin: 35,
  upsMax: 100,
  humMin: 32,
  humMax: 68,
  humObjetivo: 45,
  probabilidadPico: 0.05, // 5 % de paquetes con subida brusca de temperatura
  probabilidadAgua: 0.012, // 1,2 % de paquetes con inundación
  probabilidadPuerta: 0.05, // 5 % de paquetes con puerta abierta
};

// Estado interno

let temporizador = null;
let activo = false;
let opcionesActuales = null;
let racks = [];
const estadoRacks = new Map();

// Utilidades

function aleatorio(min, max) {
  return min + Math.random() * (max - min);
}

/** Crea el estado inicial de un rack con valores plausibles. */
function crearEstadoInicial(indice) {
  return {
    temp: CONFIG.tempObjetivo + aleatorio(-1.5, 3.5),
    pdu: CONFIG.pduObjetivo + aleatorio(-250, 450) + indice * 40,
    ups: 100 - aleatorio(0, 8),
    hum: CONFIG.humObjetivo + aleatorio(-5, 5),
    agua: 0,
    puerta: 0,
    aguaRestante: 0,
    puertaRestante: 0,
    picoRestante: 0,
  };
}

/**
 * Paso de random walk con reversión a la media.
 * Cuanto más lejos está el valor de su objetivo, más fuerza tiene el retorno.
 */
function paso(valor, objetivo, ruido, min, max, fuerzaRetorno = 0.12) {
  const retorno = (objetivo - valor) * fuerzaRetorno;
  const siguiente = valor + retorno + aleatorio(-ruido, ruido);
  return Math.min(max, Math.max(min, siguiente));
}

function redondear(valor, decimales = 1) {
  const factor = Math.pow(10, decimales);
  return Math.round(valor * factor) / factor;
}

// Generación de un paquete

function generarPaquete() {
  const paquetes = [];

  for (let i = 0; i < racks.length; i++) {
    const rackId = racks[i];
    const estado = estadoRacks.get(rackId);

    // Pico térmico ocasional: simula una pérdida de refrigeración.
    if (estado.picoRestante <= 0 && Math.random() < CONFIG.probabilidadPico) {
      estado.picoRestante = 3; // el pico dura ~3 paquetes (9 s)
    }

    if (estado.picoRestante > 0) {
      estado.temp += aleatorio(1.8, 3.4);
      estado.picoRestante -= 1;
    } else {
      estado.temp = paso(
        estado.temp,
        CONFIG.tempObjetivo,
        0.35,
        CONFIG.tempMin,
        CONFIG.tempMax
      );
    }

    // La UPS baja lentamente y se recupera sola.
    estado.ups = paso(estado.ups, 96, 1.2, CONFIG.upsMin, CONFIG.upsMax, 0.05);

    // El consumo sigue a la temperatura (más calor = más carga de refrigeración).
    const objetivoPdu = CONFIG.pduObjetivo + (estado.temp - CONFIG.tempObjetivo) * 90;
    estado.pdu = paso(estado.pdu, objetivoPdu, 60, CONFIG.pduMin, CONFIG.pduMax, 0.18);

    // Humedad relativa: random walk suave alrededor del 45 %.
    estado.hum = paso(
      estado.hum,
      CONFIG.humObjetivo,
      1.1,
      CONFIG.humMin,
      CONFIG.humMax,
      0.1
    );

    // Inundación: evento raro que se mantiene ~2 paquetes.
    if (estado.aguaRestante > 0) {
      estado.agua = 1;
      estado.aguaRestante -= 1;
    } else if (Math.random() < CONFIG.probabilidadAgua) {
      estado.agua = 1;
      estado.aguaRestante = 2;
    } else {
      estado.agua = 0;
    }

    // Puerta magnética: se abre de forma ocasional y se cierra sola.
    if (estado.puertaRestante > 0) {
      estado.puerta = 1;
      estado.puertaRestante -= 1;
    } else if (Math.random() < CONFIG.probabilidadPuerta) {
      estado.puerta = 1;
      estado.puertaRestante = 3;
    } else {
      estado.puerta = 0;
    }

    const lectura = {
      origen: 'simulador',
      rackId,
      timestamp: Date.now(),
      temp: redondear(estado.temp, 1),
      ups: redondear(estado.ups, 0),
      pdu: Math.round(estado.pdu),
      hum: redondear(estado.hum, 1),
      agua: estado.agua,
      puerta: estado.puerta,
    };

    // Permitir que main.js descarte métricas que ya llegan por MQTT.
    if (typeof opcionesActuales.debeSimular === 'function') {
      for (const metrica of ['temp', 'ups', 'pdu', 'hum', 'agua', 'puerta']) {
        if (!opcionesActuales.debeSimular(rackId, metrica)) {
          delete lectura[metrica];
        }
      }
    }

    // Si todas las métricas están silenciadas, no emitimos nada para este rack.
    if (
      lectura.temp === undefined &&
      lectura.ups === undefined &&
      lectura.pdu === undefined &&
      lectura.hum === undefined &&
      lectura.agua === undefined &&
      lectura.puerta === undefined
    ) {
      continue;
    }

    paquetes.push(lectura);
  }

  return paquetes;
}

function tick() {
  if (!opcionesActuales || !opcionesActuales.onDatos) return;

  const paquetes = generarPaquete();
  if (paquetes.length === 0) return;

  try {
    opcionesActuales.onDatos(paquetes);
  } catch (error) {
    console.error('[Simulador] Error en el callback onDatos:', error);
  }
}

// API pública

/**
 * Arranca el simulador.
 *
 * Si `USAR_SIMULADOR` es false no se inicia ningún intervalo: la aplicación
 * queda a la espera de los datos reales que lleguen por MQTT.
 *
 * @param {{
 *   onDatos: (paquetes: Array<object>) => void,
 *   debeSimular?: (
 *     rackId: string,
 *     metrica: 'temp'|'ups'|'pdu'|'hum'|'agua'|'puerta'
 *   ) => boolean,
 *   racks?: string[],
 *   intervalo?: number,
 *   emitirInmediato?: boolean
 * }} opciones
 */
export function iniciarSimulador(opciones = {}) {
  detenerSimulador();

  // Interruptor maestro: sin simulador no se emite nada.
  if (!USAR_SIMULADOR) {
    console.info(
      '[Simulador] Desactivado (USAR_SIMULADOR = false). Se esperarán datos MQTT del ESP32.'
    );
    return { activo: false, intervalo: 0, racks: [] };
  }

  opcionesActuales = opciones;
  racks = Array.isArray(opciones.racks) && opciones.racks.length
    ? [...opciones.racks]
    : ['rack-01', 'rack-02', 'rack-03', 'rack-04'];

  // Conservamos el estado si ya existía (por ejemplo al pausar y reanudar).
  racks.forEach((rackId, indice) => {
    if (!estadoRacks.has(rackId)) {
      estadoRacks.set(rackId, crearEstadoInicial(indice));
    }
  });

  const intervalo = Number(opciones.intervalo) > 0
    ? Number(opciones.intervalo)
    : CONFIG.intervalo;

  activo = true;

  if (opciones.emitirInmediato !== false) {
    tick();
  }

  temporizador = setInterval(tick, intervalo);

  console.info(`[Simulador] Activo · ${racks.length} racks · cada ${intervalo} ms.`);

  return { activo, intervalo, racks: [...racks] };
}

/** Pausa la emisión sin perder el estado de los valores. */
export function pausarSimulador() {
  if (temporizador) {
    clearInterval(temporizador);
    temporizador = null;
  }
  activo = false;
}

/** Reanuda la emisión con la configuración anterior. */
export function reanudarSimulador() {
  if (!USAR_SIMULADOR) return false;
  if (activo || !opcionesActuales) return false;

  const intervalo = Number(opcionesActuales.intervalo) > 0
    ? Number(opcionesActuales.intervalo)
    : CONFIG.intervalo;

  activo = true;
  temporizador = setInterval(tick, intervalo);

  return true;
}

/** Detiene el simulador y limpia el estado. */
export function detenerSimulador() {
  if (temporizador) {
    clearInterval(temporizador);
    temporizador = null;
  }

  activo = false;
  opcionesActuales = null;
  racks = [];
  estadoRacks.clear();
}

/** Indica si el simulador está emitiendo datos. */
export function estaActivo() {
  return activo;
}

/** Devuelve una copia del estado interno (útil para depuración). */
export function obtenerEstadoSimulado() {
  return Object.fromEntries(
    [...estadoRacks.entries()].map(([rackId, estado]) => [
      rackId,
      {
        temp: redondear(estado.temp, 1),
        ups: redondear(estado.ups, 0),
        pdu: Math.round(estado.pdu),
        hum: redondear(estado.hum, 1),
        agua: estado.agua,
        puerta: estado.puerta,
      },
    ])
  );
}
