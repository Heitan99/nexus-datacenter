// Carga del GLB, detección de componentes, puertas y animaciones.

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { ajustarCamaraInicial, crearSuelo } from './scene.js';

// Configuración

const RUTAS_MODELO = [
  'assets/datacenter.glb',
  'datacenter.glb',
  'DATACENTER.glb',
];

const TAMANO_OBJETIVO = 14;

/* Componentes semánticos detectados por nombre de nodo. */
const DEFINICIONES_COMPONENTES = [
  {
    id: 'cdu',
    nombre: 'CDU',
    categoria: 'Refrigeración',
    descripcion: 'Unidad de distribución de refrigeración XDU450.',
    test: /XDU450/i,
  },
  {
    id: 'busway',
    nombre: 'BUSWAY',
    categoria: 'Energía',
    descripcion: 'Sistema de busway y barras de distribución eléctrica.',
    test: /busway|busbar/i,
  },
  {
    id: 'refrigeracion',
    nombre: 'REFRIGERACIÓN',
    categoria: 'Refrigeración líquida',
    descripcion: 'Colectores, mangueras y bandejas de agua del circuito de refrigeración.',
    test: /MANIFOLD|HOSE|WATER_TRAY|RACK_MANI/i,
  },
  {
    id: 'monitorizacion',
    nombre: 'MONITORIZACIÓN',
    categoria: 'Control',
    descripcion: 'Switch PoE de 24 puertos y controlador RDU501.',
    test: /POESwitch|RDU501/i,
  },
];

/* Nombres del GLB que pertenecen a un rack (el resto son sistemas de la fila). */
const INCLUIR_EN_RACK =
  /^(VR|VRGR|rPDU|DCD35|DCD47|BRIAGE_FRAME|Plane_\d+_DCD_door_screen|Plane_DCD_door_screen)/i;

/* Colores del gradiente térmico y del modo mantenimiento. */
const COLOR_FRIO = new THREE.Color(0x1e6fa8); // azul
const COLOR_CALIENTE = new THREE.Color(0xff3b30); // rojo
const COLOR_MANTENIMIENTO = new THREE.Color(0xffb020); // ámbar

// Estado interno del módulo

let escenaActual;
let camaraActual;
let rendererActual;

let raizModelo = null;
let meshes = [];
let componentes = [];
const componentesPorId = new Map();
const racks = [];

let mixer = null;
let clipPuertas = null;
let accionPuertas = null;
let puertasAbiertas = false;

let raycaster = null;
let hoverId = null;
let seleccionId = null;
let outlineHover = null;
let outlineSeleccion = null;

let alHover = null;
let alSeleccionar = null;

// Carga principal

/**
 * @param {{
 *   escena: THREE.Scene,
 *   camara: THREE.PerspectiveCamera,
 *   renderer: THREE.WebGLRenderer,
 *   controles: object,
 *   alProgreso?: (evento: ProgressEvent, ruta: string) => void,
 *   onHover?: (componente: object|null, evento: PointerEvent) => void,
 *   onSeleccionar?: (componente: object|null) => void
 * }} opciones
 */
export async function cargarModelo(opciones) {
  escenaActual = opciones.escena;
  camaraActual = opciones.camara;
  rendererActual = opciones.renderer;
  alHover = opciones.onHover || null;
  alSeleccionar = opciones.onSeleccionar || null;

  const gltf = await cargarConFallback(opciones.alProgreso);
  const modelo = gltf.scene;
  modelo.name = 'DataCenter';
  raizModelo = modelo;

  /* 1) Normalizar escala: la dimensión mayor medirá TAMANO_OBJETIVO. */
  const cajaInicial = new THREE.Box3().setFromObject(modelo);
  const tamanoInicial = cajaInicial.getSize(new THREE.Vector3());
  const dimensionMayor = Math.max(tamanoInicial.x, tamanoInicial.y, tamanoInicial.z) || 1;
  const factorEscala = TAMANO_OBJETIVO / dimensionMayor;

  modelo.scale.setScalar(factorEscala);
  modelo.updateMatrixWorld(true);

  /* 2) Centrar en X/Z y apoyar sobre el suelo (y = 0). */
  const cajaEscalada = new THREE.Box3().setFromObject(modelo);
  const centro = cajaEscalada.getCenter(new THREE.Vector3());

  modelo.position.x -= centro.x;
  modelo.position.z -= centro.z;
  modelo.position.y -= cajaEscalada.min.y;

  escenaActual.add(modelo);
  modelo.updateMatrixWorld(true);

  const cajaFinal = new THREE.Box3().setFromObject(modelo);

  /* 3) Suelo, cámara y componentes. */
  crearSuelo(cajaFinal);
  ajustarCamaraInicial(cajaFinal);
  construirComponentes(modelo, cajaFinal);

  /* 4) Materiales independientes por rack. */
  for (const rack of racks) prepararMaterialesRack(rack);

  /* 4b) Relleno procedural (servidores, LEDs, cables y ventiladores). */
  construirInternosProcedurales();

  /* 5) Animación de puertas. */
  configurarAnimaciones(gltf);

  /* 6) Raycaster y helpers de selección. */
  configurarRaycaster();

  return {
    componentes,
    raiz: modelo,
    caja: cajaFinal,
    tieneAnimacionPuertas: !!accionPuertas,
  };
}

/* Carga con varias rutas candidatas por si el archivo cambia de sitio. */
async function cargarConFallback(alProgreso) {
  let ultimoError = null;

  for (const ruta of RUTAS_MODELO) {
    try {
      return await cargarGLTF(ruta, alProgreso);
    } catch (error) {
      ultimoError = error;
      console.warn(`[Modelo] No se pudo cargar "${ruta}". Probando siguiente…`, error);
    }
  }

  throw ultimoError || new Error('No se encontró el modelo GLB.');
}

function cargarGLTF(ruta, alProgreso) {
  return new Promise((resolve, reject) => {
    const loader = new GLTFLoader();

    loader.load(
      ruta,
      resolve,
      (evento) => {
        if (alProgreso) alProgreso(evento, ruta);
      },
      reject
    );
  });
}

// Construcción de componentes

function construirComponentes(modelo, cajaModelo) {
  componentes = [];
  componentesPorId.clear();
  racks.length = 0;
  meshes = [];

  modelo.traverse((objeto) => {
    if (objeto.isMesh) meshes.push(objeto);
  });

  const asignados = new Set();

  /* 1) Componentes semánticos (CDU, busway, refrigeración, monitorización). */
  for (const definicion of DEFINICIONES_COMPONENTES) {
    const objetos = meshes.filter(
      (mesh) => !asignados.has(mesh) && definicion.test.test(mesh.name)
    );

    if (objetos.length === 0) continue;

    objetos.forEach((mesh) => asignados.add(mesh));

    const caja = cajaDeObjetos(objetos);
    if (caja.isEmpty()) continue;

    const componente = crearComponente({
      id: definicion.id,
      nombre: definicion.nombre,
      categoria: definicion.categoria,
      descripcion: definicion.descripcion,
      tipo: 'componente',
      objetos,
      caja,
    });

    componentes.push(componente);
  }

  /* 2) Racks: usamos las 4 puertas frontales como anclas espaciales. */
  const puertas = buscarPuertasFrontales(modelo);
  const centrosPuerta = puertas.map((puerta) =>
    cajaDeObjetos(obtenerMeshes(puerta)).getCenter(new THREE.Vector3())
  );

  // Ordenar de izquierda a derecha (eje X).
  const indicesPuertas = centrosPuerta
    .map((centro, indice) => ({ x: centro.x, indice }))
    .sort((a, b) => a.x - b.x)
    .map((item) => item.indice);

  const puertasOrdenadas = indicesPuertas.map((i) => puertas[i]);
  const centrosX = indicesPuertas.map((i) => centrosPuerta[i].x);

  const cajasPuerta = puertasOrdenadas.map((puerta) =>
    cajaDeObjetos(obtenerMeshes(puerta))
  );

  // Si no se detectan 4 puertas, dividimos el modelo en 4 zonas iguales.
  const zonas = crearZonas(cajaModelo, centrosX);

  // Altura máxima de las puertas: todo lo que quede por debajo es rack.
  const yCorte = cajasPuerta.length
    ? Math.max(...cajasPuerta.map((caja) => caja.max.y)) + 0.6
    : cajaModelo.max.y * 0.72;

  const objetosPorRack = zonas.map(() => []);

  for (const mesh of meshes) {
    if (asignados.has(mesh)) continue;

    // Solo el hardware propio del rack (no mangueras ni escalerillas).
    if (!INCLUIR_EN_RACK.test(mesh.name)) continue;

    const cajaMesh = new THREE.Box3().setFromObject(mesh);
    if (cajaMesh.isEmpty()) continue;

    const centroMesh = cajaMesh.getCenter(new THREE.Vector3());

    // Solo la zona baja (los racks); el resto son sistemas de la fila.
    if (centroMesh.y > yCorte) continue;

    const indice = indiceZona(centroMesh.x, zonas);
    if (indice >= 0) objetosPorRack[indice].push(mesh);
  }

  for (let i = 0; i < zonas.length; i++) {
    let objetos = objetosPorRack[i];

    // Fallback: si una zona quedó vacía, usamos su puerta.
    if (objetos.length === 0 && puertasOrdenadas[i]) {
      objetos = obtenerMeshes(puertasOrdenadas[i]);
    }

    if (objetos.length === 0) continue;

    const caja = cajaDeObjetos(objetos);

    const numero = String(i + 1).padStart(2, '0');
    const componente = crearComponente({
      id: `rack-${numero}`,
      nombre: `RACK-${numero}`,
      categoria: 'Rack 48U',
      descripcion: 'Rack 48U con puerta frontal, rPDU y sensores de temperatura.',
      tipo: 'rack',
      objetos,
      caja,
    });

    componente.indiceRack = i + 1;
    racks.push(componente);
    componentes.push(componente);
  }

  /* 3) Asignar el componente a cada malla para el Raycaster. */
  for (const componente of componentes) {
    for (const mesh of componente.objetos) {
      mesh.userData.componenteId = componente.id;
    }
  }

  /* 4) Índice por id. */
  for (const componente of componentes) {
    componentesPorId.set(componente.id, componente);
  }

  console.info(
    `[Modelo] ${meshes.length} mallas · ${componentes.length} componentes · ` +
    `${racks.length} racks detectados.`
  );
}

/**
 * Busca los 4 grupos de puerta frontal del GLB.
 * Se usa una expresión regular para no depender de los sufijos exactos.
 */
function buscarPuertasFrontales(modelo) {
  const puertas = [];

  modelo.traverse((objeto) => {
    if (
      /^VR_Front_Panel_48Ux800_003(_\d+)?$/.test(objeto.name) &&
      objeto.children.length > 0
    ) {
      puertas.push(objeto);
    }
  });

  return puertas;
}

function crearZonas(cajaModelo, centrosX) {
  const minX = cajaModelo.min.x;
  const maxX = cajaModelo.max.x;

  // Si no hay 4 centros, repartimos el ancho en 4 partes.
  if (centrosX.length < 4) {
    const ancho = (maxX - minX) / 4;
    return [0, 1, 2, 3].map((i) => ({
      min: minX + ancho * i,
      max: minX + ancho * (i + 1),
    }));
  }

  const centros = centrosX.slice(0, 4);
  const limites = [minX];

  for (let i = 0; i < centros.length - 1; i++) {
    limites.push((centros[i] + centros[i + 1]) / 2);
  }

  limites.push(maxX);

  return limites.slice(0, -1).map((min, i) => ({
    min,
    max: limites[i + 1],
  }));
}

function indiceZona(x, zonas) {
  for (let i = 0; i < zonas.length; i++) {
    if (x >= zonas[i].min && x < zonas[i].max) return i;
  }
  return x < zonas[0].min ? 0 : zonas.length - 1;
}

function crearComponente({ id, nombre, categoria, descripcion, tipo, objetos, caja }) {
  // Para los sistemas con varias unidades (por ejemplo dos CDU), colocamos
  // la etiqueta sobre la unidad más grande en lugar del centro del grupo.
  let cajaEtiqueta = caja;

  if (tipo === 'componente' && objetos.length > 1) {
    let mayorVolumen = -1;
    let cajaMayor = null;

    for (const objeto of objetos) {
      const cajaObjeto = new THREE.Box3().setFromObject(objeto);
      if (cajaObjeto.isEmpty()) continue;

      const tamano = cajaObjeto.getSize(new THREE.Vector3());
      const volumen = tamano.x * tamano.y * tamano.z;

      if (volumen > mayorVolumen) {
        mayorVolumen = volumen;
        cajaMayor = cajaObjeto;
      }
    }

    if (cajaMayor) cajaEtiqueta = cajaMayor;
  }

  // La CDU son dos unidades; etiquetamos la de la derecha, que es la visible
  // desde la vista inicial.
  if (id === 'cdu') {
    let mejorX = -Infinity;
    let cajaDerecha = null;

    for (const objeto of objetos) {
      const cajaObjeto = new THREE.Box3().setFromObject(objeto);
      if (cajaObjeto.isEmpty()) continue;

      const centroObjeto = cajaObjeto.getCenter(new THREE.Vector3());

      if (centroObjeto.x > mejorX) {
        mejorX = centroObjeto.x;
        cajaDerecha = cajaObjeto;
      }
    }

    if (cajaDerecha) cajaEtiqueta = cajaDerecha;
  }

  const centroEtiqueta = cajaEtiqueta.getCenter(new THREE.Vector3());

  // Los sistemas se etiquetan por encima de todo el grupo para no chocar
  // con las etiquetas de los racks.
  const alturaEtiqueta = tipo === 'rack'
    ? cajaEtiqueta.max.y + 0.35
    : caja.max.y + 0.6;

  const puntoEtiqueta = new THREE.Vector3(
    centroEtiqueta.x,
    alturaEtiqueta,
    tipo === 'rack' ? caja.max.z + 0.15 : centroEtiqueta.z
  );

  return {
    id,
    nombre,
    categoria,
    descripcion,
    tipo,
    objetos,
    caja: caja.clone(),
    puntoEtiqueta,
    materiales: [],
    // Estado térmico y de mantenimiento (solo se usa en racks).
    temperatura: null,
    alarma: false,
    enMantenimiento: false,
  };
}

function obtenerMeshes(objeto) {
  const lista = [];
  objeto.traverse((hijo) => {
    if (hijo.isMesh) lista.push(hijo);
  });
  return lista;
}

function cajaDeObjetos(objetos) {
  const caja = new THREE.Box3();

  for (const objeto of objetos) {
    caja.expandByObject(objeto);
  }

  return caja;
}

/* Relleno procedural de los racks: servidores, LEDs, cables y ventiladores.
   Vive fuera del GLB, así que no interfiere con el raycasting ni con el tintado. */

/* Medidas del relleno interno (unidades del modelo ya normalizado). */
const RELLENO = {
  margenFrontal: 0.22, // separación respecto a la puerta de cristal (−Z)
  anchoServidor: 1.28,
  altoServidor: 0.09,
  fondoServidor: 0.9,
  pasoVertical: 0.12, // ≈ 1U por fila
  margenInferior: 0.5,
  margenSuperior: 0.5,
  radioVentilador: 0.3, // encaja dentro de las rejillas traseras del GLB
  aspasPorVentilador: 3,
  ventiladoresRespaldo: 4, // solo si el modelo no trae rejillas DCD
};

/* Colores planos de los LEDs según el estado del rack. */
const LED_NORMAL = new THREE.Color(0x39ff88); // verde
const LED_SELECCION = new THREE.Color(0x53e0ff); // cian
const LED_ALARMA = new THREE.Color(0xff3b30); // rojo
const LED_ALARMA_APAGADO = new THREE.Color(0x4a0d0a); // rojo apagado (parpadeo)
const LED_MANTENIMIENTO = new THREE.Color(0xffb020); // ámbar

/**
 * Velocidad base de giro de los ventiladores (rad/s).
 * Es una variable de estado global: puede cambiarse en caliente
 * (por ejemplo `__nexus.ventiladores(4)`). Por encima de 30 °C cada rack
 * multiplica automáticamente esta velocidad.
 */
export let velocidadVentiladores = 1.6;

/** Ajusta la velocidad base de los ventiladores (rad/s). */
export function establecerVelocidadVentiladores(valor) {
  if (Number.isFinite(valor)) {
    velocidadVentiladores = THREE.MathUtils.clamp(valor, 0, 40);
  }
  return velocidadVentiladores;
}

let grupoInternos = null;
let mallaServidores = null;
let mallaLEDs = null;
let totalServidores = 0;

const geometriasInternas = {};
const materialesInternos = {};

/** Mide el hueco interior de un rack para colocar servidores y cables. */
function medirRack(rack) {
  const caja = rack.caja;
  const centro = caja.getCenter(new THREE.Vector3());

  const frenteZ = caja.min.z + RELLENO.margenFrontal; // cara frontal (−Z)
  const centroZ = frenteZ + RELLENO.fondoServidor / 2;
  const baseY = caja.min.y + RELLENO.margenInferior;
  const topeY = caja.max.y - RELLENO.margenSuperior;
  const filas = Math.max(4, Math.floor((topeY - baseY) / RELLENO.pasoVertical));

  return {
    caja,
    centroX: centro.x,
    centroY: centro.y,
    frenteZ,
    centroZ,
    baseY,
    topeY,
    filas,
    indiceServidor: 0,
    indiceLED: 0,
    ventiladores: [],
  };
}

/**
 * Construye el relleno procedural de todos los racks.
 * Se llama una sola vez, tras preparar los materiales de los racks.
 */
function construirInternosProcedurales() {
  if (grupoInternos || racks.length === 0) return;

  grupoInternos = new THREE.Group();
  grupoInternos.name = 'InternosProcedurales';
  escenaActual.add(grupoInternos);

  /* Materiales y geometrías compartidos (se crean una sola vez). */
  materialesInternos.servidor = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.72,
    metalness: 0.22,
  });
  materialesInternos.led = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    toneMapped: false,
  });
  materialesInternos.ventilador = new THREE.MeshStandardMaterial({
    color: 0x2a323c,
    roughness: 0.55,
    metalness: 0.65,
  });
  materialesInternos.aspa = new THREE.MeshStandardMaterial({
    color: 0x5a6a7e,
    roughness: 0.5,
    metalness: 0.5,
  });

  geometriasInternas.servidor = new THREE.BoxGeometry(
    RELLENO.anchoServidor,
    RELLENO.altoServidor,
    RELLENO.fondoServidor
  );
  geometriasInternas.led = new THREE.BoxGeometry(0.05, 0.022, 0.02);
  geometriasInternas.aro = new THREE.TorusGeometry(RELLENO.radioVentilador, 0.026, 6, 20);
  geometriasInternas.buje = new THREE.CylinderGeometry(0.055, 0.055, 0.07, 12);
  geometriasInternas.aspa = new THREE.BoxGeometry(RELLENO.radioVentilador * 0.92, 0.09, 0.02);

  /* 1) Medimos cada rack y contamos las instancias necesarias. */
  for (const rack of racks) rack.interno = medirRack(rack);
  totalServidores = racks.reduce(
    (total, rack) => total + (rack.interno ? rack.interno.filas : 0),
    0
  );

  if (totalServidores === 0) return;

  /* 2) Servidores: un único InstancedMesh para todos los racks. */
  mallaServidores = new THREE.InstancedMesh(
    geometriasInternas.servidor,
    materialesInternos.servidor,
    totalServidores
  );
  mallaServidores.name = 'ServidoresInternos';
  mallaServidores.instanceMatrix.setUsage(THREE.StaticDrawUsage);
  grupoInternos.add(mallaServidores);

  /* 3) LEDs: un único InstancedMesh, dos LEDs por servidor. */
  mallaLEDs = new THREE.InstancedMesh(
    geometriasInternas.led,
    materialesInternos.led,
    totalServidores * 2
  );
  mallaLEDs.name = 'LEDsInternos';
  mallaLEDs.instanceMatrix.setUsage(THREE.StaticDrawUsage);
  grupoInternos.add(mallaLEDs);

  /* 4) Rellenamos matrices y colores. */
  const matriz = new THREE.Matrix4();
  const color = new THREE.Color();
  const tonos = [0x2b313a, 0x232831, 0x333a45];
  let indice = 0;

  for (const rack of racks) {
    const info = rack.interno;
    if (!info) continue;

    info.indiceServidor = indice;
    info.indiceLED = indice * 2;
    rack.anguloVentilador = 0;

    for (let fila = 0; fila < info.filas; fila++) {
      const y = info.baseY + fila * RELLENO.pasoVertical + RELLENO.altoServidor / 2;

      matriz.makeTranslation(info.centroX, y, info.centroZ);
      mallaServidores.setMatrixAt(indice, matriz);
      mallaServidores.setColorAt(indice, color.setHex(tonos[fila % tonos.length]));

      // Dos LEDs en el borde frontal (−Z) de cada servidor.
      for (let led = 0; led < 2; led++) {
        const xLed = info.centroX + RELLENO.anchoServidor / 2 - 0.07 - led * 0.05;
        matriz.makeTranslation(xLed, y + 0.006, info.frenteZ - 0.012);
        mallaLEDs.setMatrixAt(info.indiceLED + fila * 2 + led, matriz);
      }

      indice++;
    }

    construirVentiladores(rack, info);
    construirCables(rack, info);
  }

  mallaServidores.instanceMatrix.needsUpdate = true;
  mallaLEDs.instanceMatrix.needsUpdate = true;
  if (mallaServidores.instanceColor) mallaServidores.instanceColor.needsUpdate = true;

  /* 5) Estado inicial de los LEDs de cada rack. */
  for (const rack of racks) aplicarLEDsRack(rack, true);

  console.info(
    `[Modelo] Relleno procedural: ${totalServidores} servidores instanciados ` +
    `en ${racks.length} racks.`
  );
}

/**
 * Localiza las rejillas de ventilador del modelo (`*_door_screen_*`).
 * Son 4 tapas circulares por rack, en columna, sobre la puerta trasera DCD.
 */
function buscarRejillasVentilador(caja) {
  const rejillas = [];
  const mitadZ = (caja.min.z + caja.max.z) / 2;

  escenaActual.traverse((objeto) => {
    if (!objeto.isMesh || !/door_screen/i.test(objeto.name)) return;

    const bb = new THREE.Box3().setFromObject(objeto);
    if (bb.isEmpty()) return;

    const centro = bb.getCenter(new THREE.Vector3());

    // Solo las rejillas de este rack: dentro de su huella en X y en su mitad
    // trasera (+Z). Así no se mezclan las de los racks vecinos.
    if (centro.x < caja.min.x - 0.05 || centro.x > caja.max.x + 0.05) return;
    if (centro.z < mitadZ) return;

    rejillas.push({ centro, tam: bb.getSize(new THREE.Vector3()) });
  });

  return rejillas;
}

/** Posiciones de reserva si el GLB no trae rejillas DCD. */
function ventiladoresDeRespaldo(info) {
  const x = info.centroX - 0.11;
  const z = info.caja.max.z - 0.02;
  const y0 = info.caja.min.y + 1.35;
  const paso = 1.05;

  return [0, 1, 2, 3].map((i) => new THREE.Vector3(x, y0 + i * paso, z));
}

/**
 * Crea los ventiladores de un rack.
 * Se colocan en la PUERTA TRASERA (+Z), justo sobre las rejillas del propio
 * modelo (allí donde ventilan de verdad, no encima del rack). Miran a ±Z y
 * giran constantemente sobre el eje Z.
 */
function construirVentiladores(rack, info) {
  const rejillas = buscarRejillasVentilador(info.caja);

  const posiciones = rejillas.length > 0
    ? rejillas.map((r) => r.centro)
    : ventiladoresDeRespaldo(info);

  // Escala para que el disco no sobresalga de la rejilla (si la hay).
  const radioRejilla = rejillas.length > 0
    ? Math.min(...rejillas.map((r) => Math.min(r.tam.x, r.tam.y) / 2))
    : RELLENO.radioVentilador;
  const escala = Math.min(1, (radioRejilla * 0.94) / RELLENO.radioVentilador);

  posiciones.forEach((centro, i) => {
    const ventilador = new THREE.Group();
    ventilador.name = `Ventilador_${rack.id}`;
    // Un pelo por delante de la rejilla para no pelearse con ella (z-fighting).
    ventilador.position.set(centro.x, centro.y, centro.z + 0.008);
    ventilador.scale.setScalar(escala);

    // Aro (toro en el plano XY) y buje (cilindro con el eje en Z).
    ventilador.add(new THREE.Mesh(geometriasInternas.aro, materialesInternos.ventilador));

    const buje = new THREE.Mesh(geometriasInternas.buje, materialesInternos.ventilador);
    buje.rotation.x = Math.PI / 2;
    ventilador.add(buje);

    // Aspas: cada una vive en un soporte girado; el grupo completo rota en Z.
    const aspas = new THREE.Group();
    aspas.name = 'Aspas';

    for (let a = 0; a < RELLENO.aspasPorVentilador; a++) {
      const soporte = new THREE.Group();
      soporte.rotation.z = (Math.PI * 2 * a) / RELLENO.aspasPorVentilador;

      const aspa = new THREE.Mesh(geometriasInternas.aspa, materialesInternos.aspa);
      aspa.position.x = RELLENO.radioVentilador * 0.52;
      aspa.rotation.x = 0.55; // paso de hélice
      soporte.add(aspa);

      aspas.add(soporte);
    }

    ventilador.add(aspas);

    grupoInternos.add(ventilador);
    // Desfase distinto por ventilador para que no giren todos sincronizados.
    info.ventiladores.push({ aspas, desfase: i * 0.9 });
  });
}

/** Crea cables curvos (azules y rojos) que caen desde el techo a los servidores. */
function construirCables(rack, info) {
  const caja = info.caja;
  const yTecho = caja.max.y - 0.45;
  const lado = RELLENO.anchoServidor / 2 + 0.08;
  const xIzq = info.centroX - lado;
  const xDer = info.centroX + lado;
  const zFrente = info.frenteZ + 0.02;
  const zMedio = info.centroZ;
  const alto = info.filas * RELLENO.pasoVertical;
  const yMedio = info.baseY + alto * 0.5;
  const yBajo = info.baseY + alto * 0.2;

  const azul = 0x2f6bff;
  const rojo = 0xff3b30;

  const definiciones = [
    {
      color: azul,
      puntos: [
        new THREE.Vector3(xIzq - 0.05, yTecho, zMedio - 0.15),
        new THREE.Vector3(xIzq - 0.18, yTecho - 0.6, zMedio),
        new THREE.Vector3(xIzq - 0.10, yMedio, zFrente + 0.10),
        new THREE.Vector3(xIzq + 0.22, info.baseY + 0.6, zFrente + 0.04),
      ],
    },
    {
      color: azul,
      puntos: [
        new THREE.Vector3(xDer + 0.05, yTecho, zMedio - 0.15),
        new THREE.Vector3(xDer + 0.18, yTecho - 0.7, zMedio + 0.1),
        new THREE.Vector3(xDer + 0.05, yMedio + 0.3, zFrente + 0.10),
        new THREE.Vector3(xDer - 0.22, info.baseY + alto * 0.7, zFrente + 0.04),
      ],
    },
    {
      color: rojo,
      puntos: [
        new THREE.Vector3(info.centroX + 0.15, yTecho, zMedio - 0.3),
        new THREE.Vector3(info.centroX + 0.32, yTecho - 0.5, zMedio - 0.05),
        new THREE.Vector3(info.centroX + 0.2, yBajo, zMedio),
        new THREE.Vector3(info.centroX - 0.12, yBajo - 0.4, zFrente + 0.02),
      ],
    },
  ];

  for (const definicion of definiciones) {
    const curva = new THREE.CatmullRomCurve3(definicion.puntos);
    const geometria = new THREE.TubeGeometry(curva, 16, 0.02, 5, false);
    const material = new THREE.MeshStandardMaterial({
      color: definicion.color,
      emissive: definicion.color,
      emissiveIntensity: 0.3,
      roughness: 0.55,
      metalness: 0.1,
    });

    const cable = new THREE.Mesh(geometria, material);
    cable.name = `Cable_${rack.id}`;
    grupoInternos.add(cable);
  }
}

/** Color de LED que corresponde al estado actual del rack. */
function colorLEDRack(rack) {
  if (rack.enMantenimiento) return LED_MANTENIMIENTO;
  if (rack.alarma) return rack.parpadeoLED ? LED_ALARMA : LED_ALARMA_APAGADO;
  if (rack.seleccionado) return LED_SELECCION;
  return LED_NORMAL;
}

/**
 * Vuelca el color de LED a las instancias del rack.
 * Solo escribe si el color cambió (o si `forzar` es true) para no tocar el
 * buffer cada frame.
 */
function aplicarLEDsRack(rack, forzar = false) {
  const info = rack.interno;
  if (!info || !mallaLEDs) return;

  const color = colorLEDRack(rack);
  const firma = color.getHexString();

  if (!forzar && rack.firmaLED === firma) return;
  rack.firmaLED = firma;

  for (let i = 0; i < info.filas * 2; i++) {
    mallaLEDs.setColorAt(info.indiceLED + i, color);
  }

  if (mallaLEDs.instanceColor) mallaLEDs.instanceColor.needsUpdate = true;
}

/** Multiplicador de velocidad de los ventiladores de un rack. */
function factorVentilador(rack) {
  const temperatura = Number.isFinite(rack.temperatura) ? rack.temperatura : 22;

  // Lento por debajo de 30 °C, se acelera rápido al superarlos.
  const calor = THREE.MathUtils.smoothstep(temperatura, 28, 33);
  let factor = 0.4 + calor * 2.6;

  if (rack.seleccionado) factor *= 1.8;
  if (rack.enMantenimiento) factor *= 0.6;

  return factor;
}

/** Marca qué rack está seleccionado (y refresca sus LEDs). */
function marcarSeleccionInterna(id) {
  for (const rack of racks) {
    const seleccionado = rack.id === id;

    if (rack.seleccionado === seleccionado) continue;

    rack.seleccionado = seleccionado;
    if (seleccionado) rack.parpadeoLED = false;
    aplicarLEDsRack(rack);
  }
}

// Materiales por rack (gradiente térmico azul → rojo)

function prepararMaterialesRack(rack) {
  const clones = new Map();

  for (const mesh of rack.objetos) {
    const originales = Array.isArray(mesh.material) ? mesh.material : [mesh.material];

    const nuevos = originales.map((material) => {
      if (!material) return material;

      if (!clones.has(material)) {
        const clon = material.clone();

        clon.userData.colorBase = clon.color ? clon.color.clone() : null;
        clon.userData.emissiveBase = clon.emissive ? clon.emissive.clone() : null;
        clon.userData.emissiveIntensityBase = clon.emissiveIntensity ?? 0;

        clones.set(material, clon);
      }

      return clones.get(material);
    });

    mesh.material = Array.isArray(mesh.material) ? nuevos : nuevos[0];
  }

  rack.materiales = [...clones.values()];
}

/**
 * Cambia el color del rack según su temperatura.
 * 22 °C → azul · 30-34 °C → rojo.
 * La transición se concentra en la zona alta para que los racks fríos
 * permanezcan azules y solo se enciendan cuando hay riesgo real.
 *
 * Si el rack está en mantenimiento se pinta en ámbar y se ignora la alarma.
 */
export function actualizarTemperaturaRack(id, temperatura, alarma = false) {
  const rack = componentesPorId.get(id);
  if (!rack || rack.tipo !== 'rack') return;

  rack.temperatura = temperatura;

  // El mantenimiento tiene prioridad: nunca rojo, siempre ámbar.
  if (rack.enMantenimiento) {
    pintarRack(rack, COLOR_MANTENIMIENTO, 0.55, 0.1);
    rack.alarma = false;
    aplicarLEDsRack(rack);
    return;
  }

  const t = THREE.MathUtils.clamp((temperatura - 22) / 12, 0, 1);

  // smoothstep: 0 hasta ~25,6 °C y 1 a partir de ~33,4 °C.
  const calor = THREE.MathUtils.smoothstep(t, 0.3, 0.95);

  const color = COLOR_FRIO.clone().lerp(COLOR_CALIENTE, calor);
  const mezcla = 0.35 + calor * 0.45;

  pintarRack(rack, color, mezcla, 0.04 + calor * 0.22);

  rack.alarma = alarma;
  if (alarma) rack.parpadeoLED = true; // arranca el parpadeo en rojo
  aplicarLEDsRack(rack);
}

/** Aplica un color y una emisión a todos los materiales de un rack. */
function pintarRack(rack, color, mezcla, intensidadEmisiva) {
  for (const material of rack.materiales) {
    if (material.color && material.userData.colorBase) {
      material.color.copy(material.userData.colorBase).lerp(color, mezcla);
    }

    if (material.emissive) {
      material.emissive.copy(color);
      material.emissiveIntensity = intensidadEmisiva;
    }
  }
}

/**
 * Activa o desactiva el modo mantenimiento de un rack.
 *
 * @param {string} id
 * @param {boolean} activo
 * @returns {boolean} estado final
 */
export function establecerMantenimiento(id, activo) {
  const rack = componentesPorId.get(id);
  if (!rack || rack.tipo !== 'rack') return false;

  rack.enMantenimiento = Boolean(activo);
  rack.alarma = false;

  // Repintamos de inmediato con la última temperatura conocida.
  actualizarTemperaturaRack(id, rack.temperatura ?? 22, false);

  return rack.enMantenimiento;
}

/**
 * Indica si un rack está en mantenimiento.
 * @param {string} id
 * @returns {boolean}
 */
export function estaEnMantenimiento(id) {
  const rack = componentesPorId.get(id);
  return Boolean(rack?.enMantenimiento);
}

// Animación "4XL400 Doors Open"

function configurarAnimaciones(gltf) {
  if (!gltf.animations || gltf.animations.length === 0) return;

  clipPuertas =
    gltf.animations.find((clip) => /4XL400 Doors Open/i.test(clip.name)) ||
    gltf.animations[0];

  if (!clipPuertas) return;

  mixer = new THREE.AnimationMixer(raizModelo);
  accionPuertas = mixer.clipAction(clipPuertas);
  accionPuertas.setLoop(THREE.LoopOnce, 1);
  accionPuertas.clampWhenFinished = true;

  console.info(`[Modelo] Animación de puertas lista: "${clipPuertas.name}".`);
}

/**
 * Abre o cierra las puertas. Si no se pasa argumento, alterna.
 * @returns {boolean} estado final (true = abiertas)
 */
export function alternarPuertas(abrir) {
  if (!accionPuertas || !clipPuertas) return false;

  const destino = typeof abrir === 'boolean' ? abrir : !puertasAbiertas;

  if (destino === puertasAbiertas) return puertasAbiertas;

  const tiempoActual = accionPuertas.time;
  accionPuertas.stop();

  if (destino) {
    accionPuertas.reset();
    accionPuertas.timeScale = 1;
    accionPuertas.play();
  } else {
    accionPuertas.reset();
    accionPuertas.time =
      tiempoActual > 0.01 ? tiempoActual : clipPuertas.duration;
    accionPuertas.timeScale = -1;
    accionPuertas.play();
  }

  puertasAbiertas = destino;
  return puertasAbiertas;
}

export function puertasEstanAbiertas() {
  return puertasAbiertas;
}

export function tieneAnimacionPuertas() {
  return !!accionPuertas;
}

// Raycaster: hover y clic

function configurarRaycaster() {
  raycaster = new THREE.Raycaster();

  outlineHover = crearOutline(0x22d3ee, 0.55);
  outlineSeleccion = crearOutline(0x7df9ff, 0.95);

  const dom = rendererActual.domElement;

  let ultimoRaycast = 0;
  let pointerDown = null;
  let arrastrado = false;

  dom.addEventListener('pointermove', (evento) => {
    if (pointerDown) {
      const dx = evento.clientX - pointerDown.x;
      const dy = evento.clientY - pointerDown.y;
      if (Math.hypot(dx, dy) > 6) arrastrado = true;
    }

    const ahora = performance.now();
    if (ahora - ultimoRaycast < 50) return;
    ultimoRaycast = ahora;

    const componente = componenteEnPuntero(evento);

    if ((componente ? componente.id : null) !== hoverId) {
      hoverId = componente ? componente.id : null;
      actualizarHover(componente);
      dom.style.cursor = componente ? 'pointer' : 'grab';
    }

    if (alHover) alHover(componente, evento);
  });

  dom.addEventListener('pointerleave', () => {
    hoverId = null;
    actualizarHover(null);
    dom.style.cursor = 'grab';
    if (alHover) alHover(null, null);
  });

  dom.addEventListener('pointerdown', (evento) => {
    if (evento.button !== 0) return;
    pointerDown = { x: evento.clientX, y: evento.clientY };
    arrastrado = false;
  });

  dom.addEventListener('pointerup', (evento) => {
    if (evento.button !== 0 || !pointerDown) return;

    const fueClic = !arrastrado;
    pointerDown = null;

    if (!fueClic) return;

    const componente = componenteEnPuntero(evento);
    if (alSeleccionar) alSeleccionar(componente);
  });

  dom.addEventListener('pointercancel', () => {
    pointerDown = null;
    arrastrado = false;
  });
}

function componenteEnPuntero(evento) {
  if (!raycaster || !camaraActual) return null;

  const rect = rendererActual.domElement.getBoundingClientRect();
  const ndc = new THREE.Vector2(
    ((evento.clientX - rect.left) / rect.width) * 2 - 1,
    -((evento.clientY - rect.top) / rect.height) * 2 + 1
  );

  raycaster.setFromCamera(ndc, camaraActual);

  const impactos = raycaster.intersectObjects(meshes, false);

  for (const impacto of impactos) {
    const id = impacto.object.userData.componenteId;
    if (id && componentesPorId.has(id)) {
      return componentesPorId.get(id);
    }
  }

  return null;
}

function crearOutline(color, opacidad) {
  const helper = new THREE.Box3Helper(new THREE.Box3(), color);

  helper.material.transparent = true;
  helper.material.opacity = opacidad;
  helper.material.depthTest = false;
  helper.renderOrder = 999;
  helper.visible = false;

  escenaActual.add(helper);

  return helper;
}

function mostrarCaja(helper, caja) {
  if (!helper || !caja) return;
  helper.box.copy(caja);
  helper.updateMatrixWorld(true);
  helper.visible = true;
}

function actualizarHover(componente) {
  if (!outlineHover) return;

  // Si el componente ya está seleccionado, no duplicamos el outline.
  if (!componente || componente.id === seleccionId) {
    outlineHover.visible = false;
    return;
  }

  mostrarCaja(outlineHover, componente.caja);
}

// Selección

export function resaltarComponente(id) {
  const componente = componentesPorId.get(id);

  if (!componente) {
    limpiarSeleccion();
    return;
  }

  seleccionId = id;
  marcarSeleccionInterna(id);
  mostrarCaja(outlineSeleccion, componente.caja);
  actualizarHover(componentesPorId.get(hoverId) || null);
}

export function limpiarSeleccion() {
  seleccionId = null;
  marcarSeleccionInterna(null);
  if (outlineSeleccion) outlineSeleccion.visible = false;
  actualizarHover(componentesPorId.get(hoverId) || null);
}

// Actualización por frame

export function actualizarModelo(delta, elapsed) {
  if (mixer) mixer.update(delta);

  // Delta acotado: evita saltos bruscos si la pestaña estuvo en segundo plano.
  const dt = Math.min(delta, 0.1);

  // Ventiladores
  // Giran siempre; se aceleran con la temperatura del rack (> 30 °C) y cuando
  // el rack está seleccionado. La variable global `velocidadVentiladores`
  // actúa como velocidad base.
  for (const rack of racks) {
    const info = rack.interno;
    if (!info || info.ventiladores.length === 0) continue;

    rack.anguloVentilador =
      (rack.anguloVentilador || 0) + dt * velocidadVentiladores * factorVentilador(rack);

    for (const ventilador of info.ventiladores) {
      ventilador.aspas.rotation.z = rack.anguloVentilador + ventilador.desfase;
    }
  }

  // LEDs en alarma
  // Parpadeo rojo encendido/apagado (nunca en mantenimiento).
  for (const rack of racks) {
    if (!rack.alarma || rack.enMantenimiento || !rack.interno) continue;

    rack.tiempoLED = (rack.tiempoLED || 0) + dt;

    if (rack.tiempoLED >= 0.45) {
      rack.tiempoLED = 0;
      rack.parpadeoLED = !rack.parpadeoLED;
      aplicarLEDsRack(rack);
    }
  }

  // Pulso rojo en los racks en alarma (nunca en mantenimiento).
  for (const rack of racks) {
    if (!rack.alarma || rack.enMantenimiento) continue;

    const pulso = 0.18 + 0.14 * (0.5 + 0.5 * Math.sin(elapsed * 5));

    for (const material of rack.materiales) {
      if (material.emissive) material.emissiveIntensity = pulso;
    }
  }
}

// Consultas

export function obtenerComponentes() {
  return componentes;
}

export function obtenerComponentePorId(id) {
  return componentesPorId.get(id) || null;
}

export function obtenerRacks() {
  return racks;
}
