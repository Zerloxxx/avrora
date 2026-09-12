// Проверка расчётного ядра против эталонных значений geometry.py и известных свойств модели.
// Запуск: node --test tests/  (из папки web/)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { snapshot, findRoute, computeAvailability, validate, routeLengthKm, optimizePlanes, coverageGrid, pairFailures, timeGrid, C_LIGHT, contactWindows, skyView, uniformMask, siteMask, maskSector, planeInclination } from '../src/sim.js';

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

test('окна связи: покрывают горизонт без дыр и совпадают с computeAvailability', () => {
  for (const name of ['01_full_constellation', '02_first_launch', '03_satellite_outages']) {
    const s = clone(S[name]);
    const client = s.ground_sites.find(g => g.role === 'client').id;
    const w = contactWindows(s, client);
    const av = computeAvailability(s)[client];

    // доступность считается тем же маршрутом — значения должны быть идентичны
    assert.equal(w.availability.toFixed(9), av.availability.toFixed(9), `${name}: доступность разошлась`);

    // окна и перерывы вместе укладывают горизонт встык, без пропусков и наложений
    const all = [...w.windows, ...w.gaps].sort((a, b) => a.start_s - b.start_s);
    assert.equal(all[0].start_s, 0, `${name}: первый отрезок должен начинаться в 0`);
    assert.equal(all[all.length - 1].end_s, w.steps * w.step_s, `${name}: последний отрезок должен доходить до конца сетки`);
    for (let i = 1; i < all.length; i++) assert.equal(all[i].start_s, all[i - 1].end_s, `${name}: разрыв между отрезками`);

    // суммарная длительность окон = доля доступности × горизонт
    const okMin = w.windows.reduce((a, x) => a + x.durMin, 0);
    assert.equal((okMin * 60 / (w.steps * w.step_s)).toFixed(9), w.availability.toFixed(9), `${name}: сумма окон не бьётся с долей`);

    // максимальный перерыв — тот же, что в сводке
    assert.equal((w.worstGap?.durMin ?? 0).toFixed(6), av.maxGapMin.toFixed(6), `${name}: максимальный перерыв разошёлся`);

    // у каждого перерыва названа причина из разрешённого списка
    for (const g of w.gaps) assert.ok(['no_sat', 'net_split', 'no_gw_contact', 'gw_offline'].includes(g.reason), `${name}: причина «${g.reason}»`);
  }
});

test('небо над пунктом: видны ровно те аппараты, что в снимке, и все выше порога', () => {
  const s = clone(full);
  const client = s.ground_sites.find(g => g.role === 'client').id;
  const minEl = s.environment.min_elevation_deg;
  for (const t of [0, 21600, 43200, 64800]) {
    const sky = skyView(s, client, t);
    const snap = snapshot(s, t);
    assert.equal(sky.length, snap.ground[client].visibleRaw.length + (snap.ground[client].blocked?.length ?? 0),
      `t=${t}: состав неба разошёлся со snapshot() (видимые + закрытые рельефом)`);
    for (const x of sky) {
      assert.ok(x.elDeg >= minEl - 1e-9, `t=${t}: ${x.id} возвышение ${x.elDeg.toFixed(2)}° ниже порога ${minEl}°`);
      assert.ok(x.azDeg >= 0 && x.azDeg < 360, `t=${t}: ${x.id} азимут вне [0,360)`);
      // дальность согласована с углом возвышения: чем выше, тем ближе (для круговой орбиты)
      assert.ok(x.rangeKm > s.environment.altitude_km - 1 && x.rangeKm < 3000, `t=${t}: ${x.id} дальность ${x.rangeKm.toFixed(0)} км`);
    }
    // отсортировано по убыванию возвышения — первый и есть «над головой»
    for (let i = 1; i < sky.length; i++) assert.ok(sky[i - 1].elDeg >= sky[i].elDeg, `t=${t}: порядок сортировки`);
  }
});

test('небо: аппарат в зените даёт возвышение ~90° и дальность ~высоте орбиты', () => {
  const s = clone(full);
  const client = s.ground_sites.find(g => g.role === 'client').id;
  // ищем момент, когда над пунктом самый высокий аппарат — проверяем физику на экстремуме
  let best = { elDeg: -90 };
  for (let t = 0; t < s.environment.horizon_s; t += s.environment.step_s) {
    const top = skyView(s, client, t)[0];
    if (top && top.elDeg > best.elDeg) best = top;
  }
  assert.ok(best.elDeg > 70, `лучший пролёт всего ${best.elDeg.toFixed(1)}° — ожидалось выше 70°`);
  // при возвышении el дальность до круговой орбиты не меньше высоты и растёт при снижении el
  assert.ok(best.rangeKm < s.environment.altitude_km * 1.15,
    `в зените дальность ${best.rangeKm.toFixed(0)} км должна быть близка к высоте ${s.environment.altitude_km} км`);
});

test('рельеф: маска горизонта закрывает аппараты, роняет доступность и видна абоненту', () => {
  const base = clone(full);
  const client = base.ground_sites.find(g => g.role === 'client').id;
  const avail0 = computeAvailability(base)[client].availability;

  // тот же сценарий, но у пункта горы: закрытие 30° по всем азимутам
  const masked = clone(full);
  const site = masked.ground_sites.find(g => g.id === client);
  site.horizon_mask = uniformMask(30);
  site.terrain = 'valley';

  // 1. маска читается и применяется к нужному сектору
  assert.equal(siteMask(site).length, 36, 'маска должна быть на 36 секторов');
  assert.equal(maskSector(siteMask(site), 123.4), 30, 'угол закрытия в секторе азимута');

  // 2. закрытое небо не может дать доступность выше открытого
  const avail1 = computeAvailability(masked)[client].availability;
  assert.ok(avail1 <= avail0 + 1e-9, `с маской ${(avail1*100).toFixed(1)}% > без маски ${(avail0*100).toFixed(1)}%`);
  assert.ok(avail1 < avail0, 'закрытие 30° обязано снизить доступность полной группировки');

  // 3. окна связи для абонента считаются на той же физике
  const w = contactWindows(masked, client);
  assert.equal(w.availability.toFixed(9), avail1.toFixed(9), 'окна связи разошлись с computeAvailability при маске');

  // 4. небо разделяет «видно» и «закрыто рельефом», причём закрытые ниже своей маски
  let blockedSeen = 0;
  for (const t of [0, 21600, 43200, 64800]) {
    const snap = snapshot(masked, t);
    for (const x of skyView(masked, client, t)) {
      assert.equal(x.maskDeg, 30, 'maskDeg должен отдавать угол закрытия сектора');
      if (x.blocked) {
        blockedSeen++;
        assert.ok(x.elDeg < x.maskDeg + 1e-9, `${x.id}: закрыт, но возвышение ${x.elDeg.toFixed(1)}° ≥ маски`);
        assert.ok(snap.ground[client].blocked.includes(x.index), 'закрытый аппарат должен быть в snapshot().blocked');
      } else {
        assert.ok(x.elDeg >= x.maskDeg - 1e-9, `${x.id}: виден, но возвышение ${x.elDeg.toFixed(1)}° < маски`);
      }
    }
  }
  assert.ok(blockedSeen > 0, 'при закрытии 30° хотя бы один аппарат обязан оказаться за рельефом');
});

test('наклонение на плоскость: своё значение меняет геометрию, отсутствие — берёт общее', () => {
  const s = clone(full);
  assert.equal(planeInclination(s, s.design.planes[0]), s.environment.inclination_deg, 'без поля — общее наклонение');
  const tilted = clone(full);
  tilted.design.planes[0].inclination_deg = 60;
  assert.equal(planeInclination(tilted, tilted.design.planes[0]), 60, 'своё наклонение плоскости');
  // аппараты первой плоскости обязаны сместиться, остальных — остаться на месте
  const a = snapshot(s, 1000).pos, b = snapshot(tilted, 1000).pos;
  const p0 = tilted.design.satellites.findIndex(x => x.plane_id === tilted.design.planes[0].id);
  const p1 = tilted.design.satellites.findIndex(x => x.plane_id === tilted.design.planes[1].id);
  assert.ok(Math.hypot(a[p0].x-b[p0].x, a[p0].y-b[p0].y, a[p0].z-b[p0].z) > 100, 'плоскость с новым наклонением должна сдвинуться');
  assert.ok(Math.hypot(a[p1].x-b[p1].x, a[p1].y-b[p1].y, a[p1].z-b[p1].z) < 1e-6, 'остальные плоскости трогать нельзя');
  assert.deepEqual(validate(tilted), [], 'наклонение плоскости — допустимое расширение схемы');
});
