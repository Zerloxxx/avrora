/* 3D-сцена: Земля, атмосфера, орбиты, модели спутников, ISL; 2D-оверлей подписей и маршрута;
   камера с зумом; главный цикл. Читает state, ничего в модели не меняет. */
import * as THREE from 'three';
import { RoomEnvironment } from '../vendor/jsm/environments/RoomEnvironment.js';
import { R, rad, earthAngle, satInertial, snapshot, findRoute, sunDirection, planeInclination } from './sim.js';
import { state, $, ROUTE_COLOR, FAIL_COLOR, heat, on } from './state.js';
import { toThree, ORBIT_VISUAL, makeStarfield, makeEarth, glowTex, buildProceduralSatellite, loadSatelliteGltf, makeProjector } from './globe.js';

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

scene.add(...makeStarfield());

// Земля с атмосферой — общая фабрика из globe.js (та же и на странице абонента)
const globe = makeEarth(renderer, sunDir);
export const earth = globe.earth;
const clouds = globe.clouds;
root.add(...globe.meshes);

let satTemplate = buildProceduralSatellite();

// необязательная «настоящая» модель аппарата (vendor/satellite.glb)
loadSatelliteGltf(model => { satTemplate = model; if (state.scenario) buildSceneObjects(); });

// динамические объекты сцены (пересоздаются при загрузке сценария)
export const dyn = { orbits: [], sats: [], isl: null, kSat: 1, kEarth: 1 / R };

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

// проекция мировой точки на экран (общая фабрика из globe.js)
const project = makeProjector(camera);
export const projectWorld = world => project(world, W, H);

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
    octx.font = `${isSel ? 600 : 500} 11px 'Golos Text', sans-serif`;
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
      octx.fillStyle = '#fff'; octx.font = '500 11px "Golos Text", sans-serif';
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

/* Главный цикл. Следующий кадр планируется в finally: одно исключение внутри кадра
   не должно навсегда останавливать сцену — на защите это выглядело бы как «всё зависло». */
/* Время модели идёт от настоящих часов, а не от отрисованных кадров.

   Было `state.t += Math.min(0.1, dt) * speed` прямо в кадре, и это врало дважды, стоило окну
   уйти в фон: `requestAnimationFrame` в скрытой вкладке не тикает вовсе, а clamp 0.1 с превращал
   редкий кадр в десятую долю секунды модельного времени. Инженерный вид при этом продолжал
   рассылать такты (setInterval в фоне тормозится до раза в секунду, но работает) — с замороженным
   `t`. Вид абонента жёстко привязывается к каждому такту, поэтому его часы и спутники
   откатывались назад примерно раз в секунду: между тактами он доигрывал вперёд сам, а такт
   возвращал его обратно. Пила. Локально этого не видно, потому что оба окна открыты рядом
   и кадры идут; на публичной ссылке «Вид абонента» открывается новой вкладкой поверх
   инженерной — и ведущий сразу оказывается в фоне.

   Дельта по часам невосприимчива к троттлингу: как бы редко нас ни позвали, модельное время
   сдвинется ровно на прошедшее реальное время × скорость, и назад не уйдёт никогда. */
let clock = performance.now();

export function advanceTime(now = performance.now()) {
  const dt = (now - clock) / 1000;
  clock = now;
  if (!state.scenario || !state.playing) return;
  const H = state.scenario.environment.horizon_s;
  state.t = ((state.t + dt * state.speed) % H + H) % H;
}

/* В фоне кадров нет, поэтому время двигает таймер. Браузер затормозит его до раза в секунду —
   не страшно, дельта считается по часам. Пока окно видимо, этим занимается сам кадр. */
setInterval(() => { if (document.hidden) advanceTime(); }, 250);

export function startLoop(onFrame) {
  function frame(now) {
    try {
      step(now);
    } catch (e) {
      console.error('кадр сцены упал:', e);
    } finally {
      requestAnimationFrame(frame);
    }
  }
  function step(now) {
    // clamp остаётся только для камеры: после долгой паузы большой dt дал бы рывок поворота и зума
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    advanceTime(now);
    if (state.scenario && state.avail) {
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
  }
  requestAnimationFrame(frame);
}

window.addEventListener('resize', layout);
layout();
on('scenario', buildSceneObjects);
on('scene:rebuild', buildSceneObjects);
