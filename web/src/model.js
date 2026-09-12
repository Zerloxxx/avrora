/* Модель: загрузка и правка конфигурации, пересчёт, варианты, импорт/экспорт, ссылка.
   Только мутации state и события шины — никакого DOM, кроме уведомлений. */
import { state, clone, toast, fmtTime, stamp, emit } from './state.js';
import { computeAvailability, summarize, score, validate, snapshot, findRoute, timeGrid, REASONS, walkerDelta, maxBatch, TERRAIN_PRESETS, maskFromProfiles, uniformMask, MASK_SECTORS, R } from './sim.js';
import { encodeDiff, decodeDiff, applyDiff, readHash } from './configlink.js';

const START_T = 43200;   // полдень UTC

export function loadScenario(raw, id) {
  state.base = clone(raw);
  state.scenario = clone(raw);
  state.scenarioId = id;
  state.t = START_T % raw.environment.horizon_s;
  const clients = state.scenario.ground_sites.filter(g => g.role === 'client');
  if (!clients.some(c => c.id === state.clientId)) state.clientId = clients[0]?.id ?? null;
  recompute();
  emit('scenario');
}

export function recompute() {
  state.avail = computeAvailability(state.scenario);
  emit('recomputed');
}

let recomputeTimer = null;
// После правки параметров: пересчитать сутки с задержкой, чтобы не дёргать расчёт на каждый ввод.
export function markChanged({ rebuildScene = false } = {}) {
  document.body.classList.add('workspace');
  if (rebuildScene) emit('scene:rebuild');
  clearTimeout(recomputeTimer);
  recomputeTimer = setTimeout(() => { recompute(); emit('controls'); }, 120);
}

export const isModified = () => JSON.stringify(state.scenario) !== JSON.stringify(state.base);

export function resetScenario() {
  state.scenario = clone(state.base);
  markChanged({ rebuildScene: true });
}

export function setStage(stage) {
  state.scenario.design.launch_stage = stage;
  markChanged();
}

export function setPlaneParam(planeId, key, value) {
  const p = state.scenario.design.planes.find(x => x.id === planeId);
  if (key === 'inclination_deg') {
    // пусто или равно общему — убираем поле, чтобы файл оставался чистой схемой кейса
    if (!Number.isFinite(value) || value === state.scenario.environment.inclination_deg) delete p.inclination_deg;
    else p.inclination_deg = Math.min(180, Math.max(1, value));
    markChanged({ rebuildScene: true });
    return p.inclination_deg ?? '';
  }
  p[key] = ((value % 360) + 360) % 360;
  markChanged({ rebuildScene: true });
  return p[key];
}

// Заменить состав группировки (плоскости + аппараты) — из конструктора или подбора проекта.
export function applyDesign(design, { launch_stage } = {}) {
  const s = state.scenario;
  const ids = new Set(design.satellites.map(x => x.id));
  s.design = { planes: clone(design.planes), satellites: clone(design.satellites), launch_stage: 1 };
  s.design.launch_stage = Math.min(launch_stage ?? maxBatch(s), maxBatch(s));
  const dropped = s.failures.filter(f => !ids.has(f.satellite_id)).length;
  s.failures = s.failures.filter(f => ids.has(f.satellite_id));
  markChanged({ rebuildScene: true });
  return dropped;
}

export function generateWalker(params) {
  const design = walkerDelta(params);
  const dropped = applyDesign(design);
  toast(`Группировка собрана: ${params.T} КА в ${params.P} плоскостях, ${params.batches} очередей${dropped ? `; снято отказов по удалённым КА: ${dropped}` : ''}`, 'ok', 3500);
  return design;
}

// ---------- местность пункта ----------
export const TERRAIN_KEY = g => `${g.lat_deg.toFixed(2)},${g.lon_deg.toFixed(2)}`;
export const demFor = g => window.TERRAIN?.[TERRAIN_KEY(g)] || null;
export function terrainLabel(g) {
  if (!Array.isArray(g.horizon_mask)) return 'открытая местность';
  if (g.terrain === 'dem') return 'рельеф (DEM)';
  return TERRAIN_PRESETS[g.terrain]?.label || 'своя маска';
}
// key: 'open' | ключ пресета | 'dem' (из предрасчёта) | массив (своя маска) | null
export function setSiteTerrain(site, key) {
  const g = state.scenario.ground_sites.find(x => x.id === site.id);
  if (!g) return;
  if (key === null || key === 'open') { delete g.horizon_mask; delete g.terrain; }
  else if (key === 'dem') {
    const dem = demFor(g);
    if (!dem) { toast('Для этой точки нет предрасчитанного рельефа — выберите пресет или запросите высоты', 'error'); return; }
    g.horizon_mask = dem.horizon_mask.slice(); g.terrain = 'dem'; g.terrain_source = dem.source;
  } else if (Array.isArray(key)) { g.horizon_mask = key.slice(); g.terrain = 'custom'; }
  else if (TERRAIN_PRESETS[key]) { g.horizon_mask = TERRAIN_PRESETS[key].build(); g.terrain = key; }
  markChanged();
}

// Маска по реальному рельефу из браузера: Copernicus DEM GLO-90 через open-meteo (CORS открыт), ~600 точек, 6 запросов.
const DEM_DISTS = [0.25, 0.4, 0.6, 0.9, 1.3, 1.8, 2.5, 3.5, 5, 7, 9, 12, 15, 19, 24, 30];
function destPoint(lat, lon, azDeg, dKm) {
  const la = lat * Math.PI / 180, lo = lon * Math.PI / 180, az = azDeg * Math.PI / 180, dr = dKm / R;
  const la2 = Math.asin(Math.sin(la) * Math.cos(dr) + Math.cos(la) * Math.sin(dr) * Math.cos(az));
  const lo2 = lo + Math.atan2(Math.sin(az) * Math.sin(dr) * Math.cos(la), Math.cos(dr) - Math.sin(la) * Math.sin(la2));
  return [la2 * 180 / Math.PI, ((lo2 * 180 / Math.PI + 540) % 360) - 180];
}
export async function fetchTerrainMask(site, onProgress) {
  const g = state.scenario.ground_sites.find(x => x.id === site.id);
  const pts = [[g.lat_deg, g.lon_deg]];
  for (let k = 0; k < MASK_SECTORS; k++) for (const d of DEM_DISTS) pts.push(destPoint(g.lat_deg, g.lon_deg, (k + 0.5) * 360 / MASK_SECTORS, d));
  const h = [];
  for (let i = 0; i < pts.length; i += 100) {
    const chunk = pts.slice(i, i + 100);
    const url = `https://api.open-meteo.com/v1/elevation?latitude=${chunk.map(p => p[0].toFixed(5)).join(',')}&longitude=${chunk.map(p => p[1].toFixed(5)).join(',')}`;
    const r = await fetch(url);
    if (!r.ok) throw new Error(`open-meteo: HTTP ${r.status}`);
    h.push(...(await r.json()).elevation.map(v => v ?? 0));
    onProgress?.(Math.min(i + 100, pts.length), pts.length);
  }
  const profiles = [];
  let i = 1;
  for (let k = 0; k < MASK_SECTORS; k++) { const pr = []; for (const d of DEM_DISTS) pr.push({ dist_km: d, h_m: h[i++] }); profiles.push(pr); }
  const mask = maskFromProfiles(h[0], profiles);
  g.horizon_mask = mask; g.terrain = 'dem'; g.terrain_source = 'Copernicus DEM GLO-90 (open-meteo)'; g.h0_m = h[0];
  markChanged();
  return { h0: h[0], mask };
}

export function setEclipseIslOff(flag) {
  if (flag) state.scenario.environment.eclipse_isl_off = true;
  else delete state.scenario.environment.eclipse_isl_off;
  markChanged();
}

export function addOutage(id, start, end) {
  const s = state.scenario;
  const isGw = s.ground_sites.some(g => g.id === id && g.role === 'gateway');
  if (isGw) s.gateway_outages.push({ gateway_id: id, start_s: start, end_s: end });
  else s.failures.push({ satellite_id: id, start_s: start, end_s: end });
  markChanged();
  toast(`${id}: недоступен ${fmtTime(start)} — ${fmtTime(end)}`, 'ok', 2500);
}

export function removeOutage(kind, index) {
  state.scenario[kind].splice(index, 1);
  markChanged();
}

export function addSite(id, role, lat, lon, name, terrain = null) {
  const s = state.scenario;
  id = id.trim().replace(/\s+/g, '_');
  if (!id) { toast('Укажите ID пункта', 'error'); return false; }
  if (s.ground_sites.some(g => g.id === id) || s.design.satellites.some(x => x.id === id)) { toast(`ID «${id}» уже занят`, 'error'); return false; }
  if (!(Math.abs(lat) <= 90 && Math.abs(lon) <= 180)) { toast('Широта в [-90…90], долгота в [-180…180]', 'error'); return false; }
  const g = { id, name: name || id, role, lat_deg: +lat.toFixed(3), lon_deg: +lon.toFixed(3) };
  s.ground_sites.push(g);
  if (terrain && terrain !== 'open') setSiteTerrain(g, terrain);
  markChanged();
  toast(`Добавлен ${role === 'gateway' ? 'шлюз' : 'пункт'} ${id} (${lat.toFixed(2)}°, ${lon.toFixed(2)}°)`, 'ok', 2500);
  return true;
}

export function removeSite(site) {
  const s = state.scenario;
  s.ground_sites = s.ground_sites.filter(x => x !== site);
  s.gateway_outages = s.gateway_outages.filter(f => f.gateway_id !== site.id);
  if (state.clientId === site.id) state.clientId = s.ground_sites.find(x => x.role === 'client').id;
  markChanged();
}

export function addSpareSatellite(plane, slot) {
  const s = state.scenario;
  let k = 1; while (s.design.satellites.some(x => x.id === `SP${k}`)) k++;
  s.design.satellites.push({ id: `SP${k}`, plane_id: plane, slot_deg: +slot.toFixed(3), launch_batch: 1 });
  markChanged({ rebuildScene: true });
  return `SP${k}`;
}

// ---------- варианты ----------
const VKEY = 'aurora.variants.v1';
export function persistVariants() { try { localStorage.setItem(VKEY, JSON.stringify(state.variants)); } catch {} }
export function restoreVariants() { try { state.variants = JSON.parse(localStorage.getItem(VKEY) || '[]'); } catch { state.variants = []; } }

// Человекочитаемый список отличий конфигурации от исходного файла.
export function describeChanges(scenario, base) {
  const out = [];
  if (!base) return out;
  if (scenario.design.launch_stage !== base.design.launch_stage) out.push(`этап ${base.design.launch_stage} → ${scenario.design.launch_stage}`);
  const sameShape = scenario.design.planes.length === base.design.planes.length && scenario.design.satellites.length === base.design.satellites.length
    && scenario.design.planes.every(p => base.design.planes.some(x => x.id === p.id));
  if (!sameShape) out.push(`группировка ${base.design.satellites.length} КА / ${base.design.planes.length} пл. → ${scenario.design.satellites.length} КА / ${scenario.design.planes.length} пл.`);
  for (const p of sameShape ? scenario.design.planes : []) {
    const b = base.design.planes.find(x => x.id === p.id);
    if (!b) continue;
    if (p.raan_deg !== b.raan_deg) out.push(`${p.id} RAAN ${b.raan_deg}° → ${p.raan_deg}°`);
    if (p.phase_deg !== b.phase_deg) out.push(`${p.id} фаза ${b.phase_deg}° → ${p.phase_deg}°`);
    if ((p.inclination_deg ?? null) !== (b.inclination_deg ?? null)) out.push(`${p.id} наклонение ${p.inclination_deg ?? scenario.environment.inclination_deg}°`);
  }
  for (const g of scenario.ground_sites) {
    const b = base.ground_sites.find(x => x.id === g.id);
    if (b && JSON.stringify(g.horizon_mask || null) !== JSON.stringify(b.horizon_mask || null)) out.push(`${g.id}: ${terrainLabel(g)}`);
  }
  const df = scenario.failures.length - base.failures.length;
  if (df) out.push(`отказов КА ${df > 0 ? '+' : ''}${df}`);
  const dg = scenario.gateway_outages.length - base.gateway_outages.length;
  if (dg) out.push(`отказов шлюза ${dg > 0 ? '+' : ''}${dg}`);
  if (scenario.environment.isl_range_km !== base.environment.isl_range_km) out.push(`ISL ${scenario.environment.isl_range_km} км`);
  const addedSites = scenario.ground_sites.filter(g => !base.ground_sites.some(x => x.id === g.id)).map(g => g.id);
  if (addedSites.length) out.push(`+пункты ${addedSites.join(', ')}`);
  const removedSites = base.ground_sites.filter(g => !scenario.ground_sites.some(x => x.id === g.id)).map(g => g.id);
  if (removedSites.length) out.push(`−пункты ${removedSites.join(', ')}`);
  const addedSats = sameShape ? scenario.design.satellites.filter(x => !base.design.satellites.some(y => y.id === x.id)).map(x => x.id) : [];
  if (addedSats.length) out.push(`+КА ${addedSats.join(', ')}`);
  const batchChanged = scenario.design.satellites.filter(x => { const b = base.design.satellites.find(y => y.id === x.id); return b && b.launch_batch !== x.launch_batch; }).length;
  if (batchChanged) out.push(`очереди изменены у ${batchChanged} КА`);
  if (scenario.environment.eclipse_isl_off) out.push('ISL выкл. в тени');
  return out;
}

export function saveVariant(name) {
  const avail = state.avail;
  const v = {
    id: Date.now().toString(36),
    name: name || `Вариант ${state.variants.length + 1}`,
    scenarioId: state.scenarioId,
    scenarioTitle: state.scenario.meta?.title || state.scenarioId,
    changes: describeChanges(state.scenario, state.base),
    scenario: clone(state.scenario),
    summary: summarize(avail),
    timelines: Object.fromEntries(Object.entries(avail).map(([k, r]) => [k, Array.from(r.ok)])),
    score: score(avail),
    selected: true,
    createdAt: new Date().toISOString(),
  };
  state.variants.push(v);
  persistVariants();
  emit('variants');
  toast(`Вариант «${v.name}» сохранён`, 'ok', 2500);
}

export function openVariant(v) {
  state.scenario = clone(v.scenario);
  state.scenarioId = v.scenarioId;
  const baseSrc = window.SCENARIOS?.[v.scenarioId];
  state.base = baseSrc ? clone(baseSrc) : clone(v.scenario);
  recompute();
  emit('scenario');
  document.body.classList.add('workspace');
  toast(`Открыт вариант «${v.name}»`, 'ok', 2000);
}

export function deleteVariant(v) {
  state.variants = state.variants.filter(x => x !== v);
  persistVariants();
  emit('variants');
}

// ---------- импорт / экспорт ----------
export async function importFile(file) {
  let raw;
  try { raw = JSON.parse(await file.text()); }
  catch (e) { toast(`<b>Файл не разобран как JSON.</b><ul><li>${e.message}</li></ul>`, 'error', 8000); return; }
  const errors = validate(raw);
  if (errors.length) {
    toast(`<b>Сценарий не загружен — исправьте данные:</b><ul>${errors.slice(0, 12).map(x => `<li>${x}</li>`).join('')}${errors.length > 12 ? `<li>… и ещё ${errors.length - 12}</li>` : ''}</ul>`, 'error', 12000);
    return;
  }
  loadScenario(raw, '__custom__');
  document.body.classList.add('workspace');
  toast(`Загружен сценарий «${raw.meta?.title || file.name}»`, 'ok', 3000);
}

function download(name, obj) {
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

export function exportScenario() {
  const s = clone(state.scenario);
  s.meta = { ...(s.meta || {}), id: (s.meta?.id || 'scenario') + (isModified() ? '_modified' : ''), exported_at: new Date().toISOString() };
  download(`${s.meta.id}.json`, s);
}
// Результат по схеме cosmo-A-result-1.0 («Описание данных»): effective_scenario + routes на каждую пару «момент — пункт»,
// path — идентификаторы от наземного пункта до шлюза, пустой список — маршрута нет. Сводка — дополнительно.
export function buildResult() {
  const s = state.scenario;
  const { step, steps } = timeGrid(s);
  const clients = s.ground_sites.filter(g => g.role === 'client').map(g => g.id);
  const satId = k => s.design.satellites[k].id;
  const routes = [];
  const prev = {};
  for (let k = 0; k < steps; k++) {
    const t = k * step;
    const snap = snapshot(s, t);
    for (const c of clients) {
      const r = findRoute(s, snap, c, prev[c]);
      prev[c] = r.path ? r : null;
      routes.push(r.path
        ? { t_s: t, client_id: c, path: [c, ...r.path.map(satId), r.gateway] }
        : { t_s: t, client_id: c, path: [], reason: r.reason, reason_text: REASONS[r.reason] });
    }
  }
  const summary = {};
  for (const [c, r] of Object.entries(state.avail)) {
    summary[c] = { visibility_share: r.visibility, availability_share: r.availability, max_gap_s: r.maxGapMin * 60, gaps: r.gaps,
      avg_edges: r.avgHops, avg_latency_ms: r.avgLatencyMs, max_latency_ms: r.maxLatencyMs, handovers: r.handovers, no_route_reasons: r.reasons };
  }
  return {
    schema_version: 'cosmo-A-result-1.0',
    generated_at: new Date().toISOString(),
    generator: 'Аврора (КосмоХакатон 2026)',
    effective_scenario: clone(s),
    time_grid: { step_s: step, steps, t_first_s: 0, t_last_s: (steps - 1) * step },
    target_availability: s.environment.target_availability,
    summary,
    routes,
  };
}
export function exportResults() {
  download(`result_${state.scenario.meta?.id || 'scenario'}_${stamp()}.json`, buildResult());
}
export function exportVariants() {
  download(`variants_${stamp()}.json`, state.variants.map(({ timelines, ...v }) => v));
}

// ---------- ссылка на конфигурацию ----------
// Формат диффа — в configlink.js (его же читает вид абонента), чтобы страницы не разошлись.
export function encodeConfig() {
  return encodeDiff(state.scenario, state.base, { scenarioId: state.scenarioId, clientId: state.clientId });
}
export function applyConfigFromHash() {
  const b64 = readHash(location.hash);
  if (!b64) return false;
  const d = decodeDiff(b64);
  const src = d && window.SCENARIOS?.[d.id];
  if (!src) return false;
  loadScenario(src, d.id);
  applyDiff(state.scenario, d);
  if (d.c) state.clientId = d.c;
  markChanged({ rebuildScene: true });
  document.body.classList.add('workspace');
  toast('Конфигурация загружена из ссылки', 'ok', 3000);
  return true;
}
