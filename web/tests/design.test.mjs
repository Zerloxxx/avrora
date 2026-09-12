// Конструктор группировки и маска горизонта: генератор Walker, очереди, рельеф/застройка, поиск проекта.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { snapshot, computeAvailability, validate, satPositions, siteFrame, lookAngles, uniformMask, sectorMask, maskFromProfiles,
  buildingAngle, TERRAIN_PRESETS, walkerDelta, assignBatches, designSearch, optimizeBatches, deploymentPlan, maxBatch, layoutCompare } from '../src/sim.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const window = {};
eval(fs.readFileSync(path.join(here, '../data/scenarios.js'), 'utf8'));
const S = window.SCENARIOS;
const full = S['01_full_constellation'];
const clone = o => JSON.parse(JSON.stringify(o));

test('местная система пункта: зенит, север и восток дают ожидаемые азимут и возвышение', () => {
  const g = { lat_deg: 70, lon_deg: 30 };
  const f = siteFrame(g);
  const at = (dir, h) => ({ x: f.pos.x + dir.x * h, y: f.pos.y + dir.y * h, z: f.pos.z + dir.z * h });
  assert.ok(Math.abs(lookAngles(f, at(f.up, 500)).el_deg - 90) < 1e-6);
  const n = lookAngles(f, { x: f.pos.x + f.north.x * 100 + f.up.x * 100, y: f.pos.y + f.north.y * 100 + f.up.y * 100, z: f.pos.z + f.north.z * 100 + f.up.z * 100 });
  assert.ok(Math.min(n.az_deg, 360 - n.az_deg) < 1e-6 && Math.abs(n.el_deg - 45) < 1e-6);
  const e = lookAngles(f, at(f.east, 100));
  assert.ok(Math.abs(e.az_deg - 90) < 1e-6 && Math.abs(e.el_deg) < 1e-6);
});

test('маска горизонта: нулевая маска не меняет видимость; равномерная 20° убирает низкие спутники', () => {
  const s0 = clone(full);
  const withZero = clone(full); withZero.ground_sites.forEach(g => g.horizon_mask = uniformMask(0));
  const with20 = clone(full); with20.ground_sites.forEach(g => g.horizon_mask = uniformMask(20));
  for (const t of [0, 43200, 61200]) {
    const a = snapshot(s0, t), b = snapshot(withZero, t), c = snapshot(with20, t);
    for (const id of Object.keys(a.ground)) {
      assert.deepEqual(b.ground[id].visible, a.ground[id].visible, `t=${t} ${id}: маска 0 ≠ без маски`);
      assert.ok(c.ground[id].visible.every(k => a.ground[id].visible.includes(k)), 'маска 20° не может добавить спутников');
      // всё, что маска убрала, действительно ниже 20°
      const fr = siteFrame(s0.ground_sites.find(g => g.id === id));
      for (const k of c.ground[id].blocked) assert.ok(lookAngles(fr, a.pos[k]).el_deg < 20 + 1e-9);
      for (const k of c.ground[id].visible) assert.ok(lookAngles(fr, a.pos[k]).el_deg >= 20 - 1e-9);
    }
  }
  const avA = computeAvailability(s0), avC = computeAvailability(with20);
  for (const id of Object.keys(avA)) assert.ok(avC[id].availability < avA[id].availability, `${id}: застройка должна снижать доступность`);
});

test('секторная маска закрывает только свой сектор азимутов', () => {
  const s = clone(full);
  const c65 = s.ground_sites.find(g => g.id === 'C65');
  c65.horizon_mask = sectorMask(0, 120, 240, 60);       // юг закрыт «хребтом» 60°
  const fr = siteFrame(c65);
  for (const t of [0, 7200, 43200]) {
    const snap = snapshot(s, t), ref = snapshot(full, t);
    for (const k of snap.ground.C65.blocked) { const la = lookAngles(fr, snap.pos[k]); assert.ok(la.az_deg >= 120 && la.az_deg < 240 && la.el_deg < 60); }
    for (const k of ref.ground.C65.visible) { const la = lookAngles(fr, ref.pos[k]); if (la.az_deg < 120 || la.az_deg >= 240) assert.ok(snap.ground.C65.visible.includes(k)); }
  }
});

test('маска из профилей рельефа: кривизна Земли и высота антенны учтены; пресеты застройки монотонны', () => {
  // ровная равнина: закрытие 0; холм 300 м на 5 км: atan((300 − 2 − 5²/(2R)·1000)/5000)
  const flat = maskFromProfiles(0, [[{ dist_km: 5, h_m: 0 }, { dist_km: 20, h_m: 0 }]]);
  assert.equal(flat[0], 0);
  const hill = maskFromProfiles(0, [[{ dist_km: 5, h_m: 300 }]]);
  const drop = 25 / (2 * 6371) * 1000;
  assert.ok(Math.abs(hill[0] - Math.atan2(300 - 2 - drop, 5000) * 180 / Math.PI) < 0.01);
  assert.ok(buildingAngle(8, 40) < buildingAngle(16, 50) && buildingAngle(16, 50) < buildingAngle(30, 60));
  const m = TERRAIN_PRESETS.city.build();
  assert.equal(m.length, 36); assert.ok(m.every(v => v > 20));
});

test('Walker 48/3/1 со спредом 180° воспроизводит группировку кейса', () => {
  const d = walkerDelta({ T: 48, P: 3, F: 1, raanSpread: 180, batches: 3, batchMode: 'plane' });
  assert.deepEqual(d.planes.map(p => [p.raan_deg, p.phase_deg]), [[0, 0], [60, 7.5], [120, 15]]);
  const s = clone(full); s.design = { ...d, launch_stage: 3 };
  const a = satPositions(full, 3600), b = satPositions(s, 3600);
  const key = p => `${p.x.toFixed(3)},${p.y.toFixed(3)},${p.z.toFixed(3)}`;
  assert.deepEqual(new Set(a.map(key)), new Set(b.map(key)));
  // очередь = плоскость (как в кейсе)
  assert.deepEqual(s.design.satellites.filter(x => x.launch_batch === 1).map(x => x.plane_id), Array(16).fill('P1'));
  assert.deepEqual(computeAvailability(s, 4).C65.ok, computeAvailability(full, 4).C65.ok);
});

test('раскладка по очередям: 6 очередей по 8, режим spread берёт аппараты из всех плоскостей', () => {
  const d = walkerDelta({ T: 48, P: 3, F: 1, raanSpread: 180, batches: 6, batchMode: 'spread' });
  const counts = {};
  for (const x of d.satellites) counts[x.launch_batch] = (counts[x.launch_batch] || 0) + 1;
  assert.deepEqual(counts, { 1: 8, 2: 8, 3: 8, 4: 8, 5: 8, 6: 8 });
  const first = d.satellites.filter(x => x.launch_batch === 1);
  assert.deepEqual(new Set(first.map(x => x.plane_id)), new Set(['P1', 'P2', 'P3']));
  assignBatches(d.satellites, [20, 28]);
  assert.equal(d.satellites.filter(x => x.launch_batch === 2).length, 28);
  const s = clone(full); s.design = { ...d, launch_stage: 2 };
  assert.equal(maxBatch(s), 2);
  assert.deepEqual(validate(s), []);
  s.design.launch_stage = 3;
  assert.ok(validate(s).some(e => e.includes('launch_stage')));
  assert.equal(deploymentPlan({ ...s, design: { ...s.design, launch_stage: 2 } }).stages.length, 2);
});

test('наклонение на плоскость: разные оси меняют положения, без поля — как environment', () => {
  const s = clone(full);
  s.design.planes[1].inclination_deg = 60;
  const a = satPositions(full, 0), b = satPositions(s, 0);
  s.design.satellites.forEach((x, k) => {
    const same = Math.hypot(a[k].x - b[k].x, a[k].y - b[k].y, a[k].z - b[k].z) < 1e-6;
    assert.equal(same, x.plane_id !== 'P2');
  });
  assert.deepEqual(validate(s), []);
  s.design.planes[1].inclination_deg = 0;
  assert.ok(validate(s).some(e => e.includes('inclination_deg')));
});

test('поиск проекта: находит минимальную группировку, кандидат 48/3 не хуже кейса', () => {
  const r = designSearch(full, { T: [36, 48], P: [3], stepMul: 6 });
  assert.equal(r.evaluated, 12);   // 2 T × 3 F × 2 спреда RAAN
  assert.equal(r.pareto.length, 2);
  assert.ok(r.pareto[0].T < r.pareto[1].T);
  const c48 = r.results.filter(x => x.T === 48).sort((a, b) => b.score - a.score)[0];
  const ref = computeAvailability(full, 6);
  assert.ok(c48.minFull >= Math.min(...Object.values(ref).map(x => x.availability)) - 1e-9);
  assert.ok(r.results.every(x => x.minFirst <= x.minFull + 1e-9));
});

test('состав очередей при шести очередях: размеры сохраняются, первая — не хуже текущей', () => {
  const d = walkerDelta({ T: 48, P: 3, F: 1, raanSpread: 180, batches: 6, batchMode: 'plane' });
  const s = clone(full); s.design = { ...d, launch_stage: 6 };
  const r = optimizeBatches(s, { stepMul: 12 });
  const counts = {};
  for (const v of Object.values(r.assignment)) counts[v] = (counts[v] || 0) + 1;
  assert.deepEqual(counts, { 1: 8, 2: 8, 3: 8, 4: 8, 5: 8, 6: 8 });
  assert.ok(r.options[0].score >= r.options.find(o => o.name === 'текущая').score);
});

test('сравнение раскладок: разнесение первой очереди по плоскостям поднимает худший пункт и режет перерыв', () => {
  const r = layoutCompare(full, { planes: [4] });
  const byId = Object.fromEntries(r.options.map(o => [o.id, o]));
  assert.ok(byId.case && byId.spread && byId.walker4);
  // полная группировка у «тех же плоскостей» не меняется
  assert.equal(byId.spread.stages[2].min, byId.case.stages[2].min);
  // первая очередь: 13% → ~31%, перерыв 13 ч → ~1 ч
  assert.ok(byId.spread.stages[0].min > byId.case.stages[0].min + 0.1);
  assert.ok(byId.spread.stages[0].maxGap < byId.case.stages[0].maxGap / 5);
  assert.equal(r.bestId, 'spread');
  // размеры очередей сохранены
  const counts = {}; for (const b of Object.values(byId.spread.assignment)) counts[b] = (counts[b] || 0) + 1;
  assert.deepEqual(counts, { 1: 16, 2: 16, 3: 16 });
});
