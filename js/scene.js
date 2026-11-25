// Escena Three.js: cámara, luces, entorno y bucle de render.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

/* GSAP se carga por CDN en index.html (variable global). */
const gsap = window.gsap;

let escena;
let camara;
let renderer;
let controles;
let rejilla = null;
let halo = null;
let cajaModelo = null;

// Creación de la escena

export function crearEscena(canvas) {
  renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    powerPreference: 'high-performance',
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.1;

  escena = new THREE.Scene();
  escena.background = new THREE.Color(0x04070c);
  escena.fog = new THREE.FogExp2(0x04070c, 0.0065);

  camara = new THREE.PerspectiveCamera(
    42,
    window.innerWidth / window.innerHeight,
    0.1,
    2000
  );
  camara.position.set(18, 12, 20);

  controles = new OrbitControls(camara, renderer.domElement);
  controles.enableDamping = true;
  controles.dampingFactor = 0.06;
  controles.screenSpacePanning = true;
  controles.minDistance = 0.5;
  controles.maxDistance = 220;
  controles.minPolarAngle = 0.12;
  controles.maxPolarAngle = Math.PI * 0.495;
  controles.target.set(0, 4, 0);
  controles.update();

  crearIluminacion();
  crearEntornoPBR();

  window.addEventListener('resize', alRedimensionar);

  return { escena, camara, renderer, controles };
}

// Iluminación

function crearIluminacion() {
  // Luz ambiental suave para que ninguna zona quede negra.
  escena.add(new THREE.AmbientLight(0x9fd8ff, 0.55));

  // Cielo frío + rebote cálido del suelo.
  escena.add(new THREE.HemisphereLight(0x7fd8ff, 0x0a1620, 0.9));

  // Luz principal.
  const luzPrincipal = new THREE.DirectionalLight(0xffffff, 2.4);
  luzPrincipal.position.set(14, 22, 12);
  escena.add(luzPrincipal);

  // Luz de relleno cian (rim light).
  const luzRelleno = new THREE.DirectionalLight(0x22d3ee, 1.4);
  luzRelleno.position.set(-16, 10, -14);
  escena.add(luzRelleno);
}

/* Entorno PBR para reflejos suaves en los materiales metálicos. */
function crearEntornoPBR() {
  const generadorPMREM = new THREE.PMREMGenerator(renderer);
  const entorno = generadorPMREM.fromScene(new RoomEnvironment(), 0.04).texture;

  escena.environment = entorno;
  escena.environmentIntensity = 0.5;
  generadorPMREM.dispose();
}

// Suelo / rejilla futurista

export function crearSuelo(caja) {
  if (rejilla) {
    escena.remove(rejilla);
    rejilla.geometry.dispose();
    rejilla.material.dispose();
    rejilla = null;
  }

  if (halo) {
    escena.remove(halo);
    halo.geometry.dispose();
    halo.material.dispose();
    halo = null;
  }

  const tamano = caja.getSize(new THREE.Vector3());
  const lado = Math.max(tamano.x, tamano.z) * 3.4;

  rejilla = new THREE.GridHelper(lado, 52, 0x22d3ee, 0x0d3442);
  rejilla.position.y = 0.015;
  rejilla.material.transparent = true;
  rejilla.material.opacity = 0.24;
  rejilla.material.depthWrite = false;
  escena.add(rejilla);

  // Halo circular bajo el Data Center.
  const radio = Math.max(tamano.x, tamano.z) * 0.62;
  halo = new THREE.Mesh(
    new THREE.RingGeometry(radio * 0.96, radio, 96),
    new THREE.MeshBasicMaterial({
      color: 0x22d3ee,
      transparent: true,
      opacity: 0.18,
      side: THREE.DoubleSide,
      depthWrite: false,
    })
  );
  halo.rotation.x = -Math.PI / 2;
  halo.position.y = 0.02;
  escena.add(halo);
}

// Cámara: encuadre y vuelo animado

/**
 * Calcula la distancia necesaria para que una caja quepa en pantalla.
 */
function calcularDistancia(caja, margen = 1.35) {
  const tamano = caja.getSize(new THREE.Vector3());

  const fovVertical = THREE.MathUtils.degToRad(camara.fov);
  const fovHorizontal = 2 * Math.atan(Math.tan(fovVertical / 2) * camara.aspect);

  const distanciaAlto = (tamano.y / 2) / Math.tan(fovVertical / 2);
  const distanciaAncho = (tamano.x / 2) / Math.tan(fovHorizontal / 2);

  return Math.max(distanciaAlto, distanciaAncho) * margen + tamano.z * 0.15;
}

/**
 * Encuadre inicial del modelo completo (sin animación).
 */
export function ajustarCamaraInicial(caja) {
  cajaModelo = caja.clone();

  const centro = caja.getCenter(new THREE.Vector3());
  const tamano = caja.getSize(new THREE.Vector3());
  const distancia = calcularDistancia(caja, 1.35);

  // En pantallas estrechas el panel tapa la parte inferior:
  // bajamos el punto de mira para que el modelo quede en la zona visible.
  if (camara.aspect < 1) {
    centro.y -= tamano.y * 0.55;
  }

  // Vista inicial desde el FRENTE del rack (lado −Z, donde está el cristal
  // y se ven los servidores y los ventiladores girando).
  const direccion = new THREE.Vector3(0.55, 0.75, -1).normalize();

  camara.position.copy(centro).add(direccion.multiplyScalar(distancia));
  camara.near = Math.max(0.05, tamano.length() / 400);
  camara.far = Math.max(500, tamano.length() * 60);
  camara.updateProjectionMatrix();

  controles.target.copy(centro);
  controles.minDistance = Math.max(0.5, tamano.length() * 0.08);
  controles.maxDistance = tamano.length() * 5;
  controles.update();
}

/**
 * Vuela la cámara hasta un componente usando GSAP.
 * @param {THREE.Box3} caja Caja envolvente del componente.
 * @param {{ margen?: number, duracion?: number, frente?: boolean }} opciones
 *        `frente` encuadra desde el lado −Z (el cristal). Se usa para los racks
 *        y la vista general; el resto de componentes miran desde +Z, que es
 *        donde están sus caras útiles, para que los racks no los tapen.
 */
export function volarAComponente(caja, opciones = {}) {
  const { margen = 1.45, duracion = 1.15, frente = false } = opciones;

  if (!caja || caja.isEmpty()) return;

  const centro = caja.getCenter(new THREE.Vector3());
  const distancia = calcularDistancia(caja, margen);

  // Vista en tres cuartos: los racks desde el FRENTE (lado −Z) para ver sus
  // servidores y ventiladores tras el cristal; el resto desde +Z, su cara útil.
  const direccion = (frente
    ? new THREE.Vector3(0.5, 0.5, -1)
    : new THREE.Vector3(0.5, 0.5, 1)
  ).normalize();
  const destino = centro.clone().add(direccion.multiplyScalar(distancia));

  // Si el panel lateral está abierto, desplazamos el encuadre a la izquierda
  // para que el componente seleccionado no quede oculto bajo el panel.
  if (document.body.classList.contains('panel-abierto')) {
    const anchoPanel = document.querySelector('.panel-detalle')?.offsetWidth || 0;
    const fraccion = anchoPanel / window.innerWidth;
    const medioAncho =
      distancia * Math.tan(THREE.MathUtils.degToRad(camara.fov / 2)) * camara.aspect;

    const derecha = new THREE.Vector3()
      .crossVectors(centro.clone().sub(destino), camara.up)
      .normalize()
      .multiplyScalar((fraccion / 2) * medioAncho);

    centro.add(derecha);
    destino.add(derecha);
  }

  if (!gsap) {
    // Fallback si GSAP no está disponible.
    camara.position.copy(destino);
    controles.target.copy(centro);
    controles.update();
    return;
  }

  gsap.killTweensOf(camara.position);
  gsap.killTweensOf(controles.target);

  controles.enabled = false;

  gsap.to(camara.position, {
    x: destino.x,
    y: destino.y,
    z: destino.z,
    duration: duracion,
    ease: 'power3.inOut',
    onUpdate: () => controles.update(),
  });

  gsap.to(controles.target, {
    x: centro.x,
    y: centro.y,
    z: centro.z,
    duration: duracion,
    ease: 'power3.inOut',
    onUpdate: () => controles.update(),
    onComplete: () => {
      controles.enabled = true;
    },
  });
}

/**
 * Vuelve a la vista general del modelo.
 */
export function reiniciarVista() {
  if (cajaModelo) {
    volarAComponente(cajaModelo, { margen: 1.35, duracion: 1.2, frente: true });
  }
}

// Bucle de renderizado

/**
 * @param {{ alFrame?: (delta:number, elapsed:number)=>void,
 *           alRender?: ()=>void }} callbacks
 */
export function iniciarBucle({ alFrame, alRender } = {}) {
  const temporizador = new THREE.Timer();

  renderer.setAnimationLoop((marcaTiempo) => {
    temporizador.update(marcaTiempo);

    controles.update();

    if (alFrame) alFrame(temporizador.getDelta(), temporizador.getElapsed());

    renderer.render(escena, camara);

    if (alRender) alRender();
  });
}

// Resize

function alRedimensionar() {
  camara.aspect = window.innerWidth / window.innerHeight;
  camara.updateProjectionMatrix();

  renderer.setSize(window.innerWidth, window.innerHeight, false);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
}
