/* Страница абонента: что связь над Севером значит для человека в пункте.
   Тот же расчёт (sim.js) и тот же глобус (globe.js), что на инженерном сайте, — числа обязаны совпадать.
   Конфигурация приходит по ссылке #c= (формат — configlink.js) либо берётся встроенный сценарий. */
import * as THREE from 'three';
import { RoomEnvironment } from '../vendor/jsm/environments/RoomEnvironment.js';
import { R, rad, earthAngle, satInertial, snapshot, findRoute, sunDirection, groundPosition,
  computeAvailability, contactWindows, skyView, routeLengthKm, C_LIGHT, REASONS } from './sim.js';
import { toThree, ORBIT_VISUAL, makeStarfield, makeEarth, glowTex,
  buildProceduralSatellite, loadSatelliteGltf, makeProjector } from './globe.js';
import { readHash, decodeDiff, applyDiff } from './configlink.js';
import { startFollower } from './sync.js';
import { fmtTime, pct, drawStrip, ROUTE_COLOR, FAIL_COLOR } from './state.js';

const $ = sel => document.querySelector(sel);
const clone = o => JSON.parse(JSON.stringify(o));
const REDUCED_MOTION = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

// Состояние страницы: плоское и локальное — шина событий здесь избыточна.
const S = {
  scenario: null, scenarioId: null, clientId: null,
  t: 0, live: true,              // live — время модели идёт от текущего UTC
  follow: false, detached: false, speed: 1, playing: true, leaderSeen: 0,
  // follow — временем управляет инженерный вид; detached — житель отцепился руками и такты его не вернут
  avail: null, windows: null, snap: null, route: null,
  view: { yaw: 0, pitch: 0.18, drag: null },
};

const utcNow = () => { const d = new Date(); return d.getUTCHours() * 3600 + d.getUTCMinutes() * 60 + d.getUTCSeconds(); };
const onGrid = t => {
  const e = S.scenario.environment;
  return Math.min(Math.round(t / e.step_s) * e.step_s, e.horizon_s - e.step_s);
};
// округляем до деления на часы, иначе 419.9 мин превращается в «6 ч 60 мин»
const minutes = m => {
  const t = Math.round(m);
  return t >= 60 ? `${Math.floor(t / 60)} ч ${t % 60} мин` : `${t} мин`;
};

let toastTimer = null;
function toast(text, kind = '') {
  const el = $('#toast');
  el.textContent = text; el.className = 'toast ' + kind; el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.hidden = true, 4000);
}

// ---------- сцена ----------
const canvas = $('#globe'), labels = $('#glabels');
const lctx = labels.getContext('2d');
let W = 0, H = 0, DPR = 1;

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
renderer.outputColorSpace = THREE.SRGBColorSpace;
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(38, 1, 0.05, 200);
const project = makeProjector(camera);
scene.environment = new THREE.PMREMGenerator(renderer).fromScene(new RoomEnvironment(renderer), 0.04).texture;

const sun = new THREE.DirectionalLight(0xffffff, 2.6);
sun.position.set(-4, 2.2, 5);
scene.add(sun, new THREE.AmbientLight(0x334466, 0.45));
const sunDir = sun.position.clone().normalize();
scene.add(...makeStarfield());

const rootUser = new THREE.Group();      // поворот пальцем
const globeFrame = new THREE.Group();    // разворот так, чтобы пункт жителя смотрел в камеру
scene.add(rootUser); rootUser.add(globeFrame);

// на телефоне берём текстуру 2048 вместо 4096 — вдвое меньше трафика и памяти
const globe = makeEarth(renderer, sunDir, { lowDetail: true });
globeFrame.add(...globe.meshes);

const inertial = new THREE.Group();      // спутники и связи — вращаются относительно Земли
globeFrame.add(inertial);

let satTemplate = buildProceduralSatellite();
loadSatelliteGltf(model => { satTemplate = model; if (S.scenario) buildSats(); });

const dyn = { sats: [], isl: null, route: null, kSat: 1, kEarth: 1 / R };

function buildSats() {
  for (const o of [...dyn.sats.map(x => x.group), dyn.isl, dyn.route].filter(Boolean)) inertial.remove(o);
  dyn.sats = [];
  const s = S.scenario, d = s.design;
  dyn.kSat = ORBIT_VISUAL / (R + s.environment.altitude_km);

  const beaconGeo = new THREE.SphereGeometry(0.0025, 8, 8);
  for (let i = 0; i < d.satellites.length; i++) {
    const color = new THREE.Color(0xd6e4ff);
    const group = new THREE.Group();
    const model = satTemplate.clone();
    const beacon = new THREE.Mesh(beaconGeo, new THREE.MeshBasicMaterial({ color }));
    beacon.position.set(0, 0.011, -0.006);
    const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, color, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: 0.4 }));
    glow.scale.setScalar(0.06);
    group.add(model, beacon, glow);
    inertial.add(group);
    dyn.sats.push({ group, model, beacon, glow, color });
  }

  const maxEdges = d.satellites.length * (d.satellites.length - 1) / 2;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(maxEdges * 6), 3));
  dyn.isl = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.1 }));
  inertial.add(dyn.isl);

  // золотая ломаная маршрута: пункт → аппараты → шлюз (максимум аппаратов + 2 точки)
  const rgeo = new THREE.BufferGeometry();
  rgeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array((d.satellites.length + 2) * 3), 3));
  dyn.route = new THREE.Line(rgeo, new THREE.LineBasicMaterial({ color: ROUTE_COLOR, linewidth: 2 }));
  dyn.route.frustumCulled = false;
  globeFrame.add(dyn.route);   // концы лежат на Земле, поэтому не в inertial
}

// Развернуть глобус так, чтобы выбранный пункт смотрел в камеру (+Z).
function faceClient() {
  const site = S.scenario.ground_sites.find(g => g.id === S.clientId);
  if (!site) return;
  const dir = toThree(groundPosition(site)).normalize();
  globeFrame.quaternion.setFromUnitVectors(dir, new THREE.Vector3(0, 0, 1));
}

function layout() {
  DPR = Math.min(2, window.devicePixelRatio || 1);
  const box = canvas.getBoundingClientRect();
  W = box.width; H = box.height;
  renderer.setPixelRatio(DPR);
  renderer.setSize(W, H, false);
  labels.width = W * DPR; labels.height = H * DPR;
  lctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  camera.aspect = W / H;
  camera.updateProjectionMatrix();
  const f = 1.55;                                  // половина кадра в радиусах Земли — планета целиком
  camera.position.set(0, 0, f / Math.tan(rad(camera.fov / 2)));
  camera.lookAt(0, 0, 0);
}

const ecefToWorld = p => toThree(p).multiplyScalar(dyn.kEarth).applyMatrix4(globeFrame.matrixWorld);

function drawGlobe() {
  const s = S.scenario, snap = S.snap, d = s.design;
  rootUser.rotation.set(S.view.pitch, S.view.yaw, 0);
  inertial.rotation.y = -earthAngle(s, S.t);
  if (!REDUCED_MOTION) globe.clouds.rotation.y += 0.00004;

  scene.updateMatrixWorld(true);
  const sunWorld = toThree(sunDirection(s))
    .applyAxisAngle(new THREE.Vector3(0, 1, 0), inertial.rotation.y)
    .applyQuaternion(globeFrame.quaternion)
    .applyEuler(rootUser.rotation).normalize();
  sun.position.copy(sunWorld).multiplyScalar(10);
  sunDir.copy(sunWorld);

  const inert = satInertial(s, S.t);
  const routeSet = new Set(S.route?.path || []);
  dyn.sats.forEach((o, k) => {
    o.group.position.copy(toThree(inert[k])).multiplyScalar(dyn.kSat);
    const sat = d.satellites[k];
    const launched = sat.launch_batch <= d.launch_stage;
    const failed = snap.failed.has(sat.id);
    const onRoute = routeSet.has(k);
    const col = failed ? new THREE.Color(FAIL_COLOR) : onRoute ? new THREE.Color(ROUTE_COLOR) : o.color;
    o.beacon.material.color.copy(col); o.glow.material.color.copy(col);
    o.model.visible = launched; o.glow.visible = launched;
    o.glow.scale.setScalar(onRoute ? 0.16 : 0.07);
    o.group.lookAt(0, 0, 0);
  });

  // ISL
  const pos = dyn.isl.geometry.attributes.position;
  let n = 0;
  for (const [i, j] of snap.isl) {
    const a = dyn.sats[i].group.position, b = dyn.sats[j].group.position;
    pos.array.set([a.x, a.y, a.z, b.x, b.y, b.z], n * 6); n++;
  }
  pos.needsUpdate = true;
  dyn.isl.geometry.setDrawRange(0, n * 2);

  // маршрут целиком, включая две наземные линии
  const rpos = dyn.route.geometry.attributes.position;
  const path = S.route?.path;
  if (path) {
    const site = s.ground_sites.find(g => g.id === S.clientId);
    const gw = s.ground_sites.find(g => g.id === S.route.gateway);
    const pts = [toThree(groundPosition(site)).multiplyScalar(dyn.kEarth)];
    for (const k of path) pts.push(toThree(inert[k]).multiplyScalar(dyn.kSat).applyAxisAngle(new THREE.Vector3(0, 1, 0), inertial.rotation.y));
    pts.push(toThree(groundPosition(gw)).multiplyScalar(dyn.kEarth));
    pts.forEach((p, i) => rpos.array.set([p.x, p.y, p.z], i * 3));
    rpos.needsUpdate = true;
    dyn.route.geometry.setDrawRange(0, pts.length);
    dyn.route.visible = true;
  } else dyn.route.visible = false;

  renderer.render(scene, camera);

  // ---- подписи на 2D-слое ----
  lctx.clearRect(0, 0, W, H);
  const label = (q, text, color, bold) => {
    if (q.hidden) return;
    lctx.fillStyle = color;
    lctx.font = `${bold ? 600 : 500} 11px 'Golos Text', system-ui, sans-serif`;
    lctx.shadowColor = 'rgba(0,0,0,0.9)'; lctx.shadowBlur = 4;
    lctx.fillText(text, q.sx + 10, q.sy + 4);
    lctx.shadowBlur = 0;
  };
  const mark = (q, color, r, dashed) => {
    if (q.hidden) return;
    lctx.strokeStyle = color; lctx.lineWidth = 1.6;
    lctx.setLineDash(dashed ? [3, 3] : []);
    lctx.beginPath(); lctx.arc(q.sx, q.sy, r, 0, Math.PI * 2); lctx.stroke();
    lctx.setLineDash([]);
    lctx.fillStyle = color;
    lctx.beginPath(); lctx.arc(q.sx, q.sy, 2.5, 0, Math.PI * 2); lctx.fill();
  };
  for (const g of s.ground_sites) {
    const isMe = g.id === S.clientId, isGw = g.role === 'gateway';
    if (!isMe && !isGw) continue;
    const q = project(ecefToWorld(snap.ground[g.id].pos), W, H);
    const col = snap.ground[g.id].offline ? FAIL_COLOR : isMe ? '#ffffff' : 'rgba(225,232,245,0.85)';
    mark(q, col, isMe ? 8 : 6, isGw);
    label(q, isMe ? 'вы' : g.id + ', шлюз', col, isMe);
  }
  if (path) {
    const k = path[0];
    const q = project(dyn.sats[k].group.getWorldPosition(new THREE.Vector3()), W, H);
    label(q, d.satellites[k].id, ROUTE_COLOR, true);
  }
}

// ---------- расчёт и текст ----------
function recompute() {
  S.avail = computeAvailability(S.scenario)[S.clientId];
  S.windows = contactWindows(S.scenario, S.clientId);
  faceClient();
  renderDay();
  renderClients();
}

const leaderPresent = () => Date.now() - S.leaderSeen < 3000;

let lastMark = -1;
function renderStatus() {
  const s = S.scenario;
  const has = !!S.route?.path;
  $('#status').className = 'status ' + (has ? 'ok' : 'bad');
  $('#status-big').textContent = has ? 'Связь есть' : 'Связи нет';

  // сколько осталось / сколько ждать — из расписания окон, а не отдельным расчётом
  const t = S.t;
  const seg = [...S.windows.windows, ...S.windows.gaps].find(x => x.start_s <= t && t < x.end_s);
  let sub = '';
  if (has) {
    const left = seg ? (seg.end_s - t) / 60 : 0;
    const sat = s.design.satellites[S.route.path[0]].id;
    sub = `ещё ${minutes(left)}, через аппарат ${sat}`;
  } else {
    const next = S.windows.windows.find(w => w.start_s > t);
    const reason = seg?.reason ? REASONS[seg.reason] : '';
    sub = next ? `появится в ${fmtTime(next.start_s)}, через ${minutes((next.start_s - t) / 60)}` : 'до конца суток связи не будет';
    if (reason) sub += `. Причина: ${reason}`;
  }
  $('#status-sub').textContent = sub;

  // через какой спутник и с какой задержкой
  const box = $('#route-info');
  if (has) {
    const snap = S.snap, site = snap.ground[S.clientId], gw = snap.ground[S.route.gateway];
    const km = routeLengthKm(snap, S.route.path, site.pos, gw.pos);
    const chain = S.route.path.map(k => s.design.satellites[k].id).join(' → ');
    box.innerHTML = `<div class="kv"><span>${S.route.path.length === 1 ? 'Спутник' : 'Цепочка спутников'}</span><b>${chain}</b></div>
      <div class="kv"><span>Наземная станция</span><b>${S.route.gateway}</b></div>
      <div class="kv"><span>Сигнал идёт</span><b>${(km / C_LIGHT * 1000).toFixed(0)} мс</b></div>`;
  } else {
    box.innerHTML = `<div class="kv muted"><span>Сейчас сигналу не через что пройти до наземной станции</span></div>`;
  }

  // спутники над головой; закрытые рельефом показываем отдельно — для жителя это другой ответ
  const sky = skyView(s, S.clientId, S.t);
  const onRoute = new Set(S.route?.path || []);
  const dir = az => ['С','СВ','В','ЮВ','Ю','ЮЗ','З','СЗ'][Math.round(az / 45) % 8];
  $('#sky-list').innerHTML = sky.length
    ? sky.map(x => `<div class="sky ${onRoute.has(x.index) ? 'on' : ''} ${x.blocked ? 'blocked' : ''}">
        <b>${x.id}</b><span>${x.elDeg.toFixed(0)}° над горизонтом</span>
        <span>${dir(x.azDeg)}, ${x.rangeKm.toFixed(0)} км</span>
        ${onRoute.has(x.index) ? '<i>передаёт ваш сигнал</i>'
          : x.blocked ? `<i class="b">за рельефом, закрытие ${x.maskDeg.toFixed(0)}°</i>` : ''}</div>`).join('')
    : '<div class="kv muted"><span>Сейчас над вами нет ни одного спутника достаточно высоко</span></div>';

  // если у пункта задан рельеф, говорим об этом прямо: иначе непонятно, почему спутник есть, а связи нет
  const site = s.ground_sites.find(g => g.id === S.clientId);
  const nBlocked = sky.filter(x => x.blocked).length;
  $('#terrain-note').innerHTML = site?.horizon_mask
    ? `Здесь учтены горы и дома вокруг: они закрывают небо до ${Math.max(...site.horizon_mask).toFixed(0)}° над горизонтом. `
      + `Сейчас за ними ${nBlocked === 0 ? 'никого нет' : nBlocked === 1 ? 'один спутник' : `${nBlocked} спутников`}.`
    : 'Считаем как на открытом месте: спутник виден, если он выше ' + s.environment.min_elevation_deg + '° над горизонтом.';

  // отметка «сейчас» на ленте суток: раз в секунду, чтобы не перерисовывать канвас каждый кадр
  const mark = stripMarker();
  if (mark !== lastMark) { lastMark = mark; drawStrip($('#strip'), S.avail.ok, mark); }

  $('#clock-time').textContent = fmtTime(S.t);
  const leader = leaderPresent();
  // ведущий в фоне — такты не идут, но скорость и момент у нас его: так и говорим
  $('#clock-mode').textContent = S.follow ? `${leader ? 'за инженерным видом' : 'инженерный вид в фоне'}, ×${Math.round(S.speed / 60)}`
    : S.live ? 'сейчас, UTC' : 'выбранный момент';
  const btn = $('#btn-live');
  if (S.follow) { btn.hidden = false; btn.textContent = 'Сейчас'; }
  else if (leader) { btn.hidden = false; btn.textContent = 'За инженером'; }
  else { btn.hidden = S.live; btn.textContent = 'Сейчас'; }
  const scrub = $('#scrub');
  if (document.activeElement !== scrub) scrub.value = onGrid(S.t);
}

const stripMarker = () => Math.round(S.t / S.windows.step_s);

function renderDay() {
  const w = S.windows, a = S.avail, target = S.scenario.environment.target_availability;
  drawStrip($('#strip'), a.ok, stripMarker());
  $('#day-stats').innerHTML = `
    <div class="stat"><b class="${a.availability >= target ? 'good' : 'bad'}">${pct(a.availability)}</b><span>времени со связью</span></div>
    <div class="stat"><b>${w.windows.length}</b><span>сеансов связи</span></div>
    <div class="stat"><b>${w.gaps.length}</b><span>перерывов</span></div>
    <div class="stat"><b>${minutes(w.worstGap?.durMin ?? 0)}</b><span>самый долгий перерыв</span></div>`;

  const t = S.t;
  const next = w.windows.filter(x => x.end_s > t).slice(0, 5);
  $('#windows-list').innerHTML = next.length
    ? next.map(x => `<div class="win ${x.start_s <= t ? 'now' : ''}">
        <b>${fmtTime(x.start_s)} — ${fmtTime(x.end_s)}</b>
        <span>${minutes(x.durMin)}</span>
        ${x.start_s <= t ? '<i>сейчас</i>' : ''}</div>`).join('')
    : '<div class="kv muted"><span>До конца дня связи больше не будет</span></div>';
}

function renderClients() {
  const seg = $('#client-seg');
  seg.innerHTML = '';
  for (const c of S.scenario.ground_sites.filter(g => g.role === 'client')) {
    const b = document.createElement('button');
    b.textContent = c.id === 'MY' ? 'Моя точка' : (c.name && c.name.length <= 14 ? c.name : c.id);
    b.className = c.id === S.clientId ? 'active' : '';
    b.onclick = () => { S.clientId = c.id; recompute(); };
    seg.appendChild(b);
  }
  const site = S.scenario.ground_sites.find(g => g.id === S.clientId);
  $('#foot').textContent = `${site.name || site.id}, ${site.lat_deg.toFixed(2)}° с.ш., ${site.lon_deg.toFixed(2)}° в.д. `
    + `Сценарий «${S.scenario.meta?.title || S.scenarioId}». Расчёт тот же, что в инженерном виде.`;
}

/* Применить дифф конфигурации: и на старте из ссылки, и когда инженерный вид что-то поменял.
   Свой выбранный пункт сохраняем — точка жителя его, а не ведущего. */
function applyConfig(diff) {
  const src = window.SCENARIOS?.[diff.id] ?? window.SCENARIOS?.[S.scenarioId];
  if (!src) return false;
  const satsBefore = S.scenario?.design.satellites.length ?? -1;
  const keepClient = S.clientId;
  const myPoint = S.scenario?.ground_sites.find(g => g.id === 'MY');
  S.scenarioId = diff.id ?? S.scenarioId;
  S.scenario = clone(src);
  applyDiff(S.scenario, diff);
  if (myPoint && !S.scenario.ground_sites.some(g => g.id === 'MY')) S.scenario.ground_sites.push(myPoint);
  const clients = S.scenario.ground_sites.filter(g => g.role === 'client');
  S.clientId = clients.some(c => c.id === keepClient) ? keepClient
    : (diff.c && clients.some(c => c.id === diff.c)) ? diff.c : clients[0].id;
  if (S.scenario.design.satellites.length !== satsBefore) buildSats();
  recompute();
  return true;
}

// ---------- геолокация ----------
function useMyLocation() {
  if (!navigator.geolocation) { toast('Браузер не умеет геолокацию', 'bad'); return; }
  $('#btn-geo').disabled = true;
  navigator.geolocation.getCurrentPosition(p => {
    $('#btn-geo').disabled = false;
    const lat = p.coords.latitude, lon = p.coords.longitude;
    const sites = S.scenario.ground_sites;
    const mine = sites.find(g => g.id === 'MY');
    if (mine) { mine.lat_deg = +lat.toFixed(3); mine.lon_deg = +lon.toFixed(3); }
    else sites.push({ id: 'MY', name: 'Моя точка', role: 'client', lat_deg: +lat.toFixed(3), lon_deg: +lon.toFixed(3) });
    S.clientId = 'MY';
    recompute();
    toast(`Считаю для ${lat.toFixed(2)}°, ${lon.toFixed(2)}°`, 'ok');
  }, err => {
    $('#btn-geo').disabled = false;
    toast(err.code === 1 ? 'Доступ к геопозиции не разрешён' : 'Не удалось определить местоположение', 'bad');
  }, { timeout: 10000 });
}

// ---------- события ----------
labels.addEventListener('pointerdown', ev => {
  ev.preventDefault();
  S.view.drag = { x: ev.clientX, y: ev.clientY, yaw: S.view.yaw, pitch: S.view.pitch };
  document.body.classList.add('dragging');
});
window.addEventListener('pointerup', () => { S.view.drag = null; document.body.classList.remove('dragging'); });
labels.addEventListener('pointermove', ev => {
  const dr = S.view.drag;
  if (!dr) return;
  S.view.yaw = dr.yaw + (ev.clientX - dr.x) * 0.006;
  S.view.pitch = Math.max(-0.9, Math.min(0.9, dr.pitch + (ev.clientY - dr.y) * 0.005));
});

$('#scrub').oninput = ev => { S.live = false; S.follow = false; S.detached = true; S.t = +ev.target.value; };
$('#btn-live').onclick = () => {
  if (S.follow || !leaderPresent()) {            // отцепиться от ведущего / вернуться к живому времени
    S.follow = false; S.detached = true; S.live = true;
  } else {                                        // снова пойти за инженерным видом
    S.detached = false; S.live = false;
  }
  renderDay();
};
$('#btn-geo').onclick = useMyLocation;
window.addEventListener('resize', layout);

// ---------- старт ----------
const SCENARIOS = window.SCENARIOS || {};
let diff = null;
const b64 = readHash(location.hash);
if (b64) diff = decodeDiff(b64);

const id = (diff && SCENARIOS[diff.id]) ? diff.id : Object.keys(SCENARIOS)[0];
if (!id) {
  toast('Не найден data/scenarios.js', 'bad');
} else {
  S.scenarioId = id;
  S.scenario = clone(SCENARIOS[id]);
  if (diff) applyDiff(S.scenario, diff);
  const clients = S.scenario.ground_sites.filter(g => g.role === 'client');
  S.clientId = (diff?.c && clients.some(c => c.id === diff.c)) ? diff.c : clients[0].id;
  S.t = onGrid(utcNow() % S.scenario.environment.horizon_s);

  // ссылка назад в инженерный вид — с той же конфигурацией
  $('#to-site').href = new URL('../index.html', import.meta.url).pathname + (b64 ? '#c=' + b64 : '');

  buildSats();
  recompute();
  layout();

  let last = performance.now();
  (function frame(now) {
    const dt = Math.min(0.5, (now - last) / 1000);
    last = now;
    const H = S.scenario.environment.horizon_s;
    if (S.follow) {
      // между тактами ведущего доигрываем время сами — движение плавное на 60 кадрах
      if (S.playing) { S.t += dt * S.speed; if (S.t >= H) S.t -= H; }
    } else if (S.live) S.t = utcNow() % H;
    S.snap = snapshot(S.scenario, onGrid(S.t));
    S.route = findRoute(S.scenario, S.snap, S.clientId, S.route);
    drawGlobe();
    renderStatus();
    requestAnimationFrame(frame);
  })(last);

  // расписание пересобираем раз в минуту: окна сдвигаются относительно «сейчас»
  setInterval(() => { if (S.live) renderDay(); }, 60000);

  /* Следуем за инженерным видом, если он открыт в этом же браузере.
     Такт задаёт момент и скорость; конфигурацию применяем, только если она реально изменилась. */
  let lastDiff = b64;
  startFollower({
    onTick: m => {
      // restored — состояние поднято с диска при возврате на экран, живым ведущим это не считается
      if (!m.restored) S.leaderSeen = Date.now();
      if (Number.isFinite(m.speed)) S.speed = m.speed;
      if (S.detached) return;              // отцепился руками — время не трогаем
      const first = !S.follow;
      S.follow = true; S.live = false;
      const H = S.scenario.environment.horizon_s;
      S.t = ((m.t % H) + H) % H;           // восстановленный момент мог уйти за горизонт
      S.playing = m.playing;
      if (first) { renderDay(); toast(m.restored ? 'Продолжаю с момента инженерного вида' : 'Следую за инженерным видом', 'ok'); }
    },
    onConfig: d => {
      if (!d || d === lastDiff) return;
      lastDiff = d;
      const diff = decodeDiff(d);
      if (diff && applyConfig(diff)) toast('Конфигурация обновлена с инженерного вида', 'ok');
    },
  });
}

window.S = S;   // отладка из консоли
