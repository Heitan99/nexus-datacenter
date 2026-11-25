// Health Score, vida útil estimada y predicción de temperatura.

// Umbrales de operación (grados Celsius, vatios y porcentaje de UPS)

export const UMBRALES = {
  tempOptima: 24, // por debajo de aquí no penaliza
  tempAviso: 28, // a partir de aquí el rack entra en aviso
  tempAlarma: 30, // temperatura de ALARMA CRÍTICA (dispara Telegram)
  tempCritica: 38, // zona de riesgo de apagado térmico
  upsAviso: 40, // UPS por debajo del 40 % → aviso
  upsAlarma: 20, // UPS por debajo del 20 % → alarma
  pduNominal: 2500, // consumo "normal" de un rack en vatios
  pduMaximo: 4000, // consumo máximo admisible
  humedadMin: 30, // humedad relativa mínima recomendada
  humedadMax: 70, // humedad relativa máxima recomendada
  aguaAlarma: 1, // sensor de inundación activo
};

// Utilidades internas

/** Limita un número a un rango. */
function limitar(valor, min, max) {
  return Math.min(max, Math.max(min, valor));
}

/** Devuelve un número seguro (evita NaN cuando llegan datos incompletos). */
function numero(valor, porDefecto = 0) {
  const n = Number(valor);
  return Number.isFinite(n) ? n : porDefecto;
}

// Health Score

/**
 * Calcula el Health Score de un rack (0 = crítico, 100 = perfecto).
 *
 * Penalizaciones:
 *   - Temperatura por encima de la óptima (peso alto, es el factor crítico).
 *   - UPS por debajo del 100 % (peso medio).
 *   - Consumo PDU por encima del nominal (peso bajo).
 *   - Humedad fuera de rango, inundación y puerta abierta (sensores ESP32).
 *
 * @param {{
 *   temp?: number, ups?: number, pdu?: number,
 *   hum?: number, agua?: number, puerta?: number
 * }} lectura
 * @returns {number} puntuación entera entre 0 y 100
 */
export function calcularHealthScore(lectura = {}) {
  const temp = numero(lectura.temp, UMBRALES.tempOptima);
  const ups = numero(lectura.ups, 100);
  const pdu = numero(lectura.pdu, UMBRALES.pduNominal);
  const hum = numero(lectura.hum, 45);
  const agua = numero(lectura.agua, 0);
  const puerta = numero(lectura.puerta, 0);

  // 1) Penalización térmica: 3,5 puntos por grado por encima de 24 °C.
  const excesoTemp = Math.max(0, temp - UMBRALES.tempOptima);
  let penalizacionTemp = excesoTemp * 3.5;

  // Por encima de la temperatura crítica la penalización se acelera.
  if (temp > UMBRALES.tempCritica) {
    penalizacionTemp += (temp - UMBRALES.tempCritica) * 4;
  }
  penalizacionTemp = limitar(penalizacionTemp, 0, 65);

  // 2) Penalización eléctrica: 0,9 puntos por cada punto de UPS perdido.
  const penalizacionUps = limitar((100 - ups) * 0.9, 0, 30);

  // 3) Penalización de consumo: 1 punto por cada 100 W por encima del nominal.
  const excesoPdu = Math.max(0, pdu - UMBRALES.pduNominal);
  const penalizacionPdu = limitar(excesoPdu / 100, 0, 15);

  // 4) Humedad fuera del rango recomendado.
  let penalizacionHum = 0;
  if (hum > UMBRALES.humedadMax) penalizacionHum = (hum - UMBRALES.humedadMax) * 0.5;
  if (hum < UMBRALES.humedadMin) penalizacionHum = (UMBRALES.humedadMin - hum) * 0.5;
  penalizacionHum = limitar(penalizacionHum, 0, 10);

  // 5) Inundación y puerta abierta.
  const penalizacionAgua = agua >= UMBRALES.aguaAlarma ? 35 : 0;
  const penalizacionPuerta = puerta === 1 ? 5 : 0;

  const score =
    100 -
    penalizacionTemp -
    penalizacionUps -
    penalizacionPdu -
    penalizacionHum -
    penalizacionAgua -
    penalizacionPuerta;

  return Math.round(limitar(score, 0, 100));
}

/**
 * Etiqueta cualitativa del Health Score.
 * @param {number} score
 */
export function describirHealthScore(score) {
  if (score >= 90) return 'Sistema saludable';
  if (score >= 75) return 'Funcionamiento estable';
  if (score >= 60) return 'Requiere atención';
  if (score >= 40) return 'Degradación detectada';
  return 'Riesgo alto de fallo';
}

// Vida útil estimada

/**
 * Estima los días de vida útil restantes a partir del Health Score.
 * Se usa una curva cúbica: pequeñas pérdidas de salud apenas afectan,
 * pero por debajo del 50 % la vida restante cae en picado.
 *
 * @param {number} health 0-100
 * @returns {number} días estimados
 */
export function estimarDiasVidaUtil(health) {
  const normalizado = limitar(numero(health, 100), 0, 100) / 100;
  const dias = 3650 * Math.pow(normalizado, 3); // 10 años con salud perfecta
  return Math.max(0, Math.round(dias));
}

/**
 * Formatea los días restantes en un texto legible.
 * @param {number} dias
 */
export function formatearDiasVida(dias) {
  if (!Number.isFinite(dias) || dias <= 0) return 'sin vida útil estimada';

  if (dias >= 365) {
    const anos = dias / 365;
    return `${dias} días (~${anos.toFixed(1)} años)`;
  }

  if (dias >= 30) return `${dias} días (~${Math.round(dias / 30)} meses)`;

  return `${dias} días`;
}

// Predicción temporal (regresión lineal)

/**
 * Ajusta una recta por mínimos cuadrados sobre los puntos del histórico
 * y estima cuántos minutos faltan para alcanzar `umbral`.
 *
 * @param {Array<{ t: number, valor: number }>} historial
 *        `t` en milisegundos (Date.now()) y `valor` la temperatura.
 * @param {number} umbral temperatura objetivo (°C)
 * @returns {number|null} minutos hasta el umbral, o null si no hay tendencia
 */
export function predecirMinutosHastaUmbral(historial, umbral = UMBRALES.tempAlarma) {
  if (!Array.isArray(historial) || historial.length < 3) return null;

  // Usamos como máximo los últimos 20 puntos para que la predicción reaccione.
  const puntos = historial.slice(-20);
  const t0 = puntos[0].t;

  // Regresión lineal: valor = a + b * minutos
  let sumaX = 0;
  let sumaY = 0;
  let sumaXY = 0;
  let sumaXX = 0;

  for (const punto of puntos) {
    const x = (punto.t - t0) / 60000; // minutos desde el primer punto
    const y = numero(punto.valor, 0);

    sumaX += x;
    sumaY += y;
    sumaXY += x * y;
    sumaXX += x * x;
  }

  const n = puntos.length;
  const denominador = n * sumaXX - sumaX * sumaX;

  // Sin dispersión temporal suficiente no hay recta fiable.
  if (Math.abs(denominador) < 1e-6) return null;

  const pendiente = (n * sumaXY - sumaX * sumaY) / denominador; // °C por minuto
  const intercepto = (sumaY - pendiente * sumaX) / n;

  const ultimoPunto = puntos[puntos.length - 1];
  const ultimoValor = numero(ultimoPunto.valor, 0);

  // Si ya se superó el umbral no hay nada que predecir.
  if (ultimoValor >= umbral) return 0;

  const xUltimo = (ultimoPunto.t - t0) / 60000;
  const valorEstimado = intercepto + pendiente * xUltimo;

  // Solo predecimos subidas de temperatura.
  if (pendiente <= 0.002) return null;

  const minutos = (umbral - valorEstimado) / pendiente;

  if (!Number.isFinite(minutos) || minutos <= 0) return null;

  return Math.round(minutos);
}

/**
 * Describe la tendencia térmica del histórico.
 * @param {Array<{ t: number, valor: number }>} historial
 * @returns {'subiendo'|'bajando'|'estable'|'sin-datos'}
 */
export function calcularTendencia(historial) {
  if (!Array.isArray(historial) || historial.length < 3) return 'sin-datos';

  const muestra = historial.slice(-8);
  const primero = numero(muestra[0].valor, 0);
  const ultimo = numero(muestra[muestra.length - 1].valor, 0);
  const diferencia = ultimo - primero;

  if (diferencia > 0.6) return 'subiendo';
  if (diferencia < -0.6) return 'bajando';
  return 'estable';
}

// Clasificación de estado

/**
 * Indica si la lectura supera el umbral de ALARMA CRÍTICA por temperatura.
 * Es el único criterio que dispara la alerta real de Telegram.
 *
 * @param {{ temp?: number }} lectura
 * @returns {boolean}
 */
export function esAlarmaCritica(lectura = {}) {
  const temp = numero(lectura.temp, 0);
  return temp > UMBRALES.tempAlarma;
}

/**
 * Clasifica el estado operativo de un rack.
 *
 * El mantenimiento tiene prioridad absoluta: mientras esté activo no se
 * devuelve 'alarma' ni 'aviso', de modo que el rack no se pinta en rojo y
 * no se disparan alertas.
 *
 * @param {{
 *   temp?: number, ups?: number, pdu?: number,
 *   hum?: number, agua?: number, puerta?: number,
 *   enMantenimiento?: boolean
 * }} lectura
 * @returns {'normal'|'aviso'|'alarma'|'mantenimiento'}
 */
export function clasificarEstado(lectura = {}) {
  if (lectura.enMantenimiento) return 'mantenimiento';

  const temp = numero(lectura.temp, 0);
  const ups = numero(lectura.ups, 100);
  const pdu = numero(lectura.pdu, 0);
  const hum = numero(lectura.hum, 45);
  const agua = numero(lectura.agua, 0);
  const puerta = numero(lectura.puerta, 0);

  if (
    esAlarmaCritica(lectura) ||
    ups <= UMBRALES.upsAlarma ||
    pdu >= UMBRALES.pduMaximo ||
    agua >= UMBRALES.aguaAlarma
  ) {
    return 'alarma';
  }

  if (
    temp >= UMBRALES.tempAviso ||
    ups <= UMBRALES.upsAviso ||
    pdu >= UMBRALES.pduNominal * 1.35 ||
    hum < UMBRALES.humedadMin ||
    hum > UMBRALES.humedadMax ||
    puerta === 1
  ) {
    return 'aviso';
  }

  return 'normal';
}

// Análisis completo de un rack

/**
 * Agrupa todas las predicciones en un objeto listo para pintar en la UI.
 *
 * Si el rack está en mantenimiento se reutiliza el Health Score congelado
 * (`healthCongelado`) para que la puntuación deje de bajar.
 *
 * @param {{
 *   temp:number, ups:number, pdu:number,
 *   hum?:number, agua?:number, puerta?:number,
 *   enMantenimiento?:boolean, healthCongelado?:number,
 *   historial?: Array
 * }} lectura
 * @returns {{
 *   health: number,
 *   healthTexto: string,
 *   diasVida: number,
 *   diasVidaTexto: string,
 *   estado: 'normal'|'aviso'|'alarma'|'mantenimiento',
 *   enMantenimiento: boolean,
 *   tendencia: string,
 *   minutosHastaAlarma: number|null,
 *   prediccionTexto: string
 * }}
 */
export function analizarRack(lectura = {}) {
  const enMantenimiento = Boolean(lectura.enMantenimiento);

  // Salud congelada durante el mantenimiento; si no hay valor previo,
  // se calcula una única vez con la telemetría actual.
  const saludCongelada = Number(lectura.healthCongelado);
  const tieneSaludCongelada =
    lectura.healthCongelado !== null &&
    lectura.healthCongelado !== undefined &&
    Number.isFinite(saludCongelada);

  const health = enMantenimiento && tieneSaludCongelada
    ? Math.round(limitar(saludCongelada, 0, 100))
    : calcularHealthScore(lectura);

  const diasVida = estimarDiasVidaUtil(health);
  const estado = clasificarEstado(lectura);
  const historial = lectura.historial || [];
  const tendencia = calcularTendencia(historial);
  const minutosHastaAlarma = predecirMinutosHastaUmbral(historial, UMBRALES.tempAlarma);

  let prediccionTexto = 'Tendencia estable';

  if (enMantenimiento) {
    prediccionTexto = 'Health Score pausado · mantenimiento activo';
  } else if (minutosHastaAlarma === 0) {
    prediccionTexto = `Umbral de ${UMBRALES.tempAlarma} °C superado`;
  } else if (minutosHastaAlarma !== null) {
    if (minutosHastaAlarma < 60) {
      prediccionTexto = `Alcanzará ${UMBRALES.tempAlarma} °C en ~${minutosHastaAlarma} min`;
    } else {
      const horas = (minutosHastaAlarma / 60).toFixed(1);
      prediccionTexto = `Alcanzará ${UMBRALES.tempAlarma} °C en ~${horas} h`;
    }
  } else if (tendencia === 'bajando') {
    prediccionTexto = 'Temperatura en descenso';
  } else if (tendencia === 'subiendo') {
    prediccionTexto = 'Temperatura al alza (sin riesgo inmediato)';
  }

  return {
    health,
    healthTexto: describirHealthScore(health),
    diasVida,
    diasVidaTexto: formatearDiasVida(diasVida),
    estado,
    enMantenimiento,
    tendencia,
    minutosHastaAlarma,
    prediccionTexto,
  };
}

// Agregado global (para el panel principal)

/**
 * Calcula el Health Score global a partir de todos los racks.
 * Se usa la media ponderada: el rack más crítico pesa más que la media simple,
 * de modo que un solo rack en mal estado baja la puntuación del sistema.
 *
 * Los racks en mantenimiento se excluyen del estado global: su salud está
 * congelada y no deben marcar alarma en el panel principal.
 *
 * @param {Array<{
 *   temp:number, ups:number, pdu:number,
 *   enMantenimiento?:boolean, healthCongelado?:number
 * }>} racks
 */
export function analizarSistema(racks = []) {
  if (!Array.isArray(racks) || racks.length === 0) {
    return {
      health: 100,
      estado: 'normal',
      temp: 0,
      ups: 100,
      pdu: 0,
      enMantenimiento: 0,
    };
  }

  const activos = racks.filter((rack) => !rack.enMantenimiento);
  const baseMetricas = activos.length ? activos : racks;

  // La salud incluye los racks en mantenimiento con su valor congelado,
  // pero el estado de alarma solo mira los racks activos.
  const analisisSalud = racks.map((rack) => analizarRack(rack));
  const analisisEstado = activos.map((rack) => analizarRack(rack));

  const media =
    analisisSalud.reduce((total, item) => total + item.health, 0) / analisisSalud.length;
  const peor = Math.min(...analisisSalud.map((item) => item.health));

  // 70 % media + 30 % peor caso.
  const health = Math.round(media * 0.7 + peor * 0.3);

  const estados = analisisEstado.map((item) => item.estado);
  const estado = estados.includes('alarma')
    ? 'alarma'
    : estados.includes('aviso')
      ? 'aviso'
      : 'normal';

  return {
    health,
    estado,
    temp: Math.max(...baseMetricas.map((rack) => numero(rack.temp, 0))),
    ups: Math.min(...baseMetricas.map((rack) => numero(rack.ups, 100))),
    pdu: baseMetricas.reduce((total, rack) => total + numero(rack.pdu, 0), 0),
    enMantenimiento: racks.length - activos.length,
  };
}
