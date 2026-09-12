/* Запуск инструментов анализа в фоновом воркере с прогрессом. Одновременно — один расчёт. */
import { state, toast, hashScenario } from './state.js';

let worker = null;
export const isBusy = () => !!worker;

// progress: элемент .progress с дочерними .bar и .txt; buttons: что заблокировать на время расчёта
export function runTask(type, opts, { progress, buttons = [], onDone }) {
  if (worker) { toast('Уже идёт расчёт — подождите', 'error'); return; }
  const bar = progress.querySelector('.bar'), txt = progress.querySelector('.txt');
  progress.hidden = false; bar.style.transform = 'scaleX(0)'; txt.textContent = 'Запуск…';
  buttons.forEach(b => b.disabled = true);
  worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
  worker.onmessage = ev => {
    const m = ev.data;
    if (m.type === 'progress') { bar.style.transform = `scaleX(${m.done / m.total})`; txt.textContent = `${m.done} / ${m.total}`; }
    else if (m.type === 'done') { finish(); state.analysis[type] = { result: m.result, at: Date.now(), scenarioHash: hashScenario() }; onDone(m.result); }
    else if (m.type === 'error') { finish(); toast('Ошибка расчёта: ' + m.message, 'error'); }
  };
  worker.onerror = e => { finish(); toast('Ошибка воркера: ' + e.message, 'error'); };
  worker.postMessage({ type, scenario: state.scenario, opts });
  function finish() { worker.terminate(); worker = null; progress.hidden = true; buttons.forEach(b => b.disabled = false); }
}
