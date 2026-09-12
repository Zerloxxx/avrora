/* Окно «Аналитика» и инструменты панели: запуск расчётов в воркере, отрисовка результатов, отчёт. */
import { state, $, $$, toast, fmtTime, pct, drawStrip, heat, stamp, hashScenario, on } from './state.js';
import { generateWalker, terrainLabel } from './model.js';
import { REASONS } from './sim.js';
import { markChanged, addOutage, addSpareSatellite, describeChanges } from './model.js';
import { setCoverageOverlay } from './scene.js';
import { runTask } from './tools.js';

const anProgress = () => $('#an-progress');
const anButtons = () => $$('#analysis-modal button[id^="an-run-"]');

// Человеческие названия инструментов — для отчёта и для пометки «устарело».
const TOOL_NAMES = { optimize: 'подбор RAAN и фазирования', vulnerable: 'уязвимые аппараты', coverage: 'карта покрытия',
  deployment: 'план развёртывания', batches: 'состав очередей', layouts: 'раскладки очередей', pairs: 'матрица N-1/N-2',
  spares: 'резервный аппарат', montecarlo: 'Монте-Карло', design: 'подбор проекта',
  strategies: 'сравнение стратегий маршрутизации', backup: 'резервные пути' };
// Где нарисован результат каждого инструмента: контейнер помечается устаревшим при смене конфигурации.
const OUT_OF = { optimize: '#tool-result', vulnerable: '#tool-result' };

/* Результат инструмента годен только для той конфигурации, на которой он считался.
   Без этой проверки отчёт цитировал числа прежнего варианта как обоснование текущего. */
export const freshResult = type => {
  const a = state.analysis[type];
  return a && a.scenarioHash === hashScenario() ? a.result : null;
};

// запуск инструмента из окна аналитики: результат рисует render(result, outElement)
export function runAnalysis(type, opts, outSel, render) {
  const out = $(outSel);
  OUT_OF[type] = outSel;
  runTask(type, opts, { progress: anProgress(), buttons: anButtons(), onDone: res => render(res, out) });
}

const kpi = (v, l, cls = '') => `<div class="kpi"><span class="v ${cls}">${v}</span><span class="l">${l}</span></div>`;

// --- 1. карта покрытия ---
export function renderCoverage(res, out) {
  const { lats, lons, values, shareOk, target } = res;
  const rows = lats.length, cols = lons.length;
  const stats = { ok: 0, min: 1, minAt: null };
  values.forEach((v, i) => { if (v >= target) stats.ok++; if (v < stats.min) { stats.min = v; stats.minAt = [lats[Math.floor(i / cols)], lons[i % cols]]; } });
  const cv = document.createElement('canvas');
  const cw = 900, ch = Math.round(cw * rows / cols * 1.6);
  cv.width = cw; cv.height = ch; cv.className = 'chart';
  const g = cv.getContext('2d');
  const cellW = cw / cols, cellH = ch / rows;
  for (let i = 0; i < rows; i++) for (let j = 0; j < cols; j++) {
    g.fillStyle = heat(values[i * cols + j], target);
    g.fillRect(j * cellW, (rows - 1 - i) * cellH, Math.ceil(cellW), Math.ceil(cellH));
  }
  g.font = '11px "Golos Text", sans-serif'; g.fillStyle = 'rgba(0,0,0,0.75)';
  for (let i = 0; i < rows; i += 2) g.fillText(`${lats[i]}°`, 4, (rows - 1 - i) * cellH + cellH / 2 + 4);
  for (let j = 0; j < cols; j += 6) g.fillText(`${lons[j]}°`, j * cellW + 2, ch - 4);
  // пункты
  for (const site of state.scenario.ground_sites) {
    const x = (site.lon_deg + 180) / 360 * cw, y = (lats[rows - 1] + (lats[1] - lats[0]) / 2 - site.lat_deg) / ((lats[1] - lats[0]) * rows) * ch;
    if (y < 0 || y > ch) continue;
    g.fillStyle = '#fff'; g.beginPath(); g.arc(x, y, 4, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#000'; g.fillText(site.id, x + 6, y + 4);
  }
  out.innerHTML = `<div class="kpis">${kpi(pct(shareOk), 'площади 55–85° с.ш. с доступностью ≥ ' + pct(target), shareOk > 0.8 ? 'good' : shareOk > 0.5 ? 'warn' : 'bad')}
    ${kpi(pct(stats.min), `минимум (${stats.minAt[0]}°, ${stats.minAt[1]}°)`, stats.min < target ? 'bad' : 'good')}
    ${kpi(rows * cols, 'точек сетки')}</div>
    <div class="scale">0% <i></i> ≥ ${pct(target)}</div>`;
  out.appendChild(cv);
  const note = document.createElement('div'); note.className = 'an-note';
  const rowMean = i => values.slice(i * cols, (i + 1) * cols).reduce((x, y) => x + y, 0) / cols;
  const colMean = j => lats.reduce((acc, _, i) => acc + values[i * cols + j], 0) / rows;
  let worstJ = 0; for (let j = 1; j < cols; j++) if (colMean(j) < colMean(worstJ)) worstJ = j;
  const midI = Math.floor(rows / 2);
  note.innerHTML = `Доступность по широтам: ${lats[0]}° — <b>${pct(rowMean(0))}</b>, ${lats[midI]}° — <b>${pct(rowMean(midI))}</b>, ${lats[rows - 1]}° — <b>${pct(rowMean(rows - 1))}</b>. Слабее всего сектор долгот около ${lons[worstJ]}° (${pct(colMean(worstJ))} в среднем по широтам). ${shareOk < 0.9 ? 'Дыры на карте — аргумент за дополнительный шлюз в слабом секторе (вкладка «Конфигурация» → Наземные пункты).' : 'Покрытие почти сплошное: конфигурация подходит не только трём пунктам задания.'}`;
  out.appendChild(note);
  setCoverageOverlay(res);
}

// --- 3. развёртывание ---
export function renderDeployment(res, out) {
  const { stages, monthsBetween } = res;
  const clients = Object.keys(stages[0].summary);
  const target = state.scenario.environment.target_availability;
  const cv = document.createElement('canvas'); cv.width = 900; cv.height = 300; cv.className = 'chart';
  const g = cv.getContext('2d');
  const L = 50, Rr = 20, T = 20, B = 40, w = cv.width - L - Rr, h = cv.height - T - B;
  const months = monthsBetween * 3;
  const X = m => L + m / months * w, Y = v => T + (1 - v) * h;
  g.strokeStyle = 'rgba(255,255,255,0.08)'; g.fillStyle = 'rgba(233,237,247,0.7)'; g.font = '11px "Golos Text", sans-serif';
  for (let v = 0; v <= 1; v += 0.25) { g.beginPath(); g.moveTo(L, Y(v)); g.lineTo(L + w, Y(v)); g.stroke(); g.fillText(pct(v), 6, Y(v) + 4); }
  for (let m = 0; m <= months; m += monthsBetween) { g.fillText(`${m} мес`, X(m) - 12, cv.height - 18); }
  g.strokeStyle = '#ffd166'; g.setLineDash([4, 4]); g.beginPath(); g.moveTo(L, Y(target)); g.lineTo(L + w, Y(target)); g.stroke(); g.setLineDash([]);
  g.fillStyle = '#ffd166'; g.fillText('цель', L + w - 30, Y(target) - 6);
  const cols = ['#4fd1ff', '#9b5cff', '#ff4fd8', '#7ee787', '#ffa94d'];
  clients.forEach((c, ci) => {
    g.strokeStyle = cols[ci % cols.length]; g.lineWidth = 2; g.beginPath();
    stages.forEach((st, i) => { const v = st.summary[c].availability; const x0 = X(st.month), x1 = X(i + 1 < stages.length ? stages[i + 1].month : months); if (i === 0) g.moveTo(x0, Y(v)); else g.lineTo(x0, Y(v)); g.lineTo(x1, Y(v)); });
    g.stroke();
    g.fillStyle = cols[ci % cols.length]; g.fillText(c, L + 10 + ci * 50, T + 14);
  });
  let html = `<div class="kpis">${stages.map(st => { const m = Math.min(...clients.map(c => st.summary[c].availability)); return kpi(pct(m), `этап ${st.stage}: ${st.sats} аппаратов, с ${st.month}-го месяца`, m >= target ? 'good' : m > 0.5 ? 'warn' : 'bad'); }).join('')}</div>`;
  html += `<table class="cmp"><thead><tr><th>Пункт</th>${stages.map(st => `<th class="v">Этап ${st.stage}</th>`).join('')}</tr></thead><tbody>` +
    clients.map(c => `<tr><td>${c}</td>${stages.map(st => { const r = st.summary[c]; return `<td class="num ${r.availability >= target ? 'good' : 'bad'}">${pct(r.availability)} <span class="delta">перерыв до ${r.maxGapMin.toFixed(0)} мин</span></td>`; }).join('')}</tr>`).join('') + '</tbody></table>';
  out.innerHTML = html;
  out.prepend(cv);
  const firstOk = stages.find(st => Math.min(...clients.map(c => st.summary[c].availability)) >= target);
  const note = document.createElement('div'); note.className = 'an-note';
  note.innerHTML = firstOk ? `Цель ${pct(target)} для всех пунктов достигается с <b>этапа ${firstOk.stage}</b> (через ${firstOk.month} мес. после первого запуска). До этого пользователи ${firstOk.stage === 3 ? 'полгода' : 'три месяца'} живут с перерывами — см. вкладку «Покрытие» и второй шлюз как способ сократить этот срок.` : `Цель ${pct(target)} <b>не достигается ни на одном этапе</b> — нужна другая конфигурация или дополнительный шлюз.`;
  out.appendChild(note);
}

export function renderBatches(res, out) {
  const clients = Object.keys(res.before[0]);
  const target = state.scenario.environment.target_availability;
  const row = (label, arr) => `<tr><td>${label}</td>${clients.map(c => `<td class="num ${arr[c].availability >= target ? 'good' : 'bad'}">${pct(arr[c].availability)}</td>`).join('')}</tr>`;
  const div = document.createElement('div');
  div.innerHTML = `<h4 style="margin:8px 0 6px;font:500 13px var(--font-display)">Состав очередей: ${res.best1}</h4>
    <table class="cmp"><thead><tr><th></th>${clients.map(c => `<th class="v">${c}</th>`).join('')}</tr></thead><tbody>
    ${row('Этап 1 — сейчас', res.before[0])}${row('Этап 1 — предложение', res.after[0])}
    ${row('Этап 2 — сейчас', res.before[1])}${row('Этап 2 — предложение', res.after[1])}</tbody></table>
    <div class="an-note">Проверены варианты: ${res.options.map(o => o.name).join(', ')}. Первая очередь: ${Object.entries(res.assignment).filter(([, b]) => b === 1).map(([id]) => id).join(', ')}.
    ${Math.min(...clients.map(c => res.after[0][c].availability)) < target ? 'Даже лучший состав первой очереди не даёт 90% — 16 аппаратов физически не покрывают три пункта непрерывно; это аргумент за второй шлюз или ускорение второго запуска.' : ''}</div>
    <div class="row" style="margin-top:8px"><button class="btn small primary" id="an-apply-batches">Применить состав очередей</button></div>`;
  out.appendChild(div);
  div.querySelector('#an-apply-batches').onclick = () => {
    for (const x of state.scenario.design.satellites) x.launch_batch = res.assignment[x.id];
    markChanged();
    toast('Состав очередей применён. Сохраните как вариант, чтобы сравнить.', 'ok', 3000);
  };
}


// --- 6. матрица N-1 / N-2 ---
export function renderPairs(res, out) {
  const { ids, matrix, baseMin, n1Min, n2Min, badSingles, badPairs, worstPairs, target, tolerance } = res;
  const n = ids.length;
  const cv = document.createElement('canvas'); cv.width = n; cv.height = n; cv.className = 'matrix';
  const g = cv.getContext('2d');
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) { g.fillStyle = heat(matrix[i * n + j], target); g.fillRect(j, i, 1, 1); }
  const verdict = tolerance === 2 ? 'выдерживает любые два одновременных отказа' : tolerance === 1 ? 'выдерживает любой одиночный отказ, но есть пары, роняющие сеть ниже цели' : baseMin < target ? 'цель не достигается даже без отказов' : 'есть аппараты, отказ которых сам по себе роняет сеть ниже цели';
  out.innerHTML = `<div class="kpis">${kpi(pct(baseMin), 'без отказов', baseMin >= target ? 'good' : 'bad')}${kpi(pct(n1Min), 'худший одиночный отказ (N-1)', n1Min >= target ? 'good' : 'bad')}${kpi(pct(n2Min), 'худшая пара (N-2)', n2Min >= target ? 'good' : 'bad')}${kpi(`${badSingles} / ${badPairs}`, 'аппаратов / пар ниже цели', badPairs ? 'warn' : 'good')}</div>
    <div class="an-note"><b>Запас прочности: ${tolerance}.</b> Группировка ${verdict}. Цвет клетки — минимальная доступность при одновременном отказе аппаратов строки и столбца (диагональ — одиночные отказы); порядок ${ids[0]} … ${ids[n - 1]}.</div>`;
  const wrap = document.createElement('div'); wrap.style.cssText = 'display:flex;gap:20px;flex-wrap:wrap;align-items:flex-start';
  wrap.appendChild(cv);
  const list = document.createElement('div'); list.className = 'an-list';
  const byClient = res.badPairsByClient || {};
  const hit = Object.entries(byClient).sort((a, b) => b[1] - a[1]);
  list.innerHTML = `<div class="an-note">Самые опасные пары — и направление связи, которое от них страдает:</div>`
    + worstPairs.map(p => `<div class="it"><span>${p.a} + ${p.b}${p.worstClient ? ` <small style="color:var(--muted)">→ ${p.worstClient}</small>` : ''}</span><span class="n ${p.minAv < target ? 'bad' : ''}" style="color:${p.minAv < target ? '#ff7b7b' : '#7ee787'}">${pct(p.minAv)}</span><button data-a="${p.a}" data-b="${p.b}">сломать оба</button></div>`).join('')
    + (hit.length ? `<div class="an-note" style="margin-top:10px">Пар, роняющих пункт ниже цели, по направлениям: ${hit.map(([c, n]) => `<b>${c}</b> — ${n}`).join(', ')}. Уязвимость распределена неравномерно: усиливать надо направление с наибольшим числом опасных пар.</div>` : '');
  list.querySelectorAll('button').forEach(b => b.onclick = () => { addOutage(b.dataset.a, 0, state.scenario.environment.horizon_s); addOutage(b.dataset.b, 0, state.scenario.environment.horizon_s); });
  wrap.appendChild(list);
  out.appendChild(wrap);
}


// --- 7. резерв ---
export function renderSpares(res, out) {
  const div = document.createElement('div');
  div.innerHTML = `<div class="an-note"><b>Резервный аппарат.</b> Без резерва при отказе одного из ${res.vulnerable.length} самых критичных (${res.vulnerable.map(v => v.id).join(', ')}) худший пункт в среднем получает ${pct(res.baseResilience)}. Лучшие места для одного запасного спутника (слот между соседями в плоскости):</div>
    <div class="an-list">${res.best.map((b, i) => `<div class="it"><span>${b.plane}, слот ${b.slot.toFixed(2)}°</span><span class="n" style="color:#7ee787">${pct(b.resilience)} <small style="color:var(--muted)">при отказе</small> · ${pct(b.minAv)}</span><button data-i="${i}">добавить</button></div>`).join('')}</div>`;
  div.querySelectorAll('button').forEach(b => b.onclick = () => {
    const c = res.best[+b.dataset.i];
    const id = addSpareSatellite(c.plane, c.slot);
    toast(`Добавлен резервный аппарат ${id} в ${c.plane}, слот ${c.slot.toFixed(2)}°`, 'ok', 3000);
  });
  out.appendChild(div);
}


// --- 8. Монте-Карло ---
export function renderMonteCarlo(res, out) {
  const cv = document.createElement('canvas'); cv.width = 600; cv.height = 180; cv.className = 'chart'; cv.style.maxWidth = '600px';
  const g = cv.getContext('2d');
  const max = Math.max(...res.hist, 1), bw = cv.width / 20;
  res.hist.forEach((h, i) => { const x = i * bw, y = 150 - h / max * 130; g.fillStyle = (i + 1) / 20 <= res.target ? '#ff4d4d' : '#3ddc84'; g.fillRect(x + 1, y, bw - 2, 150 - y); });
  g.fillStyle = 'rgba(233,237,247,0.7)'; g.font = '11px "Golos Text", sans-serif';
  for (let i = 0; i <= 20; i += 5) g.fillText(pct(i / 20), i * bw - 8, 168);
  const div = document.createElement('div');
  div.innerHTML = `<div class="kpis">${kpi(pct(res.probOk), `вероятность удержать ≥ ${pct(res.target)} для всех пунктов`, res.probOk > 0.9 ? 'good' : res.probOk > 0.6 ? 'warn' : 'bad')}${kpi(pct(res.p50), 'медиана худшего пункта')}${kpi(pct(res.p10), '10-й процентиль (плохой день)')}${kpi(res.avgFailed.toFixed(1), 'отказов в среднем за сутки')}</div>
    <div class="an-note">${res.runs} случайных суток, каждый аппарат отказывает с вероятностью ${(res.pFail * 100).toFixed(0)}% в случайный момент и не восстанавливается до конца суток. Гистограмма — распределение доступности худшего пункта.</div>`;
  div.appendChild(cv);
  out.appendChild(div);
}


// --- 5. качество связи ---
export function renderQuality() {
  const out = $('#an-quality-out');
  const a = state.avail; if (!a) return;
  const snap = state.snap;
  const ecl = snap ? snap.eclipsed.filter((e, k) => e && snap.active[k]).length : 0;
  const rows = Object.entries(a).map(([c, r]) => `<tr><td>${c}</td><td class="num">${r.avgLatencyMs.toFixed(1)} мс</td><td class="num">${r.maxLatencyMs.toFixed(1)} мс</td><td class="num">${r.handovers}</td><td class="num">${pct(r.visibility)}</td><td class="num ${r.availability >= state.scenario.environment.target_availability ? 'good' : 'bad'}">${pct(r.availability)}</td></tr>`).join('');
  out.innerHTML = `<table class="cmp"><thead><tr><th>Пункт</th><th>Задержка (ср.)</th><th>Задержка (макс.)</th><th>Переключений маршрута / сутки</th><th>Видимость (хотя бы один КА)</th><th>Сквозная доступность</th></tr></thead><tbody>${rows}</tbody></table>
    <div class="an-note">Задержка — односторонняя, по длине пути «пункт → спутники → шлюз» со скоростью света (без обработки на борту). Переключение — смена цепочки аппаратов; маршрут «липкий»: держится, пока все его звенья существуют. Разница между видимостью и доступностью — доля времени, когда спутник над головой есть, а пути до шлюза нет.
    <br>Сейчас в тени Земли: <b>${ecl}</b> активных аппаратов (условное Солнце, цилиндрическая тень — как в sunlight() расчётного модуля).${state.scenario.environment.eclipse_isl_off ? ' <b>Режим включён:</b> аппараты в тени не ретранслируют.' : ''}</div>`;
}


/* --- сравнение стратегий маршрутизации ---
   Главный вывод обычно один и тот же: доступность у стратегий совпадает, потому что
   существование пути — свойство сети, а не алгоритма. Расходятся переключения и задержка. */
export function renderStrategies(res, out) {
  const { rows, best, sameAvailability, target } = res;
  const chosen = rows.find(r => r.key === res.chosen);
  const minhop = rows.find(r => r.key === 'minhop');
  const lat = rows.find(r => r.key === 'latency');
  const hoSave = minhop && chosen ? minhop.handovers - chosen.handovers : 0;
  const msCost = lat && chosen ? chosen.avgLatencyMs - lat.avgLatencyMs : 0;
  const cell = (v, isBest) => `<td class="num${isBest ? ' good' : ''}">${v}</td>`;
  const body = rows.map(r => `<tr${r.key === res.chosen ? ' class="me"' : ''}>
      <td><b>${r.name}</b>${r.key === res.chosen ? ' <small style="color:var(--muted)">— наш выбор</small>' : ''}<div class="an-sub">${r.note}</div></td>
      <td class="num ${r.minAvailability >= target ? 'good' : 'bad'}">${pct(r.minAvailability)}</td>
      ${cell(r.maxGapMin.toFixed(0) + ' мин', false)}
      ${cell(r.handovers, best.stability === r.key)}
      ${cell(r.avgHops.toFixed(2), best.hops === r.key)}
      ${cell(r.avgLatencyMs.toFixed(1) + ' мс', best.latency === r.key)}
      ${cell(r.maxLatencyMs.toFixed(1) + ' мс', false)}
    </tr>`).join('');
  out.innerHTML = `<div class="kpis">
      ${kpi(sameAvailability ? 'одинаковая' : 'разная', 'доступность у всех стратегий', sameAvailability ? 'good' : 'warn')}
      ${kpi(hoSave > 0 ? `−${hoSave}` : String(hoSave), 'переключений в сутки экономит липкий BFS', hoSave > 0 ? 'good' : '')}
      ${kpi(`${msCost >= 0 ? '+' : ''}${msCost.toFixed(1)} мс`, 'цена липкости по средней задержке', Math.abs(msCost) < 2 ? '' : 'warn')}</div>
    <table class="cmp"><thead><tr><th>Стратегия</th><th>Худший пункт</th><th>Макс. перерыв</th><th>Переключений / сутки</th><th>Ср. переходов</th><th>Задержка (ср.)</th><th>Задержка (макс.)</th></tr></thead><tbody>${body}</tbody></table>
    <div class="an-note">${sameAvailability
      ? '<b>Доступность совпала у всех трёх стратегий</b> — и это не совпадение: путь «пункт → спутники → шлюз» либо существует на шаге, либо нет, и это свойство геометрии сети, а не алгоритма поиска. Поэтому выбирать стратегию нужно не по доступности, а по качеству связи.'
      : '<b>Доступность разошлась</b> — значит какая-то стратегия не находит существующий путь; это баг, а не свойство сети.'}
      <br>Мы выбрали <b>липкий BFS</b>: он держит прежний маршрут, пока живы все его звенья, и за сутки даёт на <b>${hoSave}</b> переключений меньше, чем поиск заново на каждом шаге. Для абонента каждое переключение — переустановка сессии, то есть заметный микроперерыв, тогда как плата составляет ${Math.abs(msCost).toFixed(1)} мс средней задержки против стратегии «минимум задержки». Минимум переходов даёт самые короткие цепочки, но меняет их чаще всего.
      <br>Все три стратегии считаются одним и тем же кодом (<code>computeAvailability</code> с разным поиском), поэтому колонки сравнимы напрямую.</div>`;
}

/* --- резервные пути ---
   Отвечает на «что будет, если аппарат на маршруте откажется прямо сейчас» и отделяет
   нехватку покрытия над пунктом от узкого звена в межспутниковой цепочке. */
export function renderBackup(res, out) {
  const { clientId, steps, withRoute, disjointShare, spofShare, oneAccessShare, chainCriticalShare, critical, step_s } = res;
  const top = critical.slice(0, 8);
  // без маршрута все доли равны нулю, и «0% незаменимых» читалось бы как хорошая новость
  if (!withRoute) {
    out.innerHTML = `<div class="an-note an-stale">У пункта <b>${clientId}</b> за сутки нет ни одного шага со сквозным маршрутом до шлюза,
      поэтому резервировать нечего. Сначала нужно добиться связи: добавить аппаратов, сменить этап развёртывания или поставить второй шлюз.</div>`;
    return;
  }
  out.innerHTML = `<div class="kpis">
      ${kpi(pct(disjointShare), 'времени со связью есть полностью независимый обходной путь', disjointShare > 0.5 ? 'good' : disjointShare > 0.2 ? 'warn' : 'bad')}
      ${kpi(pct(spofShare), 'времени в маршруте есть незаменимый аппарат', spofShare < 0.3 ? 'good' : 'bad')}
      ${kpi(pct(oneAccessShare), 'времени над пунктом виден ровно один аппарат', oneAccessShare < 0.3 ? 'good' : 'warn')}
      ${kpi(pct(chainCriticalShare), 'времени узкое звено — в середине цепочки', chainCriticalShare < 0.1 ? 'good' : 'warn')}</div>
    <div class="an-note">Пункт <b>${clientId}</b>, ${withRoute} из ${steps} шагов по ${step_s} с со сквозным маршрутом. «Независимый обходной путь» — путь до шлюза, не использующий ни одного аппарата основного маршрута: только в этом случае отказ любого аппарата маршрута не прерывает связь.
      <br><b>Где именно узко.</b> Незаменимый аппарат бывает по двум разным причинам, и лечатся они по-разному: если над пунктом виден всего один аппарат (${pct(oneAccessShare)} времени) — это нехватка покрытия, помогает больше аппаратов или второе наклонение; если незаменимое звено в середине цепочки (${pct(chainCriticalShare)}) — тонкая межспутниковая сеть, помогает дальность ISL или второй шлюз.</div>
    ${top.length ? `<h4>Аппараты, без которых на каком-то шаге маршрута нет вовсе</h4>
      <table class="cmp"><thead><tr><th>Аппарат</th><th>Сколько времени незаменим</th><th>Доля суток</th><th></th></tr></thead><tbody>
      ${top.map(x => `<tr><td><b>${x.id}</b></td><td class="num">${x.minutes.toFixed(0)} мин</td><td class="num">${pct(x.shareOfDay)}</td><td><button class="btn small" data-break="${x.id}">сломать на сутки</button></td></tr>`).join('')}
      </tbody></table>` : '<div class="an-note">Незаменимых аппаратов нет: на каждом шаге отказ любого аппарата маршрута перекрывается обходным путём.</div>'}`;
  out.querySelectorAll('button[data-break]').forEach(b => b.onclick = () => addOutage(b.dataset.break, 0, state.scenario.environment.horizon_s));
}

// --- 4. отчёт ---
export function buildReport() {
  const s = state.scenario, e = s.environment, a = state.avail;
  const target = e.target_availability;
  const clients = Object.keys(a);
  // В отчёт идут только результаты, посчитанные на этой же конфигурации; остальные перечислим явно.
  const staleTools = [];
  const an = type => {
    const a = state.analysis[type];
    if (!a) return null;
    if (a.scenarioHash !== hashScenario()) { staleTools.push(TOOL_NAMES[type] || type); return null; }
    return a.result;
  };
  const esc = x => String(x).replace(/[&<>]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[ch]));
  const strip = ok => { const c = document.createElement('canvas'); drawStrip(c, ok); return c.toDataURL(); };
  const changes = describeChanges(s, state.base);
  const minAv = Math.min(...clients.map(c => a[c].availability));
  const recs = [];
  if (minAv >= target) recs.push(`Текущая конфигурация обеспечивает цель ${pct(target)} для всех пунктов (худший — ${pct(minAv)}).`);
  else recs.push(`Цель ${pct(target)} не достигнута: худший пункт ${pct(minAv)}. Требуются изменения конфигурации или наземной инфраструктуры.`);
  if (an('optimize')) recs.push('Автоподбор RAAN/фазирования выполнен — см. раздел «Варианты» для сравнения.');
  { const dep = an('deployment'); if (dep) { const st = dep.stages; const firstOk = st.find(x => Math.min(...clients.map(c => x.summary[c]?.availability ?? 0)) >= target); recs.push(firstOk ? `Целевой уровень достигается с этапа ${firstOk.stage} (${firstOk.month} мес. после первого запуска).` : 'Ни один этап развёртывания не достигает цели — рекомендуется дополнительный шлюз в восточном секторе.'); } }
  { const b = an('batches'); if (b) recs.push(`Состав очередей: лучший вариант первой очереди — «${b.best1}».`); }
  { const L = an('layouts'); if (L) { const b = L.options.find(o => o.id === L.bestId), c = L.options[0]; if (b.id !== 'case') recs.push(`Раскладка очередей по плоскостям: «${b.name}» даёт на первой очереди ${pct(b.stages[0].min)} для худшего пункта против ${pct(c.stages[0].min)} при запуске плоскость за плоскостью; самый долгий перерыв ${Math.round(c.stages[0].maxGap / 60)} ч → ${Math.round(b.stages[0].maxGap)} мин. Реализуемо отдельными запусками в каждую плоскость или разведением узлов прецессией.`); } }
  { const pr = an('pairs'); if (pr) recs.push(`Запас прочности по отказам: ${pr.tolerance} (N-1: ${pct(pr.n1Min)}, N-2: ${pct(pr.n2Min)}). Самая опасная пара: ${pr.worstPairs[0]?.a} + ${pr.worstPairs[0]?.b}${pr.worstPairs[0]?.worstClient ? ` — роняет ${pr.worstPairs[0].worstClient}` : ''}.${Object.keys(pr.badPairsByClient || {}).length ? ` Опасные пары по направлениям: ${Object.entries(pr.badPairsByClient).sort((x, y) => y[1] - x[1]).map(([c, n]) => `${c} — ${n}`).join(', ')}.` : ''}`); }
  { const sp = an('spares'); if (sp) recs.push(`Резервный аппарат: ${sp.best[0].plane}, слот ${sp.best[0].slot.toFixed(2)}° — поднимает доступность при отказах критичных аппаратов до ${pct(sp.best[0].resilience)}.`); }
  { const mc = an('montecarlo'); if (mc) recs.push(`Монте-Карло (${mc.runs} прогонов, ${(mc.pFail * 100).toFixed(0)}% отказов/сутки): цель удерживается с вероятностью ${pct(mc.probOk)}.`); }
  { const cv = an('coverage'); if (cv) recs.push(`Покрытие Арктики (55–85° с.ш.): ${pct(cv.shareOk)} площади с доступностью ≥ ${pct(target)}.`); }
  { const vu = an('vulnerable'); if (vu) recs.push(`Самые уязвимые аппараты: ${vu.items.slice(0, 3).map(i => `${i.id}${i.worstClient ? ` (бьёт по ${i.worstClient}, −${(i.worstClientDrop * 100).toFixed(1)} п.п.)` : ''}`).join(', ')}.`); }
  { const st = an('strategies'); if (st) {
    const ch = st.rows.find(r => r.key === st.chosen), mh = st.rows.find(r => r.key === 'minhop'), lt = st.rows.find(r => r.key === 'latency');
    recs.push(`Стратегия маршрутизации обоснована расчётом: доступность у липкого BFS, поиска заново и минимума задержки ${st.sameAvailability ? 'совпадает' : 'различается'} (${pct(ch.minAvailability)} для худшего пункта) — существование пути определяется геометрией сети, а не алгоритмом. Выбран липкий BFS: ${mh.handovers - ch.handovers} переключений маршрута в сутки меньше, чем при поиске заново (${ch.handovers} против ${mh.handovers}), ценой ${(ch.avgLatencyMs - lt.avgLatencyMs).toFixed(1)} мс средней задержки против стратегии минимума задержки.`);
  } }
  { const bp = an('backup'); if (bp && !bp.withRoute) recs.push(`Резервные пути для ${bp.clientId}: за сутки нет ни одного шага со сквозным маршрутом — резервировать нечего, сначала нужна связь.`); else if (bp) recs.push(`Резервные пути для ${bp.clientId}: полностью независимый обходной путь есть только ${pct(bp.disjointShare)} времени со связью, в ${pct(bp.spofShare)} в маршруте есть незаменимый аппарат. Основная причина — над пунктом виден ровно один аппарат (${pct(bp.oneAccessShare)} времени), узкое звено в середине цепочки только ${pct(bp.chainCriticalShare)}: резерв даёт увеличение числа аппаратов над пунктом, а не дальности ISL.${bp.critical[0] ? ` Дольше всех незаменим ${bp.critical[0].id} — ${bp.critical[0].minutes.toFixed(0)} мин.` : ''}`); }

  const vs = state.variants;
  const variantsTable = vs.length ? `<h2>Сравнение сохранённых вариантов</h2><table><thead><tr><th>Вариант</th><th>Сценарий</th><th>Изменения</th>${clients.map(c => `<th>${c}</th>`).join('')}<th>Макс. перерыв</th></tr></thead><tbody>${vs.map(v => `<tr><td><b>${esc(v.name)}</b></td><td>${esc(v.scenarioTitle)}</td><td>${esc(v.changes.join('; ') || '—')}</td>${clients.map(c => { const r = v.summary[c]; return r ? `<td class="${r.availability >= target ? 'good' : 'bad'}">${pct(r.availability)}</td>` : '<td>—</td>'; }).join('')}<td>${Math.max(...Object.values(v.summary).map(r => r.maxGapMin)).toFixed(0)} мин</td></tr>`).join('')}</tbody></table>` : '';

  const html = `<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>Обоснование конфигурации — ${esc(s.meta?.title || s.meta?.id || 'сценарий')}</title>
<style>:root{color-scheme:light}body{background:#fff;font:15px/1.6 Georgia,'Times New Roman',serif;color:#16181d;max-width:820px;margin:48px auto;padding:0 28px}h1{font:600 30px/1.15 Georgia,serif;margin:0 0 10px;letter-spacing:-.01em}h2{font:600 19px/1.3 Georgia,serif;margin:36px 0 12px}p{margin:0 0 12px;max-width:70ch}.lead{color:#5b606b;margin-bottom:28px}.muted{color:#5b606b;font-size:13.5px}table{border-collapse:collapse;width:100%;margin:10px 0 16px;font:13.5px/1.45 \"Golos Text\",Segoe UI,system-ui,sans-serif}th,td{padding:7px 10px 7px 0;text-align:left;vertical-align:top;border-bottom:1px solid #e6e8ee}th{font-weight:600;color:#16181d;border-bottom:2px solid #16181d}td.good{color:#1a7f37;font-weight:600}td.bad{color:#b3261e;font-weight:600}img.strip{width:100%;height:14px;image-rendering:pixelated}ul{padding-left:22px;max-width:70ch}li{margin-bottom:6px}.kv{display:grid;grid-template-columns:repeat(4,1fr);gap:14px 24px;margin:6px 0 18px}.kv div{border-top:1px solid #16181d;padding-top:6px}.kv b{display:block;font:600 22px/1.1 Georgia,serif}.kv span{font:13px 'Golos Text',Segoe UI,system-ui,sans-serif;color:#5b606b}@media print{body{margin:0}h2{page-break-after:avoid}}</style></head><body>
<h1>Обоснование конфигурации спутниковой группировки</h1>
<p class="lead">Сценарий «${esc(s.meta?.title || s.meta?.id || '')}». Сформировано ${new Date().toLocaleString('ru-RU')} сервисом «Аврора» для КосмоХакатона 2026.</p>
<h2>Параметры</h2>
<div class="kv"><div><b>${e.altitude_km} км</b><span>высота орбиты</span></div><div><b>${e.inclination_deg}°</b><span>наклонение</span></div><div><b>${s.design.satellites.filter(x => x.launch_batch <= s.design.launch_stage).length} / ${s.design.satellites.length}</b><span>активных аппаратов (этап ${s.design.launch_stage})</span></div><div><b>${e.isl_range_km} км</b><span>дальность ISL</span></div>
<div><b>${e.min_elevation_deg}°</b><span>мин. угол возвышения</span></div><div><b>${e.horizon_s / 3600} ч / ${e.step_s} с</b><span>горизонт / шаг</span></div><div><b>${pct(target)}</b><span>целевая доступность</span></div><div><b>${s.failures.length + s.gateway_outages.length}</b><span>периодов недоступности</span></div></div>
<table><thead><tr><th>Плоскость</th><th>RAAN</th><th>Фаза</th><th>Наклонение</th><th>Аппаратов</th><th>Очереди</th></tr></thead><tbody>${s.design.planes.map(p => { const ps = s.design.satellites.filter(x => x.plane_id === p.id); return `<tr><td>${p.id}</td><td>${p.raan_deg}°</td><td>${p.phase_deg}°</td><td>${p.inclination_deg ?? e.inclination_deg}°</td><td>${ps.length}</td><td>${[...new Set(ps.map(x => x.launch_batch))].sort((a, b) => a - b).join(', ')}</td></tr>`; }).join('')}</tbody></table>
<table><thead><tr><th>Пункт</th><th>Роль</th><th>Широта</th><th>Долгота</th><th>Местность (закрытие горизонта)</th></tr></thead><tbody>${s.ground_sites.map(g => `<tr><td>${esc(g.id)}</td><td>${g.role === 'gateway' ? 'шлюз' : 'клиент'}</td><td>${g.lat_deg}°</td><td>${g.lon_deg}°</td><td>${g.horizon_mask ? `${esc(terrainLabel(g))}: до ${Math.max(...g.horizon_mask).toFixed(1)}°, в среднем ${(g.horizon_mask.reduce((a, b) => a + b, 0) / g.horizon_mask.length).toFixed(1)}°${g.terrain_source ? ` (${esc(g.terrain_source)})` : ''}` : 'открытая — правило кейса'}</td></tr>`).join('')}</tbody></table>
${(ds => ds ? `<p>Подбор проекта (${ds.evaluated} Walker-конфигураций): ${ds.minimal ? `минимум для цели — <b>${ds.minimal.T} КА</b> (Walker ${ds.minimal.T}/${ds.minimal.P}/${ds.minimal.F}, веер ${ds.minimal.spread}°, наклонение ${ds.minimal.inc}°), худший пункт ${pct(ds.minimal.minFull)}` : 'ни одна из рассмотренных конфигураций не достигает цели'}; лучшая по оценке — ${ds.results[0].T}/${ds.results[0].P}/${ds.results[0].F} (${pct(ds.results[0].minFull)}).</p>` : '')(an('design'))}
${changes.length ? `<p>Изменения относительно исходного файла: ${esc(changes.join('; '))}.</p>` : ''}
${s.failures.length || s.gateway_outages.length ? `<p>Периоды недоступности: ${[...s.failures.map(f => `${f.satellite_id} ${fmtTime(f.start_s)}–${fmtTime(f.end_s)}`), ...s.gateway_outages.map(f => `${f.gateway_id} ${fmtTime(f.start_s)}–${fmtTime(f.end_s)}`)].join(', ')}.</p>` : ''}
<h2>Доступность связи за сутки</h2>
<table><thead><tr><th>Пункт</th><th>Видимость</th><th>Доступность</th><th>Макс. перерыв</th><th>Перерывов</th><th>Ср. переходов</th><th>Задержка (ср./макс.)</th><th>Переключений</th><th>Основная причина перерывов</th></tr></thead><tbody>${clients.map(c => { const r = a[c]; const worst = Object.entries(r.reasons).sort((x, y) => y[1] - x[1])[0]; return `<tr><td>${c}</td><td>${pct(r.visibility)}</td><td class="${r.availability >= target ? 'good' : 'bad'}">${pct(r.availability)}</td><td>${r.maxGapMin.toFixed(0)} мин</td><td>${r.gaps}</td><td>${r.avgHops.toFixed(2)}</td><td>${r.avgLatencyMs.toFixed(1)} / ${r.maxLatencyMs.toFixed(1)} мс</td><td>${r.handovers}</td><td>${worst ? REASONS[worst[0]] : '—'}</td></tr>`; }).join('')}</tbody></table>
${clients.map(c => `<div class="muted" style="margin-top:6px">${c} — связь (зелёный) и перерывы (красный), 00:00–24:00</div><img class="strip" src="${strip(a[c].ok)}">`).join('')}
${variantsTable}
<h2>Выводы и рекомендации</h2><ul>${recs.map(r => `<li>${r}</li>`).join('')}</ul>
${staleTools.length ? `<p class="muted">Не включено в выводы: ${esc([...new Set(staleTools)].join(', '))} — эти расчёты выполнялись для другой конфигурации, их числа к текущему варианту не относятся. Запустите инструменты заново и сформируйте отчёт ещё раз.</p>` : ''}
<h2>Метод</h2><p class="muted">Положения аппаратов — круговые орбиты с учётом вращения Земли; видимость — угол возвышения ≥ ${e.min_elevation_deg}° и выше маски горизонта пункта (рельеф/застройка по 36 азимутам), если она задана; межспутниковая связь — дальность ≤ ${e.isl_range_km} км и отсутствие пересечения с Землёй; маршрут — поиск в ширину по графу с удержанием прежнего пути, пока он существует; доступность — доля шагов (${e.step_s} с) со сквозным маршрутом «пункт → спутники → шлюз». Формулы соответствуют расчётному модулю geometry.py кейса.</p>
</body></html>`;
  state.lastReportHtml = html;
  const blob = new Blob([html], { type: 'text/html' });
  const url = URL.createObjectURL(blob);
  const w = window.open(url, '_blank');
  if (!w) { const aEl = document.createElement('a'); aEl.href = url; aEl.download = `report_${stamp()}.html`; aEl.click(); }
  $('#an-report-out').innerHTML = `<div class="an-note">Отчёт сформирован (${recs.length} выводов).</div>`
    + (staleTools.length ? `<div class="an-note an-stale">Не попало в отчёт: ${[...new Set(staleTools)].join(', ')} — эти расчёты относятся к прежней конфигурации. Запустите их заново.</div>` : '<div class="an-note">Чем больше инструментов аналитики запущено до этого, тем полнее раздел «Выводы».</div>');
}


// --- инструменты боковой панели ---
export function runOptimize() {
  runTask('optimize', {}, { progress: $('#tool-progress'), buttons: [$('#btn-optimize'), $('#btn-vulnerable')], onDone: res => {
    const box = $('#tool-result');
    const before = state.scenario.design.planes;
    const rows = res.planes.map(p => {
      const b = before.find(x => x.id === p.id);
      return `<div class="vuln"><span>${p.id}</span><span>RAAN ${b.raan_deg}° → <b>${p.raan_deg}°</b></span><span>фаза ${b.phase_deg}° → <b>${p.phase_deg}°</b></span></div>`;
    }).join('');
    const same = res.planes.every(p => { const b = before.find(x => x.id === p.id); return b.raan_deg === p.raan_deg && b.phase_deg === p.phase_deg; });
    box.innerHTML = `<div class="note">Подбор RAAN и фазирования: покоординатный спуск, шаг 5° / 1.5°, два прохода</div>${rows}
      ${same ? '<div class="note">Текущая конфигурация уже оптимальна на сетке перебора.</div>' : `<div class="apply"><button class="btn small primary wide" id="apply-opt">Применить</button></div>`}`;
    $('#apply-opt')?.addEventListener('click', () => {
      for (const p of res.planes) { const cur = state.scenario.design.planes.find(x => x.id === p.id); cur.raan_deg = p.raan_deg; cur.phase_deg = p.phase_deg; }
      markChanged({ rebuildScene: true });
      box.innerHTML = '<div class="note">Применено. Сохраните как вариант, чтобы сравнить с исходным.</div>';
    });
  } });
}

export function runVulnerable() {
  runTask('vulnerable', {}, { progress: $('#tool-progress'), buttons: [$('#btn-optimize'), $('#btn-vulnerable')], onDone: res => {
    const box = $('#tool-result');
    const top = res.items.slice(0, 6);
    box.innerHTML = `<div class="note">Просадка при потере аппарата на сутки (база ${pct(res.baseMin)}); справа — направление связи, которое страдает сильнее всего</div>` +
      top.map(it => `<div class="vuln"><span>${it.id} <small style="color:var(--muted)">${it.plane}${it.worstClient ? ` · ${it.worstClient}` : ''}</small></span><span class="d">−${(it.drop * 100).toFixed(1)} п.п.</span><button data-id="${it.id}">сломать</button></div>`).join('');
    box.querySelectorAll('button').forEach(b => b.onclick = () => addOutage(b.dataset.id, 0, state.scenario.environment.horizon_s));
  } });
}

export function toggleCoverageOverlay(show) {
  state.showCoverage = show;
  setCoverageOverlay(state.analysis.coverage?.result);
}

/* Конфигурация изменилась — все ранее посчитанные результаты относятся к прежнему варианту.
   Не удаляем их (пользователь может сравнивать глазами), но помечаем в интерфейсе и не пускаем в отчёт. */
function markStaleAnalysis() {
  const h = hashScenario();
  for (const [type, a] of Object.entries(state.analysis)) {
    if (!a || a.scenarioHash === h) continue;
    const out = OUT_OF[type] && $(OUT_OF[type]);
    if (out && out.children.length && !out.querySelector('.an-stale')) {
      const note = document.createElement('div');
      note.className = 'an-note an-stale';
      note.textContent = `Конфигурация изменилась после этого расчёта (${TOOL_NAMES[type] || type}) — числа ниже относятся к прежнему варианту, в отчёт они не попадут. Запустите инструмент заново.`;
      out.prepend(note);
    }
  }
}

on('recomputed', () => {
  renderQuality();
  // карта покрытия относится к прежней конфигурации — снимаем с глобуса
  if (state.analysis.coverage && state.analysis.coverage.scenarioHash !== hashScenario()) { state.analysis.coverage = null; setCoverageOverlay(null); }
  markStaleAnalysis();
});
on('scenario', () => { $('#an-eclipse').checked = !!state.scenario.environment.eclipse_isl_off; });
on('controls', () => { $('#an-eclipse').checked = !!state.scenario.environment.eclipse_isl_off; });

// ---------- подбор проекта группировки ----------
export function renderDesign(res, out) {
  const { results, pareto, minimal, target, evaluated } = res;
  const cur = state.scenario.design;
  const fmtC = c => `${c.T}/${c.P}/${c.F} · веер ${c.spread}°${c.inc !== state.scenario.environment.inclination_deg ? ` · накл. ${c.inc}°` : ''}`;
  let html = `<div class="kpis">${kpi(String(evaluated), 'конфигураций рассчитано')}${minimal
    ? kpi(`${minimal.T} КА`, `минимум для цели ${pct(target)} — Walker ${minimal.T}/${minimal.P}/${minimal.F}`, 'good')
    : kpi('—', `ни одна конфигурация не достигает ${pct(target)}`, 'bad')}${kpi(pct(results[0].minFull), `лучший худший-пункт: ${fmtC(results[0])}`, results[0].minFull >= target ? 'good' : 'warn')}</div>`;
  html += `<h4>Фронт «число аппаратов ↔ доступность» (лучший вариант для каждого T)</h4>
    <table class="cmp ds-table"><thead><tr><th>КА</th><th>Walker T/P/F</th><th>Веер RAAN</th><th>Накл.</th><th>Худший пункт</th><th>Средняя</th><th>Макс. перерыв</th><th>1-я очередь</th><th></th></tr></thead><tbody>`;
  const row = c => `<tr><td><b>${c.T}</b></td><td>${c.T}/${c.P}/${c.F}</td><td>${c.spread}°</td><td>${c.inc}°</td>
    <td class="${c.minFull >= target ? 'good' : 'bad'}">${pct(c.minFull)}</td><td>${pct(c.meanFull)}</td><td>${c.maxGapFull.toFixed(0)} мин</td><td>${pct(c.minFirst)}</td>
    <td class="apply"><button class="btn small" data-c='${JSON.stringify({ T: c.T, P: c.P, F: c.F, spread: c.spread, inc: c.inc })}'>Применить</button></td></tr>`;
  html += pareto.map(row).join('') + '</tbody></table>';
  html += `<h4>Топ-10 по оценке (все конфигурации)</h4><table class="cmp ds-table"><thead><tr><th>КА</th><th>Walker T/P/F</th><th>Веер RAAN</th><th>Накл.</th><th>Худший пункт</th><th>Средняя</th><th>Макс. перерыв</th><th>1-я очередь</th><th></th></tr></thead><tbody>`;
  html += results.slice(0, 10).map(row).join('') + '</tbody></table>';
  html += `<p class="note">Сейчас: ${cur.satellites.length} КА / ${cur.planes.length} пл. Оценка на грубой сетке (шаг ×3); после «Применить» показатели пересчитываются на полной сетке. Очереди раскладываются «плоскость за плоскостью» — состав можно улучшить во вкладке «Развёртывание».</p>`;
  out.innerHTML = html;
  out.querySelectorAll('button[data-c]').forEach(b => b.onclick = () => {
    const c = JSON.parse(b.dataset.c);
    const B = +$('#an-ds-B').value || 3;
    generateWalker({ T: c.T, P: c.P, F: c.F, raanSpread: c.spread, inclination_deg: c.inc === state.scenario.environment.inclination_deg ? undefined : c.inc, batches: B, batchMode: 'plane' });
    toast('Конфигурация применена — сохраните как вариант, чтобы сравнить с исходной', 'ok', 3500);
  });
}

// --- раскладка очередей по плоскостям: «как в файле» против «разнесённо» ---
export function renderLayouts(res, out) {
  const { options, bestId, batches, target } = res;
  const clients = Object.keys(options[0].stages[0].summary);
  const cell = (v, ok) => `<td class="num ${ok ? 'good' : 'bad'}">${pct(v)}</td>`;
  const stageBlock = st => `<h4 style="margin:14px 0 6px;font:500 13px var(--font-display)">Этап ${st + 1}: ${options[0].stages[st].sats} аппаратов на орбите</h4>
    <table class="cmp"><thead><tr><th>Раскладка</th>${clients.map(c => `<th class="v">${c}</th>`).join('')}<th>Худший пункт</th><th>Самый долгий перерыв</th><th>ISL, среднее</th></tr></thead><tbody>
    ${options.map(o => { const s = o.stages[st]; return `<tr class="${o.id === bestId ? 'best' : ''}"><td>${o.name}${o.id === bestId ? ' <b style="color:var(--accent)">лучшая</b>' : ''}</td>${clients.map(c => cell(s.summary[c].availability, s.summary[c].availability >= target)).join('')}<td class="num ${s.min >= target ? 'good' : 'bad'}"><b>${pct(s.min)}</b></td><td class="num">${s.maxGap >= 120 ? (s.maxGap / 60).toFixed(1) + ' ч' : s.maxGap.toFixed(0) + ' мин'}</td><td class="num">${s.isl.toFixed(0)}</td></tr>`; }).join('')}
    </tbody></table>`;
  const best = options.find(o => o.id === bestId), cur = options[0];
  const s1b = best.stages[0], s1c = cur.stages[0];
  const div = document.createElement('div');
  div.innerHTML = `<div class="kpis">${kpi(pct(s1c.min), 'первая очередь, как в файле (худший пункт)', s1c.min >= target ? 'good' : 'bad')}${kpi(pct(s1b.min), `первая очередь, лучшая раскладка`, s1b.min >= target ? 'good' : s1b.min > s1c.min ? 'warn' : 'bad')}${kpi(`${(s1c.maxGap / 60).toFixed(0)} ч → ${s1b.maxGap >= 120 ? (s1b.maxGap / 60).toFixed(1) + ' ч' : s1b.maxGap.toFixed(0) + ' мин'}`, 'самый долгий перерыв на первой очереди')}</div>
    ${Array.from({ length: batches - 1 }, (_, i) => stageBlock(i)).join('')}
    <div class="an-note"><b>Почему так.</b> Одна плоскость проходит над пунктом дважды в сутки, между проходами связи нет часами. Разнесённые плоскости приходят в разное время — перерывы короче, худший пункт лучше. Плата — межспутниковые связи: внутри плоскости соседи держат канал постоянно, между плоскостями сближаются только у полюсов (столбец ISL). Поэтому оптимум — 3–4 плоскости, а не 8.
    <br><b>Реализуемость.</b> Одна ракета выводит аппараты в одну плоскость; «вперемешку» — это либо отдельный запуск в каждую плоскость на каждую очередь, либо вывод на разные высоты с разведением узлов за счёт прецессии (несколько месяцев, почти без топлива). Полная группировка (последний этап) у вариантов «те же плоскости» не меняется.</div>
    <div class="row" style="margin-top:8px">${options.filter(o => o.id !== 'case').map(o => `<button class="btn small ${o.id === bestId ? 'primary' : ''}" data-apply="${o.id}">Применить: ${o.id === 'spread' ? 'очереди вперемешку' : o.name.replace('другая группировка: ', '')}</button>`).join('')}</div>`;
  out.innerHTML = '';
  out.appendChild(div);
  div.querySelectorAll('button[data-apply]').forEach(b => b.onclick = () => {
    const o = options.find(x => x.id === b.dataset.apply);
    if (o.kind === 'walker') generateWalker(o.walker);
    else { for (const x of state.scenario.design.satellites) x.launch_batch = o.assignment[x.id]; markChanged(); }
    toast('Раскладка применена — переключите этап на 1-й и сохраните как вариант, чтобы сравнить', 'ok', 4000);
  });
}
