/* 3D-сцена: Земля, атмосфера, орбиты, модели спутников, ISL; 2D-оверлей подписей и маршрута;
   камера с зумом; главный цикл. Читает state, ничего в модели не меняет. */
import * as THREE from 'three';
import { GLTFLoader } from '../vendor/jsm/loaders/GLTFLoader.js';
import { RoomEnvironment } from '../vendor/jsm/environments/RoomEnvironment.js';
import { R, rad, earthAngle, satInertial, snapshot, findRoute, sunDirection } from './sim.js';
import { state, $, ROUTE_COLOR, FAIL_COLOR, heat, on } from './state.js';
import { planeInclination } from './sim.js';

const canvas = $('#space');
export const overlay = $('#overlay');
const octx = overlay.getContext('2d');
let W = 0, H = 0, DPR = 1;

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
renderer.outputColorSpace = THREE.SRGBColorSpace;
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x000000);
export const camera = new THREE.PerspectiveCamera(36, 1, 0.05, 200);

scene.environment = new THREE.PMREMGenerator(renderer).fromScene(new RoomEnvironment(renderer), 0.04).texture;

export const root = new THREE.Group();          // вращение мышью
scene.add(root);
export const inertial = new THREE.Group();      // орбиты и спутники — вращаются относительно Земли
root.add(inertial);

// Солнце: направленный свет + слабый заполняющий
const sun = new THREE.DirectionalLight(0xffffff, 2.6);
sun.position.set(-4, 2.2, 5);
scene.add(sun, new THREE.AmbientLight(0x334466, 0.45));
const sunDir = sun.position.clone().normalize();   // обновляется каждый кадр по положению Солнца в модели

// звёзды: две «оболочки» разного размера
function makeStars(count, size, radius, opacity) {
  const pos = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const u = Math.random() * 2 - 1, phi = Math.random() * Math.PI * 2, r = Math.sqrt(1 - u * u);
    pos.set([radius * r * Math.cos(phi), radius * u, radius * r * Math.sin(phi)], i * 3);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const mat = new THREE.PointsMaterial({ size, color: 0xffffff, transparent: true, opacity, sizeAttenuation: true, depthWrite: false });
  return new THREE.Points(geo, mat);
}
scene.add(makeStars(2500, 0.06, 60, 0.85), makeStars(600, 0.13, 55, 1));

// текстуры NASA Blue Marble (скопированы из репозитория three.js в vendor/)
const TEX = './vendor/textures/';
const loader = new THREE.TextureLoader();
const tex = (name, srgb = true) => {
  const t = loader.load(TEX + name);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = renderer.capabilities.getMaxAnisotropy();
  return t;
};

export const earth = new THREE.Mesh(
  new THREE.SphereGeometry(1, 128, 128),
  new THREE.MeshPhongMaterial({
    map: tex('earth_atmos_4096.jpg'),
    specularMap: tex('earth_specular_2048.jpg', false),
    normalMap: tex('earth_normal_2048.jpg', false),
    normalScale: new THREE.Vector2(0.55, 0.55),
    specular: new THREE.Color(0x3a4a66),
    shininess: 22,
  })
);
root.add(earth);

// ночные огни городов — только на тёмной стороне
const nightLights = new THREE.Mesh(
  new THREE.SphereGeometry(1.002, 96, 96),
  new THREE.ShaderMaterial({
    uniforms: { lights: { value: tex('earth_lights_2048.png') }, sunDir: { value: sunDir } },
    vertexShader: `varying vec3 vN; varying vec2 vUv;
      void main(){ vN = normalize(mat3(modelMatrix) * normal); vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
    fragmentShader: `uniform sampler2D lights; uniform vec3 sunDir; varying vec3 vN; varying vec2 vUv;
      void main(){ float night = smoothstep(0.12, -0.2, dot(vN, sunDir)); vec3 c = texture2D(lights, vUv).rgb; gl_FragColor = vec4(c * night * 1.4, 1.0); }`,
    blending: THREE.AdditiveBlending, depthWrite: false, transparent: true,
  })
);
root.add(nightLights);

const clouds = new THREE.Mesh(
  new THREE.SphereGeometry(1.008, 96, 96),
  new THREE.MeshPhongMaterial({ map: tex('earth_clouds_2048.png'), transparent: true, opacity: 0.95, depthWrite: false })
);
root.add(clouds);

// атмосфера: внутренний обод + внешнее свечение
const rimMat = new THREE.ShaderMaterial({
  vertexShader: `varying vec3 vN; varying vec3 vP;
    void main(){ vN = normalize(normalMatrix * normal); vec4 mv = modelViewMatrix * vec4(position,1.0); vP = mv.xyz; gl_Position = projectionMatrix * mv; }`,
  fragmentShader: `varying vec3 vN; varying vec3 vP;
    void main(){ float f = 1.0 - max(dot(vN, normalize(-vP)), 0.0); float i = pow(f, 4.0) * 0.9; gl_FragColor = vec4(vec3(0.45, 0.7, 1.0) * i, 1.0); }`,
  blending: THREE.AdditiveBlending, depthWrite: false, transparent: true,
});
root.add(new THREE.Mesh(new THREE.SphereGeometry(1.001, 96, 96), rimMat));

const glowMat = new THREE.ShaderMaterial({
  vertexShader: rimMat.vertexShader,
  fragmentShader: `varying vec3 vN; varying vec3 vP;
    void main(){ float a = clamp(-dot(vN, normalize(-vP)), 0.0, 1.0); float t = clamp(a / 0.42, 0.0, 1.0); float i = t * t * 1.3; gl_FragColor = vec4(vec3(0.35, 0.62, 1.0) * i, 1.0); }`,
  side: THREE.BackSide, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true,
});
root.add(new THREE.Mesh(new THREE.SphereGeometry(1.1, 96, 96), glowMat));

// свечение для спутников — спрайт с радиальным градиентом
const glowTex = (() => {
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const g = c.getContext('2d');
  const gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.25, 'rgba(255,255,255,0.5)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = gr; g.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
})();

// ---------- модель спутника ----------
// Процедурная модель: корпус в золотой ЭВТИ, две панели солнечных батарей,
// антенна-тарелка в надир. Если рядом лежит vendor/satellite.glb — подменяется им.
// текстура солнечных батарей: ячейки с тонкой серебристой сеткой и лёгким бликом
const solarTex = (() => {
  const c = document.createElement('canvas'); c.width = 512; c.height = 192;
  const g = c.getContext('2d');
  g.fillStyle = '#0a1f52'; g.fillRect(0, 0, 512, 192);
  const grad = g.createLinearGradient(0, 0, 512, 192);
  grad.addColorStop(0, 'rgba(90,130,255,0.35)'); grad.addColorStop(0.45, 'rgba(20,30,80,0)'); grad.addColorStop(1, 'rgba(120,90,220,0.3)');
  g.fillStyle = grad; g.fillRect(0, 0, 512, 192);
  // ячейки со скошенными углами
  for (let y = 0; y < 192; y += 24) for (let x = 0; x < 512; x += 24) {
    g.fillStyle = `rgba(${10 + Math.random() * 10}, ${30 + Math.random() * 14}, ${90 + Math.random() * 30}, 0.9)`;
    g.beginPath(); g.moveTo(x + 3, y + 1); g.lineTo(x + 21, y + 1); g.lineTo(x + 23, y + 3); g.lineTo(x + 23, y + 21);
    g.lineTo(x + 21, y + 23); g.lineTo(x + 3, y + 23); g.lineTo(x + 1, y + 21); g.lineTo(x + 1, y + 3); g.closePath(); g.fill();
  }
  g.strokeStyle = 'rgba(210,225,255,0.7)'; g.lineWidth = 1.2;
  for (let x = 0; x <= 512; x += 24) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x, 192); g.stroke(); }
  for (let y = 0; y <= 192; y += 24) { g.beginPath(); g.moveTo(0, y); g.lineTo(512, y); g.stroke(); }
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8; return t;
})();

// мятая ЭВТИ: шумовая карта рельефа
const foilBump = (() => {
  const c = document.createElement('canvas'); c.width = c.height = 128;
  const g = c.getContext('2d');
  const img = g.createImageData(128, 128);
  for (let i = 0; i < img.data.length; i += 4) { const v = 120 + Math.random() * 120; img.data[i] = img.data[i + 1] = img.data[i + 2] = v; img.data[i + 3] = 255; }
  g.putImageData(img, 0, 0);
  g.globalAlpha = 0.5; g.drawImage(c, 1, 0); g.drawImage(c, 0, 1); g.drawImage(c, -1, 0);   // лёгкое сглаживание
  const t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(3, 3); return t;
})();

// серая решётка антенной решётки на надирной грани
const arrayTex = (() => {
  const c = document.createElement('canvas'); c.width = c.height = 128;
  const g = c.getContext('2d');
  g.fillStyle = '#b9c0c9'; g.fillRect(0, 0, 128, 128);
  g.strokeStyle = 'rgba(40,45,55,0.6)'; g.lineWidth = 1;
  for (let v = 0; v <= 128; v += 16) { g.beginPath(); g.moveTo(v, 0); g.lineTo(v, 128); g.stroke(); g.beginPath(); g.moveTo(0, v); g.lineTo(128, v); g.stroke(); }
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
})();

const SAT_MAT = {
  foil: new THREE.MeshStandardMaterial({ color: 0xe0b44c, metalness: 0.85, roughness: 0.42, bumpMap: foilBump, bumpScale: 0.0006, emissive: 0x2a1c05, emissiveIntensity: 0.35 }),
  white: new THREE.MeshStandardMaterial({ color: 0xf2f4f7, metalness: 0.15, roughness: 0.55, emissive: 0x15181f, emissiveIntensity: 0.5 }),
  dark: new THREE.MeshStandardMaterial({ color: 0x23272f, metalness: 0.7, roughness: 0.45, emissive: 0x07080b, emissiveIntensity: 0.5 }),
  steel: new THREE.MeshStandardMaterial({ color: 0xaab2bd, metalness: 0.9, roughness: 0.3 }),
  panel: new THREE.MeshStandardMaterial({ map: solarTex, metalness: 0.35, roughness: 0.32, emissive: 0x081a44, emissiveIntensity: 0.4, side: THREE.DoubleSide }),
  panelBack: new THREE.MeshStandardMaterial({ color: 0x2a2d33, metalness: 0.4, roughness: 0.7, emissive: 0x08090c, emissiveIntensity: 0.5 }),
  array: new THREE.MeshStandardMaterial({ map: arrayTex, metalness: 0.4, roughness: 0.5, emissive: 0x101216, emissiveIntensity: 0.4 }),
};

// Процедурная модель связного аппарата. Локальные оси: +Z — надир (на Землю), X — размах крыльев.
function buildProceduralSatellite() {
  const g = new THREE.Group();
  const add = (geo, mat, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0, parent = g) => {
    const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); m.rotation.set(rx, ry, rz); parent.add(m); return m;
  };
  const rod = (len, r = 0.0004) => new THREE.CylinderGeometry(r, r, len, 6);

  // --- корпус ---
  add(new THREE.BoxGeometry(0.018, 0.018, 0.026), SAT_MAT.foil);
  add(new THREE.BoxGeometry(0.0184, 0.0012, 0.0236), SAT_MAT.white, 0, 0.0092, 0);     // радиатор сверху
  add(new THREE.BoxGeometry(0.0184, 0.0012, 0.0236), SAT_MAT.white, 0, -0.0092, 0);    // радиатор снизу
  add(new THREE.BoxGeometry(0.0006, 0.0184, 0.0264), SAT_MAT.dark, 0.0092, 0, 0);       // рёбра по бокам
  add(new THREE.BoxGeometry(0.0006, 0.0184, 0.0264), SAT_MAT.dark, -0.0092, 0, 0);
  // надирная грань: плоская антенная решётка
  add(new THREE.BoxGeometry(0.0152, 0.0152, 0.0012), SAT_MAT.array, 0, 0, 0.0135);
  // задняя часть: переходник, двигатель, звёздный датчик
  add(new THREE.CylinderGeometry(0.0072, 0.0078, 0.003, 32, 1, true), SAT_MAT.dark, 0, 0, -0.0145, Math.PI / 2, 0, 0);
  add(new THREE.CylinderGeometry(0.0012, 0.0032, 0.0034, 24, 1, true), SAT_MAT.steel, 0, 0, -0.0175, -Math.PI / 2, 0, 0);
  add(new THREE.CylinderGeometry(0.0014, 0.0016, 0.004, 12), SAT_MAT.dark, 0.0055, 0.0055, -0.014, Math.PI / 2, 0, 0);

  // --- параболическая антенна на кронштейне, направлена в надир ---
  const dish = new THREE.Group();
  dish.position.set(0, 0.0125, 0.012);
  const prof = []; for (let i = 0; i <= 12; i++) { const r = 0.0085 * i / 12; prof.push(new THREE.Vector2(r, 0.09 * r * r / 0.0085)); }
  const dishMesh = add(new THREE.LatheGeometry(prof, 40), new THREE.MeshStandardMaterial({ color: 0xf5f6f8, metalness: 0.2, roughness: 0.4, side: THREE.DoubleSide, emissive: 0x15181f, emissiveIntensity: 0.4 }), 0, 0, 0, Math.PI / 2, 0, 0, dish);
  dishMesh.position.z = 0.002;
  add(new THREE.TorusGeometry(0.0085, 0.0003, 6, 40), SAT_MAT.steel, 0, 0, 0.0028, 0, 0, 0, dish);         // обод
  add(new THREE.SphereGeometry(0.0009, 10, 10), SAT_MAT.dark, 0, 0, 0.0075, 0, 0, 0, dish);                  // облучатель
  for (let k = 0; k < 3; k++) {                                                                               // тренога облучателя
    const a = k / 3 * Math.PI * 2, x = Math.cos(a) * 0.0075, y = Math.sin(a) * 0.0075;
    const strut = add(rod(0.0089, 0.00025), SAT_MAT.steel, x / 2, y / 2, 0.005, 0, 0, 0, dish);
    strut.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3(-x, -y, 0.0047).normalize());
  }
  add(rod(0.006, 0.0006), SAT_MAT.dark, 0, -0.004, -0.004, Math.PI / 2, 0, 0, dish);                          // кронштейн
  g.add(dish);

  // --- крылья солнечных батарей: штанга + 3 секции с рамками и шарнирами ---
  for (const sgn of [-1, 1]) {
    add(new THREE.BoxGeometry(0.014, 0.0022, 0.0022), SAT_MAT.dark, sgn * 0.016, 0, 0);                       // штанга
    add(new THREE.CylinderGeometry(0.0022, 0.0022, 0.004, 16), SAT_MAT.steel, sgn * 0.0225, 0, 0, 0, 0, Math.PI / 2); // привод
    for (let i = 0; i < 3; i++) {
      const cx = sgn * (0.0245 + 0.0136 + i * 0.0282);
      add(new THREE.BoxGeometry(0.0272, 0.0206, 0.0006), SAT_MAT.panel, cx, 0, 0.0004);
      add(new THREE.BoxGeometry(0.0272, 0.0206, 0.0004), SAT_MAT.panelBack, cx, 0, -0.0003);
      add(new THREE.BoxGeometry(0.0276, 0.0009, 0.0012), SAT_MAT.dark, cx, 0.0106, 0);                       // рамка
      add(new THREE.BoxGeometry(0.0276, 0.0009, 0.0012), SAT_MAT.dark, cx, -0.0106, 0);
      if (i < 2) add(new THREE.CylinderGeometry(0.0007, 0.0007, 0.0212, 8), SAT_MAT.steel, cx + sgn * 0.0141, 0, 0); // шарнир
    }
    add(new THREE.BoxGeometry(0.0009, 0.0212, 0.0012), SAT_MAT.dark, sgn * (0.0245 + 0.0846), 0, 0);        // торец крыла
  }

  // --- антенны и мелочи ---
  add(rod(0.016), SAT_MAT.white, 0.007, 0.0135, -0.006);
  add(rod(0.011), SAT_MAT.white, -0.006, -0.0125, -0.003);
  add(new THREE.SphereGeometry(0.0007, 8, 8), SAT_MAT.steel, 0.007, 0.0215, -0.006);
  add(new THREE.BoxGeometry(0.004, 0.004, 0.0008), SAT_MAT.dark, -0.005, 0.0096, 0.006);                    // датчик
  return g;
}

let satTemplate = buildProceduralSatellite();

// необязательная «настоящая» модель: положить glTF в vendor/satellite.glb
new GLTFLoader().load('./vendor/satellite.glb', gltf => {
  const model = gltf.scene;
  const box = new THREE.Box3().setFromObject(model);
  const size = box.getSize(new THREE.Vector3()), center = box.getCenter(new THREE.Vector3());
  model.position.sub(center);
  const wrap = new THREE.Group();
  wrap.add(model);
  wrap.scale.setScalar(0.11 / Math.max(size.x, size.y, size.z));   // размах ~0.11 радиуса Земли
  satTemplate = wrap;
  if (state.scenario) buildSceneObjects();
}, undefined, () => { /* файла нет — остаёмся на процедурной модели */ });

// динамические объекты сцены (пересоздаются при загрузке сценария)
export const dyn = { orbits: [], sats: [], isl: null, kSat: 1, kEarth: 1 / R };
const ORBIT_VISUAL = 1.42;   // орбита визуально приподнята: реальные 550 км сливались бы с поверхностью
const toThree = p => new THREE.Vector3(p.x, p.z, -p.y);   // ECEF (Z — север) → Three (Y — вверх)

export function buildSceneObjects() {
  const s = state.scenario, e = s.environment, d = s.design;
  for (const o of [...dyn.orbits, ...dyn.sats.map(x => x.group), dyn.isl].filter(Boolean)) inertial.remove(o);
  dyn.orbits = []; dyn.sats = [];
  dyn.kSat = ORBIT_VISUAL / (R + e.altitude_km);

  d.planes.forEach((p, pi) => {
    const inc = rad(planeInclination(s, p)), ci = Math.cos(inc), si = Math.sin(inc);
    const om = rad(p.raan_deg), co = Math.cos(om), so = Math.sin(om);
    const pts = [];
    for (let i = 0; i <= 180; i++) {
      const u = i / 180 * Math.PI * 2, cu = Math.cos(u), su = Math.sin(u);
      pts.push(toThree({ x: co * cu - so * su * ci, y: so * cu + co * su * ci, z: su * si }).multiplyScalar(ORBIT_VISUAL));
    }
    const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts),
      new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.14 }));
    inertial.add(line); dyn.orbits.push(line);
  });

  const planeIndex = {}; d.planes.forEach((p, i) => planeIndex[p.id] = i);
  const beaconGeo = new THREE.SphereGeometry(0.0025, 8, 8);
  for (const sat of d.satellites) {
    const color = new THREE.Color(0xd6e4ff);   // нейтральный маячок; цветом выделяются только маршрут и отказ
    const group = new THREE.Group();
    const model = satTemplate.clone();
    // бортовой маячок цвета плоскости + мягкое свечение
    const beacon = new THREE.Mesh(beaconGeo, new THREE.MeshBasicMaterial({ color }));
    beacon.position.set(0, 0.011, -0.006);
    const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, color, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: 0.4 }));
    glow.scale.setScalar(0.06);
    group.add(model, beacon, glow);
    inertial.add(group);
    dyn.sats.push({ group, model, beacon, glow, color });
  }

  const n = d.satellites.length, maxEdges = n * (n - 1) / 2;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(maxEdges * 6), 3));
  dyn.isl = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.13 }));
  inertial.add(dyn.isl);
}

export function layout() {
  DPR = Math.min(2, window.devicePixelRatio || 1);
  W = window.innerWidth; H = window.innerHeight;
  renderer.setPixelRatio(DPR);
  renderer.setSize(W, H, false);
  overlay.width = W * DPR; overlay.height = H * DPR;
  octx.setTransform(DPR, 0, 0, DPR, 0, 0);
  camera.aspect = W / H;
  camera.updateProjectionMatrix();
  // по умолчанию: радиус Земли ≈ 0.38 ширины / 0.6 высоты, центр планеты на нижней кромке
  const Rpx = Math.min(W * 0.38, H * 0.6);
  const prevDefault = state.view.fDefault;
  state.view.fDefault = H / (2 * Rpx);
  if (!state.view.f || state.view.f === prevDefault) state.view.f = state.view.fDefault;
  applyCamera();
}

const ZOOM_MIN = 0.3, ZOOM_MAX = 2.4;   // половина высоты кадра в радиусах Земли
// Камера смотрит вдоль -Z на точку (0, ty, 0). Пока Земля не помещается — её центр на нижней кромке,
// при отдалении центр плавно уезжает в середину экрана, и планета видна целиком.
export function applyCamera() {
  const f = state.view.f;
  const tanH = Math.tan(rad(camera.fov / 2));
  const D = f / tanH;
  const ty = f <= 1 ? f : f >= 1.3 ? 0 : (1.3 - f) / 0.3;
  camera.position.set(0, ty, D);
  camera.lookAt(0, ty, 0);
}
// Зум идёт к цели с экспоненциальным сглаживанием в цикле кадров: колесо и кнопки только двигают цель,
// поэтому движение прерываемое и не ступенчатое. При «меньше движения» — сразу к цели.
const REDUCED_MOTION = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
export function zoomBy(factor) {
  const target = state.view.fTarget ?? state.view.f;
  zoomTo(Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, target * factor)));
}
export function zoomTo(f) {
  state.view.fTarget = f;
  if (REDUCED_MOTION) { state.view.f = f; state.view.fTarget = null; applyCamera(); }
}
function settleZoom(dt) {
  const target = state.view.fTarget;
  if (target == null) return;
  const diff = target - state.view.f;
  if (Math.abs(diff) < 1e-4) { state.view.f = target; state.view.fTarget = null; }
  else state.view.f += diff * (1 - Math.exp(-dt * 14));
  applyCamera();
}

// проекция мировой точки на экран + проверка, не спрятана ли она за Землёй
const _v = new THREE.Vector3(), _c = new THREE.Vector3(), _d = new THREE.Vector3();
export function projectWorld(world) {
  _d.copy(world).sub(camera.position);
  const t = Math.min(1, Math.max(0, -camera.position.dot(_d) / Math.max(_d.lengthSq(), 1e-9)));
  _c.copy(camera.position).addScaledVector(_d, t);
  const hidden = t < 1 && _c.length() < 0.999;
  _v.copy(world).project(camera);
  return { sx: (_v.x + 1) / 2 * W, sy: (1 - _v.y) / 2 * H, hidden: hidden || _v.z > 1 };
}

function drawScene(now) {
  const s = state.scenario, snap = state.snap, d = s.design;

  root.rotation.set(state.view.pitch, state.view.yaw, 0);
  inertial.rotation.y = -earthAngle(s, state.t);
  clouds.rotation.y += 0.00004;
  // Солнце из модели: направление в инерциальной системе → в мировую (терминатор движется по Земле со временем)
  root.updateMatrixWorld(true);
  const sunWorld = toThree(sunDirection(s)).applyAxisAngle(new THREE.Vector3(0, 1, 0), inertial.rotation.y).applyEuler(root.rotation).normalize();
  sun.position.copy(sunWorld).multiplyScalar(10);
  sunDir.copy(sunWorld);

  // спутники
  const inert = satInertial(s, state.t);
  const routeSet = new Set(state.route?.path || []);
  dyn.sats.forEach((o, k) => {
    o.group.position.copy(toThree(inert[k])).multiplyScalar(dyn.kSat);
    const sat = d.satellites[k];
    const launched = sat.launch_batch <= d.launch_stage;
    const failed = snap.failed.has(sat.id);
    const inShade = snap.eclipsed[k] && !failed && !routeSet.has(k);
    const col = failed ? new THREE.Color(FAIL_COLOR) : routeSet.has(k) ? new THREE.Color(ROUTE_COLOR) : inShade ? new THREE.Color(0x55607a) : o.color;
    o.beacon.material.color.copy(col); o.glow.material.color.copy(col);
    o.model.visible = launched;          // незапущенные — только маячок-«призрак»
    o.glow.visible = launched;
    o.beacon.material.opacity = launched ? 1 : 0.3; o.beacon.material.transparent = !launched;
    const hi = routeSet.has(k) || state.hover === k;
    o.glow.scale.setScalar(hi ? 0.16 : 0.07);
    o.glow.material.opacity = hi ? 0.9 : 0.4;
    // ориентация: тарелка в надир, панели поперёк направления на Землю
    o.group.lookAt(0, 0, 0);
  });

  // ISL-связи
  const pos = dyn.isl.geometry.attributes.position;
  let n = 0;
  for (const [i, j] of snap.isl) {
    const a = dyn.sats[i].group.position, b = dyn.sats[j].group.position;
    pos.array.set([a.x, a.y, a.z, b.x, b.y, b.z], n * 6); n++;
  }
  pos.needsUpdate = true;
  dyn.isl.geometry.setDrawRange(0, n * 2);

  renderer.render(scene, camera);

  // ---- подписи, маршрут и наземные пункты на 2D-оверлее ----
  octx.clearRect(0, 0, W, H);
  root.updateMatrixWorld(true);
  const satScreen = dyn.sats.map(o => projectWorld(o.group.getWorldPosition(new THREE.Vector3())));

  const seg = (a, b, color, width, glow) => {
    if (a.hidden || b.hidden) return;
    octx.strokeStyle = color; octx.lineWidth = width;
    octx.shadowColor = glow ? color : 'transparent'; octx.shadowBlur = glow ? 12 : 0;
    octx.beginPath(); octx.moveTo(a.sx, a.sy); octx.lineTo(b.sx, b.sy); octx.stroke();
    octx.shadowBlur = 0;
  };
  const path = state.route?.path;
  if (path) for (let i = 0; i + 1 < path.length; i++) seg(satScreen[path[i]], satScreen[path[i + 1]], ROUTE_COLOR, 2.5, true);

  for (const g of s.ground_sites) {
    const gs = snap.ground[g.id];
    const q = projectWorld(toThree(gs.pos).multiplyScalar(dyn.kEarth).applyMatrix4(root.matrixWorld));
    if (q.hidden) continue;
    const isGw = g.role === 'gateway', isSel = g.id === state.clientId;
    const col = gs.offline ? FAIL_COLOR : isSel ? '#ffffff' : 'rgba(225,232,245,0.85)';
    for (const k of gs.visible) {
      const onRoute = path && ((isSel && path[0] === k) || (isGw && g.id === state.route.gateway && path[path.length - 1] === k));
      if (onRoute) seg(q, satScreen[k], ROUTE_COLOR, 2.5, true);
      else if (isSel || isGw) seg(q, satScreen[k], isSel ? 'rgba(255,255,255,0.28)' : 'rgba(255,255,255,0.14)', 1, false);
    }
    // геометрически над горизонтом, но закрыт рельефом/застройкой — красный пунктир
    if ((isSel || isGw) && gs.blocked?.length) {
      octx.setLineDash([3, 4]);
      for (const k of gs.blocked) seg(q, satScreen[k], 'rgba(255,90,90,0.45)', 1, false);
      octx.setLineDash([]);
    }
    const pulse = 1 + 0.25 * Math.sin(now * 0.004);
    octx.strokeStyle = col; octx.lineWidth = isGw ? 2 : 1.5;
    octx.setLineDash(isGw ? [3, 3] : []);
    octx.beginPath(); octx.arc(q.sx, q.sy, (isSel ? 9 : 6) * pulse, 0, Math.PI * 2); octx.stroke();
    octx.setLineDash([]);
    octx.fillStyle = col; octx.shadowColor = col; octx.shadowBlur = 10;
    octx.beginPath(); octx.arc(q.sx, q.sy, 3, 0, Math.PI * 2); octx.fill();
    octx.shadowBlur = 0;
    octx.fillStyle = isSel ? '#fff' : 'rgba(233,237,247,0.9)';
    octx.font = `${isSel ? 600 : 500} 11px Inter, sans-serif`;
    octx.shadowColor = 'rgba(0,0,0,0.9)'; octx.shadowBlur = 4;
    octx.fillText(g.id + (isGw ? ' · шлюз' : ''), q.sx + 12, q.sy + 4);
    octx.shadowBlur = 0;
  }

  d.satellites.forEach((sat, k) => {
    const q = satScreen[k];
    if (q.hidden) return;
    if (snap.failed.has(sat.id)) {
      octx.strokeStyle = FAIL_COLOR; octx.lineWidth = 1.5;
      octx.beginPath(); octx.arc(q.sx, q.sy, 6, 0, Math.PI * 2); octx.stroke();
      octx.beginPath(); octx.moveTo(q.sx - 4, q.sy - 4); octx.lineTo(q.sx + 4, q.sy + 4); octx.stroke();
    }
    if (routeSet.has(k) || state.hover === k) {
      octx.fillStyle = '#fff'; octx.font = '500 11px Inter, sans-serif';
      octx.shadowColor = 'rgba(0,0,0,0.9)'; octx.shadowBlur = 4;
      octx.fillText(sat.id, q.sx + 8, q.sy - 6);
      octx.shadowBlur = 0;
    }
  });

  return satScreen;
}

// клик по Земле → широта/долгота (для установки шлюза)
const raycaster = new THREE.Raycaster();
export function pickLatLon(clientX, clientY) {
  const ndc = new THREE.Vector2(clientX / W * 2 - 1, -(clientY / H) * 2 + 1);
  raycaster.setFromCamera(ndc, camera);
  const hit = raycaster.intersectObject(earth, false)[0];
  if (!hit) return null;
  const p = earth.worldToLocal(hit.point.clone());   // локальные координаты Земли (Three: Y — север)
  const ecef = { x: p.x, y: -p.z, z: p.y };
  const lat = Math.asin(Math.max(-1, Math.min(1, ecef.z / Math.hypot(ecef.x, ecef.y, ecef.z)))) * 180 / Math.PI;
  const lon = Math.atan2(ecef.y, ecef.x) * 180 / Math.PI;
  return { lat, lon };
}


// наложение карты покрытия на глобус (res — результат coverageGrid или null, чтобы снять)
let coverageMesh = null;
export function setCoverageOverlay(res) {
  if (coverageMesh) { root.remove(coverageMesh); coverageMesh.geometry.dispose(); coverageMesh.material.map.dispose(); coverageMesh.material.dispose(); coverageMesh = null; }
  if (!res || !state.showCoverage) return;
  const { lats, lons, values, target } = res;
  const rows = lats.length, cols = lons.length;
  const c = document.createElement('canvas'); c.width = 1440; c.height = 720;
  const g = c.getContext('2d');
  const dLat = lats[1] - lats[0], dLon = lons[1] - lons[0];
  for (let i = 0; i < rows; i++) for (let j = 0; j < cols; j++) {
    const lat0 = lats[i] - dLat / 2, lon0 = lons[j] - dLon / 2;
    g.fillStyle = heat(values[i * cols + j], target).replace('rgb', 'rgba').replace(')', ',0.55)');
    g.fillRect((lon0 + 180) / 360 * c.width, (90 - (lat0 + dLat)) / 180 * c.height, dLon / 360 * c.width + 1, dLat / 180 * c.height + 1);
  }
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
  coverageMesh = new THREE.Mesh(new THREE.SphereGeometry(1.004, 96, 96), new THREE.MeshBasicMaterial({ map: t, transparent: true, depthWrite: false }));
  root.add(coverageMesh);
}


// ---------- главный цикл ----------
let last = performance.now();
let lastProj = null;              // экранные координаты спутников последнего кадра (для hover)
export const getLastProj = () => lastProj;

export function startLoop(onFrame) {
  function frame(now) {
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    if (state.scenario && state.avail) {
      if (state.playing) {
        state.t += dt * state.speed;
        if (state.t >= state.scenario.environment.horizon_s) state.t = 0;
      }
      if (!state.view.drag && !REDUCED_MOTION) state.view.yaw += dt * 0.02;
      settleZoom(dt);
      // привязка к сетке шагов, чтобы совпадать с диаграммой доступности
      const step = state.scenario.environment.step_s;
      const tSnap = Math.min(Math.round(state.t / step) * step, state.scenario.environment.horizon_s - step);
      state.snap = snapshot(state.scenario, tSnap);
      state.route = findRoute(state.scenario, state.snap, state.clientId, state.route);
      lastProj = drawScene(now);
      onFrame?.();
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

window.addEventListener('resize', layout);
layout();
on('scenario', buildSceneObjects);
on('scene:rebuild', buildSceneObjects);
