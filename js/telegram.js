// Alertas por Telegram. Las credenciales se guardan en localStorage.

const CLAVE = 'nexus.telegram.config.v1';

const DEFAULTS = Object.freeze({
  token: '',
  chatId: '',
  habilitado: true,
});

/** Configuración activa en memoria (sincronizada con localStorage). */
const config = { ...DEFAULTS };

/** Comprueba que un valor no sea el placeholder de la plantilla. */
function valorReal(valor, placeholder) {
  return Boolean(valor) && valor !== placeholder && !valor.includes('AQUI');
}

/** Normaliza un token de bot: formato "<digitos>:<clave>". */
function tokenValido(token) {
  return /^\d+:[A-Za-z0-9_-]{20,}$/.test(String(token || '').trim());
}

// Persistencia local (localStorage)

/** Lee la configuración guardada en este navegador (con valores por defecto). */
export function obtenerConfigTelegram() {
  try {
    const bruto = localStorage.getItem(CLAVE);
    if (!bruto) return { ...DEFAULTS };

    const datos = JSON.parse(bruto);
    return {
      token: typeof datos?.token === 'string' ? datos.token.trim() : '',
      chatId: typeof datos?.chatId === 'string' ? String(datos.chatId).trim() : '',
      habilitado: typeof datos?.habilitado === 'boolean' ? datos.habilitado : DEFAULTS.habilitado,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

/**
 * Guarda la configuración de Telegram en este navegador.
 * @param {{ token?: string, chatId?: string, habilitado?: boolean }} cambios
 */
export function guardarConfigTelegram(cambios = {}) {
  const actual = obtenerConfigTelegram();

  const siguiente = {
    token: typeof cambios.token === 'string' ? cambios.token.trim() : actual.token,
    chatId: typeof cambios.chatId === 'string' ? String(cambios.chatId).trim() : actual.chatId,
    habilitado:
      typeof cambios.habilitado === 'boolean' ? cambios.habilitado : actual.habilitado,
  };

  try {
    localStorage.setItem(CLAVE, JSON.stringify(siguiente));
  } catch (error) {
    console.warn('[Telegram] No se pudo guardar la configuración:', error);
  }

  config.token = siguiente.token;
  config.chatId = siguiente.chatId;
  config.habilitado = siguiente.habilitado;

  return { ...siguiente };
}

/** Borra el token y el chat_id (mantiene el interruptor general). */
export function limpiarConfigTelegram() {
  return guardarConfigTelegram({ token: '', chatId: '' });
}

// API pública de configuración

/**
 * Atajo compatible: actualiza la configuración activa.
 * @param {{ token?: string, chatId?: string, habilitado?: boolean }} opciones
 */
export function configurarTelegram(opciones = {}) {
  guardarConfigTelegram(opciones);
  return obtenerConfiguracionTelegram();
}

/**
 * Indica si el bot está listo para enviar mensajes reales.
 * @returns {boolean}
 */
export function telegramConfigurado() {
  return (
    config.habilitado &&
    tokenValido(config.token) &&
    valorReal(config.chatId, 'TU_CHAT_ID_AQUI')
  );
}

/** Devuelve la configuración actual sin exponer el token completo. */
export function obtenerConfiguracionTelegram() {
  return {
    chatId: config.chatId,
    habilitado: config.habilitado,
    tieneToken: Boolean(config.token),
    tieneChatId: Boolean(config.chatId),
    configurado: telegramConfigurado(),
  };
}

// Envío de alertas

/**
 * Envía un mensaje al chat configurado mediante la Bot API de Telegram.
 *
 * La función NO aplica cooldown: la protección contra spam se controla en
 * `ui.js` (una sola alerta por rack hasta que vuelva a la normalidad).
 *
 * @param {string} mensaje Texto de la alerta (admite HTML básico de Telegram).
 * @returns {Promise<{ ok: boolean, motivo?: string, simulada?: boolean }>}
 */
export async function enviarAlertaTelegram(mensaje) {
  const texto = String(mensaje || '').trim();

  if (!texto) {
    return { ok: false, motivo: 'mensaje-vacio' };
  }

  // Silenciado desde el HUD: no se envía nada ni se registra como error.
  if (!config.habilitado) {
    console.info('[Telegram] Alertas silenciadas desde el HUD:', texto);
    return { ok: false, motivo: 'silenciado' };
  }

  // Sin credenciales reales, dejamos la alerta en consola para no romper la demo.
  if (!telegramConfigurado()) {
    console.info(
      '[Telegram] Alerta simulada (configura el token y el chat_id en ALERTAS TELEGRAM):',
      texto
    );
    return { ok: false, motivo: 'no-configurado', simulada: true };
  }

  const url = `https://api.telegram.org/bot${config.token}/sendMessage`;

  try {
    const respuesta = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: config.chatId,
        text: texto,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      }),
    });

    const datos = await respuesta.json().catch(() => null);

    if (!respuesta.ok || !datos?.ok) {
      console.warn('[Telegram] La API rechazó el mensaje:', datos);
      return { ok: false, motivo: datos?.description || `http-${respuesta.status}` };
    }

    console.info('[Telegram] Alerta enviada correctamente.');
    return { ok: true };
  } catch (error) {
    console.warn('[Telegram] Error de red:', error);
    return { ok: false, motivo: 'error-red' };
  }
}

/**
 * Construye y envía una alerta de temperatura para un rack.
 * Se mantiene como utilidad para pruebas manuales desde consola.
 *
 * @param {{
 *   rackId: string,
 *   temp: number,
 *   ups?: number,
 *   pdu?: number,
 *   hum?: number,
 *   agua?: number,
 *   puerta?: number
 * }} datos
 */
export function alertarTemperaturaRack(datos = {}) {
  const rack = String(datos.rackId || 'rack').toUpperCase();
  const temp = Number(datos.temp ?? 0).toFixed(1);
  const ups = Number(datos.ups ?? 0).toFixed(0);
  const pdu = Math.round(Number(datos.pdu ?? 0));
  const hum = Number(datos.hum ?? 0).toFixed(1);
  const agua = Number(datos.agua ?? 0) === 1 ? 'SÍ' : 'NO';
  const puerta = Number(datos.puerta ?? 0) === 1 ? 'ABIERTA' : 'CERRADA';

  const mensaje = [
    '🚨 <b>ALARMA CRÍTICA · DATA CENTER</b>',
    '',
    `<b>Rack:</b> ${rack}`,
    `<b>Temperatura:</b> ${temp} °C`,
    `<b>UPS:</b> ${ups} %`,
    `<b>PDU:</b> ${pdu} W`,
    `<b>Humedad:</b> ${hum} %`,
    `<b>Inundación:</b> ${agua}`,
    `<b>Puerta:</b> ${puerta}`,
    '',
    `<i>${new Date().toLocaleString('es-ES')}</i>`,
  ].join('\n');

  return enviarAlertaTelegram(mensaje);
}

/* Carga la configuración persistida al importar el módulo. */
Object.assign(config, obtenerConfigTelegram());
