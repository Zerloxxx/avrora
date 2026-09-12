/* Общее состояние приложения, DOM-хелперы, форматирование и шина событий.
   Ничего не импортирует — на него можно ссылаться из любого модуля. */

export const PLANE_COLORS = ['#4f8dff', '#9b5cff', '#ff4fd8', '#4fd1ff', '#7ee787', '#ffa94d'];
export const ROUTE_COLOR = '#ffd166';
export const FAIL_COLOR = '#ff4d4d';

export const $ = sel => document.querySelector(sel);
export const $$ = sel => [...document.querySelectorAll(sel)];
export const clone = o => JSON.parse(JSON.stringify(o));

export const state = {
  scenario: null,     // текущая (редактируемая) конфигурация
  base: null,         // исходный файл — для сброса и диффа
  scenarioId: null,
  clientId: null,
  t: 43200,           // старт в полдень UTC — освещённая сторона к зрителю
  playing: true,
  speed: 240,         // секунд модели за секунду реального времени
  avail: null,        // результат computeAvailability для текущей конфигурации
  snap: null,         // снимок сети на текущий момент (обновляется каждый кадр)
  route: null,
  hover: null,        // индекс спутника под курсором
  placing: false,     // режим «поставить шлюз кликом по Земле»
  variants: [],
  analysis: {},       // результаты инструментов аналитики: { [type]: { result, at, scenarioHash } }
  showCoverage: true,
  lastReportHtml: null,
  view: { yaw: -0.6, pitch: 0.42, drag: null, f: 0, fDefault: 0 },   // f — половина высоты кадра в радиусах Земли
};

// Шина событий между модулями: модель публикует, представления подписываются.
//   scenario      — загружена/открыта другая конфигурация (перерисовать всё, пересобрать сцену)
//   recomputed    — пересчитана доступность (state.avail)
//   controls      — параметры изменены, обновить панели
//   scene:rebuild — изменилась геометрия (плоскости, состав) — пересобрать объекты сцены
//   variants      — изменился список вариантов
const bus = new EventTarget();
export const emit = (name, detail) => bus.dispatchEvent(new CustomEvent(name, { detail }));
export const on = (name, fn) => bus.addEventListener(name, ev => fn(ev.detail));

let toastTimer = null;
export function toast(html, kind = '', ms = 4500) {
  const el = $('#toast');
  el.className = 'toast ' + kind;
  el.innerHTML = html;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.hidden = true, ms);
}

export const fmtTime = t => {
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
};
export const parseTime = v => { const [h, m] = v.split(':').map(Number); return h * 3600 + m * 60; };
export const pct = x => (x * 100).toFixed(1) + '%';
export const stamp = () => new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');

// Полоска «связь/перерыв» за сутки: 1 px на шаг, белый маркер — текущее время.
export function drawStrip(cv, ok, marker = -1) {
  const w = cv.width = ok.length, h = cv.height = 14;
  const g = cv.getContext('2d');
  for (let k = 0; k < w; k++) { g.fillStyle = ok[k] ? '#3ddc84' : '#ff4d4d'; g.fillRect(k, 0, 1, h); }
  if (marker >= 0) { g.fillStyle = '#fff'; g.fillRect(marker, 0, 2, h); }
}

// Шкала: красный (0) → жёлтый (цель) → зелёный (100%).
export const heat = (v, target) => {
  const t = Math.max(0, Math.min(1, v));
  const mix = (a, b, u) => a.map((x, i) => Math.round(x + (b[i] - x) * u));
  const c = t < target ? mix([255, 77, 77], [255, 209, 102], t / target) : mix([255, 209, 102], [61, 220, 132], (t - target) / Math.max(1e-9, 1 - target));
  return `rgb(${c[0]},${c[1]},${c[2]})`;
};

/* Отпечаток конфигурации: по нему результат аналитики признаётся устаревшим.
   Считается по содержимому (FNV-1a), а не по длине JSON: raan 120 и 130 дают строку одной длины,
   поэтому прежний вариант признавал результат свежим при разнице доступности в 3.7 п.п.
   Порядок ключей в JSON влияет на отпечаток — это безопасная сторона ошибки:
   лишний пересчёт, а не устаревшие числа в отчёте. */
const fnv1a = str => {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(36);
};
export const hashScenario = () => fnv1a(JSON.stringify(state.scenario)) + ':' + state.scenarioId;
