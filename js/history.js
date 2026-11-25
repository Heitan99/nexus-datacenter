// Bitácora de eventos y muestras con persistencia local y exportación CSV.

/** Tipos de evento reconocidos por el HUD y la bitácora. */
export const TIPOS_EVENTO = Object.freeze({
  ALARMA: 'ALARMA',
  RECUPERADO: 'RECUPERADO',
  PREVENTIVO_IA: 'PREVENTIVO_IA',
  DESCONECTADO: 'DESCONECTADO',
  RECONECTADO: 'RECONECTADO',
  LECTURA_INVALIDA: 'LECTURA_INVALIDA',
  CONTROL_AISLADO: 'CONTROL_AISLADO',
});

// Persistencia

const DB_NOMBRE = 'nexus_datacenter';
const DB_VERSION = 1;
const ALMACEN = 'bitacora';
const CLAVE_EVENTOS = 'eventos';
const CLAVE_MUESTRAS = 'muestras';
const LS_CLAVE = 'nexus.historial.v1';

/* Límites en memoria (visibles en el modal). */
const LIMITE_EVENTOS = 800;
const LIMITE_MUESTRAS = 2000;

/* Límites de la copia en localStorage (cuota mucho menor). */
const LIMITE_LS_EVENTOS = 250;
const LIMITE_LS_MUESTRAS = 350;

let eventos = [];
let muestras = [];
let db = null;
let usandoLS = false;
let listo = false;

const oyentes = new Set();

let temporizadorPersistencia = null;

// IndexedDB (con promesas)

function abrirDB() {
  return new Promise((resolver) => {
    if (typeof indexedDB === 'undefined') {
      resolver(null);
      return;
    }

    let peticion;
    try {
      peticion = indexedDB.open(DB_NOMBRE, DB_VERSION);
    } catch {
      resolver(null);
      return;
    }

    peticion.onupgradeneeded = () => {
      const base = peticion.result;
      if (!base.objectStoreNames.contains(ALMACEN)) {
        base.createObjectStore(ALMACEN, { keyPath: 'clave' });
      }
    };

    peticion.onsuccess = () => resolver(peticion.result);
    peticion.onerror = () => resolver(null);
    peticion.onblocked = () => resolver(null);
  });
}

function idbLeer(base, clave) {
  return new Promise((resolver) => {
    try {
      const tx = base.transaction(ALMACEN, 'readonly');
      const peticion = tx.objectStore(ALMACEN).get(clave);
      peticion.onsuccess = () => resolver(peticion.result?.datos ?? []);
      peticion.onerror = () => resolver([]);
    } catch {
      resolver([]);
    }
  });
}

function idbEscribir(base, clave, datos) {
  return new Promise((resolver) => {
    try {
      const tx = base.transaction(ALMACEN, 'readwrite');
      tx.objectStore(ALMACEN).put({ clave, datos, actualizado: Date.now() });
      tx.oncomplete = () => resolver(true);
      tx.onerror = () => resolver(false);
    } catch {
      resolver(false);
    }
  });
}

// localStorage (respaldo)

function cargarLS() {
  usandoLS = true;
  try {
    const bruto = localStorage.getItem(LS_CLAVE);
    if (!bruto) return;
    const datos = JSON.parse(bruto);
    eventos = Array.isArray(datos?.eventos) ? datos.eventos : [];
    muestras = Array.isArray(datos?.muestras) ? datos.muestras : [];
  } catch {
    eventos = [];
    muestras = [];
  }
}

function guardarLS() {
  try {
    localStorage.setItem(
      LS_CLAVE,
      JSON.stringify({
        eventos: eventos.slice(-LIMITE_LS_EVENTOS),
        muestras: muestras.slice(-LIMITE_LS_MUESTRAS),
      })
    );
  } catch {
    /* Cuota llena o almacenamiento no disponible: la sesión sigue en memoria. */
  }
}

// Persistencia diferida (evita escribir en cada muestra)

function programarPersistencia() {
  if (temporizadorPersistencia !== null) return;

  temporizadorPersistencia = setTimeout(() => {
    temporizadorPersistencia = null;

    if (usandoLS || !db) {
      guardarLS();
      return;
    }

    idbEscribir(db, CLAVE_EVENTOS, eventos);
    idbEscribir(db, CLAVE_MUESTRAS, muestras);
  }, 400);
}

// Notificación a la UI

function notificar() {
  for (const oyente of oyentes) {
    try {
      oyente();
    } catch (error) {
      console.warn('[Historial] Error en un oyente:', error);
    }
  }
}

// API pública

/** Carga la bitácora persistida. Idempotente; seguro de llamar varias veces. */
export async function inicializarHistorial() {
  if (listo) return;

  db = await abrirDB();

  if (db) {
    eventos = await idbLeer(db, CLAVE_EVENTOS);
    muestras = await idbLeer(db, CLAVE_MUESTRAS);
    if (!Array.isArray(eventos)) eventos = [];
    if (!Array.isArray(muestras)) muestras = [];
  } else {
    cargarLS();
  }

  listo = true;
  notificar();
}

/**
 * Registra un evento en la bitácora.
 * @param {{
 *   tipo: string,
 *   rackId?: string|null,
 *   variable?: string|null,
 *   valor?: number|string|null,
 *   mensaje?: string,
 *   timestamp?: number
 * }} datos
 * @returns {object} el evento registrado
 */
export function registrarEvento(datos = {}) {
  const evento = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: Number(datos.timestamp) || Date.now(),
    tipo: datos.tipo || 'INFO',
    rackId: datos.rackId || null,
    variable: datos.variable || null,
    valor: datos.valor ?? null,
    mensaje: datos.mensaje || '',
  };

  eventos.push(evento);

  if (eventos.length > LIMITE_EVENTOS) {
    eventos.splice(0, eventos.length - LIMITE_EVENTOS);
  }

  programarPersistencia();
  notificar();

  return evento;
}

/**
 * Registra una muestra de telemetría.
 * @param {{
 *   timestamp?: number, rackId: string, variable: string,
 *   valor: number|null, unidad?: string|null, source?: string|null,
 *   quality?: string|null
 * }} muestra
 */
export function registrarMuestra(muestra = {}) {
  muestras.push({
    timestamp: Number(muestra.timestamp) || Date.now(),
    rackId: muestra.rackId || null,
    variable: muestra.variable || null,
    valor: Number.isFinite(muestra.valor) ? muestra.valor : null,
    unidad: muestra.unidad ?? null,
    source: muestra.source ?? null,
    quality: muestra.quality ?? null,
  });

  if (muestras.length > LIMITE_MUESTRAS) {
    muestras.splice(0, muestras.length - LIMITE_MUESTRAS);
  }

  programarPersistencia();
}

/** Copia de los eventos (más recientes primero). */
export function obtenerEventos() {
  return [...eventos].sort((a, b) => b.timestamp - a.timestamp);
}

/** Copia de las muestras (más recientes primero). */
export function obtenerMuestras() {
  return [...muestras].sort((a, b) => b.timestamp - a.timestamp);
}

/** Resumen de conteos por tipo de evento. */
export function estadisticasHistorial() {
  const porTipo = {};
  for (const evento of eventos) {
    porTipo[evento.tipo] = (porTipo[evento.tipo] || 0) + 1;
  }
  return {
    eventos: eventos.length,
    muestras: muestras.length,
    porTipo,
    persistencia: db ? 'IndexedDB' : usandoLS ? 'localStorage' : 'memoria',
  };
}

/** Suscribe una función que se llamará cuando cambie la bitácora. */
export function suscribirHistorial(oyente) {
  if (typeof oyente !== 'function') return () => {};
  oyentes.add(oyente);
  return () => oyentes.delete(oyente);
}

/** Vacía la bitácora (útil para reiniciar una demo). */
export function limpiarHistorial() {
  eventos = [];
  muestras = [];
  programarPersistencia();
  notificar();
}

// Exportación CSV

function escaparCSV(valor) {
  if (valor === null || valor === undefined) return '';
  const texto = String(valor);
  if (/[",\n\r;]/.test(texto)) {
    return `"${texto.replace(/"/g, '""')}"`;
  }
  return texto;
}

function filaCSV(valores) {
  return valores.map(escaparCSV).join(',');
}

function fechaISO(timestamp) {
  try {
    return new Date(timestamp).toISOString();
  } catch {
    return '';
  }
}

/** Construye el CSV de eventos (orden cronológico ascendente). */
export function construirCSVEventos() {
  const cabecera = filaCSV([
    'timestamp',
    'fecha_iso',
    'tipo',
    'rackId',
    'variable',
    'valor',
    'mensaje',
  ]);

  const filas = [...eventos]
    .sort((a, b) => a.timestamp - b.timestamp)
    .map((evento) =>
      filaCSV([
        evento.timestamp,
        fechaISO(evento.timestamp),
        evento.tipo,
        evento.rackId,
        evento.variable,
        evento.valor,
        evento.mensaje,
      ])
    );

  return [cabecera, ...filas].join('\r\n');
}

/** Construye el CSV de muestras (orden cronológico ascendente). */
export function construirCSVMuestras() {
  const cabecera = filaCSV([
    'timestamp',
    'fecha_iso',
    'rackId',
    'variable',
    'valor',
    'unidad',
    'source',
    'quality',
  ]);

  const filas = [...muestras]
    .sort((a, b) => a.timestamp - b.timestamp)
    .map((muestra) =>
      filaCSV([
        muestra.timestamp,
        fechaISO(muestra.timestamp),
        muestra.rackId,
        muestra.variable,
        muestra.valor,
        muestra.unidad,
        muestra.source,
        muestra.quality,
      ])
    );

  return [cabecera, ...filas].join('\r\n');
}

/** Fuerza una descarga en el navegador. */
export function descargarCSV(nombre, contenido) {
  try {
    const blob = new Blob(['\ufeff' + contenido], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const enlace = document.createElement('a');
    enlace.href = url;
    enlace.download = nombre;
    document.body.appendChild(enlace);
    enlace.click();
    enlace.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
    return true;
  } catch (error) {
    console.warn('[Historial] No se pudo descargar el CSV:', error);
    return false;
  }
}

/** Exporta los eventos a un archivo .csv. */
export function exportarEventosCSV() {
  const marca = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return descargarCSV(`nexus_eventos_${marca}.csv`, construirCSVEventos());
}

/** Exporta las muestras a un archivo .csv. */
export function exportarMuestrasCSV() {
  const marca = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return descargarCSV(`nexus_muestras_${marca}.csv`, construirCSVMuestras());
}
