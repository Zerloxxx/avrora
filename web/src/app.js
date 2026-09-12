/* Точка входа: привязка DOM-событий к модели/сцене/аналитике и старт. */
import { state, $, $$, toast, fmtTime, parseTime, on } from './state.js';
import { TERRAIN_PRESETS } from './sim.js';
import { loadScenario, markChanged, resetScenario, setStage, setEclipseIslOff, addOutage, addSite, saveVariant, restoreVariants, importFile, exportScenario, exportResults, exportVariants, encodeConfig, applyConfigFromHash, generateWalker, demFor } from './model.js';
import { overlay, zoomBy, zoomTo, applyCamera, pickLatLon, getLastProj, startLoop, camera, dyn, root, inertial } from './scene.js';
import { renderStatus, openCompare } from './panels.js';
import { startBroadcaster } from './sync.js';
import { renderDesign, renderLayouts, runAnalysis, renderCoverage, renderDeployment, renderBatches, renderPairs, renderSpares, renderMonteCarlo,
  renderStrategies, renderBackup, renderQuality, buildReport, runOptimize, runVulnerable, toggleCoverageOverlay } from './analysis.js';

// ---------- события ----------
const enterWorkspace = () => document.body.classList.add('workspace');

// вкладки панелей
$$('.tabs button').forEach(b => b.onclick = () => {
  const panel = b.closest('.panel');
  panel.querySelectorAll('.tabs button').forEach(x => x.classList.toggle('active', x === b));
  panel.querySelectorAll('.tab').forEach(x => x.classList.toggle('active', x.id === b.dataset.tab));
});
const showTab = id => document.querySelector(`.tabs button[data-tab="${id}"]`)?.click();

$('#btn-play').onclick = () => {
  state.playing = !state.playing;
  $('#btn-play').classList.toggle('playing', state.playing);
};
$('#btn-start').onclick = () => enterWorkspace();
$('#btn-play').classList.toggle('playing', state.playing);
// узкие экраны: панели показываются по одной поверх сцены
const togglePanel = side => { const on = !document.body.classList.contains('show-' + side); document.body.classList.remove('show-left', 'show-right'); document.body.classList.toggle('show-' + side, on); };
$('#toggle-left').onclick = () => togglePanel('left');
$('#toggle-right').onclick = () => togglePanel('right');
$('#logo').onclick = ev => { ev.preventDefault(); document.body.classList.remove('workspace'); };
$('#nav-scene').onclick = ev => { ev.preventDefault(); enterWorkspace(); };
$('#nav-compare').onclick = ev => { ev.preventDefault(); openCompare(); };
$('#nav-about').onclick = $('#btn-about').onclick = ev => { ev.preventDefault(); $('#about-modal').hidden = false; };
const openAnalysis = ev => { ev?.preventDefault(); enterWorkspace(); renderQuality(); $('#analysis-modal').hidden = false; };
$('#nav-analysis').onclick = openAnalysis;
$('#btn-analysis').onclick = openAnalysis;
$$('.an-tabs button').forEach(b => b.onclick = () => {
  const card = b.closest('.modal-card');
  card.querySelectorAll('.an-tabs button').forEach(x => x.classList.toggle('active', x === b));
  card.querySelectorAll('.an-body > .tab').forEach(x => x.classList.toggle('active', x.id === b.dataset.tab));
});
$('#an-run-coverage').onclick = () => runAnalysis('coverage', {}, '#an-coverage-out', renderCoverage);
$('#an-run-design').onclick = () => {
  const nums = sel => $(sel).value.split(/[,\s]+/).map(Number).filter(n => Number.isInteger(n) && n > 0);
  const T = nums('#an-ds-T'), P = nums('#an-ds-P');
  if (!T.length || !P.length) { toast('Укажите списки чисел аппаратов и плоскостей', 'error'); return; }
  const inc0 = state.scenario.environment.inclination_deg;
  const inclinations = $('#an-ds-inc').checked ? [...new Set([inc0, 70, 80, 90])] : null;
  runAnalysis('design', { T, P, inclinations, batches: +$('#an-ds-B').value || 3 }, '#an-design-out', renderDesign);
};
$('#an-coverage-globe').onchange = ev => toggleCoverageOverlay(ev.target.checked);
$('#an-run-deploy').onclick = () => runAnalysis('deployment', {}, '#an-deploy-out', renderDeployment);
$('#an-run-batches').onclick = () => runAnalysis('batches', {}, '#an-deploy-out', renderBatches);
$('#an-run-layouts').onclick = () => runAnalysis('layouts', {}, '#an-deploy-out', renderLayouts);
$('#an-run-pairs').onclick = () => runAnalysis('pairs', {}, '#an-resilience-out', (r, out) => { out.innerHTML = ''; renderPairs(r, out); });
$('#an-run-spares').onclick = () => runAnalysis('spares', {}, '#an-resilience-out', renderSpares);
$('#an-run-mc').onclick = () => runAnalysis('montecarlo', { pFail: (+$('#an-mc-p').value || 5) / 100, runs: +$('#an-mc-runs').value || 300 }, '#an-resilience-out', renderMonteCarlo);
$('#an-run-backup').onclick = () => runAnalysis('backup', { clientId: state.clientId }, '#an-resilience-out', renderBackup);
$('#an-run-strategies').onclick = () => runAnalysis('strategies', {}, '#an-strategies-out', renderStrategies);
$('#an-eclipse').onchange = ev => setEclipseIslOff(ev.target.checked);
$('#an-run-report').onclick = buildReport;
$('#export-report').onclick = buildReport;
// Ссылка на вид абонента несёт ту же конфигурацию (#c=), поэтому числа на телефоне совпадают с этим экраном.
const abonentUrl = () => new URL('abonent/', location.href).href + '#c=' + encodeConfig();
const copyLink = async (url, what) => {
  try { await navigator.clipboard.writeText(url); toast(`${what} скопирована`, 'ok', 2500); }
  catch { prompt('Скопируйте ссылку:', url); }
};
$('#export-link').onclick = () => copyLink(location.origin + location.pathname + '#c=' + encodeConfig(), 'Ссылка на конфигурацию');
$('#export-abonent-link').onclick = () => copyLink(abonentUrl(), 'Ссылка для абонента');
$('#nav-abonent').onclick = ev => { ev.preventDefault(); window.open(abonentUrl(), '_blank'); };

/* Ведём вид абонента: время, скорость, пауза и конфигурация уходят в BroadcastChannel.
   Работает между окнами одного браузера; на отдельном телефоне синхронизации нет — там живой UTC. */
const sync = startBroadcaster({
  getState: () => ({ t: state.t, playing: state.playing, speed: state.speed }),
  getConfig: () => (state.scenario ? encodeConfig() : null),
  onFollowers: n => {
    const nav = $('#nav-abonent');
    nav.classList.toggle('live', n > 0);
    nav.title = n > 0 ? `Вид абонента открыт (${n}) и следует за этим экраном` : 'Открыть вид абонента';
  },
});
// конфигурацию шлём по факту изменения, а не по таймеру
on('controls', () => sync.configChanged());
on('scenario', () => sync.configChanged());
$('#btn-now').onclick = () => {
  const d = new Date();
  state.t = (d.getUTCHours() * 3600 + d.getUTCMinutes() * 60 + d.getUTCSeconds()) % state.scenario.environment.horizon_s;
  toast(`Время модели — текущее UTC ${fmtTime(state.t)}`, 'ok', 2000);
};

// наземные пункты
$('#site-preset').onchange = ev => {
  const [id, name, lat, lon] = ev.target.value.split('|');
  if (!id) return;
  $('#site-id').value = id; $('#site-lat').value = lat; $('#site-lon').value = lon; $('#site-id').dataset.name = name;
};
$('#site-form').onsubmit = ev => {
  ev.preventDefault();
  if (addSite($('#site-id').value, $('#site-role').value, +$('#site-lat').value, +$('#site-lon').value, $('#site-id').dataset.name, $('#site-terrain').value)) {
    $('#site-form').reset(); delete $('#site-id').dataset.name;
  }
};
// местность для нового пункта; «рельеф DEM» появляется, когда для точки есть предрасчёт
function fillTerrainSelect() {
  const sel = $('#site-terrain');
  const lat = +$('#site-lat').value, lon = +$('#site-lon').value;
  const dem = Number.isFinite(lat) && Number.isFinite(lon) ? demFor({ lat_deg: lat, lon_deg: lon }) : null;
  const cur = sel.value;
  sel.innerHTML = `<option value="open">местность: открытая</option>` + Object.entries(TERRAIN_PRESETS).filter(([k]) => k !== 'open').map(([k, v]) => `<option value="${k}">местность: ${v.label}</option>`).join('')
    + (dem ? `<option value="dem">местность: рельеф DEM (макс. ${Math.max(...dem.horizon_mask).toFixed(0)}°)</option>` : '');
  sel.value = [...sel.options].some(o => o.value === cur) ? cur : (dem ? 'dem' : 'open');
}
fillTerrainSelect();
$('#site-lat').oninput = $('#site-lon').oninput = fillTerrainSelect;

// конструктор группировки
$('#btn-walker-toggle').onclick = () => { const f = $('#walker-form'); f.hidden = !f.hidden; $('#btn-walker-toggle').textContent = f.hidden ? 'развернуть' : 'свернуть'; };
$('#walker-form').onsubmit = ev => {
  ev.preventDefault();
  const T = +$('#wk-T').value, P = +$('#wk-P').value, F = +$('#wk-F').value, B = +$('#wk-B').value;
  if (!(T >= P && T % P === 0)) { toast(`Число аппаратов (${T}) должно делиться на число плоскостей (${P})`, 'error'); return; }
  if (!(F >= 0 && F < P)) { toast(`Фазирование F должно быть от 0 до ${P - 1}`, 'error'); return; }
  const inc = parseFloat($('#wk-inc').value);
  generateWalker({ T, P, F, raanSpread: +$('#wk-spread').value, inclination_deg: Number.isFinite(inc) && inc !== state.scenario.environment.inclination_deg ? inc : undefined, batches: B, batchMode: $('#wk-mode').value });
};
$('#btn-place').onclick = () => {
  state.placing = !state.placing;
  document.body.classList.toggle('placing', state.placing);
  $('#btn-place').classList.toggle('active', state.placing);
  if (state.placing) toast('Кликните по Земле, куда поставить шлюз (Esc — отмена)', '', 4000);
};
window.addEventListener('keydown', ev => { if (ev.key === 'Escape' && state.placing) $('#btn-place').click(); });
$$('.modal').forEach(m => {
  m.addEventListener('click', ev => { if (ev.target === m || ev.target.closest('[data-close]')) m.hidden = true; });
});
window.addEventListener('keydown', ev => { if (ev.key === 'Escape') $$('.modal').forEach(m => m.hidden = true); });

$('#time-range').oninput = ev => { state.t = +ev.target.value; };
$('#speed').onchange = ev => { state.speed = +ev.target.value; };
$$('.panel').forEach(p => p.addEventListener('pointerdown', enterWorkspace));


$('#btn-reset').onclick = () => {
  resetScenario();
  toast('Изменения сброшены к исходному файлу', 'ok', 2000);
};

$('#outage-form').onsubmit = ev => {
  ev.preventDefault();
  const id = $('#outage-node').value;
  const h = state.scenario.environment.horizon_s;
  let start = parseTime($('#outage-start').value), end = parseTime($('#outage-end').value);
  if (end >= 86340) end = h;                    // 23:59 → до конца горизонта
  end = Math.min(end, h);
  if (!(start < end)) { toast('Начало периода должно быть раньше конца', 'error'); return; }
  addOutage(id, start, end);
};

$('#variant-form').onsubmit = ev => {
  ev.preventDefault();
  saveVariant($('#variant-name').value.trim());
  $('#variant-name').value = '';
};
$('#btn-compare').onclick = openCompare;
$('#btn-optimize').onclick = runOptimize;
$('#btn-vulnerable').onclick = runVulnerable;

$('#btn-export').onclick = ev => { ev.stopPropagation(); const m = $('#btn-export').nextElementSibling; $('#mobile-menu-items').hidden = true; m.hidden = !m.hidden; };
$('#btn-menu').onclick = ev => { ev.stopPropagation(); const m = $('#mobile-menu-items'); $('#btn-export').nextElementSibling.hidden = true; m.hidden = !m.hidden; };
$$('#mobile-menu-items button').forEach(b => b.onclick = () => { $('#mobile-menu-items').hidden = true; $('#' + b.dataset.go).click(); });
window.addEventListener('click', () => { $$('.menu-items').forEach(m => m.hidden = true); });
$('#export-scenario').onclick = exportScenario;
$('#export-results').onclick = exportResults;
$('#export-variants').onclick = exportVariants;

$('#file-input').onchange = async ev => {
  const f = ev.target.files[0];
  if (f) await importFile(f);
  ev.target.value = '';
};

// зум колесом и кнопками
overlay.addEventListener('wheel', ev => { ev.preventDefault(); zoomBy(Math.pow(1.0015, ev.deltaY)); }, { passive: false });
$('#zoom-in').onclick = () => zoomBy(0.8);
$('#zoom-out').onclick = () => zoomBy(1.25);
$('#zoom-reset').onclick = () => { zoomTo(state.view.fDefault); state.view.pitch = 0.42; applyCamera(); };

// вращение сцены мышью, подсказки по спутникам, клик по спутнику — выбрать его для отказа
// несколько пальцев: щипок меняет зум, вращение при этом выключено
const touches = new Map();
let pinch = null;
overlay.addEventListener('pointerdown', ev => {
  if (ev.pointerType === 'touch') {
    touches.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
    if (touches.size === 2) {
      const [a, b] = [...touches.values()];
      pinch = { d0: Math.hypot(a.x - b.x, a.y - b.y), f0: state.view.fTarget ?? state.view.f };
      state.view.drag = null;
      return;
    }
  }
  // мышью нативный старт выделения делает курсор текстовым и выделяет страницу; на touch этим занимается touch-action
  if (ev.pointerType !== 'touch') ev.preventDefault();
  // на телефоне тап по сцене закрывает выдвинутую панель
  document.body.classList.remove('show-left', 'show-right');
  state.view.drag = { x: ev.clientX, y: ev.clientY, yaw: state.view.yaw, pitch: state.view.pitch, moved: false };
  document.body.classList.add('dragging');
});
const endTouch = ev => { touches.delete(ev.pointerId); if (touches.size < 2) pinch = null; document.body.classList.remove('dragging'); };
window.addEventListener('pointercancel', endTouch);
window.addEventListener('pointerup', ev => {
  endTouch(ev);
  const dr = state.view.drag;
  state.view.drag = null;
  document.body.classList.remove('dragging');
  if (dr && !dr.moved && state.placing && ev.target === overlay) {
    const ll = pickLatLon(ev.clientX, ev.clientY);
    if (!ll) { toast('Кликните по поверхности Земли', 'error'); return; }
    let k = 2; while (state.scenario.ground_sites.some(g => g.id === `G${k}`)) k++;
    if (addSite(`G${k}`, 'gateway', ll.lat, ll.lon)) $('#btn-place').click();
    return;
  }
  if (dr && !dr.moved && state.hover != null && ev.target === overlay) {
    const sat = state.scenario.design.satellites[state.hover];
    enterWorkspace();
    showTab('tab-config');
    $('#outage-node').value = sat.id;
    toast(`Выбран ${sat.id} — задайте период недоступности в панели «Периоды недоступности» и нажмите «+»`, '', 4000);
  }
});
overlay.addEventListener('pointermove', ev => {
  if (ev.pointerType === 'touch' && touches.has(ev.pointerId)) {
    touches.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
    if (pinch && touches.size === 2) {
      const [a, b] = [...touches.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      if (d > 10) zoomTo(Math.min(2.4, Math.max(0.3, pinch.f0 * pinch.d0 / d)));
      return;
    }
  }
  const dr = state.view.drag;
  if (dr) {
    if (Math.abs(ev.clientX - dr.x) + Math.abs(ev.clientY - dr.y) > 3) dr.moved = true;
    state.view.yaw = dr.yaw + (ev.clientX - dr.x) * 0.005;
    state.view.pitch = Math.max(0.05, Math.min(1.2, dr.pitch + (ev.clientY - dr.y) * 0.004));
    return;
  }
  const tip = $('#tooltip');
  state.hover = null;
  const lastProj = getLastProj();
  if (!lastProj) return;
  let best = 14, bi = -1;
  lastProj.forEach((q, k) => {
    if (q.hidden) return;
    const dd = Math.hypot(q.sx - ev.clientX, q.sy - ev.clientY);
    if (dd < best) { best = dd; bi = k; }
  });
  if (bi < 0) { tip.hidden = true; return; }
  state.hover = bi;
  const sat = state.scenario.design.satellites[bi];
  const st = state.snap.failed.has(sat.id) ? 'отказ' : sat.launch_batch > state.scenario.design.launch_stage ? 'ещё не запущен' : 'активен';
  tip.innerHTML = `<b>${sat.id}</b> · плоскость ${sat.plane_id} · очередь ${sat.launch_batch}<br>${st} · ISL: ${state.snap.adj[bi].length}<br><span style="color:var(--muted)">клик — выбрать для отказа</span>`;
  tip.hidden = false;
  tip.style.left = ev.clientX + 14 + 'px';
  tip.style.top = ev.clientY + 14 + 'px';
});

// ---------- старт ----------
restoreVariants();
const first = Object.keys(window.SCENARIOS || {})[0];
if (!applyConfigFromHash()) {
  if (first) loadScenario(window.SCENARIOS[first], first);
  else toast('Не найден data/scenarios.js — сгенерируйте его из папки «Данные»', 'error', 10000);
}
startLoop(renderStatus);

// для отладки из консоли
window.state = state;
window.__scene = { camera, dyn, root, inertial };
