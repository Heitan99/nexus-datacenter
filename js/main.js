// Punto de entrada: orquesta escena, UI, telemetría, IA e histórico.

import { crearEscena, iniciarBucle, volarAComponente, reiniciarVista } from './scene.js';
import {
  cargarModelo,
  actualizarModelo,
  actualizarTemperaturaRack,
  alternarPuertas,
  puertasEstanAbiertas,
  resaltarComponente,
  limpiarSeleccion,
  obtenerComponentePorId,
  obtenerRacks,
  establecerMantenimiento,
  establecerVelocidadVentiladores,
  velocidadVentiladores,
} from './model.js';
import * as UI from './ui.js';
import { conectarMQTT, publicarMQTT } from './mqtt.js';
import {
  iniciarSimulador,
  pausarSimulador,
  reanudarSimulador,
  estaActivo,
  USAR_SIMULADOR,
} from './simulator.js';
import {
  telegramConfigurado,
  configurarTelegram,
  guardarConfigTelegram,
  limpiarConfigTelegram,
  obtenerConfiguracionTelegram,
} from './telegram.js';
import { analizarRack, analizarSistema, describirHealthScore } from './ai-predictor.js';
import {
  inicializarHistorial,
  registrarEvento,
  registrarMuestra,
  TIPOS_EVENTO,
} from './history.js';
import {
  obtenerConfigMQTT,
  guardarConfigMQTT,
  limpiarCredencialesMQTT,
} from './mqtt-config.js';

// Configuración

/* Valores por defecto; se pueden sobreescribir con localStorage (ver abajo). */
const CONFIG_POR_DEFECTO = {
  ventanaDatoRealMs: 20000, // el simulador calla 20 s tras un dato MQTT
  maxPuntosHistorial: 60,
  ventanaEcoMs: 5000, // ventana para reconocer el eco de nuestras publicaciones
  desconexionMs: 15000, // watchdog: sin telemetría → DESCONECTADO
  muestraIntervaloMs: 10000, // muestrear cada rack cada 10 s
  invalidThrottleMs: 15000, // evitar spam del evento LECTURA_INVALIDA
};

/** Lee la configuración local (localStorage) fusionada con los valores por defecto. */
function leerConfiguracion() {
  const config = { ...CONFIG_POR_DEFECTO };
  try {
    const bruto = localStorage.getItem('nexus.config.v1');
    if (bruto) {
      const datos = JSON.parse(bruto);
      for (const clave of Object.keys(CONFIG_POR_DEFECTO)) {
        const valor = Number(datos?.[clave]);
        if (Number.isFinite(valor) && valor > 0) config[clave] = valor;
      }
    }
  } catch {
    /* configuración corrupta: se usan los valores por defecto */
  }
  return config;
}

const CONFIG = leerConfiguracion();

/* Métricas que el simulador publica hacia el broker. */
const METRICAS_TELEMETRIA = ['temp', 'ups', 'pdu', 'hum', 'agua', 'puerta'];

/* Unidad mostrada por métrica (el payload extendido puede sobrescribirla). */
const UNIDADES_METRICA = {
  temp: '°C',
  hum: '%',
  ups: '%',
  pdu: 'W',
  agua: null,
  puerta: null,
};

// Estado de la aplicación

const estado = {
  // id → { temp, ups, pdu, hum, agua, puerta, historial[], enMantenimiento,
  //        healthCongelado, meta{metrica→{source,unidad,quality,timestamp}},
  //        fuente, ultimaTelemetria, ultimaTelemetriaFisica, desconectado,
  //        comandoVentilador, ultimaMuestra }
  racks: new Map(),
  seleccionId: null,
  simuladorActivo: true,
  mqttEstado: 'desconectado',
  fuente: 'SIMULADOR',

  // Análisis de IA externo (topics ".../ia"), independiente de la telemetría.
  iaRacks: new Map(),
  iaGlobal: null,
};

/** Última vez que llegó un dato real por rack+métrica: clave "rack-01:temp". */
const ultimoDatoReal = new Map();

/** Última vez que se registró una lectura inválida: clave "rack-01:temp". */
const ultimoInvalido = new Map();

/**
 * Publicaciones propias del simulador: topic → { valor, timestamp }.
 * El broker reenvía a TODOS los suscriptores, incluido quien publicó, así que
 * necesitamos distinguir ese eco de una lectura real del ESP32.
 */
const publicacionesRecientes = new Map();

let escena;
let camara;
let renderer;
let componentes = [];
let temporizadorWatchdog = null;

// Arranque

async function iniciar() {
  const canvas = document.getElementById('scene');

  UI.inicializarUI({
    onCerrarPanel: cerrarDetalle,
    onEnfocar: enfocarSeleccion,
    onPuertas: alternarPuertasUI,
    onMantenimiento: alternarMantenimiento,
    onEtiquetas: () => UI.alternarEtiquetas(),
    onReset: resetearVista,
    onToggleSimulador: alternarSimulador,
    onToggleTelegram: alternarTelegram,
    onComandoVentilador: comandarVentilador,
    onGuardarMQTT: guardarCredencialesMQTT,
    onLimpiarMQTT: limpiarCredencialesMQTTYReconectar,
    onReconectarMQTT: reconectarMQTT,
    onGuardarTelegram: guardarCredencialesTelegram,
    onLimpiarTelegram: limpiarCredencialesTelegram,
  });

  // Refleja en el HUD el estado real de las alertas de Telegram.
  UI.establecerTelegram(obtenerConfiguracionTelegram().habilitado);

  // Carga la bitácora persistente (IndexedDB/localStorage) antes de la telemetría.
  await inicializarHistorial();

  UI.actualizarLoader(2, 'Preparando escena 3D...');

  const escenaCreada = crearEscena(canvas);
  escena = escenaCreada.escena;
  camara = escenaCreada.camara;
  renderer = escenaCreada.renderer;

  try {
    const resultado = await cargarModelo({
      escena,
      camara,
      renderer,
      alProgreso: alCargarModelo,
      onHover: alHacerHover,
      onSeleccionar: alSeleccionarComponente,
    });

    componentes = resultado.componentes;
  } catch (error) {
    console.error('[Main] No se pudo cargar el modelo:', error);
    UI.mostrarErrorLoader(
      'No se pudo cargar assets/datacenter.glb. Revisa la ruta y sirve el proyecto por HTTP.'
    );
    return;
  }

  inicializarEstadoRacks();
  UI.crearRendererEtiquetas(escena);
  UI.crearEtiquetas(componentes, escena, { onSeleccionar: seleccionarPorId });

  UI.establecerBotonPuertas(false);
  UI.alternarEtiquetas(true);

  refrescarInterfaz();
  UI.ocultarLoader();

  iniciarTelemetria();
  iniciarWatchdog();

  iniciarBucle({
    alFrame: (delta, elapsed) => actualizarModelo(delta, elapsed),
    alRender: () => UI.renderizarEtiquetas(escena, camara),
  });

  console.info(
    '[Main] Gemelo digital listo ·',
    `${componentes.length} componentes ·`,
    `Telegram ${telegramConfigurado() ? 'activo' : 'en modo simulación'} ·`,
    `watchdog ${Math.round(CONFIG.desconexionMs / 1000)} s.`
  );
}

// Carga del modelo

function alCargarModelo(evento) {
  // El servidor puede no enviar `total`; usamos el tamaño conocido del GLB.
  const total = evento.total || 65634424;
  const porcentaje = total > 0 ? (evento.loaded / total) * 100 : 0;

  UI.actualizarLoader(
    Math.min(95, porcentaje),
    `Descargando modelo 3D... ${(evento.loaded / 1048576).toFixed(1)} MB`
  );
}

// Estado inicial de los racks

function inicializarEstadoRacks() {
  const racks = obtenerRacks();
  const ahora = Date.now();

  racks.forEach((rack, indice) => {
    const base = 22.4 + indice * 0.35;
    const historial = [];

    // Sembramos un histórico suave para que la gráfica no aparezca vacía.
    for (let i = 14; i >= 0; i--) {
      historial.push({
        t: ahora - i * 3000,
        valor: base + (Math.random() - 0.5) * 0.9,
      });
    }

    // Metadatos iniciales: los valores sembrados son sintéticos (SIMULADO).
    const meta = {};
    for (const metrica of METRICAS_TELEMETRIA) {
      meta[metrica] = {
        source: 'simulated',
        unidad: UNIDADES_METRICA[metrica],
        quality: 'valid',
        timestamp: ahora,
      };
    }

    estado.racks.set(rack.id, {
      temp: base,
      ups: 100 - indice,
      pdu: 1380 + indice * 55,
      hum: 45 + (indice - 1.5) * 1.5,
      agua: 0,
      puerta: 0,
      historial,
      enMantenimiento: false,
      healthCongelado: null,
      meta,
      fuente: 'simulated',
      ultimaTelemetria: ahora,
      ultimaTelemetriaFisica: 0,
      desconectado: false,
      comandoVentilador: 'OFF',
      ultimaMuestra: 0,
    });

    actualizarTemperaturaRack(rack.id, base, false);
  });
}

// Telemetría: simulador + MQTT

function crearOpcionesMQTT(config = obtenerConfigMQTT()) {
  return {
    onDatos: (dato) => procesarDatoMQTT(dato),
    onEstado: (estadoMQTT, detalle) => {
      estado.mqttEstado = estadoMQTT;
      UI.establecerEstadoMQTT(estadoMQTT, detalle);
      actualizarFuente();
    },
    url: config.url,
    username: config.username,
    password: config.password,
  };
}

function iniciarTelemetria() {
  const idsRacks = [...estado.racks.keys()];

  // El simulador solo arranca si el interruptor está activo.
  if (USAR_SIMULADOR) {
    iniciarSimulador({
      racks: idsRacks,
      intervalo: 3000,
      debeSimular,
      onDatos: (paquetes) => procesarPaquetes(paquetes, 'simulador'),
    });

    UI.configurarSimuladorDisponible(true);
    UI.establecerSimulador(true);
    estado.simuladorActivo = true;
  } else {
    UI.configurarSimuladorDisponible(false);
    estado.simuladorActivo = false;
    console.info(
      '[Main] Simulador desactivado (USAR_SIMULADOR = false). Esperando datos MQTT del ESP32.'
    );
  }

  conectarMQTT(crearOpcionesMQTT());
}

/** Reconecta al broker usando la configuración local de credenciales. */
function reconectarMQTT() {
  conectarMQTT(crearOpcionesMQTT());
}

/** Guarda credenciales MQTT locales y reconecta. */
function guardarCredencialesMQTT(configuracion = {}) {
  const guardada = guardarConfigMQTT(configuracion);
  UI.establecerCredencialesMQTT(guardada);
  reconectarMQTT();
  console.info('[Main] Credenciales MQTT actualizadas; reconectando…');
}

/** Borra las credenciales MQTT locales y reconecta como cliente anónimo. */
function limpiarCredencialesMQTTYReconectar() {
  const actual = limpiarCredencialesMQTT();
  UI.establecerCredencialesMQTT(actual);
  reconectarMQTT();
  console.info('[Main] Credenciales MQTT borradas; reconectando como cliente anónimo…');
}

/** Guarda el token/chat_id de Telegram en este navegador. */
function guardarCredencialesTelegram(configuracion = {}) {
  const guardada = guardarConfigTelegram(configuracion);
  console.info(
    '[Main] Configuración de Telegram guardada:',
    guardada.token && guardada.chatId ? 'bot listo' : 'incompleta'
  );
  UI.establecerTelegram(guardada.habilitado);
}

/** Borra las credenciales de Telegram (las alertas vuelven a modo simulación). */
function limpiarCredencialesTelegram() {
  const actual = limpiarConfigTelegram();
  console.info('[Main] Credenciales de Telegram borradas; alertas en modo simulación.');
  UI.establecerTelegram(actual.habilitado);
}

/**
 * Decide si el simulador puede emitir una métrica concreta.
 * Si esa métrica llegó por MQTT hace menos de 20 s, se silencia.
 */
function debeSimular(rackId, metrica) {
  const ultimo = ultimoDatoReal.get(`${rackId}:${metrica}`) || 0;
  return Date.now() - ultimo > CONFIG.ventanaDatoRealMs;
}

/**
 * Publica en MQTT la telemetría de un rack simulada, para que el motor de IA
 * externo (Python/Chronos-2) la reciba por MQTT.
 *
 * Se publica en formato JSON extendido marcando source:"simulated",
 * de modo que cualquier suscriptor distingue lo sintético de lo real.
 */
function publicarTelemetria(paquete) {
  const numero = String(paquete.rackId).replace(/^rack-/, '');
  const timestamp = Date.now();

  for (const metrica of METRICAS_TELEMETRIA) {
    const valor = paquete[metrica];
    if (!Number.isFinite(valor)) continue;

    const topic = `datacenter/rack/${numero}/${metrica}`;
    const payload = {
      value: valor,
      unit: UNIDADES_METRICA[metrica],
      source: 'simulated',
      quality: 'valid',
      timestamp,
    };

    if (publicarMQTT(topic, payload)) {
      // Guardamos lo publicado para reconocer su eco y no confundirlo con una
      // lectura real (si no, el simulador se silenciaría a sí mismo).
      publicacionesRecientes.set(topic, { valor, timestamp });
    }
  }
}

/**
 * ¿El mensaje MQTT es el eco de una publicación reciente hecha por nosotros?
 * Se compara topic + valor dentro de una ventana corta de tiempo.
 */
function esEcoPropio(dato) {
  if (!dato || !dato.topic || !Number.isFinite(dato.valor)) return false;

  const publicado = publicacionesRecientes.get(dato.topic);
  if (!publicado) return false;

  if (Date.now() - publicado.timestamp > CONFIG.ventanaEcoMs) {
    publicacionesRecientes.delete(dato.topic);
    return false;
  }

  return publicado.valor === dato.valor;
}

// Aplicación de lecturas (válidas e inválidas)

/**
 * Aplica una lectura a un rack.
 *
 * Si la lectura es inválida (NaN, fuera de rango o quality "invalid") NO
 * actualiza el valor actual: marca la métrica como INVÁLIDA y registra el
 * evento. Si es válida, actualiza valor, metadatos y watchdog.
 *
 * @returns {boolean} true si la lectura se aplicó como válida
 */
function aplicarLectura(rackId, metrica, lectura, origen) {
  const rack = estado.racks.get(rackId);
  if (!rack) return false;

  const ahora = Date.now();
  const source = lectura.source || (origen === 'simulador' ? 'simulated' : 'physical');
  const unidad = lectura.unidad ?? UNIDADES_METRICA[metrica] ?? null;
  const quality = lectura.quality || 'valid';
  const valida = lectura.valida !== undefined
    ? lectura.valida
    : quality === 'valid' && Number.isFinite(lectura.valor);

  if (!valida || !Number.isFinite(lectura.valor)) {
    registrarLecturaInvalida(rackId, metrica, {
      source,
      unidad,
      valor: Number.isFinite(lectura.valor) ? lectura.valor : null,
      motivo: quality === 'invalid' ? 'calidad inválida' : 'fuera de rango o no numérica',
    });
    return false;
  }

  const valor = lectura.valor;

  rack.meta[metrica] = { source, unidad, quality: 'valid', timestamp: ahora };
  rack.fuente = source;
  rack.ultimaTelemetria = ahora;
  if (source === 'physical') rack.ultimaTelemetriaFisica = ahora;

  // Si el rack estaba desconectado, este mensaje lo reconecta.
  if (rack.desconectado) {
    rack.desconectado = false;
    registrarEvento({
      tipo: TIPOS_EVENTO.RECONECTADO,
      rackId,
      variable: metrica,
      valor,
      mensaje: 'Telemetría válida restablecida',
    });
  }

  rack[metrica] = valor;

  if (metrica === 'temp') {
    rack.historial.push({ t: ahora, valor });
    if (rack.historial.length > CONFIG.maxPuntosHistorial) {
      rack.historial.splice(0, rack.historial.length - CONFIG.maxPuntosHistorial);
    }
  }

  return true;
}

/** Marca una métrica como inválida y registra el evento (con antirrebote). */
function registrarLecturaInvalida(rackId, metrica, datos) {
  const rack = estado.racks.get(rackId);
  if (!rack) return;

  const anterior = rack.meta[metrica] || {};

  rack.meta[metrica] = {
    source: datos.source || anterior.source || 'physical',
    unidad: datos.unidad ?? anterior.unidad ?? UNIDADES_METRICA[metrica] ?? null,
    quality: 'invalid',
    timestamp: Date.now(),
  };

  const clave = `${rackId}:${metrica}`;
  const ahora = Date.now();
  if (ahora - (ultimoInvalido.get(clave) || 0) < CONFIG.invalidThrottleMs) return;
  ultimoInvalido.set(clave, ahora);

  registrarEvento({
    tipo: TIPOS_EVENTO.LECTURA_INVALIDA,
    rackId,
    variable: metrica,
    valor: datos.valor ?? null,
    mensaje: `Lectura inválida de ${metrica} (${datos.motivo || 'payload corrupto'})`,
  });
}

// Muestreo periódico

function muestrearRack(rackId) {
  const rack = estado.racks.get(rackId);
  if (!rack) return;

  const ahora = Date.now();
  if (ahora - rack.ultimaMuestra < CONFIG.muestraIntervaloMs) return;
  rack.ultimaMuestra = ahora;

  for (const metrica of METRICAS_TELEMETRIA) {
    const meta = rack.meta[metrica];
    if (!meta || meta.quality !== 'valid') continue;

    registrarMuestra({
      timestamp: ahora,
      rackId,
      variable: metrica,
      valor: rack[metrica],
      unidad: meta.unidad ?? UNIDADES_METRICA[metrica] ?? null,
      source: meta.source,
      quality: meta.quality,
    });
  }
}

// Watchdog de desconexión

function iniciarWatchdog() {
  if (temporizadorWatchdog) clearInterval(temporizadorWatchdog);
  temporizadorWatchdog = setInterval(comprobarDesconexiones, 2000);
}

/**
 * ¿Debe considerarse desconectado el rack?
 *
 * - Si el rack ya ha recibido telemetría física, se exige que siga llegando.
 * - Si nunca hubo hardware, solo se exige telemetría cuando el SIM está apagado.
 */
function evaluarDesconexion(rack, ahora) {
  const timeout = CONFIG.desconexionMs;

  if (rack.ultimaTelemetriaFisica > 0) {
    return ahora - rack.ultimaTelemetriaFisica > timeout;
  }

  if (!estado.simuladorActivo) {
    return ahora - rack.ultimaTelemetria > timeout;
  }

  return false;
}

function comprobarDesconexiones() {
  const ahora = Date.now();
  let cambio = false;

  for (const [rackId, rack] of estado.racks) {
    const desconectado = evaluarDesconexion(rack, ahora);

    if (desconectado && !rack.desconectado) {
      rack.desconectado = true;
      registrarEvento({
        tipo: TIPOS_EVENTO.DESCONECTADO,
        rackId,
        mensaje: `Sin telemetría válida durante más de ${Math.round(CONFIG.desconexionMs / 1000)} s`,
      });
      cambio = true;
    }
    // La reconexión se detecta de inmediato al aplicar la siguiente lectura.
  }

  if (cambio) refrescarInterfaz();
}

// Procesado de paquetes

/** Procesa el lote del simulador (un paquete por rack). */
function procesarPaquetes(paquetes, origen) {
  if (!Array.isArray(paquetes)) return;

  for (const paquete of paquetes) {
    const actual = estado.racks.get(paquete.rackId);
    if (!actual) continue;

    for (const metrica of METRICAS_TELEMETRIA) {
      if (!Number.isFinite(paquete[metrica])) continue;

      aplicarLectura(
        paquete.rackId,
        metrica,
        {
          valor: paquete[metrica],
          source: origen === 'simulador' ? 'simulated' : 'physical',
          quality: 'valid',
          valida: true,
        },
        origen
      );
    }

    muestrearRack(paquete.rackId);

    // El simulador también publica por MQTT para alimentar al motor de IA.
    if (origen === 'simulador') publicarTelemetria(paquete);
  }

  estado.fuente = origen === 'simulador' ? 'SIMULADOR' : 'MQTT';
  refrescarInterfaz();
}

/** Procesa un mensaje individual de MQTT. */
function procesarDatoMQTT(dato) {
  if (!dato) return;

  // Análisis de IA (JSON)
  // Se procesa SIEMPRE, también con SIM ACTIVO: la IA proviene del motor
  // externo por MQTT y no depende del simulador.
  if (dato.metrica === 'ia' && dato.ia) {
    const sello = dato.timestamp || Date.now();

    if (dato.tipo === 'global') {
      estado.iaGlobal = { ...dato.ia, timestamp: sello };
    } else if (dato.rackId && estado.racks.has(dato.rackId)) {
      estado.iaRacks.set(dato.rackId, { ...dato.ia, timestamp: sello });
    }

    // Cuenta como dato real (mantiene viva la etiqueta de fuente).
    ultimoDatoReal.set(dato.rackId ? `${dato.rackId}:ia` : 'global:ia', Date.now());

    estado.fuente = 'MQTT';
    refrescarInterfaz();
    return;
  }

  // Eco de una publicación propia del simulador: el estado local ya lo tiene.
  if (esEcoPropio(dato)) return;

  if (dato.tipo === 'global') {
    // Los topics globales se reflejan en todos los racks como referencia.
    if (dato.metrica === 'temp' && Number.isFinite(dato.valor)) {
      for (const rackId of estado.racks.keys()) {
        aplicarLectura(
          rackId,
          'temp',
          {
            valor: dato.valor,
            source: dato.source,
            quality: dato.quality,
            valida: dato.valida,
            unidad: dato.unidad,
          },
          'mqtt'
        );
      }
    }
    estado.fuente = 'MQTT';
    refrescarInterfaz();
    return;
  }

  if (!dato.rackId || !estado.racks.has(dato.rackId)) return;

  // Marca de tiempo del dato real (silencia el simulador para esa métrica).
  ultimoDatoReal.set(`${dato.rackId}:${dato.metrica}`, Date.now());

  aplicarLectura(
    dato.rackId,
    dato.metrica,
    {
      valor: dato.valor,
      source: dato.source,
      quality: dato.quality,
      valida: dato.valida,
      unidad: dato.unidad,
    },
    'mqtt'
  );

  muestrearRack(dato.rackId);
  estado.fuente = 'MQTT';
  refrescarInterfaz();
}

// Refresco de la interfaz

/** Fuente agregada de una métrica en el panel global. */
function fuenteGlobal(metrica) {
  let fisico = false;
  let simulado = false;

  for (const rack of estado.racks.values()) {
    if (rack.desconectado) continue;
    const meta = rack.meta[metrica];
    if (!meta || meta.quality !== 'valid') continue;
    if (meta.source === 'physical') fisico = true;
    else if (meta.source === 'simulated') simulado = true;
  }

  if (fisico && simulado) return 'mixto';
  if (fisico) return 'physical';
  if (simulado) return 'simulated';
  return null;
}

function refrescarInterfaz() {
  const lecturas = [...estado.racks.values()];

  // Análisis global
  const global = analizarSistema(lecturas);

  UI.actualizarDashboard({
    temp: global.temp,
    ups: global.ups,
    pdu: global.pdu,
    health: global.health,
    estado: global.estado,
    pduMaximo: 4000 * Math.max(1, estado.racks.size),
    descripcion: describirHealthScore(global.health),
    descripcionSistema: describirSistema(global),
    ia: estado.iaGlobal,
    // Diferenciación FÍSICO vs SIMULADO por tarjeta.
    fuentes: {
      temp: fuenteGlobal('temp'),
      ups: fuenteGlobal('ups'),
      pdu: fuenteGlobal('pdu'),
    },
  });

  // Etiquetas y color de los racks
  const mapaEtiquetas = new Map();

  for (const [rackId, lectura] of estado.racks) {
    const analisis = analizarRack(lectura);
    const desconectado = Boolean(lectura.desconectado);
    const estadoRack = desconectado ? 'desconectado' : analisis.estado;

    mapaEtiquetas.set(rackId, { temp: lectura.temp, estado: estadoRack });

    actualizarTemperaturaRack(rackId, lectura.temp, !desconectado && analisis.estado === 'alarma');

    // Sin datos válidos no se evalúan alarmas (evita alertar con valores viejos).
    if (!desconectado) {
      UI.evaluarAlertaCritica(rackId, lectura, estado.iaRacks.get(rackId) || null);
    }
  }

  UI.actualizarEtiquetas(mapaEtiquetas);

  // Panel lateral
  if (estado.seleccionId) {
    const componente = obtenerComponentePorId(estado.seleccionId);

    if (componente) {
      const lectura = estado.racks.get(componente.id);
      const analisis = lectura ? analizarRack(lectura) : null;
      const ia = estado.iaRacks.get(componente.id) || null;
      UI.actualizarPanel(componente, lectura, analisis, ia);
    }
  }

  actualizarFuente();
}

function describirSistema(global) {
  if (global.estado === 'alarma') {
    return 'Parámetros fuera de rango crítico: revisa los racks marcados en rojo.';
  }

  if (global.estado === 'aviso') {
    return 'Algún parámetro se acerca al límite. Vigila la temperatura de los racks.';
  }

  if (global.enMantenimiento > 0) {
    return `${global.enMantenimiento} rack(s) en mantenimiento · alarmas y salud pausadas.`;
  }

  return 'Todos los parámetros dentro de rango. Refrigeración y energía estables.';
}

/** Actualiza la etiqueta de fuente de datos según simulador y MQTT. */
function actualizarFuente() {
  const hayDatosRecientes = [...ultimoDatoReal.values()].some(
    (marca) => Date.now() - marca < CONFIG.ventanaDatoRealMs
  );

  let texto = 'SIMULADOR';

  if (estado.simuladorActivo && hayDatosRecientes) texto = 'MIXTO · SIM + MQTT';
  else if (hayDatosRecientes) texto = 'MQTT';
  else if (!estado.simuladorActivo) texto = 'SIN DATOS';

  estado.fuente = texto;
  UI.establecerFuente(texto);
}

// Modo mantenimiento

/**
 * Alterna el mantenimiento del rack seleccionado.
 *
 * Al entrar se congela el Health Score actual; al salir se libera y el rack
 * vuelve a evaluarse con normalidad (incluida la alerta de Telegram).
 */
function alternarMantenimiento() {
  const rackId = estado.seleccionId;
  if (!rackId) return;

  const lectura = estado.racks.get(rackId);
  const componente = obtenerComponentePorId(rackId);

  if (!lectura || !componente || componente.tipo !== 'rack') return;

  if (!lectura.enMantenimiento) {
    // Congelamos la salud ANTES de marcar el mantenimiento.
    lectura.healthCongelado = analizarRack(lectura).health;
    lectura.enMantenimiento = true;
  } else {
    lectura.enMantenimiento = false;
    lectura.healthCongelado = null;
  }

  establecerMantenimiento(rackId, lectura.enMantenimiento);

  console.info(
    `[Mantenimiento] ${rackId} → ${lectura.enMantenimiento ? 'ACTIVO' : 'desactivado'}`
  );

  refrescarInterfaz();
}

// Control aislado de demostración

/**
 * Envía una orden al ventilador del rack seleccionado.
 * Publica en datacenter/rack/<nn>/control ("ON" | "OFF" | "AUTO") y registra
 * la orden en la bitácora. Por defecto el control permanece en OFF (seguro).
 */
function comandarVentilador(comando) {
  const rackId = estado.seleccionId;
  if (!rackId) return false;

  const rack = estado.racks.get(rackId);
  const componente = obtenerComponentePorId(rackId);
  if (!rack || !componente || componente.tipo !== 'rack') return false;

  const valor = ['ON', 'OFF', 'AUTO'].includes(comando) ? comando : 'OFF';
  rack.comandoVentilador = valor;

  const numero = rackId.replace(/^rack-/, '');
  const topic = `datacenter/rack/${numero}/control`;
  const publicado = publicarMQTT(topic, valor);

  registrarEvento({
    tipo: TIPOS_EVENTO.CONTROL_AISLADO,
    rackId,
    variable: 'ventilador',
    valor,
    mensaje: `Control aislado del ventilador → ${valor}${publicado ? '' : ' (MQTT offline, orden local)'}`,
  });

  UI.establecerComandoVentilador(valor);
  console.info(`[Control] ${rackId} ventilador → ${valor} (publicado: ${publicado})`);

  return publicado;
}

// Interacción 3D

function alHacerHover(componente, evento) {
  if (!componente || !evento) {
    UI.ocultarTooltip();
    return;
  }

  const lectura = estado.racks.get(componente.id);
  const analisis = lectura ? analizarRack(lectura) : null;

  UI.mostrarTooltip(evento, componente, lectura ? { ...lectura, estado: analisis?.estado } : null);
}

function alSeleccionarComponente(componente) {
  if (!componente) {
    cerrarDetalle();
    return;
  }

  seleccionarComponente(componente);
}

function seleccionarPorId(id) {
  const componente = obtenerComponentePorId(id);
  if (componente) seleccionarComponente(componente);
}

function seleccionarComponente(componente) {
  estado.seleccionId = componente.id;

  resaltarComponente(componente.id);
  UI.abrirPanel(componente);
  UI.marcarEtiquetaActiva(componente.id);

  volarAComponente(componente.caja, {
    margen: componente.tipo === 'rack' ? 1.5 : 1.35,
    duracion: 1.1,
    frente: componente.tipo === 'rack',
  });

  const lectura = estado.racks.get(componente.id);
  const analisis = lectura ? analizarRack(lectura) : null;
  const ia = estado.iaRacks.get(componente.id) || null;
  UI.actualizarPanel(componente, lectura, analisis, ia);

  UI.ocultarTooltip();
}

function cerrarDetalle() {
  estado.seleccionId = null;

  UI.cerrarPanel();
  limpiarSeleccion();
  reiniciarVista();
}

function enfocarSeleccion() {
  if (!estado.seleccionId) return;

  const componente = obtenerComponentePorId(estado.seleccionId);
  if (!componente) return;

  volarAComponente(componente.caja, {
    margen: 1.35,
    duracion: 1.1,
    frente: componente.tipo === 'rack',
  });
}

function resetearVista() {
  estado.seleccionId = null;
  UI.cerrarPanel();
  limpiarSeleccion();
  reiniciarVista();
}

// Controles de la UI

function alternarPuertasUI() {
  const abiertas = alternarPuertas();
  UI.establecerBotonPuertas(abiertas);
}

function alternarSimulador(activo) {
  // Con el hardware real conectado el switch queda bloqueado.
  if (!USAR_SIMULADOR) {
    UI.configurarSimuladorDisponible(false);
    return;
  }

  estado.simuladorActivo = Boolean(activo);
  UI.establecerSimulador(estado.simuladorActivo);

  if (estado.simuladorActivo) {
    const reanudado = reanudarSimulador();
    if (!reanudado && !estaActivo()) {
      iniciarSimulador({
        racks: [...estado.racks.keys()],
        intervalo: 3000,
        debeSimular,
        onDatos: (paquetes) => procesarPaquetes(paquetes, 'simulador'),
      });
    }
  } else {
    pausarSimulador();
  }

  actualizarFuente();
}

/**
 * Silencia o activa las alertas de Telegram desde el switch del HUD.
 * Al silenciar no se envían mensajes, pero el estado de alertas se conserva.
 */
function alternarTelegram(activo) {
  const on = Boolean(activo);
  configurarTelegram({ habilitado: on });
  UI.establecerTelegram(on);
  console.info(`[Main] Telegram ${on ? 'activado' : 'silenciado'} desde el HUD.`);
}

// API de depuración (consola del navegador)

window.__nexus = {
  estado,
  config: CONFIG,
  // Referencias útiles para depurar en la consola del navegador.
  get escena() {
    return escena;
  },
  get camara() {
    return camara;
  },
  get renderer() {
    return renderer;
  },
  get componentes() {
    return componentes;
  },
  seleccionar: seleccionarPorId,
  puertas: alternarPuertasUI,
  puertasAbiertas: puertasEstanAbiertas,
  simulador: alternarSimulador,
  mantenimiento: alternarMantenimiento,
  reiniciarAlertas: UI.reiniciarAlertasTelegram,

  /** Lee o ajusta la velocidad base de los ventiladores (rad/s). */
  ventiladores(valor) {
    return Number.isFinite(valor)
      ? establecerVelocidadVentiladores(valor)
      : velocidadVentiladores;
  },

  /** Indica si un rack está en mantenimiento. */
  enMantenimiento(rackId) {
    return Boolean(estado.racks.get(rackId)?.enMantenimiento);
  },

  /** Comanda el ventilador (control aislado) del rack seleccionado o indicado. */
  comandar(rackId, comando) {
    if (rackId) estado.seleccionId = rackId;
    return comandarVentilador(comando);
  },

  /**
   * Inyecta una lectura manual en un rack y refresca la interfaz.
   * Útil para probar alarmas sin esperar al simulador:
   *   __nexus.inyectar('rack-01', { temp: 35 })
   */
  inyectar(rackId, datos = {}) {
    const lectura = estado.racks.get(rackId);
    if (!lectura) return false;

    for (const metrica of METRICAS_TELEMETRIA) {
      if (!Number.isFinite(datos[metrica])) continue;
      aplicarLectura(
        rackId,
        metrica,
        { valor: datos[metrica], source: 'physical', quality: 'valid', valida: true },
        'mqtt'
      );
    }

    refrescarInterfaz();
    return true;
  },

  /**
   * Inyecta una lectura MQTT simulada (incluye casos inválidos) para pruebas:
   *   __nexus.inyectarLectura('rack-01', 'temp', 23.4, { source: 'physical' })
   *   __nexus.inyectarLectura('rack-01', 'temp', 999, { valida: false })
   */
  inyectarLectura(rackId, metrica, valor, opciones = {}) {
    procesarDatoMQTT({
      origen: 'mqtt',
      tipo: 'rack',
      rackId,
      metrica,
      valor,
      source: opciones.source || 'physical',
      quality: opciones.quality || (opciones.valida === false ? 'invalid' : 'valid'),
      valida: opciones.valida !== undefined ? opciones.valida : undefined,
      unidad: opciones.unidad ?? null,
      topic: `datacenter/rack/${String(rackId).replace(/^rack-/, '')}/${metrica}`,
      timestamp: Date.now(),
    });
    return true;
  },

  /** Devuelve el análisis de IA de un rack (o null si no ha llegado). */
  iaRack(rackId) {
    return estado.iaRacks.get(rackId) || null;
  },

  /** Devuelve el análisis de IA global (o null si no ha llegado). */
  get iaGlobal() {
    return estado.iaGlobal;
  },

  /**
   * Inyecta un análisis de IA como si llegara por MQTT (útil para pruebas):
   *   __nexus.inyectarIA('rack-01', { health_score: 88, riesgo: 'medio' })
   *   __nexus.inyectarIA('global', { ... })
   */
  inyectarIA(objetivo, ia = {}) {
    const esGlobal = objetivo === 'global';

    procesarDatoMQTT({
      origen: 'mqtt',
      tipo: esGlobal ? 'global' : 'rack',
      rackId: esGlobal ? null : objetivo,
      metrica: 'ia',
      ia,
      topic: esGlobal ? 'datacenter/global/ia' : `datacenter/rack/${objetivo}/ia`,
      timestamp: Date.now(),
    });

    return true;
  },

  /** Configuración MQTT actual (sin exponer la contraseña). */
  mqttConfig() {
    const config = obtenerConfigMQTT();
    return { url: config.url, username: config.username, tienePassword: Boolean(config.password) };
  },

  /** Reconecta al broker MQTT. */
  reconectarMQTT,

  refrescar: refrescarInterfaz,
};

// Arranque (con captura de errores global)

iniciar().catch((error) => {
  console.error('[Main] Error fatal:', error);
  UI.mostrarErrorLoader(`Error inesperado: ${error?.message || error}`);
});
