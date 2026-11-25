// Cliente MQTT: topics, normalización de payloads y reconexión.

// Configuración por defecto

const BROKER_POR_DEFECTO = 'ws://127.0.0.1:9001';

export const TOPICS = {
  global: [
    'datacenter/global/temp',
    'datacenter/global/ups',
    'datacenter/global/pdu',
    'datacenter/global/ia', // análisis de IA global (JSON)
  ],
  racks: ['01', '02', '03', '04'].flatMap((numero) => [
    `datacenter/rack/${numero}/temp`,
    `datacenter/rack/${numero}/ups`,
    `datacenter/rack/${numero}/pdu`,
    `datacenter/rack/${numero}/hum`,
    `datacenter/rack/${numero}/agua`,
    `datacenter/rack/${numero}/puerta`,
  ]),
  // Comodín: un único JSON de IA por rack (evita listar "01" a "04" a mano).
  ia: ['datacenter/rack/+/ia'],
};

/* Métricas aceptadas por el parser. */
const METRICAS_VALIDAS = ['temp', 'ups', 'pdu', 'hum', 'agua', 'puerta'];

// Un valor fuera de rango se considera corrupto y se descarta.

export const UNIDADES = Object.freeze({
  temp: '°C',
  hum: '%',
  ups: '%',
  pdu: 'W',
  agua: null,
  puerta: null,
});

export const LIMITES_FISICOS = Object.freeze({
  temp: { min: -10, max: 100 }, // °C
  hum: { min: 0, max: 100 }, // % HR
  ups: { min: 0, max: 100 }, // %
  pdu: { min: 0, max: 20000 }, // W
  agua: { min: 0, max: 1 }, // 0/1
  puerta: { min: 0, max: 1 }, // 0/1
});

/**
 * ¿El valor cae dentro del rango físico razonable de la métrica?
 * @param {string} metrica
 * @param {number} valor
 * @returns {boolean}
 */
export function validarRango(metrica, valor) {
  if (!Number.isFinite(valor)) return false;
  const limites = LIMITES_FISICOS[metrica];
  if (!limites) return true;
  return valor >= limites.min && valor <= limites.max;
}

// Estado interno

let cliente = null;
let estadoActual = 'desconectado';
let opcionesActuales = null;

// Parseo de payloads

/** Normaliza el origen de una lectura a 'physical' | 'simulated'. */
function normalizarFuente(valor, porDefecto = 'physical') {
  if (valor === null || valor === undefined) return porDefecto;

  const texto = String(valor).trim().toLowerCase();

  if (['physical', 'fisico', 'físico', 'real', 'hardware', 'esp32', 'sensor'].includes(texto)) {
    return 'physical';
  }
  if (['simulated', 'simulado', 'simulacion', 'simulación', 'sim', 'fake', 'synthetic'].includes(texto)) {
    return 'simulated';
  }
  return porDefecto;
}

/** Normaliza la calidad de una lectura a 'valid' | 'invalid'. */
function normalizarCalidad(valor, porDefecto = 'valid') {
  if (valor === null || valor === undefined) return porDefecto;

  const texto = String(valor).trim().toLowerCase();

  if (['invalid', 'invalida', 'inválida', 'bad', 'error', 'corrupto', 'corrupt'].includes(texto)) {
    return 'invalid';
  }
  if (['valid', 'valida', 'válida', 'ok', 'good', 'buena'].includes(texto)) {
    return 'valid';
  }
  return porDefecto;
}

/** Normaliza una unidad a texto corto o null. */
function normalizarUnidad(valor) {
  if (valor === null || valor === undefined) return null;
  const texto = String(valor).trim();
  return texto ? texto.slice(0, 12) : null;
}

/** Normaliza la marca de tiempo: acepta ms o segundos; devuelve ms o null. */
function normalizarTimestamp(valor) {
  if (valor === null || valor === undefined || valor === '') return null;
  const numero = Number(valor);
  if (!Number.isFinite(numero) || numero <= 0) return null;
  // Si viene en segundos (10 dígitos), lo pasamos a milisegundos.
  return numero < 1e12 ? Math.round(numero * 1000) : Math.round(numero);
}

/**
 * Convierte el payload MQTT en una lectura normalizada con metadatos.
 *
 * Mantiene compatibilidad total con los formatos antiguos (número plano,
 * booleano textual, JSON simple) y añade el JSON extendido con
 * { value/valor, unit, source, quality, timestamp }.
 *
 * @param {Uint8Array|string} payload
 * @param {string} metrica nombre de la métrica para buscar dentro del JSON
 * @returns {{
 *   valor: number|null,
 *   unidad: string|null,
 *   source: 'physical'|'simulated',
 *   quality: 'valid'|'invalid',
 *   timestamp: number|null,
 *   valida: boolean,
 *   extendido: boolean
 * }|null} null si el payload no se puede interpretar en absoluto
 */
export function parsearLectura(payload, metrica) {
  if (payload === null || payload === undefined) return null;

  const texto = typeof payload === 'string'
    ? payload
    : new TextDecoder().decode(payload);

  const limpio = texto.trim();
  if (!limpio) return null;

  const unidadPorDefecto = UNIDADES[metrica] ?? null;

  const base = (valor, extra = {}) => {
    const source = extra.source ?? 'physical';
    const quality = extra.quality ?? 'valid';
    return {
      valor,
      unidad: extra.unidad ?? (valor !== null ? unidadPorDefecto : null),
      source,
      quality,
      timestamp: extra.timestamp ?? null,
      valida: valor !== null && quality === 'valid' && validarRango(metrica, valor),
      extendido: Boolean(extra.extendido),
    };
  };

  // 0) Booleanos textuales típicos de sensores magnéticos / de agua.
  const minuscula = limpio.toLowerCase();
  if (minuscula === 'true' || minuscula === 'on') return base(1);
  if (minuscula === 'false' || minuscula === 'off') return base(0);

  // 1) Número plano → origen físico por defecto (ESP32 real).
  const directo = Number(limpio);
  if (Number.isFinite(directo)) return base(directo);

  // 2) JSON (simple o extendido).
  try {
    const datos = JSON.parse(limpio);

    if (typeof datos === 'number') {
      return Number.isFinite(datos) ? base(datos) : base(null, { quality: 'invalid' });
    }

    if (datos && typeof datos === 'object' && !Array.isArray(datos)) {
      let valor = null;
      for (const clave of ['value', 'valor', metrica]) {
        const candidato = datos?.[clave];
        if (candidato === null || candidato === undefined) continue;
        const numero = Number(candidato);
        if (Number.isFinite(numero)) {
          valor = numero;
          break;
        }
      }

      return base(valor, {
        unidad: normalizarUnidad(datos.unit ?? datos.unidad),
        source: normalizarFuente(datos.source ?? datos.fuente, 'physical'),
        quality: normalizarCalidad(datos.quality ?? datos.calidad, 'valid'),
        timestamp: normalizarTimestamp(datos.timestamp ?? datos.ts),
        extendido: true,
      });
    }
  } catch {
    // No era JSON: se devuelve como lectura inválida (payload corrupto).
  }

  return base(null, { quality: 'invalid' });
}

// Payloads de IA (JSON con predicción y pronóstico)

/** Devuelve un número finito o null (Number(null) === 0, hay que evitarlo). */
function numeroONull(valor) {
  if (valor === null || valor === undefined || valor === '') return null;
  const n = Number(valor);
  return Number.isFinite(n) ? n : null;
}

/** Devuelve un texto recortado o null. */
function textoONull(valor) {
  if (valor === null || valor === undefined) return null;
  const texto = String(valor).trim();
  return texto ? texto : null;
}

/** Normaliza un booleano (true/false, 1/0, "si"/"no") o null. */
function booleanoONull(valor) {
  if (typeof valor === 'boolean') return valor;
  const texto = String(valor ?? '').trim().toLowerCase();
  if (['1', 'true', 'si', 'sí', 'on', 'yes'].includes(texto)) return true;
  if (['0', 'false', 'no', 'off'].includes(texto)) return false;
  return null;
}

/**
 * Resume un percentil del pronóstico a un único número.
 *
 * El motor Chronos-2 publica la serie completa del horizonte (12 valores) en
 * `pronostico.p10/p50/p90`. Para el HUD mostramos el valor al final del
 * horizonte (t+H); si ya llega como número, se usa tal cual.
 */
function resumirPronostico(valor) {
  if (Array.isArray(valor)) {
    for (let i = valor.length - 1; i >= 0; i--) {
      const numero = numeroONull(valor[i]);
      if (numero !== null) return numero;
    }
    return null;
  }
  return numeroONull(valor);
}

/**
 * Convierte el payload de un topic `.../ia` en un objeto normalizado.
 *
 * Se aceptan las claves snake_case del contrato (`health_score`,
 * `eta_alarma_seg`, ...) y, por robustez, variantes en camelCase. Cualquier
 * campo ausente o inválido se normaliza a `null` sin descartar el mensaje.
 *
 * @param {Uint8Array|string} payload
 * @returns {{
 *   health_score: number|null,
 *   riesgo: string|null,
 *   eta_alarma_seg: number|null,
 *   anomalia: boolean|null,
 *   tendencia_c_min: number|null,
 *   recomendacion: string|null,
 *   pronostico: { p10:number|null, p50:number|null, p90:number|null }|null
 * }|null}
 */
function parsearIA(payload) {
  if (payload === null || payload === undefined) return null;

  const texto = typeof payload === 'string'
    ? payload
    : new TextDecoder().decode(payload);

  const limpio = texto.trim();
  if (!limpio) return null;

  let datos;
  try {
    datos = JSON.parse(limpio);
  } catch {
    return null; // La IA siempre publica JSON.
  }

  if (!datos || typeof datos !== 'object' || Array.isArray(datos)) return null;

  // Devuelve el primer valor presente entre varios alias de la misma clave.
  const leer = (...claves) => {
    for (const clave of claves) {
      const valor = datos[clave];
      if (valor !== undefined && valor !== null) return valor;
    }
    return null;
  };

  const brutoPronostico = leer('pronostico', 'pronóstico', 'forecast');
  let pronostico = null;

  if (brutoPronostico && typeof brutoPronostico === 'object') {
    const p10 = resumirPronostico(brutoPronostico.p10);
    const p50 = resumirPronostico(brutoPronostico.p50);
    const p90 = resumirPronostico(brutoPronostico.p90);
    if (p10 !== null || p50 !== null || p90 !== null) {
      pronostico = { p10, p50, p90 };
    }
  }

  // Anomalía: puede llegar como booleano (`anomalia`) o como nº de anomalías
  // activas en el resumen global (`anomalias_activas`).
  let anomalia = booleanoONull(leer('anomalia', 'anomaly'));
  if (anomalia === null) {
    const cuenta = numeroONull(leer('anomalias_activas', 'anomaliasActivas'));
    if (cuenta !== null) anomalia = cuenta > 0;
  }

  return {
    health_score: numeroONull(leer('health_score', 'healthScore', 'health', 'health_score_global')),
    riesgo: textoONull(leer('riesgo', 'risk', 'estado_sala', 'estadoSala')),
    eta_alarma_seg: numeroONull(leer('eta_alarma_seg', 'etaAlarmaSeg', 'eta')),
    anomalia,
    tendencia_c_min: numeroONull(leer('tendencia_c_min', 'tendenciaCMin', 'tendencia')),
    recomendacion: textoONull(leer('recomendacion', 'recomendación', 'recommendation')),
    pronostico,
  };
}

// Notificación de estado y de datos

function notificarEstado(estado, detalle = '') {
  estadoActual = estado;
  if (opcionesActuales && typeof opcionesActuales.onEstado === 'function') {
    opcionesActuales.onEstado(estado, detalle);
  }
}

/** Entrega un paquete de datos al consumidor registrado. */
function emitirDatos(datos) {
  if (opcionesActuales && typeof opcionesActuales.onDatos === 'function') {
    opcionesActuales.onDatos(datos);
  }
}

// Procesado de mensajes

/**
 * Extrae { tipo, rackId, metrica } de un topic.
 * @param {string} topic
 */
function analizarTopic(topic) {
  const partes = topic.split('/');

  if (partes[0] !== 'datacenter') return null;

  // datacenter/global/<metrica>
  if (partes[1] === 'global' && partes.length >= 3) {
    return { tipo: 'global', rackId: null, metrica: partes[2] };
  }

  // datacenter/rack/<nn>/<metrica>
  if (partes[1] === 'rack' && partes.length >= 4) {
    return {
      tipo: 'rack',
      rackId: `rack-${partes[2]}`,
      metrica: partes[3],
    };
  }

  return null;
}

function alRecibirMensaje(topic, payload) {
  const info = analizarTopic(topic);
  if (!info) return;

  const metrica = info.metrica.toLowerCase();

  // Topics de IA: un único JSON con predicción y pronóstico
  // No pasan por `parsearLectura` porque no son escalares: se entregan aparte
  // para no alterar el flujo de las métricas numéricas.
  if (metrica === 'ia') {
    const ia = parsearIA(payload);
    if (!ia) {
      console.warn(`[MQTT] Payload de IA no válido en "${topic}":`, payload);
      return;
    }

    emitirDatos({
      origen: 'mqtt',
      tipo: info.tipo,
      rackId: info.rackId,
      metrica: 'ia',
      ia,
      topic,
      timestamp: Date.now(),
    });
    return;
  }

  if (!METRICAS_VALIDAS.includes(metrica)) return;

  const lectura = parsearLectura(payload, metrica);
  if (!lectura) {
    console.warn(`[MQTT] Payload no interpretable en "${topic}":`, payload);
    return;
  }

  if (!lectura.valida) {
    console.warn(`[MQTT] Lectura inválida en "${topic}":`, payload);
  }

  emitirDatos({
    origen: 'mqtt',
    tipo: info.tipo,
    rackId: info.rackId,
    metrica,
    valor: lectura.valor,
    unidad: lectura.unidad,
    source: lectura.source,
    quality: lectura.valida ? 'valid' : 'invalid',
    valida: lectura.valida,
    extendido: lectura.extendido,
    topic,
    timestamp: lectura.timestamp ?? Date.now(),
    recibidoEn: Date.now(),
  });
}

// API pública

/**
 * Conecta al broker MQTT y se suscribe a todos los topics.
 *
 * @param {{
 *   onDatos: (datos: object) => void,
 *   onEstado?: (estado: string, detalle?: string) => void,
 *   url?: string,
 *   username?: string,
 *   password?: string,
 *   opciones?: object,
 *   topics?: string[]
 * }} opciones
 * @returns {boolean} true si se pudo iniciar la conexión
 */
export function conectarMQTT(opciones = {}) {
  desconectarMQTT();

  opcionesActuales = opciones;

  if (!window.mqtt || typeof window.mqtt.connect !== 'function') {
    console.warn('[MQTT] La librería MQTT.js no está disponible.');
    notificarEstado('offline', 'Librería MQTT no disponible');
    return false;
  }

  const url = opciones.url || BROKER_POR_DEFECTO;
  const topics = opciones.topics || [...TOPICS.global, ...TOPICS.racks, ...TOPICS.ia];

  // Credenciales opcionales: si están definidas, se envían al
  // broker; si no, se conecta como cliente anónimo (comportamiento previo).
  const credenciales = {};
  if (typeof opciones.username === 'string' && opciones.username) {
    credenciales.username = opciones.username;
  }
  if (typeof opciones.password === 'string' && opciones.password) {
    credenciales.password = opciones.password;
  }

  notificarEstado('connecting', `Conectando a ${url}`);

  try {
    cliente = window.mqtt.connect(url, {
      clientId: `nexus-dt-${Math.random().toString(16).slice(2, 10)}`,
      clean: true,
      connectTimeout: 8000,
      reconnectPeriod: 6000,
      keepalive: 30,
      ...credenciales,
      ...opciones.opciones,
    });
  } catch (error) {
    console.error('[MQTT] Error al crear el cliente:', error);
    notificarEstado('offline', 'No se pudo crear el cliente');
    return false;
  }

  cliente.on('connect', () => {
    notificarEstado('online', 'Broker conectado');

    cliente.subscribe(topics, { qos: 0 }, (error) => {
      if (error) {
        console.warn('[MQTT] Error en la suscripción:', error);
        return;
      }
      console.info(`[MQTT] Suscrito a ${topics.length} topics.`);
    });
  });

  cliente.on('message', alRecibirMensaje);

  cliente.on('reconnect', () => notificarEstado('connecting', 'Reconectando…'));

  cliente.on('offline', () => notificarEstado('offline', 'Broker no disponible'));

  cliente.on('error', (error) => {
    console.warn('[MQTT] Error de conexión:', error?.message || error);
    notificarEstado('offline', 'Error de conexión');
  });

  cliente.on('close', () => {
    if (estadoActual !== 'offline') {
      notificarEstado('offline', 'Conexión cerrada');
    }
  });

  return true;
}

/** Cierra la conexión de forma limpia. */
export function desconectarMQTT() {
  if (!cliente) return;

  try {
    cliente.removeAllListeners?.();
    cliente.end(true);
  } catch (error) {
    console.warn('[MQTT] Error al desconectar:', error);
  }

  cliente = null;
  notificarEstado('offline', 'Desconectado');
}

/** Devuelve el estado actual de la conexión. */
export function estadoMQTT() {
  return estadoActual;
}

/** Publica un valor (útil para probar sin hardware). */
export function publicarMQTT(topic, valor) {
  if (!cliente || !cliente.connected) return false;

  const payload = typeof valor === 'object' ? JSON.stringify(valor) : String(valor);
  cliente.publish(topic, payload, { qos: 0 });

  return true;
}
