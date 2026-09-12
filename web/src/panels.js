/* Боковые панели и окно сравнения: чистые представления над state.
   Подписаны на шину; сами модель не меняют — зовут функции model.js. */
import { state, $, $$, toast, fmtTime, pct, drawStrip, PLANE_COLORS, on } from './state.js';
import { REASONS, nextWindow, maxBatch, TERRAIN_PRESETS } from './sim.js';
import { loadScenario, isModified, setStage, setPlaneParam, removeOutage, removeSite, openVariant, deleteVariant, persistVariants, setSiteTerrain, fetchTerrainMask, terrainLabel, demFor } from './model.js';

// ---------- левая панель ----------
export function renderControls() {
  const s = state.scenario, d = s.design, e = s.environment;

  // сценарии
  const list = $('#scenario-list');
  list.innerHTML = '';
  for (const [id, sc] of Object.entries(window.SCENARIOS || {})) {
    const b = document.createElement('button');
    b.className = id === state.scenarioId ? 'active' : '';
    b.innerHTML = `${sc.meta.title}<small>${sc.design.satellites.length} аппаратов, этап ${sc.design.launch_stage}, ISL до ${sc.environment.isl_range_km} км</small>`;
    b.onclick = () => { if (!isModified() || confirm('Несохранённые изменения будут потеряны. Переключить сценарий?')) loadScenario(sc, id); };
    list.appendChild(b);
  }
  if (state.scenarioId === '__custom__') {
    const b = document.createElement('button');
    b.className = 'active';
    b.innerHTML = `${s.meta?.title || 'Загруженный сценарий'}<small>из вашего файла, ${d.satellites.length} аппаратов</small>`;
    list.appendChild(b);
  }
  $('#btn-reset').style.visibility = isModified() ? 'visible' : 'hidden';

  // этапы — по числу очередей запуска
  const seg = $('#stage-seg');
  seg.innerHTML = '';
  const nb = maxBatch(s);
  for (let st = 1; st <= nb; st++) {
    const b = document.createElement('button');
    b.dataset.stage = st;
    b.textContent = nb > 6 ? String(st) : `${st}-й — ${d.satellites.filter(x => x.launch_batch <= st).length}`;
    b.title = `После ${st}-го запуска: ${d.satellites.filter(x => x.launch_batch <= st).length} аппаратов на орбите`;
    b.className = st === d.launch_stage ? 'active' : '';
    b.onclick = () => setStage(st);
    seg.appendChild(b);
  }

  // плоскости
  const tb = $('#planes-table tbody');
  tb.innerHTML = '';
  d.planes.forEach((p, i) => {
    const basePlane = state.base.design.planes.find(x => x.id === p.id) || p;
    const tr = document.createElement('tr');
    const nSat = d.satellites.filter(x => x.plane_id === p.id).length;
    tr.innerHTML = `<td><b style="--c:${PLANE_COLORS[i % PLANE_COLORS.length]}"></b>${p.id}</td>
      <td><input type="number" step="0.5" min="0" max="359.5" data-plane="${p.id}" data-key="raan_deg" value="${p.raan_deg}" class="${p.raan_deg !== basePlane.raan_deg ? 'changed' : ''}"></td>
      <td><input type="number" step="0.5" min="0" max="359.5" data-plane="${p.id}" data-key="phase_deg" value="${p.phase_deg}" class="${p.phase_deg !== basePlane.phase_deg ? 'changed' : ''}"></td>
      <td><input type="number" step="0.5" min="1" max="180" data-plane="${p.id}" data-key="inclination_deg" value="${p.inclination_deg ?? ''}" placeholder="${e.inclination_deg}" class="inc ${(p.inclination_deg ?? null) !== (basePlane.inclination_deg ?? null) ? 'changed' : ''}"></td>
      <td class="n">${nSat}</td>`;
    tb.appendChild(tr);
  });
  tb.querySelectorAll('input').forEach(inp => inp.onchange = () => {
    const v = parseFloat(inp.value);
    if (inp.dataset.key === 'inclination_deg') { inp.value = setPlaneParam(inp.dataset.plane, 'inclination_deg', v); return; }
    if (!Number.isFinite(v)) { inp.value = d.planes.find(x => x.id === inp.dataset.plane)[inp.dataset.key]; return; }
    inp.value = setPlaneParam(inp.dataset.plane, inp.dataset.key, v);
  });
  // подсказка конструктора: что сейчас
  const wk = $('#wk-hint');
  if (wk) wk.dataset.now = `${d.satellites.length} КА / ${d.planes.length} пл. / ${nb} очередей`;

  // отказы
  const ol = $('#outage-list');
  ol.innerHTML = '';
  const items = [
    ...s.failures.map((f, i) => ({ kind: 'failures', i, id: f.satellite_id, f })),
    ...s.gateway_outages.map((f, i) => ({ kind: 'gateway_outages', i, id: f.gateway_id, f })),
  ].sort((a, b) => a.f.start_s - b.f.start_s || a.id.localeCompare(b.id));
  for (const it of items) {
    const div = document.createElement('div');
    div.className = 'outage';
    div.innerHTML = `<b>${it.id}</b><span>${fmtTime(it.f.start_s)} — ${fmtTime(it.f.end_s)}</span><button title="Убрать период" aria-label="Убрать период"><svg class="ic" aria-hidden="true"><use href="#i-x"/></svg></button>`;
    div.querySelector('button').onclick = () => removeOutage(it.kind, it.i);
    ol.appendChild(div);
  }
  const sel = $('#outage-node');
  const prev = sel.value;
  sel.innerHTML = '';
  const optGroup = (label, arr) => {
    const g = document.createElement('optgroup'); g.label = label;
    for (const x of arr) { const o = document.createElement('option'); o.value = x.id; o.textContent = x.label; g.appendChild(o); }
    sel.appendChild(g);
  };
  optGroup('Спутники', d.satellites.map(x => ({ id: x.id, label: `${x.id} · ${x.plane_id}` })));
  optGroup('Шлюзы', s.ground_sites.filter(g => g.role === 'gateway').map(g => ({ id: g.id, label: g.id })));
  if (prev) sel.value = prev;

  // клиенты
  const cs = $('#client-seg');
  cs.innerHTML = '';
  for (const c of s.ground_sites.filter(g => g.role === 'client')) {
    const b = document.createElement('button');
    b.textContent = c.id;
    b.className = c.id === state.clientId ? 'active' : '';
    b.onclick = () => { state.clientId = c.id; renderControls(); };
    cs.appendChild(b);
  }

  const range = $('#time-range');
  range.max = e.horizon_s - e.step_s;
  range.step = e.step_s;

  renderSites();
  renderVariants();
}

export function renderSites() {
  const s = state.scenario;
  const box = $('#site-list');
  box.innerHTML = '';
  const nClients = s.ground_sites.filter(g => g.role === 'client').length;
  const nGw = s.ground_sites.length - nClients;
  for (const g of s.ground_sites) {
    const div = document.createElement('div');
    div.className = 'site';
    const isGw = g.role === 'gateway';
    const canDel = isGw ? nGw > 1 : nClients > 1;
    const cur = !g.horizon_mask ? 'open' : g.terrain === 'dem' ? 'dem' : TERRAIN_PRESETS[g.terrain] ? g.terrain : 'custom';
    const dem = demFor(g);
    const opts = [['open', 'открытая местность'], ...Object.entries(TERRAIN_PRESETS).filter(([k]) => k !== 'open').map(([k, v]) => [k, v.label]),
      ...(dem ? [['dem', `рельеф DEM (макс. ${Math.max(...dem.horizon_mask).toFixed(0)}°)`]] : []), ['fetch', 'запросить рельеф (интернет)…'],
      ...(cur === 'custom' || (cur === 'dem' && !dem) ? [[cur, terrainLabel(g)]] : [])];
    div.innerHTML = `<span class="role ${isGw ? 'gw' : ''}">${isGw ? 'шлюз' : 'клиент'}</span><b>${g.id} <span>${g.lat_deg.toFixed(2)}°, ${g.lon_deg.toFixed(2)}°</span></b>
      <button title="Убрать пункт" aria-label="Убрать пункт ${g.id}" ${canDel ? '' : 'disabled'}><svg class="ic" aria-hidden="true"><use href="#i-x"/></svg></button>
      <span class="terrain"><canvas class="rose" width="52" height="52" title="Маска горизонта: закрытие по азимутам"></canvas><select aria-label="Рельеф и застройка вокруг антенны ${g.id}">${opts.map(([k, l]) => `<option value="${k}" ${k === cur ? 'selected' : ''}>${l}</option>`).join('')}</select></span>`;
    div.querySelector('button').onclick = () => removeSite(g);
    drawRose(div.querySelector('canvas'), g.horizon_mask);
    const sel = div.querySelector('select');
    sel.onchange = async () => {
      if (sel.value === 'fetch') {
        sel.disabled = true;
        try { const r = await fetchTerrainMask(g); toast(`${g.id}: рельеф получен (высота ${r.h0.toFixed(0)} м, закрытие до ${Math.max(...r.mask).toFixed(1)}°)`, 'ok', 4000); }
        catch (e) { toast(`Не удалось получить рельеф: ${e.message}. Нужен доступ к api.open-meteo.com`, 'error', 6000); renderSites(); }
        return;
      }
      setSiteTerrain(g, sel.value);
    };
    box.appendChild(div);
  }
}

// Розетка маски горизонта: радиус = 90° − закрытие (чем больше закрыто, тем меньше «небо»).
function drawRose(cv, mask) {
  const g = cv.getContext('2d'), c = cv.width / 2, r0 = c - 3;
  g.clearRect(0, 0, cv.width, cv.height);
  g.strokeStyle = 'rgba(255,255,255,0.18)'; g.lineWidth = 1; g.beginPath(); g.arc(c, c, r0, 0, Math.PI * 2); g.stroke();
  const m = mask && mask.length >= 4 ? mask : [0];
  const n = m.length;
  g.beginPath();
  for (let k = 0; k <= n; k++) {
    const v = m[k % n], az = (k / n) * Math.PI * 2, r = r0 * (1 - Math.min(90, v) / 90);
    const x = c + r * Math.sin(az), y = c - r * Math.cos(az);
    k ? g.lineTo(x, y) : g.moveTo(x, y);
  }
  g.closePath();
  g.fillStyle = mask ? 'rgba(126,231,135,0.35)' : 'rgba(255,255,255,0.12)'; g.fill();
  g.strokeStyle = mask ? '#7ee787' : 'rgba(255,255,255,0.4)'; g.stroke();
  g.fillStyle = 'rgba(255,255,255,0.6)'; g.font = '8px Inter, sans-serif'; g.fillText('N', c - 2.5, 8);
}

// ---------- правая панель ----------
export function renderAvailability() {
  const box = $('#avail-list');
  box.innerHTML = '';
  const target = state.scenario.environment.target_availability;
  for (const [id, row] of Object.entries(state.avail)) {
    const div = document.createElement('div');
    div.className = 'avail-row';
    const worst = Object.entries(row.reasons).sort((a, b) => b[1] - a[1])[0];
    div.innerHTML = `
      <div class="hdr"><b>${id}</b><span class="pct ${row.availability < target ? 'low' : ''}">${pct(row.availability)}</span></div>
      <canvas></canvas>
      <div class="kv"><span>видимость</span><b>${pct(row.visibility)}</b><span>самый долгий перерыв</span><b>${row.maxGapMin.toFixed(0)} мин</b><span>перерывов за сутки</span><b>${row.gaps}</b><span>переходов в маршруте</span><b>${row.avgHops.toFixed(1)}</b><span>задержка сигнала</span><b>${row.avgLatencyMs.toFixed(0)} мс</b>${worst ? `<span class="why">Чаще всего связи нет, потому что ${REASONS[worst[0]]}</span>` : ''}</div>`;
    box.appendChild(div);
    const cv = div.querySelector('canvas');
    cv.dataset.client = id;
    cv.onclick = ev => { state.t = Math.round(ev.offsetX / cv.clientWidth * row.ok.length) * row.step_s; };
    drawStrip(cv, row.ok);
  }
}

export function renderStatus() {
  const snap = state.snap;
  $('#st-active').textContent = snap.active.filter(Boolean).length + ' / ' + snap.active.length;
  $('#st-isl').textContent = snap.isl.length;
  const rb = $('#route-box'), rp = $('#route-path');
  if (state.route?.path) {
    const ids = state.route.path.map(k => state.scenario.design.satellites[k].id);
    rb.classList.remove('bad');
    rp.innerHTML = `${state.clientId} → ${ids.join(' → ')} → ${state.route.gateway} <span style="color:var(--muted)">(${ids.length + 1} переходов)</span>`;
  } else {
    rb.classList.add('bad');
    rp.textContent = `Нет маршрута: ${REASONS[state.route?.reason] || '—'}`;
  }
  // ближайшее окно связи (пересчитываем не чаще раза в секунду)
  if (!renderStatus._t || performance.now() - renderStatus._t > 1000) {
    renderStatus._t = performance.now();
    const nw = nextWindow(state.scenario, state.clientId, Math.round(state.t / state.scenario.environment.step_s) * state.scenario.environment.step_s);
    let txt = '';
    if (nw) txt = nw.inSec === 0 ? `окно связи ещё ${nw.durSec == null ? '> 2 ч' : Math.round(nw.durSec / 60) + ' мин'}` : `следующее окно через ${Math.round(nw.inSec / 60)} мин${nw.durSec != null ? ` на ${Math.round(nw.durSec / 60)} мин` : ''}`;
    else txt = 'в ближайшие 2 часа окна связи нет';
    let el = rb.querySelector('.next'); if (!el) { el = document.createElement('div'); el.className = 'next'; rb.appendChild(el); }
    el.textContent = txt;
  }
  $('#time-label').textContent = fmtTime(state.t);
  if (document.activeElement !== $('#time-range')) $('#time-range').value = state.t;
  $$('.avail-row canvas').forEach(cv => {
    const row = state.avail[cv.dataset.client];
    if (row) drawStrip(cv, row.ok, Math.round(state.t / row.step_s));
  });
}

export function renderVariants() {
  const list = $('#variant-list');
  list.innerHTML = '';
  const target = state.scenario?.environment.target_availability ?? 0.9;
  for (const v of state.variants) {
    const minAv = Math.min(...Object.values(v.summary).map(r => r.availability));
    const div = document.createElement('div');
    div.className = 'variant';
    div.innerHTML = `<input type="checkbox" ${v.selected ? 'checked' : ''} title="Включить в сравнение">
      <div class="nm" title="${v.changes.join(', ') || 'без изменений'}">${v.name}<small>${v.scenarioTitle}${v.changes.length ? `, изменений: ${v.changes.length}` : ''}</small></div>
      <span class="pct ${minAv < target ? 'low' : 'ok'}" title="худший пункт">${pct(minAv)}</span>
      <button class="txt" title="Открыть этот вариант на сцене">открыть</button><button title="Удалить вариант" aria-label="Удалить вариант ${v.name}"><svg class="ic" aria-hidden="true"><use href="#i-x"/></svg></button>`;
    const [chk] = div.querySelectorAll('input');
    const [open, del] = div.querySelectorAll('button');
    chk.onchange = () => { v.selected = chk.checked; persistVariants(); renderVariants(); };
    open.onclick = () => openVariant(v);
    del.onclick = () => deleteVariant(v);
    list.appendChild(div);
  }
  $('#variant-count').textContent = $('#variant-count-tab').textContent = state.variants.length;
  $('#btn-compare').disabled = state.variants.length < 2;
}

// ---------- сравнение вариантов ----------
export function openCompare() {
  let vs = state.variants.filter(v => v.selected);
  if (vs.length < 2) vs = state.variants;
  if (vs.length < 2) { toast('Сохраните хотя бы два варианта, чтобы сравнить', 'error'); return; }
  const body = $('#compare-body');
  const base = vs[0];
  const clients = [...new Set(vs.flatMap(v => Object.keys(v.summary)))];
  const target = vs[0].scenario.environment.target_availability;
  const planes = [...new Set(vs.flatMap(v => v.scenario.design.planes.map(p => p.id)))];

  const num = (v, key, fmt, better, baseV) => {
    if (v == null) return '<td>—</td>';
    let cls = 'num';
    let delta = '';
    if (baseV != null && v !== baseV) {
      const d = v - baseV, good = better === 'up' ? d > 0 : d < 0;
      delta = `<span class="delta ${good ? 'up' : 'down'}">${d > 0 ? '+' : ''}${fmt(d)}</span>`;
    }
    return `<td class="${cls}">${fmt(v)}${delta}</td>`;
  };
  const param = (vals, fmt = x => x) => {
    return vals.map((x, i) => `<td class="${i > 0 && JSON.stringify(x) !== JSON.stringify(vals[0]) ? 'diff' : ''}">${fmt(x)}</td>`).join('');
  };

  let html = `<div style="overflow:auto"><table class="cmp"><thead><tr><th></th>${vs.map(v => `<th class="v">${v.name}<br><small style="color:var(--muted);font:11px var(--font-body)">${v.scenarioTitle}</small></th>`).join('')}</tr></thead><tbody>`;
  html += `<tr class="sect"><td colspan="${vs.length + 1}">Параметры</td></tr>`;
  html += `<tr><td>Группировка</td>${param(vs.map(v => [v.scenario.design.satellites.length, v.scenario.design.planes.length, maxBatch(v.scenario)]), x => `${x[0]} КА / ${x[1]} пл. / ${x[2]} оч.`)}</tr>`;
  html += `<tr><td>Наклонения плоскостей</td>${param(vs.map(v => v.scenario.design.planes.map(p => p.inclination_deg ?? v.scenario.environment.inclination_deg)), x => [...new Set(x)].map(a => `${a}°`).join(', '))}</tr>`;
  html += `<tr><td>Местность пунктов</td>${param(vs.map(v => v.scenario.ground_sites.map(g => g.horizon_mask ? `${g.id}: ${terrainLabel(g)}` : null).filter(Boolean)), x => x.length ? x.join('; ') : 'открытая')}</tr>`;
  html += `<tr><td>Этап развёртывания</td>${param(vs.map(v => v.scenario.design.launch_stage))}</tr>`;
  html += `<tr><td>Активных аппаратов</td>${param(vs.map(v => v.scenario.design.satellites.filter(x => x.launch_batch <= v.scenario.design.launch_stage).length))}</tr>`;
  html += `<tr><td>Высота орбиты, км</td>${param(vs.map(v => v.scenario.environment.altitude_km))}</tr>`;
  html += `<tr><td>Дальность ISL, км</td>${param(vs.map(v => v.scenario.environment.isl_range_km))}</tr>`;
  html += `<tr><td>Мин. угол возвышения</td>${param(vs.map(v => v.scenario.environment.min_elevation_deg), x => `${x}°`)}</tr>`;
  html += `<tr><td>Период / шаг</td>${param(vs.map(v => [v.scenario.environment.horizon_s, v.scenario.environment.step_s]), x => `${x[0] / 3600} ч / ${x[1]} с`)}</tr>`;
  for (const pid of planes) {
    html += `<tr><td>${pid}: RAAN / фаза</td>${param(vs.map(v => { const p = v.scenario.design.planes.find(x => x.id === pid); return p ? [p.raan_deg, p.phase_deg] : null; }), x => x ? `${x[0]}° / ${x[1]}°` : '—')}</tr>`;
  }
  html += `<tr><td>Периоды недоступности</td>${param(vs.map(v => v.scenario.failures.length + v.scenario.gateway_outages.length))}</tr>`;
  html += `<tr><td>Шлюзы</td>${param(vs.map(v => v.scenario.ground_sites.filter(g => g.role === 'gateway').map(g => g.id).join(', ')))}</tr>`;
  html += `<tr><td>Изменено относительно файла</td>${vs.map(v => `<td style="white-space:normal;max-width:220px;font-size:12px;color:var(--muted)">${v.changes.join('; ') || '—'}</td>`).join('')}</tr>`;

  for (const c of clients) {
    html += `<tr class="sect"><td colspan="${vs.length + 1}">Пункт ${c} — цель не ниже ${pct(target)}</td></tr>`;
    html += `<tr><td>Доступность</td>${vs.map(v => { const r = v.summary[c]; if (!r) return '<td>—</td>'; const cell = num(r.availability, 'availability', x => (x * 100).toFixed(1) + '%', 'up', base.summary[c]?.availability); return cell.replace('class="num"', `class="num ${r.availability >= target ? 'good' : 'bad'}"`); }).join('')}</tr>`;
    html += `<tr><td>Макс. перерыв, мин</td>${vs.map(v => num(v.summary[c]?.maxGapMin, 'maxGapMin', x => x.toFixed(0), 'down', base.summary[c]?.maxGapMin)).join('')}</tr>`;
    html += `<tr><td>Число перерывов</td>${vs.map(v => num(v.summary[c]?.gaps, 'gaps', x => String(x), 'down', base.summary[c]?.gaps)).join('')}</tr>`;
    html += `<tr><td>Видимость (хотя бы один КА)</td>${vs.map(v => num(v.summary[c]?.visibility, 'visibility', x => (x * 100).toFixed(1) + '%', 'up', base.summary[c]?.visibility)).join('')}</tr>`;
    html += `<tr><td>Среднее число переходов</td>${vs.map(v => num(v.summary[c]?.avgHops, 'avgHops', x => x.toFixed(2), 'down', base.summary[c]?.avgHops)).join('')}</tr>`;
    html += `<tr><td>Задержка, мс (ср.)</td>${vs.map(v => num(v.summary[c]?.avgLatencyMs, 'avgLatencyMs', x => x.toFixed(1), 'down', base.summary[c]?.avgLatencyMs)).join('')}</tr>`;
    html += `<tr><td>Переключений маршрута</td>${vs.map(v => num(v.summary[c]?.handovers, 'handovers', x => String(x), 'down', base.summary[c]?.handovers)).join('')}</tr>`;
    html += `<tr><td>Связь за сутки</td>${vs.map(v => `<td><canvas class="strip" data-v="${v.id}" data-c="${c}"></canvas></td>`).join('')}</tr>`;
  }
  html += `</tbody></table></div>`;

  // рекомендация
  const best = [...vs].sort((a, b) => b.score - a.score)[0];
  const bestMin = Math.min(...Object.values(best.summary).map(r => r.availability));
  const bestGap = Math.max(...Object.values(best.summary).map(r => r.maxGapMin));
  html += `<div class="cmp-note"><b>Рекомендация:</b> лучший из сравниваемых — «${best.name}»: худший пункт ${pct(bestMin)}, максимальный перерыв ${bestGap.toFixed(0)} мин${bestMin >= target ? ', цель ' + pct(target) + ' достигнута для всех пунктов' : ', цель ' + pct(target) + ' <b>не достигнута</b>'}. Оценка учитывает сначала худший пункт, затем перерывы и длину маршрутов.</div>`;
  body.innerHTML = html;
  body.querySelectorAll('canvas.strip').forEach(cv => {
    const v = vs.find(x => x.id === cv.dataset.v);
    const tl = v?.timelines?.[cv.dataset.c];
    if (tl) drawStrip(cv, tl);
  });
  $('#compare-modal').hidden = false;
}

on('scenario', renderControls);
on('controls', renderControls);
on('recomputed', renderAvailability);
on('variants', renderVariants);
