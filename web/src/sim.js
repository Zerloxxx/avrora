/* =====================================================================
   Расчётное ядро — порт «Расчетный модуль/geometry.py» на JS.
   Используется и интерфейсом (app.js), и фоновым воркером (worker.js).
   ===================================================================== */

export const R = 6371.0;
export const MU = 398600.435507;
export const OMEGA = 2 * Math.PI / 86164.09054;
export const rad = d => d * Math.PI / 180;

// Угол поворота Земли на момент t.
export const earthAngle = (s, t) => rad(s.environment.earth_angle0_deg) + OMEGA * t;

// Позиции спутников в инерциальной системе (ось Z — север), км.
export function satInertial(s, t) {
  const e = s.environment, d = s.design;
  const pm = {};
  d.planes.forEach(p => pm[p.id] = p);
  const r = R + e.altitude_km;
  const n = Math.sqrt(MU / (r * r * r));
  // наклонение общее (environment), но плоскость может задать своё — «разные оси» группировки
  const trig = {};
  for (const p of d.planes) { const inc = rad(planeInclination(s, p)); trig[p.id] = [Math.cos(inc), Math.sin(inc)]; }
  return d.satellites.map(x => {
    const p = pm[x.plane_id];
    const [ci, si] = trig[p.id];
    const u = rad(x.slot_deg + p.phase_deg) + n * t, om = rad(p.raan_deg);
    const cu = Math.cos(u), su = Math.sin(u), co = Math.cos(om), so = Math.sin(om);
    return { x: r * (co * cu - so * su * ci), y: r * (so * cu + co * su * ci), z: r * su * si };
  });
}
export const planeInclination = (s, p) => Number.isFinite(p.inclination_deg) ? p.inclination_deg : s.environment.inclination_deg;
export const maxBatch = s => Math.max(1, ...s.design.satellites.map(x => x.launch_batch));

// Позиции спутников в связанной с Землёй системе (ECEF), км.
export function satPositions(s, t) {
  const th = earthAngle(s, t), c = Math.cos(th), ss = Math.sin(th);
  return satInertial(s, t).map(({ x, y, z }) => ({ x: x * c + y * ss, y: -x * ss + y * c, z }));
}

export const C_LIGHT = 299792.458;   // км/с

// Направление на Солнце в инерциальной системе (фиксированное на сутки; можно задать в environment.sun_eci).
// По умолчанию подобрано так, что в 12:00 модельного времени Солнце над нулевым меридианом, склонение ~+8°.
export function sunDirection(s) {
  const v = s.environment.sun_eci || [Math.cos(rad(192)), Math.sin(rad(192)), 0.15];
  const n = Math.hypot(v[0], v[1], v[2]) || 1;
  return { x: v[0] / n, y: v[1] / n, z: v[2] / n };
}

// Цилиндрическая тень Земли (как sunlight() в geometry.py): true — аппарат в тени.
export function eclipseFlags(s, t) {
  const sun = sunDirection(s);
  return satInertial(s, t).map(p => {
    const proj = p.x * sun.x + p.y * sun.y + p.z * sun.z;
    const px = p.x - proj * sun.x, py = p.y - proj * sun.y, pz = p.z - proj * sun.z;
    return proj < 0 && Math.hypot(px, py, pz) < R;
  });
}

export function groundPosition(g) {
  const lat = rad(g.lat_deg), lon = rad(g.lon_deg);
  return { x: R * Math.cos(lat) * Math.cos(lon), y: R * Math.cos(lat) * Math.sin(lon), z: R * Math.sin(lat) };
}

// Оси местной системы пункта (ECEF): восток, север, зенит — для азимута и возвышения.
export function siteFrame(g) {
  const lat = rad(g.lat_deg), lon = rad(g.lon_deg);
  const sl = Math.sin(lat), cl = Math.cos(lat), so = Math.sin(lon), co = Math.cos(lon);
  return {
    pos: groundPosition(g),
    east: { x: -so, y: co, z: 0 },
    north: { x: -sl * co, y: -sl * so, z: cl },
    up: { x: cl * co, y: cl * so, z: sl },
  };
}
// Азимут (от севера по часовой, 0…360) и возвышение спутника над пунктом, градусы.
export function lookAngles(frame, p) {
  const dx = p.x - frame.pos.x, dy = p.y - frame.pos.y, dz = p.z - frame.pos.z;
  const e = dx * frame.east.x + dy * frame.east.y + dz * frame.east.z;
  const n = dx * frame.north.x + dy * frame.north.y + dz * frame.north.z;
  const u = dx * frame.up.x + dy * frame.up.y + dz * frame.up.z;
  const range = Math.sqrt(dx * dx + dy * dy + dz * dz);
  const az = (Math.atan2(e, n) * 180 / Math.PI + 360) % 360;
  return { az_deg: az, el_deg: Math.asin(u / range) * 180 / Math.PI, range_km: range };
}

// Маска горизонта пункта: угол закрытия рельефом/застройкой по секторам азимута (сектор k — [k·360/N, (k+1)·360/N)).
// Спутник виден, если возвышение ≥ max(min_elevation_deg, маска[сектор]). Без маски — правило кейса.
export const MASK_SECTORS = 36;
export const maskSector = (mask, azDeg) => mask[Math.floor(((azDeg % 360) + 360) % 360 / (360 / mask.length)) % mask.length];
export const siteMask = g => Array.isArray(g.horizon_mask) && g.horizon_mask.length >= 4 ? g.horizon_mask : null;

// Угол закрытия однородной застройкой: здания высотой h_m на расстоянии d_m от антенны (антенна на высоте ant_m).
export const buildingAngle = (h_m, d_m, ant_m = 2) => Math.max(0, Math.atan2(h_m - ant_m, d_m) * 180 / Math.PI);

// Пресеты местности: как считать маску, если нет данных о рельефе.
export const TERRAIN_PRESETS = {
  open:     { label: 'открытая тундра / поле', hint: 'закрытий нет — правило кейса',        build: () => uniformMask(0) },
  village:  { label: 'посёлок (1–2 этажа)',    hint: 'дома ~8 м в 40 м от антенны',         build: () => uniformMask(buildingAngle(8, 40)) },
  town:     { label: 'город (5 этажей)',        hint: 'дома ~16 м в 50 м',                   build: () => uniformMask(buildingAngle(16, 50)) },
  city:     { label: 'плотный город (9+ этажей)', hint: 'дома ~30 м в 60 м',                build: () => uniformMask(buildingAngle(30, 60)) },
  valley:   { label: 'горная долина',           hint: 'хребет 25° с юга (±60°), 6° вокруг', build: () => sectorMask(6, 120, 240, 25) },
  roof:     { label: 'антенна на крыше',        hint: 'выше застройки, закрытие 3°',        build: () => uniformMask(3) },
};
export const uniformMask = deg => Array.from({ length: MASK_SECTORS }, () => +deg.toFixed(2));
export function sectorMask(baseDeg, azFrom, azTo, deg) {
  const m = uniformMask(baseDeg);
  for (let k = 0; k < MASK_SECTORS; k++) {
    const az = (k + 0.5) * 360 / MASK_SECTORS;
    const inside = azFrom <= azTo ? (az >= azFrom && az < azTo) : (az >= azFrom || az < azTo);
    if (inside) m[k] = +deg.toFixed(2);
  }
  return m;
}
// Маска по профилям рельефа: h0 — высота пункта (м), profiles[k] — [{dist_km, h_m}, …] вдоль азимута сектора k.
// Учитывается понижение горизонта из-за кривизны Земли: d²/(2R).
export function maskFromProfiles(h0_m, profiles, ant_m = 2) {
  return profiles.map(pr => {
    let best = 0;
    for (const { dist_km, h_m } of pr) {
      if (!(dist_km > 0)) continue;
      const drop_m = dist_km * dist_km / (2 * R) * 1000;
      const ang = Math.atan2(h_m - h0_m - ant_m - drop_m, dist_km * 1000) * 180 / Math.PI;
      if (ang > best) best = ang;
    }
    return +best.toFixed(2);
  });
}

// Снимок сети: активные аппараты, ISL-рёбра, видимость с земли.
export function snapshot(s, t) {
  const e = s.environment, d = s.design;
  const pos = satPositions(s, t);
  const failed = new Set(s.failures.filter(f => f.start_s <= t && t < f.end_s).map(f => f.satellite_id));
  const active = d.satellites.map(x => x.launch_batch <= d.launch_stage && !failed.has(x.id));
  const N = pos.length;
  // тень: по умолчанию только информация для сцены; при eclipse_isl_off аппарат в тени не ретранслирует
  const eclipsed = eclipseFlags(s, t);
  const relay = e.eclipse_isl_off ? active.map((a, k) => a && !eclipsed[k]) : active;
  const adj = Array.from({ length: N }, () => []);
  const isl = [];
  const range2 = e.isl_range_km * e.isl_range_km;
  for (let i = 0; i < N; i++) {
    if (!active[i]) continue;
    const a = pos[i];
    for (let j = i + 1; j < N; j++) {
      if (!relay[j] || !relay[i]) continue;
      const b = pos[j];
      const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 >= range2) continue;
      // ближайшая к центру Земли точка отрезка — линия не должна пересекать Землю
      let lam = -(a.x * dx + a.y * dy + a.z * dz) / Math.max(d2, 1e-12);
      lam = Math.min(1, Math.max(0, lam));
      const cx = a.x + lam * dx, cy = a.y + lam * dy, cz = a.z + lam * dz;
      if (cx * cx + cy * cy + cz * cz <= R * R) continue;
      adj[i].push(j); adj[j].push(i);
      isl.push([i, j]);
    }
  }
  const ground = {};
  const sinMin = Math.sin(rad(e.min_elevation_deg));
  for (const g of s.ground_sites) {
    const gp = groundPosition(g);
    const offline = s.gateway_outages.some(f => f.gateway_id === g.id && f.start_s <= t && t < f.end_s);
    const mask = siteMask(g);
    const frame = mask ? siteFrame(g) : null;
    const sinMask = mask ? mask.map(m => Math.sin(rad(m))) : null;
    const visible = [], blocked = [];
    for (let k = 0; k < N; k++) {
      if (!active[k]) continue;
      const dx = pos[k].x - gp.x, dy = pos[k].y - gp.y, dz = pos[k].z - gp.z;
      const dl = Math.sqrt(dx * dx + dy * dy + dz * dz);
      const sinEl = (dx * gp.x + dy * gp.y + dz * gp.z) / (R * dl);
      if (sinEl < sinMin) continue;                       // правило кейса: возвышение ≥ min_elevation_deg
      if (mask) {                                         // рельеф/застройка: возвышение ≥ маска[азимут]
        const east = dx * frame.east.x + dy * frame.east.y + dz * frame.east.z;
        const north = dx * frame.north.x + dy * frame.north.y + dz * frame.north.z;
        const az = (Math.atan2(east, north) * 180 / Math.PI + 360) % 360;
        const sec = Math.floor(az / (360 / mask.length)) % mask.length;
        if (sinEl < sinMask[sec]) { blocked.push(k); continue; }
      }
      visible.push(k);
    }
    ground[g.id] = { pos: gp, offline, visible: offline ? [] : visible, visibleRaw: visible, blocked };
  }
  return { t, pos, active, failed, adj, isl, ground, eclipsed };
}

// Кратчайший маршрут клиент → спутники → шлюз (BFS по числу хопов).
export function findRoute(s, snap, clientId, prevRoute = null) {
  const c = snap.ground[clientId];
  if (!c || c.visible.length === 0) return { path: null, reason: 'no_sat' };
  // «липкая» маршрутизация: прежний маршрут сохраняется, пока все его звенья существуют
  if (prevRoute?.path && routeValid(snap, prevRoute, clientId)) return { path: prevRoute.path, gateway: prevRoute.gateway, reason: null, kept: true };
  const gateways = s.ground_sites.filter(g => g.role === 'gateway');
  if (gateways.every(g => snap.ground[g.id].offline)) return { path: null, reason: 'gw_offline' };
  const target = new Map();
  for (const g of gateways) for (const k of snap.ground[g.id].visible) if (!target.has(k)) target.set(k, g.id);
  if (target.size === 0) return { path: null, reason: 'no_gw_contact' };
  const prev = new Array(snap.pos.length).fill(-2);
  const queue = [];
  for (const k of c.visible) { prev[k] = -1; queue.push(k); }
  for (let qi = 0; qi < queue.length; qi++) {
    const k = queue[qi];
    if (target.has(k)) {
      const path = [];
      for (let x = k; x !== -1; x = prev[x]) path.unshift(x);
      return { path, gateway: target.get(k), reason: null };
    }
    for (const nb of snap.adj[k]) if (prev[nb] === -2) { prev[nb] = k; queue.push(nb); }
  }
  return { path: null, reason: 'net_split' };
}

// Длина маршрута в км: пункт → спутники → шлюз.
export function routeLengthKm(snap, path, clientPos, gatewayPos) {
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
  let L = dist(clientPos, snap.pos[path[0]]);
  for (let i = 0; i + 1 < path.length; i++) L += dist(snap.pos[path[i]], snap.pos[path[i + 1]]);
  return L + dist(snap.pos[path[path.length - 1]], gatewayPos);
}

function routeValid(snap, r, clientId) {
  const p = r.path;
  const c = snap.ground[clientId], g = snap.ground[r.gateway];
  if (!c || !g || g.offline) return false;
  if (!c.visible.includes(p[0]) || !g.visible.includes(p[p.length - 1])) return false;
  for (let i = 0; i + 1 < p.length; i++) if (!snap.adj[p[i]].includes(p[i + 1])) return false;
  return true;
}

export const REASONS = {
  no_sat: 'нет видимого спутника над пунктом',
  gw_offline: 'шлюз недоступен',
  no_gw_contact: 'нет контакта со шлюзом',
  net_split: 'разрыв межспутниковой сети',
};

// Сетка расчёта: моменты 0, step, …, horizon − step (правый конец не включается — «Описание данных»).
export const timeGrid = (s, stepMul = 1) => {
  const step = s.environment.step_s * stepMul;
  return { step, steps: Math.ceil(s.environment.horizon_s / step) };
};

// Доступность за весь горизонт для каждого клиента.
// stepMul > 1 — грубая сетка (для перебора вариантов в оптимизаторе).
export function computeAvailability(s, stepMul = 1) {
  const e = s.environment;
  const { step, steps } = timeGrid(s, stepMul);
  const clients = s.ground_sites.filter(g => g.role === 'client');
  const result = {};
  for (const c of clients) result[c.id] = { ok: new Uint8Array(steps), hops: new Uint8Array(steps), latency: new Float32Array(steps), vis: new Uint8Array(steps), reasons: {}, handovers: 0 };
  const prevPath = {}, prevRoute = {};
  for (let k = 0; k < steps; k++) {
    const snap = snapshot(s, k * step);
    for (const c of clients) {
      const r = findRoute(s, snap, c.id, prevRoute[c.id]);
      prevRoute[c.id] = r.path ? r : null;
      const row = result[c.id];
      row.vis[k] = snap.ground[c.id].visible.length > 0 ? 1 : 0;
      if (r.path) {
        row.ok[k] = 1; row.hops[k] = r.path.length + 1;   // переходов = рёбер маршрута, включая две наземные линии
        row.latency[k] = routeLengthKm(snap, r.path, snap.ground[c.id].pos, snap.ground[r.gateway].pos) / C_LIGHT * 1000;
        const key = r.path.join('>') + '>' + r.gateway;
        if (prevPath[c.id] && prevPath[c.id] !== key) row.handovers++;
        prevPath[c.id] = key;
      } else {
        row.reasons[r.reason] = (row.reasons[r.reason] || 0) + 1;
        prevPath[c.id] = null;
      }
    }
  }
  for (const c of clients) {
    const row = result[c.id];
    let ok = 0, gap = 0, maxGap = 0, hopsSum = 0, gaps = 0, latSum = 0, latMax = 0, vis = 0;
    for (let k = 0; k < steps; k++) {
      if (row.vis[k]) vis++;
      if (row.ok[k]) { ok++; hopsSum += row.hops[k]; latSum += row.latency[k]; latMax = Math.max(latMax, row.latency[k]); gap = 0; }
      else { if (gap === 0) gaps++; gap++; maxGap = Math.max(maxGap, gap); }
    }
    row.availability = ok / steps;
    row.visibility = vis / steps;
    row.maxGapMin = maxGap * step / 60;
    row.gaps = gaps;
    row.avgHops = ok ? hopsSum / ok : 0;
    row.avgLatencyMs = ok ? latSum / ok : 0;
    row.maxLatencyMs = latMax;
    row.step_s = step;
  }
  return result;
}

// Сводка без массивов — для сохранения вариантов и сравнения.
export function summarize(avail) {
  const out = {};
  for (const [id, r] of Object.entries(avail)) {
    out[id] = { availability: r.availability, visibility: r.visibility, maxGapMin: r.maxGapMin, gaps: r.gaps, avgHops: r.avgHops,
      avgLatencyMs: r.avgLatencyMs, maxLatencyMs: r.maxLatencyMs, handovers: r.handovers, reasons: r.reasons };
  }
  return out;
}

// Скалярная оценка конфигурации: сначала худший пункт, потом перерывы, потом хопы.
export function score(avail) {
  const rows = Object.values(avail);
  const minAv = Math.min(...rows.map(r => r.availability));
  const meanAv = rows.reduce((a, r) => a + r.availability, 0) / rows.length;
  const maxGap = Math.max(...rows.map(r => r.maxGapMin));
  const hops = rows.reduce((a, r) => a + r.avgHops, 0) / rows.length;
  const vis = rows.reduce((a, r) => a + (r.visibility || 0), 0) / rows.length;
  return minAv * 1000 + meanAv * 100 + vis * 10 - maxGap * 0.5 - hops * 0.1;
}

// ---------- проверка сценария (порт validate() из geometry.py) ----------
const finite = x => typeof x === 'number' && Number.isFinite(x);

export function validate(s) {
  const errors = [];
  const err = m => errors.push(m);
  if (!s || typeof s !== 'object') return ['Файл не является JSON-объектом'];
  if (s.schema_version !== 'cosmo-A-1.0') err(`schema_version должен быть "cosmo-A-1.0" (сейчас: ${JSON.stringify(s.schema_version)})`);
  const e = s.environment, d = s.design;
  if (!e || typeof e !== 'object') { err('Отсутствует раздел environment'); return errors; }
  if (!d || typeof d !== 'object') { err('Отсутствует раздел design'); return errors; }
  for (const key of ['altitude_km', 'inclination_deg', 'earth_angle0_deg', 'horizon_s', 'step_s', 'min_elevation_deg', 'isl_range_km', 'target_availability'])
    if (!finite(e[key])) err(`environment.${key}: нужно конечное число`);
  if (errors.length) return errors;
  if (!(200 <= e.altitude_km && e.altitude_km <= 1200)) err('environment.altitude_km: допустимо 200…1200 км');
  if (!(0 < e.inclination_deg && e.inclination_deg <= 180)) err('environment.inclination_deg: допустимо (0…180]');
  if (!Number.isInteger(e.step_s) || !Number.isInteger(e.horizon_s)) err('environment.step_s и horizon_s должны быть целыми секундами');
  else if (!(0 < e.step_s && e.step_s <= e.horizon_s && e.horizon_s <= 172800 && e.horizon_s % e.step_s === 0))
    err('environment: требуется 0 < step_s ≤ horizon_s ≤ 172800 и horizon_s кратен step_s');
  if (!(0 <= e.min_elevation_deg && e.min_elevation_deg < 90)) err('environment.min_elevation_deg: допустимо [0…90)');
  if (!(0 < e.isl_range_km && e.isl_range_km <= 10000)) err('environment.isl_range_km: допустимо (0…10000]');
  if (!(0 <= e.target_availability && e.target_availability <= 1)) err('environment.target_availability: допустимо 0…1');

  if (!Array.isArray(d.planes) || !d.planes.length) err('design.planes: нужен непустой список плоскостей');
  const planeIds = new Set();
  for (const p of d.planes || []) {
    if (planeIds.has(p.id)) err(`design.planes: дублируется id "${p.id}"`);
    planeIds.add(p.id);
    for (const k of ['raan_deg', 'phase_deg'])
      if (!(finite(p[k]) && 0 <= p[k] && p[k] < 360)) err(`Плоскость ${p.id}: ${k} должен быть числом в [0…360)`);
    if (p.inclination_deg !== undefined && !(finite(p.inclination_deg) && 0 < p.inclination_deg && p.inclination_deg <= 180))
      err(`Плоскость ${p.id}: inclination_deg должен быть числом в (0…180]`);
  }
  if (!Array.isArray(d.satellites) || !d.satellites.length) err('design.satellites: нужен непустой список спутников');
  const satIds = new Set();
  for (const x of d.satellites || []) {
    if (satIds.has(x.id)) err(`design.satellites: дублируется id "${x.id}"`);
    satIds.add(x.id);
    if (!planeIds.has(x.plane_id)) err(`Спутник ${x.id}: неизвестная плоскость "${x.plane_id}"`);
    if (!(Number.isInteger(x.launch_batch) && x.launch_batch >= 1)) err(`Спутник ${x.id}: launch_batch должен быть целым ≥ 1 (в кейсе — 1, 2 или 3)`);
    if (!finite(x.slot_deg)) err(`Спутник ${x.id}: slot_deg должен быть числом`);
  }
  const nb = Math.max(1, ...(d.satellites || []).map(x => x.launch_batch).filter(Number.isInteger));
  if (!Number.isInteger(d.launch_stage) || d.launch_stage < 1 || d.launch_stage > nb) err(`design.launch_stage должен быть целым от 1 до ${nb} (число очередей запуска)`);

  const ground = s.ground_sites;
  if (!Array.isArray(ground)) err('Отсутствует список ground_sites');
  else {
    const gids = new Set();
    for (const g of ground) {
      if (gids.has(g.id)) err(`ground_sites: дублируется id "${g.id}"`);
      if (satIds.has(g.id)) err(`ground_sites: id "${g.id}" совпадает с id спутника`);
      gids.add(g.id);
      if (!['client', 'gateway'].includes(g.role)) err(`Пункт ${g.id}: role должен быть client или gateway`);
      if (!(finite(g.lat_deg) && -90 <= g.lat_deg && g.lat_deg <= 90)) err(`Пункт ${g.id}: lat_deg в [-90…90]`);
      if (!(finite(g.lon_deg) && -180 <= g.lon_deg && g.lon_deg <= 180)) err(`Пункт ${g.id}: lon_deg в [-180…180]`);
      if (g.horizon_mask !== undefined && !(Array.isArray(g.horizon_mask) && g.horizon_mask.length >= 4 && g.horizon_mask.every(v => finite(v) && 0 <= v && v < 90)))
        err(`Пункт ${g.id}: horizon_mask — список углов закрытия по азимутам (≥ 4 секторов, каждый 0…90°)`);
    }
    if (!ground.some(g => g.role === 'client')) err('Нужен хотя бы один клиентский пункт (role: client)');
    if (!ground.some(g => g.role === 'gateway')) err('Нужен хотя бы один шлюз (role: gateway)');
    const gwIds = new Set(ground.filter(g => g.role === 'gateway').map(g => g.id));
    for (const [field, key, valid] of [['failures', 'satellite_id', satIds], ['gateway_outages', 'gateway_id', gwIds]]) {
      if (!Array.isArray(s[field])) { err(`Отсутствует список ${field}`); continue; }
      s[field].forEach((f, i) => {
        if (!valid.has(f[key])) err(`${field}[${i}]: неизвестный ${key} "${f[key]}"`);
        if (!(finite(f.start_s) && finite(f.end_s) && 0 <= f.start_s && f.start_s < f.end_s && f.end_s <= e.horizon_s))
          err(`${field}[${i}]: требуется 0 ≤ start_s < end_s ≤ horizon_s`);
      });
    }
  }
  return errors;
}

// ---------- инструменты анализа ----------

// Автоподбор RAAN и фазирования плоскостей покоординатным спуском.
// onProgress(done, total, best) вызывается после каждой оценки.
export function optimizePlanes(scenario, { raanStep = 5, phaseStep = 1.5, passes = 2, stepMul = 1, onProgress } = {}) {
  const s = JSON.parse(JSON.stringify(scenario));
  const slotSpacing = slotPeriod(s);            // фаза имеет смысл только по модулю шага слотов
  const raanVals = []; for (let v = 0; v < 360; v += raanStep) raanVals.push(v);
  const phaseVals = []; for (let v = 0; v < slotSpacing - 1e-9; v += phaseStep) phaseVals.push(v);
  const total = passes * s.design.planes.length * (raanVals.length + phaseVals.length);
  let done = 0;
  const evalNow = () => score(computeAvailability(s, stepMul));
  let best = evalNow();
  const start = best;
  for (let pass = 0; pass < passes; pass++) {
    for (const p of s.design.planes) {
      for (const [key, vals] of [['raan_deg', raanVals], ['phase_deg', phaseVals]]) {
        const orig = p[key];
        let bestVal = orig;
        for (const v of vals) {
          p[key] = v;
          const sc = evalNow();
          if (sc > best + 1e-9) { best = sc; bestVal = v; }
          done++;
          onProgress?.(done, total, best);
        }
        p[key] = bestVal;
      }
    }
  }
  return { planes: s.design.planes, scoreBefore: start, scoreAfter: best };
}

function slotPeriod(s) {
  const byPlane = {};
  for (const x of s.design.satellites) (byPlane[x.plane_id] ??= []).push(x.slot_deg);
  let minGap = 360;
  for (const slots of Object.values(byPlane)) {
    const sorted = [...new Set(slots)].sort((a, b) => a - b);
    for (let i = 1; i < sorted.length; i++) minGap = Math.min(minGap, sorted[i] - sorted[i - 1]);
  }
  return minGap;
}

// Уязвимость: выводим каждый запущенный спутник на весь горизонт и смотрим просадку.
export function vulnerableSatellites(scenario, { stepMul = 1, onProgress } = {}) {
  const s = JSON.parse(JSON.stringify(scenario));
  const base = computeAvailability(s, stepMul);
  const baseMin = Math.min(...Object.values(base).map(r => r.availability));
  const sats = s.design.satellites.filter(x => x.launch_batch <= s.design.launch_stage);
  const out = [];
  sats.forEach((x, i) => {
    const failures = s.failures;
    s.failures = [...failures, { satellite_id: x.id, start_s: 0, end_s: s.environment.horizon_s }];
    const a = computeAvailability(s, stepMul);
    s.failures = failures;
    const minAv = Math.min(...Object.values(a).map(r => r.availability));
    const maxGap = Math.max(...Object.values(a).map(r => r.maxGapMin));
    out.push({ id: x.id, plane: x.plane_id, minAvailability: minAv, drop: baseMin - minAv, maxGapMin: maxGap });
    onProgress?.(i + 1, sats.length);
  });
  out.sort((a, b) => b.drop - a.drop || b.maxGapMin - a.maxGapMin);
  return { baseMin, items: out };
}

const minAvail = a => Math.min(...Object.values(a).map(r => r.availability));
const maxGapOf = a => Math.max(...Object.values(a).map(r => r.maxGapMin));
const deepClone = o => JSON.parse(JSON.stringify(o));

// Множество спутников, из которых есть путь до работающего шлюза (BFS от шлюзов).
function reachableFromGateway(s, snap) {
  const N = snap.pos.length;
  const reach = new Uint8Array(N);
  const queue = [];
  for (const g of s.ground_sites) if (g.role === 'gateway') for (const k of snap.ground[g.id].visible) if (!reach[k]) { reach[k] = 1; queue.push(k); }
  for (let qi = 0; qi < queue.length; qi++) for (const nb of snap.adj[queue[qi]]) if (!reach[nb]) { reach[nb] = 1; queue.push(nb); }
  return reach;
}

// 1. Карта покрытия: доля времени со сквозным маршрутом для сетки точек северных широт.
export function coverageGrid(s, { latMin = 55, latMax = 85, latStep = 2.5, lonStep = 5, stepMul = 2, onProgress } = {}) {
  const e = s.environment;
  const { step, steps } = timeGrid(s, stepMul);
  const lats = [], lons = [];
  for (let la = latMin; la <= latMax + 1e-9; la += latStep) lats.push(la);
  for (let lo = -180; lo < 180; lo += lonStep) lons.push(lo);
  const pts = [];
  for (const la of lats) for (const lo of lons) pts.push(groundPosition({ lat_deg: la, lon_deg: lo }));
  const counts = new Uint16Array(pts.length);
  const sinMin = Math.sin(rad(e.min_elevation_deg));
  for (let k = 0; k < steps; k++) {
    const snap = snapshot(s, k * step);
    const reach = reachableFromGateway(s, snap);
    const cand = [];
    for (let i = 0; i < reach.length; i++) if (reach[i]) cand.push(snap.pos[i]);
    for (let p = 0; p < pts.length; p++) {
      const gp = pts[p];
      for (const sp of cand) {
        const dx = sp.x - gp.x, dy = sp.y - gp.y, dz = sp.z - gp.z;
        if ((dx * gp.x + dy * gp.y + dz * gp.z) / (R * Math.sqrt(dx * dx + dy * dy + dz * dz)) >= sinMin) { counts[p]++; break; }
      }
    }
    onProgress?.(k + 1, steps);
  }
  const values = Array.from(counts, c => c / steps);
  // доля площади (с весом cos φ) с доступностью ≥ цели
  let wOk = 0, wAll = 0;
  lats.forEach((la, i) => { const w = Math.cos(rad(la)); lons.forEach((_, j) => { wAll += w; if (values[i * lons.length + j] >= e.target_availability) wOk += w; }); });
  return { lats, lons, values, shareOk: wOk / wAll, target: e.target_availability };
}

// 3а. План развёртывания: показатели на каждом этапе.
export function deploymentPlan(s, { monthsBetween = 3 } = {}) {
  const stages = [];
  for (let st = 1; st <= maxBatch(s); st++) {
    const c = deepClone(s); c.design.launch_stage = st;
    stages.push({ stage: st, month: (st - 1) * monthsBetween, sats: c.design.satellites.filter(x => x.launch_batch <= st).length, summary: summarize(computeAvailability(c)) });
  }
  return { stages, monthsBetween };
}

// 3б. Подбор состава очередей запуска: жадный отбор + структурные варианты; лучший по оценке этапа 1, затем этапа 2.
export function optimizeBatches(s, { stepMul = 3, onProgress } = {}) {
  const base = deepClone(s);
  const sats = base.design.satellites;
  const n = sats.length;
  // размеры очередей берём из текущего сценария (например 16/16/16 или 8/8/8/8/8/8); последняя — остаток
  const B = maxBatch(s);
  const sizes = Array.from({ length: B }, (_, i) => sats.filter(x => x.launch_batch === i + 1).length);
  const per = sizes[0];
  let done = 0; const total = sizes.slice(0, -1).reduce((a, sz, i) => a + sz * (n - sizes.slice(0, i).reduce((p, q) => p + q, 0)), 0) + per * 4 + 8;
  // sets[b] — множество id очереди b+1; всё, что не попало ни в одну, — последняя очередь
  const applySets = sets => { for (const x of sats) { let b = sets.findIndex(st => st?.has(x.id)); x.launch_batch = b < 0 ? B : b + 1; } };
  const evalSet = (set1, set2, stage) => {
    applySets([set1, set2]);
    base.design.launch_stage = stage;
    done++; onProgress?.(Math.min(done, total), total);
    return score(computeAvailability(base, stepMul));
  };
  const evalSets = (sets, stage) => { applySets(sets); base.design.launch_stage = stage; done++; onProgress?.(Math.min(done, total), total); return score(computeAvailability(base, stepMul)); };
  const greedy = (fixed, size, stage) => {
    const chosen = new Set(fixed);
    const pick = new Set();
    let bestSc = -Infinity;
    while (pick.size < size) {
      let best = null; bestSc = -Infinity;
      for (const x of sats) {
        if (chosen.has(x.id) || pick.has(x.id)) continue;
        const trial = new Set([...pick, x.id]);
        const sc = stage === 1 ? evalSet(trial, null, 1) : evalSet(chosen, trial, 2);
        if (sc > bestSc) { bestSc = sc; best = x.id; }
      }
      pick.add(best);
    }
    return { set: pick, score: bestSc };
  };
  // структурные кандидаты для первой очереди
  const byPlane = {};
  for (const x of sats) (byPlane[x.plane_id] ??= []).push(x);
  for (const arr of Object.values(byPlane)) arr.sort((a, b) => a.slot_deg - b.slot_deg);
  const planes = Object.keys(byPlane);
  const structured = [];
  for (const pid of planes) structured.push({ name: `вся плоскость ${pid}`, set: new Set(byPlane[pid].slice(0, per).map(x => x.id)) });
  if (planes.length >= 2) {
    const half = Math.floor(per / 2);
    structured.push({ name: `${planes[0]} + ${planes[1]} через слот`, set: new Set([...byPlane[planes[0]].filter((_, i) => i % 2 === 0).slice(0, half), ...byPlane[planes[1]].filter((_, i) => i % 2 === 0).slice(0, per - half)].map(x => x.id)) });
  }
  if (planes.length >= 3) {
    const k = Math.ceil(per / planes.length);
    const set = new Set();
    planes.forEach(pid => { const arr = byPlane[pid]; const stepI = Math.max(1, Math.floor(arr.length / k)); for (let i = 0; i < arr.length && set.size < per; i += stepI) set.add(arr[i].id); });
    structured.push({ name: 'равномерно по всем плоскостям', set });
  }
  const current = new Set(sats.filter(x => x.launch_batch === 1).map(x => x.id));
  const options = [{ name: 'текущая', set: current }, ...structured].map(o => ({ ...o, score: evalSet(o.set, null, 1) }));
  const g1 = greedy([], per, 1);
  options.push({ name: 'жадный отбор', set: g1.set, score: g1.score });
  options.sort((a, b) => b.score - a.score);
  const best1 = options[0];
  // следующие очереди: жадно при зафиксированных предыдущих (последняя — остаток)
  const sets = [best1.set];
  for (let b = 1; b < B - 1; b++) {
    const fixed = new Set(sets.flatMap(st => [...st]));
    const pick = new Set();
    while (pick.size < sizes[b]) {
      let bestId = null, bestSc = -Infinity;
      for (const x of sats) {
        if (fixed.has(x.id) || pick.has(x.id)) continue;
        const sc = evalSets([...sets, new Set([...pick, x.id])], b + 1);
        if (sc > bestSc) { bestSc = sc; bestId = x.id; }
      }
      if (bestId == null) break;
      pick.add(bestId);
    }
    sets.push(pick);
  }
  const assignment = {};
  for (const x of sats) { const b = sets.findIndex(st => st.has(x.id)); assignment[x.id] = b < 0 ? B : b + 1; }
  // сводки до/после на полной сетке
  const before = deepClone(s), after = deepClone(s);
  for (const x of after.design.satellites) x.launch_batch = assignment[x.id];
  const stagesOf = sc => Array.from({ length: Math.max(1, B - 1) }, (_, i) => i + 1).map(st => { const c = deepClone(sc); c.design.launch_stage = st; return summarize(computeAvailability(c)); });
  return { assignment, best1: best1.name, options: options.map(o => ({ name: o.name, score: o.score })), before: stagesOf(before), after: stagesOf(after) };
}

// 6. Матрица N-1 / N-2: минимальная доступность при отказе одного и пары аппаратов на весь горизонт.
export function pairFailures(s, { stepMul = 3, onProgress } = {}) {
  const c = deepClone(s);
  const ids = c.design.satellites.filter(x => x.launch_batch <= c.design.launch_stage).map(x => x.id);
  const n = ids.length, H = c.environment.horizon_s, baseF = c.failures;
  const target = c.environment.target_availability;
  const evalWith = list => { c.failures = [...baseF, ...list.map(id => ({ satellite_id: id, start_s: 0, end_s: H }))]; const a = computeAvailability(c, stepMul); c.failures = baseF; return { minAv: minAvail(a), maxGap: maxGapOf(a) }; };
  const baseMin = evalWith([]).minAv;
  const single = ids.map(id => evalWith([id]));
  const total = n * (n - 1) / 2; let done = 0;
  const matrix = new Float32Array(n * n);
  const pairs = [];
  for (let i = 0; i < n; i++) {
    matrix[i * n + i] = single[i].minAv;
    for (let j = i + 1; j < n; j++) {
      const r = evalWith([ids[i], ids[j]]);
      matrix[i * n + j] = matrix[j * n + i] = r.minAv;
      pairs.push({ a: ids[i], b: ids[j], minAv: r.minAv, maxGap: r.maxGap });
      done++; if (done % 20 === 0) onProgress?.(done, total);
    }
  }
  pairs.sort((a, b) => a.minAv - b.minAv);
  const n1Min = Math.min(...single.map(x => x.minAv)), n2Min = pairs.length ? pairs[0].minAv : n1Min;
  const badSingles = ids.filter((_, i) => single[i].minAv < target).length;
  const badPairs = pairs.filter(p => p.minAv < target).length;
  return { ids, matrix: Array.from(matrix), baseMin, n1Min, n2Min, badSingles, badPairs, worstPairs: pairs.slice(0, 8), target,
    tolerance: baseMin < target ? 0 : badSingles ? 0 : badPairs ? 1 : 2 };
}

// 7. Резервные аппараты: где добавить один запасной, чтобы сильнее всего поднять устойчивость к отказам.
export function spareSearch(s, { stepMul = 3, topK = 6, onProgress } = {}) {
  const c = deepClone(s);
  const H = c.environment.horizon_s, baseF = c.failures;
  const active = c.design.satellites.filter(x => x.launch_batch <= c.design.launch_stage);
  const evalMin = () => minAvail(computeAvailability(c, stepMul));
  // самые критичные аппараты
  const vul = active.map(x => { c.failures = [...baseF, { satellite_id: x.id, start_s: 0, end_s: H }]; const m = evalMin(); c.failures = baseF; return { id: x.id, minAv: m }; })
    .sort((a, b) => a.minAv - b.minAv).slice(0, topK);
  const baseResilience = vul.reduce((a, v) => a + v.minAv, 0) / vul.length;
  const baseMin = evalMin();
  // кандидаты: середины между соседними слотами каждой плоскости
  const byPlane = {};
  for (const x of c.design.satellites) (byPlane[x.plane_id] ??= []).push(x.slot_deg);
  const cands = [];
  for (const [pid, slots] of Object.entries(byPlane)) {
    const u = [...new Set(slots)].sort((a, b) => a - b);
    for (let i = 0; i < u.length; i++) { const next = i + 1 < u.length ? u[i + 1] : u[0] + 360; cands.push({ plane: pid, slot: ((u[i] + next) / 2) % 360 }); }
  }
  const results = [];
  cands.forEach((cd, i) => {
    const spare = { id: 'SP1', plane_id: cd.plane, slot_deg: cd.slot, launch_batch: 1 };
    c.design.satellites.push(spare);
    const base = evalMin();
    let sum = 0;
    for (const v of vul) { c.failures = [...baseF, { satellite_id: v.id, start_s: 0, end_s: H }]; sum += evalMin(); }
    c.failures = baseF;
    c.design.satellites.pop();
    results.push({ plane: cd.plane, slot: cd.slot, minAv: base, resilience: sum / vul.length });
    onProgress?.(i + 1, cands.length);
  });
  results.sort((a, b) => b.resilience - a.resilience || b.minAv - a.minAv);
  return { baseMin, baseResilience, vulnerable: vul, best: results.slice(0, 5) };
}

// 8. Монте-Карло случайных отказов.
export function monteCarlo(s, { pFail = 0.05, runs = 300, stepMul = 3, onProgress } = {}) {
  const c = deepClone(s);
  const H = c.environment.horizon_s, baseF = c.failures, target = c.environment.target_availability;
  const active = c.design.satellites.filter(x => x.launch_batch <= c.design.launch_stage);
  const mins = [];
  let ok = 0, failedTotal = 0;
  for (let r = 0; r < runs; r++) {
    const f = [];
    for (const x of active) if (Math.random() < pFail) f.push({ satellite_id: x.id, start_s: Math.floor(Math.random() * H), end_s: H });
    failedTotal += f.length;
    c.failures = [...baseF, ...f];
    const m = minAvail(computeAvailability(c, stepMul));
    mins.push(m);
    if (m >= target) ok++;
    if (r % 10 === 0) onProgress?.(r + 1, runs);
  }
  c.failures = baseF;
  mins.sort((a, b) => a - b);
  const hist = new Array(20).fill(0);
  for (const m of mins) hist[Math.min(19, Math.floor(m * 20))]++;
  return { runs, pFail, probOk: ok / runs, p10: mins[Math.floor(runs * 0.1)], p50: mins[Math.floor(runs * 0.5)], mean: mins.reduce((a, b) => a + b, 0) / runs, hist, avgFailed: failedTotal / runs, target };
}

// Ближайший пролёт: через сколько секунд у пункта появится маршрут (0 — уже есть), и на сколько.
export function nextWindow(s, clientId, t0, maxAhead = 7200) {
  const step = s.environment.step_s, H = s.environment.horizon_s;
  let start = null;
  for (let t = t0; t <= t0 + maxAhead; t += step) {
    const snap = snapshot(s, t % H);
    const ok = !!findRoute(s, snap, clientId).path;
    if (start === null && ok) start = t;
    if (start !== null && !ok) return { inSec: start - t0, durSec: t - start };
  }
  return start === null ? null : { inSec: start - t0, durSec: null };
}

// ---------- конструктор группировки ----------

// Walker Delta T/P/F: T аппаратов в P плоскостях, F — межплоскостное фазирование (0…P−1).
// Плоскости равномерно по RAAN в пределах raanSpread (360° — классический Delta, 180° — Star).
export function walkerDelta({ T, P, F = 0, inclination_deg, raan0 = 0, raanSpread = 360, batches = 3, batchMode = 'plane', idPrefix = 'S' }) {
  if (!(Number.isInteger(T) && Number.isInteger(P) && P >= 1 && T >= P && T % P === 0)) throw new Error('Walker: T должно делиться на P');
  const S = T / P;
  const planes = [], satellites = [];
  for (let j = 0; j < P; j++) {
    const p = { id: `P${j + 1}`, raan_deg: +(((raan0 + j * raanSpread / P) % 360 + 360) % 360).toFixed(3), phase_deg: +((j * F * 360 / T) % 360).toFixed(3) };
    if (Number.isFinite(inclination_deg)) p.inclination_deg = inclination_deg;
    planes.push(p);
    for (let i = 0; i < S; i++) satellites.push({ id: `${idPrefix}${satellites.length + 1}`, plane_id: p.id, slot_deg: +(i * 360 / S).toFixed(3), launch_batch: 1 });
  }
  assignBatches(satellites, batches, batchMode);
  return { planes, satellites };
}

// Раскладка аппаратов по очередям запуска. sizes — число очередей (поровну) или список размеров.
// mode 'plane' — плоскость за плоскостью (очередь = одна плоскость при 16×3), 'spread' — вперемешку по плоскостям.
export function assignBatches(satellites, sizes, mode = 'plane') {
  const n = satellites.length;
  let sz = Array.isArray(sizes) ? sizes.slice() : Array.from({ length: sizes }, (_, i) => Math.floor(n / sizes) + (i < n % sizes ? 1 : 0));
  const total = sz.reduce((a, b) => a + b, 0);
  if (total !== n) sz[sz.length - 1] += n - total;
  let order;
  if (mode === 'spread') {
    const byPlane = {};
    satellites.forEach((x, i) => (byPlane[x.plane_id] ??= []).push(i));
    const lists = Object.values(byPlane).map(a => a.sort((i, j) => satellites[i].slot_deg - satellites[j].slot_deg));
    // круговой обход плоскостей с шагом через слот, чтобы первая очередь была равномерной
    order = [];
    const ptr = lists.map(() => 0);
    while (order.length < n) for (let l = 0; l < lists.length; l++) if (ptr[l] < lists[l].length) order.push(lists[l][ptr[l]++]);
  } else {
    order = satellites.map((_, i) => i);
  }
  let b = 0, left = sz[0];
  for (const i of order) {
    while (left <= 0 && b < sz.length - 1) { b++; left = sz[b]; }
    satellites[i].launch_batch = b + 1; left--;
  }
  return satellites;
}

// Подбор проекта группировки: перебор Walker-конфигураций под заданные пункты.
// Возвращает все кандидаты с показателями полной группировки и первой очереди.
export function designSearch(scenario, { T = [24, 30, 36, 42, 48, 54, 60], P = [2, 3, 4, 5, 6], inclinations = null, spreads = [180, 360], batches = 3,
  stepMul = 3, onProgress } = {}) {
  const base = deepClone(scenario);
  const incs = inclinations || [base.environment.inclination_deg];
  const target = base.environment.target_availability;
  const cands = [];
  for (const t of T) for (const p of P) if (t % p === 0) for (const inc of incs) for (const spread of spreads) for (let f = 0; f < p; f++) cands.push({ T: t, P: p, F: f, inc, spread });
  const results = [];
  let done = 0;
  for (const c of cands) {
    const design = walkerDelta({ T: c.T, P: c.P, F: c.F, raanSpread: c.spread, inclination_deg: c.inc === base.environment.inclination_deg ? undefined : c.inc, batches, batchMode: 'plane' });
    const sc = deepClone(base); sc.design = { ...design, launch_stage: batches };
    const full = computeAvailability(sc, stepMul);
    sc.design.launch_stage = 1;
    const first = computeAvailability(sc, stepMul);
    results.push({ ...c, sats: c.T, minFull: minAvail(full), meanFull: Object.values(full).reduce((a, r) => a + r.availability, 0) / Object.keys(full).length,
      maxGapFull: maxGapOf(full), minFirst: minAvail(first), score: score(full), reachesTarget: minAvail(full) >= target });
    done++; onProgress?.(done, cands.length);
  }
  results.sort((a, b) => b.score - a.score);
  // фронт «число аппаратов ↔ лучшая доступность»: для каждого T — лучший кандидат
  const byT = {};
  for (const r of results) if (!byT[r.T] || r.score > byT[r.T].score) byT[r.T] = r;
  const pareto = Object.values(byT).sort((a, b) => a.T - b.T);
  const minimal = pareto.find(r => r.reachesTarget) || null;
  return { results, pareto, minimal, target, evaluated: cands.length };
}

// ---------- показатели для вида абонента ----------

/* Окна связи и перерывы за горизонт для одного пункта — то, что видит житель как расписание.
   Один проход по сетке: границы окон, длительности и причина каждого перерыва.
   `availability` здесь совпадает с computeAvailability() по построению (тот же findRoute с липкостью),
   а рельеф и наклонения плоскостей учитываются сами — они уже внутри snapshot(). */
export function contactWindows(s, clientId) {
  const { step, steps } = timeGrid(s);
  const windows = [], gaps = [];
  let prevRoute = null, runOk = null, runStart = 0, runReason = null, okCount = 0;
  const close = (kEnd) => {
    const seg = { start_s: runStart * step, end_s: (kEnd + 1) * step };
    seg.durMin = (seg.end_s - seg.start_s) / 60;
    if (runOk) windows.push(seg); else { seg.reason = runReason; gaps.push(seg); }
  };
  for (let k = 0; k < steps; k++) {
    const snap = snapshot(s, k * step);
    const r = findRoute(s, snap, clientId, prevRoute);
    prevRoute = r.path ? r : null;
    const ok = !!r.path;
    if (ok) okCount++;
    if (runOk === null) { runOk = ok; runStart = k; runReason = r.reason; }
    else if (ok !== runOk) { close(k - 1); runOk = ok; runStart = k; runReason = r.reason; }
    else if (!ok && r.reason) runReason = r.reason;   // в перерыве держим последнюю причину
  }
  if (runOk !== null) close(steps - 1);
  const longest = windows.reduce((a, w) => (w.durMin > (a?.durMin ?? -1) ? w : a), null);
  const worstGap = gaps.reduce((a, g) => (g.durMin > (a?.durMin ?? -1) ? g : a), null);
  return { step_s: step, steps, windows, gaps, availability: okCount / steps, longestWindow: longest, worstGap };
}

/* Небо над пунктом: азимут, возвышение и дальность аппаратов — в терминах, которые житель
   может проверить, подняв голову. Отдаём и те, что закрыты рельефом (`blocked`): для человека
   разница между «спутника нет» и «спутник есть, но за сопкой» — это разница между
   «ждать пролёта» и «переставить антенну». Углы считаем через siteFrame/lookAngles,
   чтобы азимут совпадал с тем, по которому snapshot() выбирает сектор маски. */
export function skyView(s, clientId, t) {
  const site = s.ground_sites.find(g => g.id === clientId);
  if (!site) return [];
  const frame = siteFrame(site);
  const mask = siteMask(site);
  const snap = snapshot(s, t);
  const g = snap.ground[clientId];
  if (!g) return [];
  const blocked = new Set(g.blocked ?? []);
  const out = [];
  for (const k of [...(g.visibleRaw ?? []), ...blocked]) {
    const a = lookAngles(frame, snap.pos[k]);
    out.push({
      index: k,
      id: s.design.satellites[k].id,
      azDeg: a.az_deg,
      elDeg: a.el_deg,
      rangeKm: a.range_km,
      blocked: blocked.has(k),
      maskDeg: mask ? maskSector(mask, a.az_deg) : 0,
    });
  }
  return out.sort((a, b) => b.elDeg - a.elDeg);
}
