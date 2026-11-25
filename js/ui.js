// Capa de presentación: DOM, paneles, etiquetas y modales.

import * as THREE from 'three';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';

/* Dependencias de la capa de presentación. */
import { enviarAlertaTelegram, obtenerConfigTelegram } from './telegram.js';
import { UMBRALES } from './ai-predictor.js';
import {
  TIPOS_EVENTO,
  registrarEvento,
  obtenerEventos,
  obtenerMuestras,
  estadisticasHistorial,
  suscribirHistorial,
  exportarEventosCSV,
  exportarMuestrasCSV,
  limpiarHistorial,
} from './history.js';
import { obtenerConfigMQTT } from './mqtt-config.js';

// Referencias del DOM

const $ = (id) => document.getElementById(id);

const dom = {};

/** Mapa de etiquetas: id de componente → { objeto, el, valor, led } */
const etiquetas = new Map();

let rendererEtiquetas = null;
let etiquetasVisibles = true;
let grafica = null;
let panelAbiertoId = null;
let callbacksActuales = {};
let historialTab = 'eventos';
let desuscribirHistorial = null;

// Inicialización

/**
 * Cachea el DOM y conecta los botones.
 *
 * @param {{
 *   onCerrarPanel?: Function,
 *   onEnfocar?: Function,
 *   onPuertas?: Function,
 *   onMantenimiento?: Function,
 *   onEtiquetas?: Function,
 *   onReset?: Function,
 *   onToggleSimulador?: (activo:boolean)=>void
 * }} callbacks
 */
export function inicializarUI(callbacks = {}) {
  callbacksActuales = callbacks;

  dom.clock = $('clock');
  dom.date = $('date');

  dom.tempCard = $('temp-card');
  dom.tempValue = $('temp-value');
  dom.tempBar = $('temp-bar');
  dom.tempTag = $('temp-tag');
  dom.tempSrc = $('temp-src');

  dom.upsCard = $('ups-card');
  dom.upsValue = $('ups-value');
  dom.upsBar = $('ups-bar');
  dom.upsTag = $('ups-tag');
  dom.upsSrc = $('ups-src');

  dom.pduCard = $('pdu-card');
  dom.pduValue = $('pdu-value');
  dom.pduBar = $('pdu-bar');
  dom.pduTag = $('pdu-tag');
  dom.pduSrc = $('pdu-src');

  dom.healthValue = $('health-value');
  dom.healthBar = $('health-bar');
  dom.healthLabel = $('health-label');

  dom.systemBlock = $('system-block');
  dom.systemState = $('system-state');
  dom.systemDesc = $('system-desc');

  // Bloques de análisis de IA (global y del rack seleccionado).
  dom.iaGlobal = {
    bloque: $('ia-global'),
    riesgo: $('ia-g-riesgo'),
    health: $('ia-g-health'),
    eta: $('ia-g-eta'),
    anomalia: $('ia-g-anomalia'),
    tendencia: $('ia-g-tendencia'),
    p10: $('ia-g-p10'),
    p50: $('ia-g-p50'),
    p90: $('ia-g-p90'),
    rec: $('ia-g-rec'),
  };
  dom.iaRack = {
    bloque: $('ia-rack'),
    riesgo: $('ia-r-riesgo'),
    health: $('ia-r-health'),
    eta: $('ia-r-eta'),
    anomalia: $('ia-r-anomalia'),
    tendencia: $('ia-r-tendencia'),
    p10: $('ia-r-p10'),
    p50: $('ia-r-p50'),
    p90: $('ia-r-p90'),
    rec: $('ia-r-rec'),
  };

  dom.mqttDot = $('mqtt-dot');
  dom.mqttText = $('mqtt-text');
  dom.simToggle = $('sim-toggle');
  dom.simState = $('sim-state');
  dom.tgToggle = $('tg-toggle');
  dom.tgState = $('tg-state');
  dom.sourceBadge = $('source-badge');

  dom.panel = $('panel-detalle');
  dom.btnCerrar = $('btn-cerrar-panel');
  dom.detalleCategoria = $('detalle-categoria');
  dom.detalleNombre = $('detalle-nombre');
  dom.detalleDescripcion = $('detalle-descripcion');
  dom.detalleEstado = $('detalle-estado');
  dom.detalleEstadoTexto = $('detalle-estado-texto');
  dom.detalleTemp = $('detalle-temp');
  dom.detalleUps = $('detalle-ups');
  dom.detallePdu = $('detalle-pdu');
  dom.detalleHum = $('detalle-hum');
  dom.detalleAgua = $('detalle-agua');
  dom.detallePuerta = $('detalle-puerta');

  // Chip de fuente/calidad por métrica del panel de rack.
  dom.detalleSrc = {
    temp: $('detalle-temp-src'),
    ups: $('detalle-ups-src'),
    pdu: $('detalle-pdu-src'),
    hum: $('detalle-hum-src'),
    agua: $('detalle-agua-src'),
    puerta: $('detalle-puerta-src'),
  };

  // Bloque de control aislado de laboratorio.
  dom.labBlock = $('lab-block');
  dom.labStatus = $('lab-status');
  dom.labBtns = [...document.querySelectorAll('[data-fan]')];

  // Modal de histórico/CSV.
  dom.histModal = $('historial-modal');
  dom.histThead = $('historial-thead');
  dom.histTbody = $('historial-tbody');
  dom.histResumen = $('historial-resumen');
  dom.histTabs = [...document.querySelectorAll('[data-hist-tab]')];
  dom.btnHistCerrar = $('btn-historial-cerrar');
  dom.btnHistExportEventos = $('btn-export-eventos');
  dom.btnHistExportMuestras = $('btn-export-muestras');
  dom.btnHistLimpiar = $('btn-historial-limpiar');

  // Modal de credenciales MQTT.
  dom.mqttModal = $('mqtt-modal');
  dom.mqttUrl = $('mqtt-url');
  dom.mqttUser = $('mqtt-user');
  dom.mqttPass = $('mqtt-pass');
  dom.mqttStatus = $('mqtt-config-status');
  dom.btnMqttCerrar = $('btn-mqtt-cerrar');
  dom.btnMqttGuardar = $('btn-mqtt-guardar');
  dom.btnMqttLimpiar = $('btn-mqtt-limpiar');
  dom.btnMqttReconectar = $('btn-mqtt-reconectar');

  // Modal de alertas Telegram.
  dom.tgModal = $('tg-modal');
  dom.tgToken = $('tg-token');
  dom.tgChat = $('tg-chat');
  dom.tgStatus = $('tg-config-status');
  dom.btnTgConfig = $('btn-tg-config');
  dom.btnTgCerrar = $('btn-tg-cerrar');
  dom.btnTgGuardar = $('btn-tg-guardar');
  dom.btnTgLimpiar = $('btn-tg-limpiar');

  dom.btnHistorico = $('btn-historico');
  dom.btnMqttConfig = $('btn-mqtt-config');
  dom.detalleHealthRing = $('detalle-health-ring');
  dom.detalleHealth = $('detalle-health');
  dom.detalleVida = $('detalle-vida');
  dom.detallePrediccion = $('detalle-prediccion');
  dom.chartMax = $('chart-max');

  dom.btnEnfocar = $('btn-enfocar');
  dom.btnPuertasPanel = $('btn-puertas-panel');
  dom.btnMantenimiento = $('btn-mantenimiento');
  dom.btnPuertas = $('btn-puertas');
  dom.btnEtiquetas = $('btn-etiquetas');
  dom.btnReset = $('btn-reset');

  dom.tooltip = $('tooltip');
  dom.loader = $('loader');
  dom.loaderMsg = $('loader-msg');
  dom.loaderBar = $('loader-bar');
  dom.loaderPct = $('loader-pct');
  dom.labelsLayer = $('labels-layer');

  // Botones
  dom.btnCerrar?.addEventListener('click', () => callbacks.onCerrarPanel?.());
  dom.btnEnfocar?.addEventListener('click', () => callbacks.onEnfocar?.());
  dom.btnPuertasPanel?.addEventListener('click', () => callbacks.onPuertas?.());
  dom.btnMantenimiento?.addEventListener('click', () => callbacks.onMantenimiento?.());
  dom.btnPuertas?.addEventListener('click', () => callbacks.onPuertas?.());
  dom.btnReset?.addEventListener('click', () => callbacks.onReset?.());
  dom.btnEtiquetas?.addEventListener('click', () => callbacks.onEtiquetas?.());

  dom.simToggle?.addEventListener('change', () => {
    callbacks.onToggleSimulador?.(dom.simToggle.checked);
  });

  dom.tgToggle?.addEventListener('change', () => {
    callbacks.onToggleTelegram?.(dom.tgToggle.checked);
  });

  // Control aislado de laboratorio
  for (const boton of dom.labBtns) {
    boton.addEventListener('click', () => {
      callbacks.onComandoVentilador?.(boton.dataset.fan);
    });
  }

  // Histórico / Exportar CSV
  dom.btnHistorico?.addEventListener('click', abrirHistorial);
  dom.btnHistCerrar?.addEventListener('click', cerrarHistorial);
  dom.btnHistExportEventos?.addEventListener('click', () => exportarEventosCSV());
  dom.btnHistExportMuestras?.addEventListener('click', () => exportarMuestrasCSV());
  dom.btnHistLimpiar?.addEventListener('click', () => {
    limpiarHistorial();
    pintarHistorial();
  });

  for (const pestana of dom.histTabs) {
    pestana.addEventListener('click', () => {
      historialTab = pestana.dataset.histTab;
      for (const otra of dom.histTabs) {
        otra.classList.toggle('active', otra === pestana);
      }
      pintarHistorial();
    });
  }

  dom.histModal?.addEventListener('click', (evento) => {
    if (evento.target === dom.histModal) cerrarHistorial();
  });

  // Credenciales MQTT
  dom.btnMqttConfig?.addEventListener('click', abrirConfigMQTT);
  dom.btnMqttCerrar?.addEventListener('click', cerrarConfigMQTT);
  dom.btnMqttReconectar?.addEventListener('click', () => callbacks.onReconectarMQTT?.());
  dom.btnMqttLimpiar?.addEventListener('click', () => {
    callbacks.onLimpiarMQTT?.();
    if (dom.mqttUser) dom.mqttUser.value = '';
    if (dom.mqttPass) dom.mqttPass.value = '';
    establecerCredencialesMQTT(obtenerConfigMQTT());
  });
  dom.btnMqttGuardar?.addEventListener('click', () => {
    callbacks.onGuardarMQTT?.({
      url: dom.mqttUrl?.value ?? '',
      username: dom.mqttUser?.value ?? '',
      password: dom.mqttPass?.value ?? '',
    });
    if (dom.mqttStatus) dom.mqttStatus.textContent = 'Credenciales guardadas · reconectando…';
  });

  dom.mqttModal?.addEventListener('click', (evento) => {
    if (evento.target === dom.mqttModal) cerrarConfigMQTT();
  });

  // Alertas Telegram
  dom.btnTgConfig?.addEventListener('click', abrirConfigTelegram);
  dom.btnTgCerrar?.addEventListener('click', cerrarConfigTelegram);
  dom.btnTgGuardar?.addEventListener('click', () => {
    const token = (dom.tgToken?.value ?? '').trim();
    const chatId = (dom.tgChat?.value ?? '').trim();

    // Solo se actualizan los campos rellenados; "BORRAR CREDENCIALES" limpia todo.
    const cambios = {};
    if (token) cambios.token = token;
    if (chatId) cambios.chatId = chatId;

    callbacks.onGuardarTelegram?.(cambios);

    // El token no se vuelve a pintar en el formulario.
    if (dom.tgToken) dom.tgToken.value = '';
    establecerConfigTelegram(obtenerConfigTelegram());
  });
  dom.btnTgLimpiar?.addEventListener('click', () => {
    callbacks.onLimpiarTelegram?.();
    if (dom.tgToken) dom.tgToken.value = '';
    if (dom.tgChat) dom.tgChat.value = '';
    establecerConfigTelegram(obtenerConfigTelegram());
  });
  dom.tgModal?.addEventListener('click', (evento) => {
    if (evento.target === dom.tgModal) cerrarConfigTelegram();
  });

  // Refresca la tabla del histórico cuando cambia la bitácora.
  if (!desuscribirHistorial) {
    desuscribirHistorial = suscribirHistorial(() => {
      if (dom.histModal?.classList.contains('abierto')) pintarHistorial();
    });
  }

  // Estado inicial del formulario de credenciales y del control aislado.
  establecerCredencialesMQTT(obtenerConfigMQTT());
  establecerConfigTelegram(obtenerConfigTelegram());
  establecerComandoVentilador('OFF');

  // Escape: primero cierra cualquier modal; si no hay modal, cierra el panel.
  window.addEventListener('keydown', (evento) => {
    if (evento.key !== 'Escape') return;

    if (dom.histModal?.classList.contains('abierto')) {
      cerrarHistorial();
      return;
    }
    if (dom.mqttModal?.classList.contains('abierto')) {
      cerrarConfigMQTT();
      return;
    }
    if (dom.tgModal?.classList.contains('abierto')) {
      cerrarConfigTelegram();
      return;
    }
    if (panelAbiertoId) callbacks.onCerrarPanel?.();
  });

  actualizarReloj();
  setInterval(actualizarReloj, 1000);
}

// Reloj

export function actualizarReloj() {
  if (!dom.clock) return;

  const ahora = new Date();

  dom.clock.textContent = ahora.toLocaleTimeString('es-ES', { hour12: false });

  if (dom.date) {
    dom.date.textContent = ahora
      .toLocaleDateString('es-ES', {
        weekday: 'short',
        day: '2-digit',
        month: 'short',
        year: 'numeric',
      })
      .toUpperCase();
  }
}

// Etiquetas CSS2D

/**
 * Crea el renderizador CSS2D sobre la capa #labels-layer.
 * @param {THREE.Scene} escena
 */
export function crearRendererEtiquetas(escena) {
  rendererEtiquetas = new CSS2DRenderer();

  rendererEtiquetas.setSize(window.innerWidth, window.innerHeight);

  const capa = rendererEtiquetas.domElement;
  capa.style.position = 'absolute';
  capa.style.top = '0';
  capa.style.left = '0';
  capa.style.width = '100%';
  capa.style.height = '100%';
  capa.style.pointerEvents = 'none';

  dom.labelsLayer.innerHTML = '';
  dom.labelsLayer.appendChild(capa);

  window.addEventListener('resize', () => {
    rendererEtiquetas?.setSize(window.innerWidth, window.innerHeight);
  });

  return rendererEtiquetas;
}

/**
 * Crea una etiqueta flotante por cada componente.
 *
 * @param {Array<object>} componentes
 * @param {THREE.Scene} escena
 * @param {{ onSeleccionar?: (id:string)=>void }} opciones
 */
export function crearEtiquetas(componentes, escena, opciones = {}) {
  if (!rendererEtiquetas) crearRendererEtiquetas(escena);

  for (const componente of componentes) {
    if (etiquetas.has(componente.id)) continue;

    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'etiqueta3d';
    el.dataset.id = componente.id;

    const led = document.createElement('span');
    led.className = 'etiqueta-led';

    const nombre = document.createElement('span');
    nombre.className = 'etiqueta-nombre';
    nombre.textContent = componente.nombre;

    const valor = document.createElement('span');
    valor.className = 'etiqueta-valor';
    valor.textContent = componente.tipo === 'rack' ? '--.-°' : '';

    el.append(led, nombre, valor);

    el.addEventListener('click', (evento) => {
      evento.stopPropagation();
      opciones.onSeleccionar?.(componente.id);
    });

    const objeto = new CSS2DObject(el);
    objeto.position.copy(componente.puntoEtiqueta);
    escena.add(objeto);

    etiquetas.set(componente.id, { objeto, el, valor, led, nombre });
  }

  console.info(`[UI] ${etiquetas.size} etiquetas CSS2D creadas.`);
}

/**
 * Actualiza el valor y el estado de alarma de cada etiqueta.
 *
 * @param {Map<string, { temp?:number, estado?:string }>} estadoRacks
 */
export function actualizarEtiquetas(estadoRacks) {
  for (const [id, etiqueta] of etiquetas) {
    const estado = estadoRacks?.get(id);
    if (!estado) continue;

    const desconectado = estado.estado === 'desconectado';

    if (desconectado) {
      etiqueta.valor.textContent = 'S/D';
    } else if (Number.isFinite(estado.temp)) {
      etiqueta.valor.textContent = `${estado.temp.toFixed(1)}°`;
    }

    const alarma = estado.estado === 'alarma';
    const mantenimiento = estado.estado === 'mantenimiento';

    etiqueta.el.classList.toggle('alarma', alarma);
    etiqueta.el.classList.toggle('mantenimiento', mantenimiento);
    etiqueta.el.classList.toggle('desconectado', desconectado);
  }
}

/** Marca visualmente la etiqueta del componente seleccionado. */
export function marcarEtiquetaActiva(id) {
  for (const [clave, etiqueta] of etiquetas) {
    etiqueta.el.classList.toggle('activa', clave === id);
  }
}

/** Renderiza las etiquetas; se llama en cada frame. */
export function renderizarEtiquetas(escena, camara) {
  if (!rendererEtiquetas || !etiquetasVisibles) return;
  rendererEtiquetas.render(escena, camara);
}

/**
 * Muestra u oculta todas las etiquetas.
 * @param {boolean} [forzar] si se omite, alterna
 * @returns {boolean} estado final
 */
export function alternarEtiquetas(forzar) {
  etiquetasVisibles = typeof forzar === 'boolean' ? forzar : !etiquetasVisibles;

  dom.labelsLayer?.classList.toggle('ocultas', !etiquetasVisibles);
  dom.btnEtiquetas?.classList.toggle('active', etiquetasVisibles);

  return etiquetasVisibles;
}

export function estadoEtiquetas() {
  return etiquetasVisibles;
}

// Fuente y calidad: FÍSICO, SIMULADO, inválido o sin datos.

const TEXTO_FUENTE = {
  physical: 'FÍSICO',
  simulated: 'SIMULADO',
  mixto: 'MIXTO',
  invalid: 'INVÁLIDA',
  stale: 'SIN DATOS',
};

/** Pinta un chip de fuente/calidad (data-source controla el color). */
function pintarChipFuente(el, fuente) {
  if (!el) return;
  if (fuente && TEXTO_FUENTE[fuente]) {
    el.textContent = TEXTO_FUENTE[fuente];
    el.dataset.source = fuente;
  } else {
    el.textContent = fuente === null || fuente === undefined ? '—' : String(fuente);
    delete el.dataset.source;
  }
}

/** Formatea el valor de una métrica con su sufijo. */
function formatearValorMetrica(metrica, valor) {
  if (!Number.isFinite(valor)) return '--';
  switch (metrica) {
    case 'temp':
      return `${valor.toFixed(1)}°`;
    case 'hum':
      return `${valor.toFixed(1)}%`;
    case 'ups':
      return `${Math.round(valor)}%`;
    case 'pdu':
      return `${Math.round(valor)}W`;
    case 'agua':
      return valor >= 0.5 ? 'AGUA' : 'SECO';
    case 'puerta':
      return valor >= 0.5 ? 'ABIERTA' : 'CERRADA';
    default:
      return String(valor);
  }
}

/** Pinta una métrica del panel de rack con su chip de fuente/calidad. */
function pintarMetricaRack(metrica, valor, meta, desconectado) {
  const refs = {
    temp: dom.detalleTemp,
    ups: dom.detalleUps,
    pdu: dom.detallePdu,
    hum: dom.detalleHum,
    agua: dom.detalleAgua,
    puerta: dom.detallePuerta,
  };

  const el = refs[metrica];
  const chip = dom.detalleSrc?.[metrica];
  const calidad = meta?.quality || null;
  const invalida = desconectado || calidad === 'invalid';

  if (el) {
    el.textContent = invalida ? '--' : formatearValorMetrica(metrica, valor);
  }

  if (chip) {
    const fuente = desconectado ? 'stale' : calidad === 'invalid' ? 'invalid' : meta?.source || null;
    pintarChipFuente(chip, fuente);
  }

  el?.closest('.detalle-metrica')?.classList.toggle('is-invalid', invalida);
}

/** Sincroniza el control aislado de laboratorio con la orden vigente. */
export function establecerComandoVentilador(comando) {
  const valor = ['ON', 'OFF', 'AUTO'].includes(comando) ? comando : 'OFF';

  for (const boton of dom.labBtns || []) {
    boton.classList.toggle('active', boton.dataset.fan === valor);
  }

  if (dom.labStatus) {
    dom.labStatus.textContent =
      valor === 'AUTO'
        ? 'Estado: AUTO · gestionado por la IA (Chronos-2)'
        : `Estado: ${valor}${valor === 'OFF' ? ' (seguro)' : ''}`;
  }

  return valor;
}

// Modal: histórico / exportar CSV

function formatearFechaHora(timestamp) {
  try {
    return new Date(timestamp).toLocaleString('es-ES', { hour12: false });
  } catch {
    return '';
  }
}

function etiquetaFuente(source) {
  if (source === 'physical') return 'FÍSICO';
  if (source === 'simulated') return 'SIMULADO';
  return '—';
}

function etiquetaCalidad(quality) {
  if (quality === 'valid') return 'VÁLIDA';
  if (quality === 'invalid') return 'INVÁLIDA';
  return '—';
}

function filaTabla(celdas, esCabecera = false) {
  const fila = document.createElement('tr');
  for (const celda of celdas) {
    const el = document.createElement(esCabecera ? 'th' : 'td');
    el.textContent = celda === null || celda === undefined ? '' : String(celda);
    fila.appendChild(el);
  }
  return fila;
}

/** Repinta la tabla del modal según la pestaña activa. */
export function pintarHistorial() {
  if (!dom.histTbody || !dom.histThead) return;

  const stats = estadisticasHistorial();
  if (dom.histResumen) {
    dom.histResumen.textContent = `${stats.eventos} eventos · ${stats.muestras} muestras · persistencia: ${stats.persistencia}`;
  }

  dom.histThead.innerHTML = '';
  dom.histTbody.innerHTML = '';

  if (historialTab === 'muestras') {
    dom.histThead.appendChild(
      filaTabla(['FECHA', 'RACK', 'VARIABLE', 'VALOR', 'UNIDAD', 'FUENTE', 'CALIDAD'], true)
    );

    const muestras = obtenerMuestras().slice(0, 300);
    for (const muestra of muestras) {
      dom.histTbody.appendChild(
        filaTabla([
          formatearFechaHora(muestra.timestamp),
          muestra.rackId || '—',
          muestra.variable || '—',
          muestra.valor === null ? '—' : muestra.valor,
          muestra.unidad || '—',
          etiquetaFuente(muestra.source),
          etiquetaCalidad(muestra.quality),
        ])
      );
    }

    if (!muestras.length) {
      const fila = filaTabla(['Sin muestras registradas todavía.'], false);
      fila.firstChild.colSpan = 7;
      dom.histTbody.appendChild(fila);
    }
    return;
  }

  dom.histThead.appendChild(
    filaTabla(['FECHA', 'EVENTO', 'RACK', 'VARIABLE', 'VALOR', 'DETALLE'], true)
  );

  const eventos = obtenerEventos().slice(0, 300);
  for (const evento of eventos) {
    const fila = filaTabla([
      formatearFechaHora(evento.timestamp),
      evento.tipo,
      evento.rackId || '—',
      evento.variable || '—',
      evento.valor === null ? '—' : evento.valor,
      evento.mensaje || '',
    ]);
    fila.children[1]?.setAttribute('data-tipo', evento.tipo);
    dom.histTbody.appendChild(fila);
  }

  if (!eventos.length) {
    const fila = filaTabla(['Sin eventos registrados todavía.'], false);
    fila.firstChild.colSpan = 6;
    dom.histTbody.appendChild(fila);
  }
}

function abrirHistorial() {
  if (!dom.histModal) return;
  pintarHistorial();
  dom.histModal.classList.add('abierto');
  dom.histModal.setAttribute('aria-hidden', 'false');
}

function cerrarHistorial() {
  dom.histModal?.classList.remove('abierto');
  dom.histModal?.setAttribute('aria-hidden', 'true');
}

// Modal: credenciales MQTT

/** Refleja la configuración MQTT guardada en el formulario. */
export function establecerCredencialesMQTT(config = obtenerConfigMQTT()) {
  if (dom.mqttUrl) dom.mqttUrl.value = config.url || '';
  if (dom.mqttUser) dom.mqttUser.value = config.username || '';
  if (dom.mqttPass) dom.mqttPass.value = '';

  if (dom.mqttStatus) {
    dom.mqttStatus.textContent = config.password
      ? 'Hay una contraseña guardada en este navegador.'
      : 'Cliente anónimo (sin contraseña).';
  }
}

function abrirConfigMQTT() {
  if (!dom.mqttModal) return;
  establecerCredencialesMQTT();
  dom.mqttModal.classList.add('abierto');
  dom.mqttModal.setAttribute('aria-hidden', 'false');
}

function cerrarConfigMQTT() {
  dom.mqttModal?.classList.remove('abierto');
  dom.mqttModal?.setAttribute('aria-hidden', 'true');
}

// Modal: alertas Telegram

/** Refleja la configuración de Telegram guardada en el formulario. */
export function establecerConfigTelegram(config = obtenerConfigTelegram()) {
  if (dom.tgChat) dom.tgChat.value = config.chatId || '';
  if (dom.tgToken) {
    dom.tgToken.value = '';
    dom.tgToken.placeholder = config.token ? '•••••••• (token guardado)' : '123456789:AA...';
  }

  if (dom.tgStatus) {
    if (config.token && config.chatId) {
      dom.tgStatus.textContent = 'Bot configurado · las alertas se envían a Telegram.';
    } else if (config.token || config.chatId) {
      dom.tgStatus.textContent = 'Configuración incompleta · faltan token o chat_id.';
    } else {
      dom.tgStatus.textContent = 'Sin configurar · alertas en modo simulación.';
    }
  }
}

function abrirConfigTelegram() {
  if (!dom.tgModal) return;
  establecerConfigTelegram();
  dom.tgModal.classList.add('abierto');
  dom.tgModal.setAttribute('aria-hidden', 'false');
}

function cerrarConfigTelegram() {
  dom.tgModal?.classList.remove('abierto');
  dom.tgModal?.setAttribute('aria-hidden', 'true');
}

// Panel principal (telemetría global)

/** Aplica las clases de severidad a una tarjeta de métrica. */
function aplicarSeveridad(card, estado) {
  if (!card) return;
  card.classList.toggle('is-warning', estado === 'aviso');
  card.classList.toggle('is-danger', estado === 'alarma');
}

function severidadTemperatura(temp) {
  if (temp > UMBRALES.tempAlarma) return 'alarma';
  if (temp >= UMBRALES.tempAviso) return 'aviso';
  return 'normal';
}

function severidadUps(ups) {
  if (ups <= 20) return 'alarma';
  if (ups <= 40) return 'aviso';
  return 'normal';
}

function severidadPdu(pdu, maximo = 4000) {
  if (pdu >= maximo) return 'alarma';
  if (pdu >= maximo * 0.85) return 'aviso';
  return 'normal';
}

function textoTag(estado) {
  if (estado === 'alarma') return 'ALARMA';
  if (estado === 'aviso') return 'AVISO';
  return 'NORMAL';
}

/**
 * Pinta la telemetría global del panel principal.
 *
 * @param {{
 *   temp:number, ups:number, pdu:number, health:number,
 *   estado:'normal'|'aviso'|'alarma',
 *   pduMaximo?:number,
 *   descripcion?:string
 * }} datos
 */
export function actualizarDashboard(datos = {}) {
  const temp = Number(datos.temp ?? 0);
  const ups = Number(datos.ups ?? 100);
  const pdu = Number(datos.pdu ?? 0);
  const health = Math.round(Number(datos.health ?? 100));
  const estado = datos.estado || 'normal';

  // El PDU global suma todos los racks, así que su escala también se multiplica.
  const pduMaximo = Number(datos.pduMaximo) > 0 ? Number(datos.pduMaximo) : 4000;

  // Temperatura
  if (dom.tempValue) dom.tempValue.textContent = temp.toFixed(1);
  if (dom.tempBar) {
    const pct = Math.min(100, Math.max(0, ((temp - 15) / 30) * 100));
    dom.tempBar.style.width = `${pct}%`;
  }
  if (dom.tempTag) dom.tempTag.textContent = textoTag(severidadTemperatura(temp));
  aplicarSeveridad(dom.tempCard, severidadTemperatura(temp));

  // UPS
  if (dom.upsValue) dom.upsValue.textContent = Math.round(ups);
  if (dom.upsBar) dom.upsBar.style.width = `${Math.min(100, Math.max(0, ups))}%`;
  if (dom.upsTag) dom.upsTag.textContent = textoTag(severidadUps(ups));
  aplicarSeveridad(dom.upsCard, severidadUps(ups));

  // PDU
  if (dom.pduValue) dom.pduValue.textContent = Math.round(pdu);
  if (dom.pduBar) {
    const pct = Math.min(100, Math.max(0, (pdu / pduMaximo) * 100));
    dom.pduBar.style.width = `${pct}%`;
  }
  if (dom.pduTag) dom.pduTag.textContent = textoTag(severidadPdu(pdu, pduMaximo));
  aplicarSeveridad(dom.pduCard, severidadPdu(pdu, pduMaximo));

  // Fuente por tarjeta: FÍSICO / SIMULADO / MIXTO
  pintarChipFuente(dom.tempSrc, datos.fuentes?.temp);
  pintarChipFuente(dom.upsSrc, datos.fuentes?.ups);
  pintarChipFuente(dom.pduSrc, datos.fuentes?.pdu);

  // Health Score global
  if (dom.healthValue) {
    dom.healthValue.textContent = health;
    dom.healthValue.style.color =
      health >= 80 ? 'var(--ok)' : health >= 55 ? 'var(--warn)' : 'var(--danger)';
  }
  if (dom.healthBar) {
    dom.healthBar.style.width = `${Math.min(100, Math.max(0, health))}%`;
    dom.healthBar.style.background =
      health >= 80
        ? 'linear-gradient(90deg, #0e7f6a, var(--ok))'
        : health >= 55
          ? 'linear-gradient(90deg, #9a6a00, var(--warn))'
          : 'linear-gradient(90deg, #8a0a1e, var(--danger))';
  }
  if (dom.healthLabel) {
    dom.healthLabel.textContent =
      datos.descripcion ||
      (health >= 90
        ? 'Sistema saludable'
        : health >= 75
          ? 'Funcionamiento estable'
          : health >= 60
            ? 'Requiere atención'
            : health >= 40
              ? 'Degradación detectada'
              : 'Riesgo alto de fallo');
  }

  // Estado del sistema
  if (dom.systemBlock) dom.systemBlock.dataset.state = estado;
  if (dom.systemState) {
    dom.systemState.textContent =
      estado === 'alarma'
        ? 'ALARMA'
        : estado === 'aviso'
          ? 'AVISO'
          : estado === 'mantenimiento'
            ? 'MANTENIMIENTO'
            : 'NORMAL';
  }
  if (dom.systemDesc) {
    dom.systemDesc.textContent =
      datos.descripcionSistema ||
      (estado === 'alarma'
        ? 'Parámetros fuera de rango crítico'
        : estado === 'aviso'
          ? 'Algún parámetro requiere revisión'
          : estado === 'mantenimiento'
            ? 'Racks en mantenimiento: alarmas y salud pausadas'
            : 'Todos los parámetros dentro de rango');
  }

  // Análisis de IA global (topic datacenter/global/ia)
  pintarIA(dom.iaGlobal, datos.ia || null);
}

/* Análisis de IA externa (topics `datacenter/.../ia`). Se pinta aparte de la
   telemetría y del Health Score calculado en local. */

/** Antigüedad máxima (ms) para considerar vigente un análisis de IA. */
const IA_MAX_ANTIGUEDAD_MS = 90000;

/** Normaliza el riesgo a { texto, nivel } para pintar la insignia. */
function clasificarRiesgo(valor) {
  if (valor === null || valor === undefined || valor === '') {
    return { texto: '—', nivel: 'vacio' };
  }

  const texto = String(valor).trim();
  const numero = Number(texto);

  // Riesgo numérico: 0-1 se escala a porcentaje; 0-100 se usa tal cual.
  if (Number.isFinite(numero)) {
    const escala = numero <= 1 ? numero * 100 : numero;
    if (escala >= 66) return { texto: 'ALTO', nivel: 'alto' };
    if (escala >= 33) return { texto: 'MEDIO', nivel: 'medio' };
    return { texto: 'BAJO', nivel: 'bajo' };
  }

  const t = texto.toLowerCase();

  // Vocabulario del motor de IA (Python/Chronos-2): OPTIMO | PREVENTIVO |
  // ANOMALIA | CRITICO. Se mapea a los niveles visuales del HUD.
  const ALIAS_MOTOR = {
    optimo: 'bajo',
    'óptimo': 'bajo',
    preventivo: 'medio',
    anomalia: 'alto',
    'anomalía': 'alto',
    critico: 'alto',
    'crítico': 'alto',
  };
  if (Object.prototype.hasOwnProperty.call(ALIAS_MOTOR, t)) {
    return { texto: texto.toUpperCase(), nivel: ALIAS_MOTOR[t] };
  }

  if (/(alt|crit|severo|high|peligro|danger)/.test(t)) {
    return { texto: texto.toUpperCase(), nivel: 'alto' };
  }
  if (/(med|moder|warn|avis)/.test(t)) {
    return { texto: texto.toUpperCase(), nivel: 'medio' };
  }
  if (/(baj|norm|estab|ok|low|safe|segur)/.test(t)) {
    return { texto: texto.toUpperCase(), nivel: 'bajo' };
  }
  return { texto: texto.toUpperCase(), nivel: 'neutro' };
}

/** Formatea un ETA en segundos a un texto legible. */
function formatearEta(segundos) {
  if (!Number.isFinite(segundos)) return '—';
  if (segundos <= 0) return 'INMINENTE';
  if (segundos < 60) return `${Math.round(segundos)} s`;

  const minutos = segundos / 60;
  if (minutos < 60) return `${Math.round(minutos)} min`;

  const horas = minutos / 60;
  if (horas < 48) return `${horas.toFixed(1)} h`;

  return `${Math.round(horas / 24)} días`;
}

/** Formatea la tendencia (°C/min) con signo explícito. */
function formatearTendencia(valor) {
  if (!Number.isFinite(valor)) return '—';
  const signo = valor > 0 ? '+' : '';
  return `${signo}${valor.toFixed(2)} °C/min`;
}

/** Formatea un percentil del pronóstico. */
function formatearPronostico(valor) {
  return Number.isFinite(valor) ? valor.toFixed(1) : '—';
}

/**
 * Pinta un bloque de IA (global o de rack seleccionado).
 *
 * @param {object} refs referencias DOM del bloque (ver `dom.iaGlobal`).
 * @param {object|null} ia análisis recibido por MQTT (`.../ia`).
 */
function pintarIA(refs, ia) {
  if (!refs || !refs.bloque) return;

  // Vigencia: si el último mensaje es reciente, el bloque se marca "en vivo".
  const vigente = Boolean(ia) && (!ia.timestamp || Date.now() - ia.timestamp <= IA_MAX_ANTIGUEDAD_MS);
  refs.bloque.classList.toggle('ia-vivo', vigente);
  refs.bloque.classList.toggle('ia-obsoleto', Boolean(ia) && !vigente);

  // Riesgo → insignia superior y color del bloque.
  const riesgo = clasificarRiesgo(ia?.riesgo ?? null);
  refs.bloque.dataset.nivel = riesgo.nivel;
  if (refs.riesgo) {
    refs.riesgo.textContent = riesgo.texto;
    refs.riesgo.dataset.nivel = riesgo.nivel;
  }

  // Health Score de la IA (independiente del local).
  if (refs.health) {
    const salud = ia?.health_score;
    refs.health.textContent = Number.isFinite(salud) ? String(Math.round(salud)) : '—';
    refs.health.dataset.nivel = !Number.isFinite(salud)
      ? 'vacio'
      : salud >= 80
        ? 'bajo'
        : salud >= 55
          ? 'medio'
          : 'alto';
  }

  // ETA hasta la alarma.
  if (refs.eta) refs.eta.textContent = formatearEta(ia?.eta_alarma_seg);

  // Anomalía detectada.
  if (refs.anomalia) {
    const anomalia = ia?.anomalia;
    refs.anomalia.textContent =
      anomalia === null || anomalia === undefined ? '—' : anomalia ? 'SÍ' : 'NO';
    refs.anomalia.dataset.nivel = anomalia ? 'alto' : 'bajo';
  }

  // Tendencia térmica.
  if (refs.tendencia) {
    const tendencia = ia?.tendencia_c_min;
    refs.tendencia.textContent = formatearTendencia(tendencia);
    refs.tendencia.dataset.nivel = !Number.isFinite(tendencia)
      ? 'vacio'
      : tendencia > 0.02
        ? 'alto'
        : tendencia < -0.02
          ? 'bajo'
          : 'neutro';
  }

  // Pronóstico p10 / p50 / p90.
  if (refs.p10) refs.p10.textContent = formatearPronostico(ia?.pronostico?.p10);
  if (refs.p50) refs.p50.textContent = formatearPronostico(ia?.pronostico?.p50);
  if (refs.p90) refs.p90.textContent = formatearPronostico(ia?.pronostico?.p90);

  // Recomendación en lenguaje natural.
  if (refs.rec) {
    refs.rec.textContent = ia?.recomendacion || 'Sin datos de IA todavía.';
  }
}

// Panel lateral de detalle

/**
 * Abre el panel lateral con los datos de un componente.
 * @param {object} componente
 */
export function abrirPanel(componente) {
  if (!componente || !dom.panel) return;

  panelAbiertoId = componente.id;

  dom.panel.classList.toggle('es-rack', componente.tipo === 'rack');
  dom.panel.classList.add('abierto');
  dom.panel.setAttribute('aria-hidden', 'false');

  // Desplaza los controles del pie para que el panel no los tape.
  document.body.classList.add('panel-abierto');

  if (dom.detalleCategoria) {
    dom.detalleCategoria.textContent = componente.categoria || 'COMPONENTE';
  }
  if (dom.detalleNombre) dom.detalleNombre.textContent = componente.nombre;
  if (dom.detalleDescripcion) {
    dom.detalleDescripcion.textContent = componente.descripcion || '';
  }

  if (componente.tipo === 'rack') {
    asegurarGrafica();
  }

  marcarEtiquetaActiva(componente.id);
}

/** Cierra el panel lateral. */
export function cerrarPanel() {
  panelAbiertoId = null;

  dom.panel?.classList.remove('abierto');
  dom.panel?.setAttribute('aria-hidden', 'true');
  document.body.classList.remove('panel-abierto');

  marcarEtiquetaActiva(null);
}

export function idPanelAbierto() {
  return panelAbiertoId;
}

/**
 * Refresca el contenido del panel lateral.
 *
 * @param {object} componente
 * @param {{ temp:number, ups:number, pdu:number, historial?:Array }} estadoRack
 * @param {object} analisis resultado de ai-predictor.analizarRack()
 * @param {object|null} [ia] análisis de IA externo del rack (topic `.../ia`)
 */
export function actualizarPanel(componente, estadoRack, analisis, ia = null) {
  if (!componente || !dom.panel) return;

  // Si el panel está cerrado o muestra otro componente, no hacemos nada.
  if (panelAbiertoId !== componente.id) return;

  if (componente.tipo !== 'rack' || !estadoRack || !analisis) {
    // Componentes sin telemetría directa.
    if (dom.detalleEstado) dom.detalleEstado.dataset.state = 'normal';
    if (dom.detalleEstadoTexto) dom.detalleEstadoTexto.textContent = 'OPERATIVO';
    return;
  }

  const estado = analisis.estado || 'normal';
  const desconectado = Boolean(estadoRack.desconectado);
  const estadoVisual = desconectado ? 'desconectado' : estado;
  const enMantenimiento = estado === 'mantenimiento';

  const textosEstado = {
    alarma: 'ALARMA',
    aviso: 'AVISO',
    mantenimiento: 'EN MANTENIMIENTO',
    normal: 'NORMAL',
    desconectado: 'SIN DATOS',
  };

  // Estado operativo.
  if (dom.detalleEstado) dom.detalleEstado.dataset.state = estadoVisual;
  if (dom.detalleEstadoTexto) {
    dom.detalleEstadoTexto.textContent = textosEstado[estadoVisual] || 'NORMAL';
  }

  // Botón de mantenimiento: refleja si el rack está pausado.
  establecerBotonMantenimiento(enMantenimiento);

  // Métricas con su etiqueta FÍSICO / SIMULADO / INVÁLIDA / SIN DATOS.
  const meta = estadoRack.meta || {};
  pintarMetricaRack('temp', estadoRack.temp, meta.temp, desconectado);
  pintarMetricaRack('ups', estadoRack.ups, meta.ups, desconectado);
  pintarMetricaRack('pdu', estadoRack.pdu, meta.pdu, desconectado);
  pintarMetricaRack('hum', estadoRack.hum, meta.hum, desconectado);
  pintarMetricaRack('agua', estadoRack.agua, meta.agua, desconectado);
  pintarMetricaRack('puerta', estadoRack.puerta, meta.puerta, desconectado);

  // Control aislado de laboratorio: refleja la última orden del rack.
  establecerComandoVentilador(estadoRack.comandoVentilador || 'OFF');

  // Health ring. En mantenimiento se muestra en ámbar y congelado.
  const health = analisis.health ?? 100;
  if (dom.detalleHealth) dom.detalleHealth.textContent = health;
  if (dom.detalleHealthRing) {
    dom.detalleHealthRing.style.setProperty('--score', health);
    dom.detalleHealthRing.style.setProperty(
      '--ring-color',
      enMantenimiento
        ? 'var(--warn)'
        : health >= 80
          ? 'var(--ok)'
          : health >= 55
            ? 'var(--warn)'
            : 'var(--danger)'
    );
  }

  // Vida útil y predicción.
  if (dom.detalleVida) {
    dom.detalleVida.textContent = `Vida útil estimada: ${analisis.diasVidaTexto}`;
  }
  if (dom.detallePrediccion) {
    dom.detallePrediccion.textContent = analisis.prediccionTexto;
  }

  // Análisis de IA externo del rack (topic datacenter/rack/<nn>/ia).
  pintarIA(dom.iaRack, ia);

  actualizarGrafica(estadoRack.historial || []);
}

// Gráfica histórica (Chart.js)

function asegurarGrafica() {
  if (grafica) return grafica;

  const canvas = $('grafica-temp');
  if (!canvas || !window.Chart) return null;

  const ctx = canvas.getContext('2d');

  grafica = new window.Chart(ctx, {
    type: 'line',
    data: {
      labels: [],
      datasets: [
        {
          label: 'Temperatura',
          data: [],
          borderColor: '#22d3ee',
          borderWidth: 1.6,
          backgroundColor: (contexto) => {
            const { chart } = contexto;
            const area = chart.chartArea;
            if (!area) return 'rgba(34, 211, 238, 0.12)';

            const gradiente = chart.ctx.createLinearGradient(0, area.top, 0, area.bottom);
            gradiente.addColorStop(0, 'rgba(34, 211, 238, 0.32)');
            gradiente.addColorStop(1, 'rgba(34, 211, 238, 0.02)');
            return gradiente;
          },
          fill: true,
          tension: 0.35,
          pointRadius: 0,
          pointHoverRadius: 3,
          pointHoverBackgroundColor: '#7df9ff',
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 320 },
      interaction: { intersect: false, mode: 'index' },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: 'rgba(4, 14, 23, 0.95)',
          borderColor: 'rgba(34, 211, 238, 0.5)',
          borderWidth: 1,
          titleColor: '#7df9ff',
          bodyColor: '#d8f6ff',
          titleFont: { size: 10 },
          bodyFont: { size: 11 },
          displayColors: false,
          callbacks: {
            label: (item) => `${Number(item.raw).toFixed(1)} °C`,
          },
        },
      },
      scales: {
        x: {
          grid: { display: false },
          border: { color: 'rgba(34, 211, 238, 0.18)' },
          ticks: {
            color: '#6f92a8',
            font: { size: 8 },
            maxTicksLimit: 5,
            maxRotation: 0,
          },
        },
        y: {
          grid: { color: 'rgba(34, 211, 238, 0.09)' },
          border: { display: false },
          ticks: {
            color: '#6f92a8',
            font: { size: 8 },
            maxTicksLimit: 5,
            callback: (valor) => `${valor}°`,
          },
        },
      },
    },
  });

  return grafica;
}

/**
 * Vuelca el histórico de temperatura en la gráfica.
 * @param {Array<{ t:number, valor:number }>} historial
 */
export function actualizarGrafica(historial) {
  const chart = asegurarGrafica();
  if (!chart) return;

  const puntos = (historial || []).slice(-40);

  chart.data.labels = puntos.map((punto) =>
    new Date(punto.t).toLocaleTimeString('es-ES', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    })
  );

  chart.data.datasets[0].data = puntos.map((punto) => Number(punto.valor.toFixed(1)));
  chart.update('none');

  if (dom.chartMax) {
    if (puntos.length === 0) {
      dom.chartMax.textContent = '—';
    } else {
      const maximo = Math.max(...puntos.map((punto) => punto.valor));
      dom.chartMax.textContent = `MÁX ${maximo.toFixed(1)}°`;
    }
  }
}

// Tooltip

/**
 * Muestra el tooltip junto al puntero.
 * @param {PointerEvent} evento
 * @param {object} componente
 * @param {{ temp?:number, estado?:string }} [estadoRack]
 */
export function mostrarTooltip(evento, componente, estadoRack) {
  if (!dom.tooltip || !evento) return;

  const titulo = componente.categoria || 'COMPONENTE';

  const temperatura =
    componente.tipo === 'rack' && Number.isFinite(estadoRack?.temp)
      ? ` · ${estadoRack.temp.toFixed(1)} °C`
      : '';
  const mantenimiento =
    estadoRack?.estado === 'mantenimiento' ? ' · EN MANTENIMIENTO' : '';

  dom.tooltip.innerHTML = '';

  const b = document.createElement('b');
  b.textContent = componente.nombre;

  const span = document.createElement('span');
  span.textContent = `${titulo}${temperatura}${mantenimiento} · ${
    componente.tipo === 'rack' ? 'clic para detalle' : 'sistema'
  }`;

  dom.tooltip.append(b, span);
  dom.tooltip.classList.add('visible');

  // Posicionamiento con límites para no salir de la ventana.
  const margen = 16;
  const ancho = dom.tooltip.offsetWidth || 200;
  const alto = dom.tooltip.offsetHeight || 60;

  let x = evento.clientX + margen;
  let y = evento.clientY + margen;

  if (x + ancho > window.innerWidth - 8) x = evento.clientX - ancho - margen;
  if (y + alto > window.innerHeight - 8) y = evento.clientY - alto - margen;

  dom.tooltip.style.transform = `translate(${Math.max(8, x)}px, ${Math.max(8, y)}px)`;
}

/** Oculta el tooltip. */
export function ocultarTooltip() {
  dom.tooltip?.classList.remove('visible');
}

// Estados globales de la interfaz

/**
 * Actualiza el indicador de MQTT.
 * @param {'online'|'connecting'|'offline'} estado
 * @param {string} [detalle]
 */
export function establecerEstadoMQTT(estado, detalle) {
  if (!dom.mqttDot) return;

  dom.mqttDot.classList.remove('online', 'connecting', 'offline');
  dom.mqttDot.classList.add(estado);

  if (dom.mqttText) {
    dom.mqttText.textContent =
      estado === 'online'
        ? 'MQTT ONLINE'
        : estado === 'connecting'
          ? 'CONECTANDO…'
          : 'MQTT OFFLINE';
  }

  dom.mqttDot.title = detalle || estado;
}

/** Indica de dónde vienen los datos mostrados. */
export function establecerFuente(texto) {
  if (dom.sourceBadge) dom.sourceBadge.textContent = texto;
}

/** Sincroniza el switch del simulador. */
export function establecerSimulador(activo) {
  if (dom.simToggle) dom.simToggle.checked = Boolean(activo);
  if (dom.simState) dom.simState.textContent = activo ? 'ACTIVO' : 'PAUSADO';
}

/** Sincroniza el switch de Telegram del HUD (silenciar / activar). */
export function establecerTelegram(activo) {
  const on = Boolean(activo);

  if (dom.tgToggle) dom.tgToggle.checked = on;
  if (dom.tgState) dom.tgState.textContent = on ? 'ON' : 'OFF';

  dom.tgToggle?.closest('.switch')?.classList.toggle('silenciado', !on);
}

/** Sincroniza el texto de los botones de puertas. */
export function establecerBotonPuertas(abiertas) {
  const texto = abiertas ? 'CERRAR PUERTAS' : 'ABRIR PUERTAS';

  if (dom.btnPuertas) dom.btnPuertas.textContent = texto;
  if (dom.btnPuertasPanel) dom.btnPuertasPanel.textContent = texto;
}

/* Alertas de Telegram con histéresis y cooldown por rack para evitar spam:
   30 °C crítica, rearme a 28.5 °C durante 15 s, 180 s entre críticas y 300 s
   entre preventivas. */

/* Umbrales y tiempos de las alertas. */
const ALERTA = {
  tempCritica: UMBRALES.tempAlarma, // 30 °C: dispara la alarma crítica
  tempRearme: 28.5, // por debajo de aquí se rearma la crítica
  rearmeEstableMs: 15000, // ... y debe mantenerse al menos 15 s
  cooldownCriticoMs: 180000, // 3 min entre críticas por rack
  cooldownPreventivoMs: 300000, // 5 min entre preventivas por rack
  anomaliasSeguidas: 3, // lecturas IA seguidas con anomalía
};

/** Estado de alertas por rack: rackId → { ... }. */
const estadoAlertas = new Map();

/** Devuelve (creando si hace falta) el estado de alertas de un rack. */
function obtenerEstadoAlertas(rackId) {
  let estado = estadoAlertas.get(rackId);

  if (!estado) {
    estado = {
      enAlarma: false, // ¿hay una crítica activa sin recuperar?
      ultimoCritico: 0, // ts del último mensaje crítico
      bajoUmbralDesde: null, // ts desde el que temp < umbral de rearme
      preventivoActivo: false, // latch: una preventiva por episodio
      ultimoPreventivo: 0, // ts de la última preventiva
      ultimoIaTs: 0, // ts del último análisis IA contabilizado
      anomaliasSeguidas: 0, // lecturas IA seguidas con anomalía
    };
    estadoAlertas.set(rackId, estado);
  }

  return estado;
}

/** ¿El análisis IA es reciente? (sin marca de tiempo se acepta como válido). */
function iaVigente(ia, ahora) {
  if (!ia) return false;
  if (!ia.timestamp) return true;
  return ahora - ia.timestamp <= IA_MAX_ANTIGUEDAD_MS;
}

/** Normaliza el nivel de riesgo que reporta la IA. */
function nivelRiesgoIA(valor) {
  if (valor === null || valor === undefined) return null;

  const t = String(valor).trim().toLowerCase();
  if (['preventivo', 'medio', 'moderado', 'warn', 'aviso'].includes(t)) return 'preventivo';
  if (['anomalia', 'anomalía', 'critico', 'crítico', 'alto', 'severo'].includes(t)) return 'alto';
  if (['optimo', 'óptimo', 'bajo', 'normal', 'low', 'ok'].includes(t)) return 'bajo';
  return null;
}

/**
 * Contabiliza las anomalías IA como "lecturas seguidas".
 * Solo cuenta análisis nuevos (por timestamp) para no inflar el contador con
 * las muchas evaluaciones que ocurren entre dos mensajes de IA.
 */
function registrarLecturaIA(estado, ia) {
  if (!ia || !ia.timestamp) return;
  if (ia.timestamp === estado.ultimoIaTs) return;

  estado.ultimoIaTs = ia.timestamp;
  estado.anomaliasSeguidas = ia.anomalia === true ? estado.anomaliasSeguidas + 1 : 0;
}

/** Línea con el Health Score IA (o guion si no hay dato). */
function lineaHealthIA(ia, ahora) {
  if (!iaVigente(ia, ahora) || !Number.isFinite(ia.health_score)) {
    return '<b>Health Score IA:</b> —';
  }
  return `<b>Health Score IA:</b> ${Math.round(ia.health_score)}/100`;
}

/** Construye el mensaje de ALARMA CRÍTICA (enriquecido con la IA si es reciente). */
function mensajeCritico(rackId, { temp, agua, lectura, ia, ahora }) {
  const hum = Number(lectura.hum ?? 0).toFixed(1);
  const puerta = Number(lectura.puerta ?? 0) === 1 ? 'ABIERTA' : 'CERRADA';

  const lineas = [
    '🚨 <b>ALARMA CRÍTICA · DATA CENTER</b>',
    '',
    `<b>Rack:</b> ${String(rackId).toUpperCase()}`,
    `<b>Temperatura:</b> ${temp.toFixed(1)} °C (límite ${ALERTA.tempCritica.toFixed(0)} °C)`,
    `<b>Humedad:</b> ${hum} %`,
    `<b>Inundación:</b> ${agua ? 'SÍ' : 'NO'}`,
    `<b>Puerta:</b> ${puerta}`,
  ];

  // IA reciente: enriquece con Health Score y recomendación (requisito 5).
  if (iaVigente(ia, ahora)) {
    lineas.push(lineaHealthIA(ia, ahora));
    if (ia.recomendacion) lineas.push(`<b>Recomendación IA:</b> ${ia.recomendacion}`);
  }

  lineas.push('', `<i>${new Date().toLocaleString('es-ES')}</i>`);
  return lineas.join('\n');
}

/** Construye el mensaje de RECUPERACIÓN. */
function mensajeRecuperado(rackId, { temp, ia, ahora }) {
  return [
    '🟢 <b>RECUPERADO · RACK ESTABILIZADO</b>',
    '',
    `<b>Rack:</b> ${String(rackId).toUpperCase()}`,
    `<b>Temperatura:</b> ${temp.toFixed(1)} °C (por debajo de ${ALERTA.tempRearme.toFixed(1)} °C)`,
    lineaHealthIA(ia, ahora),
    '',
    `<i>${new Date().toLocaleString('es-ES')}</i>`,
  ].join('\n');
}

/** Construye el mensaje de PREVENTIVA IA. */
function mensajePreventivo(rackId, { temp, ia, ahora, porAnomalias }) {
  const lineas = [
    '🟡 <b>PREVENTIVO IA · CHRONOS-2</b>',
    '',
    `<b>Rack:</b> ${String(rackId).toUpperCase()}`,
    `<b>Temperatura:</b> ${temp.toFixed(1)} °C`,
    lineaHealthIA(ia, ahora),
  ];

  if (iaVigente(ia, ahora)) {
    if (ia.pronostico && Number.isFinite(ia.pronostico.p50)) {
      lineas.push(`<b>Pronóstico P50:</b> ${ia.pronostico.p50.toFixed(1)} °C`);
    }
    if (Number.isFinite(ia.tendencia_c_min)) {
      const signo = ia.tendencia_c_min > 0 ? '+' : '';
      lineas.push(`<b>Tendencia:</b> ${signo}${ia.tendencia_c_min.toFixed(2)} °C/min`);
    }
    if (Number.isFinite(ia.eta_alarma_seg)) {
      lineas.push(`<b>ETA alarma (IA):</b> ${formatearEta(ia.eta_alarma_seg)}`);
    }
    if (ia.recomendacion) lineas.push(`<b>Recomendación:</b> ${ia.recomendacion}`);
  }

  if (porAnomalias) {
    lineas.push('<i>Motivo: 3 lecturas seguidas con anomalía detectada.</i>');
  }

  lineas.push('', `<i>${new Date().toLocaleString('es-ES')}</i>`);
  return lineas.join('\n');
}

/** Evalúa y, si procede, envía la alerta preventiva IA (cooldown 5 min). */
function evaluarPreventiva(estado, rackId, { temp, ia, ahora }) {
  const porEta =
    nivelRiesgoIA(ia?.riesgo) === 'preventivo' && Number.isFinite(ia?.eta_alarma_seg);
  const porAnomalias = estado.anomaliasSeguidas >= ALERTA.anomaliasSeguidas;

  const condicion = temp < ALERTA.tempCritica && (porEta || porAnomalias);

  if (!condicion) {
    estado.preventivoActivo = false; // rearma la preventiva al desaparecer
    return;
  }

  if (estado.preventivoActivo) return; // una por episodio
  if (ahora - estado.ultimoPreventivo < ALERTA.cooldownPreventivoMs) return;

  estado.preventivoActivo = true;
  estado.ultimoPreventivo = ahora;

  registrarEvento({
    tipo: TIPOS_EVENTO.PREVENTIVO_IA,
    rackId,
    variable: 'temp',
    valor: temp,
    mensaje: porAnomalias
      ? 'Preventivo IA · 3 lecturas seguidas con anomalía'
      : 'Preventivo IA · riesgo preventivo con ETA al alarma',
  });

  enviarAlertaTelegram(mensajePreventivo(rackId, { temp, ia, ahora, porAnomalias })).catch(
    (error) => console.warn('[Telegram] Error inesperado:', error)
  );
}

/**
 * Evalúa el estado de alertas de un rack (crítica, recuperación y preventiva).
 *
 * Reglas anti-spam:
 *   - Crítica en >= 30 °C o agua === 1; no se rearma hasta bajar de 28.5 °C
 *     durante 15 s ni se repite antes de 180 s.
 *   - Recuperación única al estabilizarse por debajo de 28.5 °C.
 *   - Preventiva IA como máximo una vez por episodio y cada 300 s.
 *   - En mantenimiento no se envía nada, pero se conserva el estado.
 *
 * @param {string} rackId
 * @param {{
 *   temp?:number, hum?:number, agua?:number, puerta?:number,
 *   enMantenimiento?:boolean
 * }} lectura
 * @param {object|null} [ia] análisis de IA del rack (topic `.../ia`)
 * @returns {boolean} true si se acaba de disparar una crítica
 */
export function evaluarAlertaCritica(rackId, lectura, ia = null) {
  if (!rackId || !lectura) return false;

  const temp = Number(lectura.temp);
  if (!Number.isFinite(temp)) return false;

  const ahora = Date.now();
  const estado = obtenerEstadoAlertas(rackId);

  // Cada análisis IA nuevo actualiza el contador de anomalías seguidas.
  registrarLecturaIA(estado, ia);

  // Mantenimiento: silencio total sin borrar el estado del latch.
  if (lectura.enMantenimiento) return false;

  const agua = Number(lectura.agua ?? 0) === 1;
  const critica = temp >= ALERTA.tempCritica || agua;

  if (critica) {
    // Estar en crítica rompe cualquier cuenta de estabilización previa.
    estado.bajoUmbralDesde = null;

    if (estado.enAlarma) return false; // ya avisado
    if (ahora - estado.ultimoCritico < ALERTA.cooldownCriticoMs) {
      // Cooldown activo: si sigue crítico, se disparará al expirar.
      return false;
    }

    estado.enAlarma = true;
    estado.ultimoCritico = ahora;

    registrarEvento({
      tipo: TIPOS_EVENTO.ALARMA,
      rackId,
      variable: 'temp',
      valor: temp,
      mensaje: `Alarma crítica: ${temp.toFixed(1)} °C${agua ? ' + inundación' : ''}`,
    });

    enviarAlertaTelegram(mensajeCritico(rackId, { temp, agua, lectura, ia, ahora })).catch(
      (error) => console.warn('[Telegram] Error inesperado:', error)
    );

    return true;
  }

  // No crítica
  // Recuperación estable de una alarma crítica previa.
  if (estado.enAlarma) {
    if (temp < ALERTA.tempRearme) {
      if (estado.bajoUmbralDesde === null) {
        estado.bajoUmbralDesde = ahora; // empieza la cuenta de estabilidad
      } else if (ahora - estado.bajoUmbralDesde >= ALERTA.rearmeEstableMs) {
        estado.enAlarma = false;
        estado.bajoUmbralDesde = null;

        registrarEvento({
          tipo: TIPOS_EVENTO.RECUPERADO,
          rackId,
          variable: 'temp',
          valor: temp,
          mensaje: `Recuperado: ${temp.toFixed(1)} °C (por debajo de ${ALERTA.tempRearme.toFixed(1)} °C)`,
        });

        enviarAlertaTelegram(mensajeRecuperado(rackId, { temp, ia, ahora })).catch((error) =>
          console.warn('[Telegram] Error inesperado:', error)
        );
      }
    } else {
      // Subió de 28.5 sin llegar a crítica: reinicia la cuenta de estabilidad.
      estado.bajoUmbralDesde = null;
    }
  }

  // Preventiva IA (solo cuando no hay una crítica activa).
  if (!estado.enAlarma) {
    evaluarPreventiva(estado, rackId, { temp, ia, ahora });
  }

  return false;
}

/** Limpia el estado de alertas (útil para pruebas desde consola). */
export function reiniciarAlertasTelegram() {
  estadoAlertas.clear();
}

/** Sincroniza el estado visual del botón de mantenimiento. */
export function establecerBotonMantenimiento(activo) {
  if (!dom.btnMantenimiento) return;

  dom.btnMantenimiento.classList.toggle('active', Boolean(activo));
  dom.btnMantenimiento.setAttribute('aria-pressed', String(Boolean(activo)));
}

/**
 * Habilita o deshabilita el switch del simulador.
 * Se usa cuando `USAR_SIMULADOR` vale false para esperar solo al ESP32.
 *
 * @param {boolean} disponible
 */
export function configurarSimuladorDisponible(disponible) {
  const activo = Boolean(disponible);

  if (dom.simToggle) {
    dom.simToggle.disabled = !activo;
    dom.simToggle.checked = activo;
    dom.simToggle.closest('.switch')?.classList.toggle('disabled', !activo);
  }

  if (dom.simState) dom.simState.textContent = activo ? 'ACTIVO' : 'OFF';
}

// Pantalla de carga

/**
 * @param {number} porcentaje 0-100
 * @param {string} [mensaje]
 */
export function actualizarLoader(porcentaje, mensaje) {
  const pct = Math.min(100, Math.max(0, Math.round(porcentaje)));

  if (dom.loaderBar) dom.loaderBar.style.width = `${pct}%`;
  if (dom.loaderPct) dom.loaderPct.textContent = `${pct}%`;
  if (mensaje && dom.loaderMsg) dom.loaderMsg.textContent = mensaje;
}

/** Oculta la pantalla de carga. */
export function ocultarLoader() {
  actualizarLoader(100, 'Gemelo digital listo');
  dom.loader?.classList.add('hidden');
}

/** Muestra un error en la pantalla de carga. */
export function mostrarErrorLoader(mensaje) {
  if (dom.loaderMsg) {
    dom.loaderMsg.textContent = mensaje;
    dom.loaderMsg.classList.add('error');
  }
  if (dom.loaderBar) {
    dom.loaderBar.style.background = 'linear-gradient(90deg, #8a0a1e, var(--danger))';
  }
}
