// Проверка расчётного ядра против эталонных значений geometry.py и известных свойств модели.
// Запуск: node --test tests/  (из папки web/)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { snapshot, findRoute, computeAvailability, validate, routeLengthKm, optimizePlanes, coverageGrid, pairFailures, timeGrid, C_LIGHT, contactWindows, skyView, uniformMask, siteMask, maskSector, planeInclination,
  routeStrategies, backupPaths, routeAvoiding, vulnerableSatellites, STRATEGIES } from '../src/sim.js';

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

// --- проверка сценария: список ошибок должен быть полным ---

test('validate(): одна ошибка не скрывает остальные — список полный за один проход', () => {
  const bad = clone(S['04_link_range']);
  bad.schema_version = 'cosmo-B-2.0';        // ломает схему
  bad.environment.altitude_km = 'пятьсот';   // раньше обрывало проверку здесь
  bad.environment.min_elevation_deg = 95;
  bad.ground_sites[0].lat_deg = 200;
  bad.failures.push({ satellite_id: 'НЕТ-ТАКОГО', start_s: 500, end_s: 100 });
  const errs = validate(bad);
  const has = re => errs.some(x => re.test(x));
  assert.ok(has(/schema_version/), 'схема');
  assert.ok(has(/altitude_km/), 'нечисловая высота');
  assert.ok(has(/min_elevation_deg/), 'угол возвышения за диапазоном');
  assert.ok(has(/lat_deg/), 'широта пункта за диапазоном');
  assert.ok(has(/неизвестный satellite_id/), 'отказ несуществующего аппарата');
  assert.ok(has(/start_s < end_s/), 'перевёрнутый интервал отказа');
});

test('validate(): однотипные ошибки сворачиваются в одну строку с числом повторов', () => {
  const bad = clone(full);
  bad.design.planes[1].id = bad.design.planes[0].id;   // 16 аппаратов теряют свою плоскость
  const errs = validate(bad);
  const line = errs.find(x => /неизвестная плоскость/.test(x));
  assert.ok(line, 'про неизвестную плоскость должно быть сказано');
  assert.match(line, /и ещё \d+ аппаратов/, 'повторы сворачиваются, а не печатаются по одному');
  assert.ok(errs.filter(x => /неизвестная плоскость/.test(x)).length === 1, 'одна строка на одну причину');
  assert.ok(errs.some(x => /дублируется id/.test(x)), 'исходная причина тоже названа');
});

test('validate(): отсутствие environment не мешает проверить остальной файл', () => {
  const bad = clone(full);
  delete bad.environment;
  const errs = validate(bad);
  assert.ok(errs.some(x => /environment/.test(x)), 'про отсутствующий раздел сказано');
  bad.ground_sites[0].role = 'мимо';
  assert.ok(validate(bad).some(x => /role должен быть client или gateway/.test(x)), 'проверки пунктов продолжают работать');
});

// --- стратегии маршрутизации ---

test('стратегии маршрутизации: доступность одинакова, различаются переключения и задержка', () => {
  const res = routeStrategies(full, { stepMul: 6 });
  assert.equal(res.rows.length, Object.keys(STRATEGIES).length, 'считаются все стратегии');
  // путь либо существует на шаге, либо нет — это свойство сети, а не алгоритма поиска
  assert.ok(res.sameAvailability, 'доступность обязана совпасть у всех стратегий');
  const by = Object.fromEntries(res.rows.map(r => [r.key, r]));
  for (const k of Object.keys(STRATEGIES))
    assert.ok(Math.abs(by[k].minAvailability - by.sticky.minAvailability) < 1e-9, `${k}: доступность разошлась с липкой`);
  assert.ok(by.sticky.handovers <= by.minhop.handovers, 'липкий маршрут не может переключаться чаще, чем поиск заново');
  assert.ok(by.latency.avgLatencyMs <= by.minhop.avgLatencyMs + 1e-9, 'стратегия минимума задержки не должна быть медленнее BFS');
  assert.ok(by.minhop.avgHops <= by.sticky.avgHops + 1e-9, 'минимум переходов не может давать более длинные цепочки, чем липкая');
  assert.equal(res.best.stability, 'sticky', 'по переключениям выигрывает липкая стратегия');
});

test('стратегия минимума задержки даёт путь не длиннее, чем BFS, на том же шаге', () => {
  const snap = snapshot(full, 43200);
  const c = 'C65';
  const km = r => routeLengthKm(snap, r.path, snap.ground[c].pos, snap.ground[r.gateway].pos);
  const b = findRoute(full, snap, c, null, 'minhop');
  const l = findRoute(full, snap, c, null, 'latency');
  assert.ok(b.path && l.path, 'на полдень маршрут существует в обеих стратегиях');
  assert.ok(km(l) <= km(b) + 1e-6, `минимум задержки: ${km(l).toFixed(1)} км должно быть ≤ ${km(b).toFixed(1)} км`);
});

// --- резервные пути ---

test('резервные пути: независимый обход и незаменимый аппарат — взаимоисключающие состояния шага', () => {
  const res = backupPaths(full, { clientId: 'C65', stepMul: 3 });
  assert.ok(res.withRoute > 0 && res.withRoute <= res.steps);
  for (const key of ['disjointShare', 'spofShare', 'oneAccessShare', 'chainCriticalShare'])
    assert.ok(res[key] >= 0 && res[key] <= 1, `${key} — доля, должна лежать в [0…1]`);
  // если существует путь в обход всех аппаратов основного, то отказ любого из них перекрывается
  assert.ok(res.disjointShare + res.spofShare <= 1 + 1e-9, 'шаг не может быть одновременно с полным обходом и с незаменимым аппаратом');
  assert.ok(res.chainCriticalShare <= res.spofShare + 1e-9, 'узкое звено в цепочке — подмножество незаменимых');
  // первая очередь заведомо тоньше полной группировки
  const first = backupPaths(S['02_first_launch'], { clientId: 'C65', stepMul: 3 });
  assert.ok(first.disjointShare <= res.disjointShare, 'на 16 аппаратах резерва не может быть больше, чем на 48');
});

test('routeAvoiding(): запрет аппаратов маршрута заставляет искать другой путь или признать разрыв', () => {
  const snap = snapshot(full, 43200);
  const r = routeAvoiding(full, snap, 'C65', null);
  assert.ok(r.path, 'базовый маршрут есть');
  const alt = routeAvoiding(full, snap, 'C65', new Set(r.path));
  if (alt.path) assert.ok(alt.path.every(k => !r.path.includes(k)), 'обходной путь не должен использовать запрещённые аппараты');
  else assert.ok(['no_sat', 'no_gw_contact', 'net_split'].includes(alt.reason), 'иначе — внятная причина, почему обхода нет');
});

// --- разбивка отказов по направлениям связи ---

test('уязвимые аппараты: перечислены ровно те направления, у которых доступность упала', () => {
  const res = vulnerableSatellites(S['02_first_launch'], { stepMul: 6 });
  const it = res.items[0];
  assert.ok(it.affected.length > 0, 'у самого уязвимого аппарата обязаны быть затронутые пункты');
  for (const [c, v] of Object.entries(it.perClient)) {
    const listed = it.affected.includes(c);
    assert.equal(listed, v.drop > 1e-9, `${c}: в списке затронутых ровно при фактической просадке`);
    assert.ok(v.availability <= res.baseByClient[c] + 1e-9, `${c}: отказ аппарата не может поднять доступность`);
  }
  assert.equal(it.worstClient, Object.entries(it.perClient).sort((a, b) => b[1].drop - a[1].drop)[0][0], 'worstClient — пункт с наибольшей просадкой');
});

test('матрица N-1/N-2: для каждой опасной пары назван страдающий пункт', () => {
  const res = pairFailures(S['02_first_launch'], { stepMul: 12 });
  const clients = S['02_first_launch'].ground_sites.filter(g => g.role === 'client').map(g => g.id);
  for (const p of res.worstPairs) assert.ok(clients.includes(p.worstClient), `пара ${p.a}+${p.b}: worstClient должен быть клиентским пунктом`);
  for (const [c, n] of Object.entries(res.badPairsByClient)) {
    assert.ok(clients.includes(c), 'разбивка только по клиентским пунктам');
    assert.ok(n > 0 && n <= res.badPairs, 'число пар по направлению не больше общего числа опасных пар');
  }
  assert.equal(Object.values(res.badPairsByClient).reduce((a, b) => a + b, 0), res.badPairs, 'каждая опасная пара отнесена ровно к одному направлению');
});

// --- отпечаток конфигурации: по нему аналитика признаётся устаревшей ---

test('hashScenario(): отпечаток меняется при любой правке, а не только при смене длины JSON', async () => {
  const { hashScenario, state } = await import('../src/state.js');
  state.scenarioId = '01_full_constellation';
  const set = raans => { const s = clone(full); s.design.planes.forEach((p, i) => p.raan_deg = raans[i] ?? p.raan_deg); state.scenario = s; return hashScenario(); };
  // 120 и 130 дают JSON одной длины — на этом прежний отпечаток по длине давал коллизию
  const h120 = set([120, 60, 300]), h130 = set([130, 60, 300]);
  assert.notEqual(h120, h130, 'raan 120 и 130 обязаны давать разные отпечатки');
  // и разница действительно значимая: доступность расходится
  const a120 = clone(full), a130 = clone(full);
  a120.design.planes[0].raan_deg = 120; a120.design.planes[1].raan_deg = 60; a120.design.planes[2].raan_deg = 300;
  a130.design.planes[0].raan_deg = 130; a130.design.planes[1].raan_deg = 60; a130.design.planes[2].raan_deg = 300;
  const min = s => Math.min(...Object.values(computeAvailability(s, 6)).map(r => r.availability));
  assert.ok(Math.abs(min(a120) - min(a130)) > 0.005, 'конфигурации действительно различаются по доступности');
  assert.equal(set([120, 60, 300]), h120, 'одна и та же конфигурация — один и тот же отпечаток');
  // смена сценария тоже меняет отпечаток при идентичном содержимом
  state.scenarioId = 'другой';
  assert.notEqual(hashScenario(), h120, 'отпечаток учитывает, из какого файла собрана конфигурация');
});
