// Configuración del broker guardada en localStorage (URL y credenciales).

const CLAVE = 'nexus.mqtt.config.v1';
const URL_POR_DEFECTO = 'ws://127.0.0.1:9001';

const DEFAULTS = Object.freeze({
  url: URL_POR_DEFECTO,
  username: '',
  password: '',
});

/** Devuelve la configuración actual (con valores por defecto). */
export function obtenerConfigMQTT() {
  try {
    const bruto = localStorage.getItem(CLAVE);
    if (!bruto) return { ...DEFAULTS };

    const datos = JSON.parse(bruto);
    return {
      url: typeof datos?.url === 'string' && datos.url.trim() ? datos.url.trim() : DEFAULTS.url,
      username: typeof datos?.username === 'string' ? datos.username : '',
      password: typeof datos?.password === 'string' ? datos.password : '',
    };
  } catch {
    return { ...DEFAULTS };
  }
}

/**
 * Guarda la configuración. Solo se persisten los campos indicados.
 * @param {{ url?: string, username?: string, password?: string }} config
 */
export function guardarConfigMQTT(config = {}) {
  const actual = obtenerConfigMQTT();

  const siguiente = {
    url: typeof config.url === 'string' && config.url.trim() ? config.url.trim() : actual.url,
    username: typeof config.username === 'string' ? config.username.trim() : actual.username,
    password: typeof config.password === 'string' ? config.password : actual.password,
  };

  try {
    localStorage.setItem(CLAVE, JSON.stringify(siguiente));
  } catch (error) {
    console.warn('[MQTT-Config] No se pudo guardar la configuración:', error);
  }

  return siguiente;
}

/** Borra usuario y contraseña (deja la URL). */
export function limpiarCredencialesMQTT() {
  const actual = obtenerConfigMQTT();
  return guardarConfigMQTT({ url: actual.url, username: '', password: '' });
}

/** ¿Hay credenciales configuradas? */
export function hayCredencialesMQTT() {
  const config = obtenerConfigMQTT();
  return Boolean(config.username);
}

export { URL_POR_DEFECTO };
