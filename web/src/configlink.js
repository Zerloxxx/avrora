/* Формат ссылки на конфигурацию: #c=base64(дифф к встроенному сценарию).
   Чистые функции без state и DOM — один и тот же формат читают инженерный вид (model.js)
   и вид абонента (subscriber.js). Если формат правится — правится здесь, в одном месте,
   иначе страницы начнут показывать разные числа по одной ссылке.

   Поля диффа:
     id  — идентификатор встроенного сценария
     st  — этап развёртывания
     pl  — плоскости: [id, raan_deg, phase_deg, inclination_deg?]
     dz  — весь design целиком, если состав плоскостей изменён (пересобранная группировка);
            тогда sat и lb не нужны
     sat — добавленные аппараты, lb — очереди всех аппаратов по порядку
     f, go — периоды недоступности аппаратов и шлюзов
     gs, rm — добавленные и удалённые наземные пункты
     hm  — маски горизонта и тип местности для пунктов исходного файла: { id: { m, t } }
     ecl — аппараты в тени не ретранслируют
     c   — выбранный клиентский пункт
*/

const b64encode = obj => btoa(unescape(encodeURIComponent(JSON.stringify(obj))));
const b64decode = s => JSON.parse(decodeURIComponent(escape(atob(s))));

// Дифф текущей конфигурации относительно исходного файла сценария.
export function encodeDiff(scenario, base, { scenarioId, clientId } = {}) {
  const s = scenario, b = base;
  const diff = {
    id: scenarioId,
    st: s.design.launch_stage,
    pl: s.design.planes.map(p => [p.id, p.raan_deg, p.phase_deg, p.inclination_deg]),
    f: s.failures,
    go: s.gateway_outages,
    gs: s.ground_sites.filter(g => !b.ground_sites.some(x => x.id === g.id)),
    rm: b.ground_sites.filter(g => !s.ground_sites.some(x => x.id === g.id)).map(g => g.id),
    sat: s.design.satellites.filter(x => !b.design.satellites.some(y => y.id === x.id)),
    lb: s.design.satellites.map(x => x.launch_batch),
    ecl: !!s.environment.eclipse_isl_off,
    c: clientId,
  };
  // состав плоскостей изменён (группировка пересобрана) — везём design целиком
  const sameShape = s.design.planes.length === b.design.planes.length
    && s.design.planes.every(p => b.design.planes.some(x => x.id === p.id));
  if (!sameShape) { diff.dz = s.design; delete diff.sat; delete diff.lb; }
  // маски горизонта пунктов исходного файла (у добавленных они уезжают вместе с gs)
  const hm = {};
  for (const g of s.ground_sites) if (g.horizon_mask && b.ground_sites.some(x => x.id === g.id)) hm[g.id] = { m: g.horizon_mask, t: g.terrain };
  if (Object.keys(hm).length) diff.hm = hm;
  return b64encode(diff);
}

// Вытащить base64 из хеша адреса; null — ссылки с конфигурацией нет.
export function readHash(hash = '') {
  const m = hash.match(/#c=([A-Za-z0-9+/=]+)/);
  return m ? m[1] : null;
}

export function decodeDiff(b64) {
  try { return b64decode(b64); } catch { return null; }
}

/* Наложить дифф на свежую копию встроенного сценария. Мутирует переданный scenario
   и возвращает его же; порядок шагов важен — design и пункты правятся до очередей. */
export function applyDiff(scenario, d) {
  const s = scenario;
  if (d.dz) s.design = d.dz;
  if (d.st) s.design.launch_stage = d.st;
  for (const [id, raan, phase, inc] of d.pl || []) {
    const pl = s.design.planes.find(x => x.id === id);
    if (!pl) continue;
    pl.raan_deg = raan; pl.phase_deg = phase;
    if (Number.isFinite(inc)) pl.inclination_deg = inc;
  }
  for (const [id, v] of Object.entries(d.hm || {})) {
    const g = s.ground_sites.find(x => x.id === id);
    if (g) { g.horizon_mask = v.m; g.terrain = v.t; }
  }
  s.failures = d.f || [];
  s.gateway_outages = d.go || [];
  s.ground_sites = s.ground_sites.filter(g => !(d.rm || []).includes(g.id)).concat(d.gs || []);
  for (const x of d.sat || []) s.design.satellites.push(x);
  if (d.lb && d.lb.length === s.design.satellites.length) s.design.satellites.forEach((x, i) => x.launch_batch = d.lb[i]);
  if (d.ecl) s.environment.eclipse_isl_off = true;
  return s;
}
