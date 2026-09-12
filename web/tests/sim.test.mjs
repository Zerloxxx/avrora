// Проверка расчётного ядра против эталонных значений geometry.py и известных свойств модели.
// Запуск: node --test tests/  (из папки web/)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { snapshot, findRoute, computeAvailability, validate, routeLengthKm, optimizePlanes, coverageGrid, pairFailures, timeGrid, C_LIGHT } from '../src/sim.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const window = {};
eval(fs.readFileSync(path.join(here, '../data/scenarios.js'), 'utf8'));
const S = window.SCENARIOS;
const full = S['01_full_constellation'];
const clone = o => JSON.parse(JSON.stringify(o));

test('все встроенные сценарии проходят validate()', () => {
  for (const [id, s] of Object.entries(S)) assert.deepEqual(validate(s), [], id);
});

test('снимок t=0 совпадает с geometry.py: 76 ISL, маршрут C65 → S20 → G_MUR', () => {
  const snap = snapshot(full, 0);
  assert.equal(snap.isl.length, 76);
  assert.deepEqual(snap.ground.G_MUR.visible.map(k => full.design.satellites[k].id), ['S04', 'S20']);
  const r = findRoute(full, snap, 'C65');
  assert.deepEqual(r.path.map(k => full.design.satellites[k].id), ['S20']);
  assert.equal(r.gateway, 'G_MUR');
});

test('доступность полной группировки за сутки (эталон прототипа)', () => {
  const a = computeAvailability(full);
  assert.ok(Math.abs(a.C65.availability - 0.967) < 0.002);
  assert.ok(Math.abs(a.C70.availability - 0.988) < 0.002);
  assert.ok(Math.abs(a.C72.availability - 0.989) < 0.002);
  assert.equal(a.C65.maxGapMin, 8);
  assert.ok(a.C65.avgLatencyMs > 5 && a.C65.avgLatencyMs < 40, 'задержка в разумных пределах');
  assert.ok(a.C72.avgHops > a.C65.avgHops, 'дальний пункт требует больше хопов');
});

test('первая очередь: связь рвётся, причина — нет видимого спутника / нет контакта со шлюзом', () => {
  const a = computeAvailability(S['02_first_launch']);
  assert.ok(a.C72.availability < 0.2);
  assert.ok(a.C72.maxGapMin > 600);
  assert.ok(Object.keys(a.C72.reasons).length > 0);
});

test('отказы и дальность ISL снижают доступность относительно полной группировки', () => {
  const base = computeAvailability(full);
  const outages = computeAvailability(S['03_satellite_outages']);
  const range = computeAvailability(S['04_link_range']);
  for (const c of ['C65', 'C70', 'C72']) {
    assert.ok(outages[c].availability < base[c].availability, c + ' outages');
    assert.ok(range[c].availability < base[c].availability, c + ' range');
  }
});

test('«липкий» маршрут: прежний путь сохраняется, пока все звенья живы', () => {
  // на 120 с маршрут C65 → S19 → G_MUR; на 240 с все звенья ещё существуют — путь должен сохраниться
  const r0 = findRoute(full, snapshot(full, 120), 'C65');
  const r1 = findRoute(full, snapshot(full, 240), 'C65', r0);
  assert.equal(r1.kept, true);
  assert.deepEqual(r1.path, r0.path);
  // а без памяти о прежнем маршруте BFS выбирает путь заново — результат может отличаться, но не короче
  const fresh = findRoute(full, snapshot(full, 240), 'C65');
  assert.ok(fresh.path.length <= r1.path.length);
});

test('длина маршрута и задержка физически согласованы', () => {
  const snap = snapshot(full, 0);
  const r = findRoute(full, snap, 'C65');
  const km = routeLengthKm(snap, r.path, snap.ground.C65.pos, snap.ground.G_MUR.pos);
  assert.ok(km > 1000 && km < 6000, 'один хоп с высоты 550 км — порядка тысяч км');
  assert.ok(km / C_LIGHT * 1000 < 25);
});

test('validate() перечисляет конкретные ошибки', () => {
  const bad = clone(full);
  bad.design.planes[0].raan_deg = 400;
  bad.failures.push({ satellite_id: 'S99', start_s: 5, end_s: 1 });
  const errors = validate(bad);
  assert.ok(errors.some(e => e.includes('P1') && e.includes('raan_deg')));
  assert.ok(errors.some(e => e.includes('S99')));
  assert.ok(errors.some(e => e.includes('start_s < end_s')));
});

test('автоподбор RAAN/фазы не ухудшает оценку', () => {
  const res = optimizePlanes(full, { raanStep: 30, phaseStep: 7.5, passes: 1, stepMul: 4 });
  assert.ok(res.scoreAfter >= res.scoreBefore);
});

test('карта покрытия: выше 70° с.ш. доступность не хуже, чем на 55°', () => {
  const cg = coverageGrid(full, { stepMul: 6 });
  const row = i => cg.values.slice(i * cg.lons.length, (i + 1) * cg.lons.length).reduce((a, b) => a + b, 0) / cg.lons.length;
  assert.ok(row(cg.lats.indexOf(70)) >= row(0));
});

test('матрица N-1/N-2 симметрична, диагональ — одиночные отказы', () => {
  const small = clone(full);
  small.design.launch_stage = 1;             // 16 аппаратов — быстрее
  const res = pairFailures(small, { stepMul: 6 });
  const n = res.ids.length;
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) assert.equal(res.matrix[i * n + j], res.matrix[j * n + i]);
  assert.ok(res.n2Min <= res.n1Min && res.n1Min <= res.baseMin);
});

test('сетка времени по «Описанию данных»: 720 отсчётов, 0…86 280 с, правый конец не включается', () => {
  const g = timeGrid(full);
  assert.equal(g.steps, 720);
  assert.equal((g.steps - 1) * g.step, 86280);
  assert.equal(computeAvailability(full).C65.ok.length, 720);
});

test('число переходов = рёбра маршрута, включая две наземные линии', () => {
  const snap = snapshot(full, 0);
  const r = findRoute(full, snap, 'C65');
  const a = computeAvailability(full);
  assert.equal(r.path.length, 1);          // C65 → S20 → G_MUR
  assert.equal(a.C65.hops[0], 2);          // два ребра
  assert.ok(a.C65.visibility >= a.C65.availability, 'видимость не меньше сквозной доступности');
});

test('снимок на 12:00 совпадает с geometry.py по составу рёбер', async () => {
  // эталон получен командой: python "Расчетный модуль/geometry.py" Данные/01_full_constellation.json 43200
  const { execFileSync } = await import('node:child_process');
  let ref;
  try {
    ref = JSON.parse(execFileSync('python', [path.join(here, '../../Расчетный модуль/geometry.py'), path.join(here, '../../Данные/01_full_constellation.json'), '43200'], { encoding: 'utf8' }));
  } catch { return; }   // нет python/numpy — пропускаем, остальные тесты не зависят
  const snap = snapshot(full, 43200);
  const ids = full.design.satellites.map(x => x.id);
  const mine = new Set(snap.isl.map(([i, j]) => ids[i] + '|' + ids[j]));
  for (const g of full.ground_sites) for (const k of snap.ground[g.id].visible) mine.add(g.id + '|' + ids[k]);
  const theirs = new Set(ref.edges.map(e => e[0] + '|' + e[1]));
  assert.deepEqual([...mine].sort(), [...theirs].sort());
});
