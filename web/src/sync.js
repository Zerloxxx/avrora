/* Связь двух видов в одном браузере: инженерный ведёт, абонент следует.
   Канал — BroadcastChannel (same-origin, без сервера; ADR-0001 остаётся в силе).
   Работает только между окнами/вкладками одного браузера на одной машине: на реальном телефоне
   рядом с ноутбуком синхронизации не будет — там оба вида сходятся сами, пока идут по живому UTC.

   Такты шлём ~4 раза в секунду и передаём скорость, а не каждый кадр: ведомая страница
   доигрывает время сама (t += dt * speed) и заново привязывается к каждому такту.
   Так движение остаётся плавным на 60 кадрах при 4 сообщениях в секунду. */

const NAME = 'aurora.sync.v1';
const TICK_MS = 250;         // как часто ведущий шлёт время
const ALIVE_MS = 2000;       // как часто ведомый напоминает о себе
const STALE_MS = 5500;       // после этого считаем, что ведомых нет

export const available = () => typeof BroadcastChannel !== 'undefined';

/* Ведущий: инженерный вид.
   getState() → { t, playing, speed }; getConfig() → base64-дифф конфигурации (#c=).
   onFollowers(n) — сколько ведомых на связи (для индикатора в шапке). */
export function startBroadcaster({ getState, getConfig, onFollowers }) {
  if (!available()) return { close() {} };
  const ch = new BroadcastChannel(NAME);
  const seen = new Map();          // id ведомого → время последнего сигнала
  let lastConfig = null;

  const sendTick = () => ch.postMessage({ type: 'tick', ...getState(), sentAt: Date.now() });
  const sendConfig = (force = false) => {
    const cfg = getConfig();
    if (!force && cfg === lastConfig) return;
    lastConfig = cfg;
    ch.postMessage({ type: 'config', diff: cfg });
  };

  ch.onmessage = ev => {
    const m = ev.data;
    if (m.type === 'hello') { seen.set(m.id, Date.now()); sendConfig(true); sendTick(); report(); }
    else if (m.type === 'alive') { seen.set(m.id, Date.now()); report(); }
    else if (m.type === 'bye') { seen.delete(m.id); report(); }
  };

  let lastReported = -1;
  function report() {
    const now = Date.now();
    for (const [id, at] of seen) if (now - at > STALE_MS) seen.delete(id);
    if (seen.size !== lastReported) { lastReported = seen.size; onFollowers?.(seen.size); }
  }

  const tickTimer = setInterval(() => { sendTick(); report(); }, TICK_MS);
  return {
    configChanged: () => sendConfig(),
    close() { clearInterval(tickTimer); ch.close(); },
  };
}

/* Ведомый: вид абонента.
   onTick({ t, playing, speed }) — ведущий передал момент и скорость;
   onConfig(diff) — ведущий передал конфигурацию (base64-дифф). */
export function startFollower({ onTick, onConfig }) {
  if (!available()) return { close() {} };
  const ch = new BroadcastChannel(NAME);
  const id = Math.random().toString(36).slice(2);

  ch.onmessage = ev => {
    const m = ev.data;
    if (m.type === 'tick') onTick?.(m);
    else if (m.type === 'config') onConfig?.(m.diff);
  };

  ch.postMessage({ type: 'hello', id });
  const aliveTimer = setInterval(() => ch.postMessage({ type: 'alive', id }), ALIVE_MS);
  // уходим со связи явно, чтобы индикатор у ведущего погас сразу
  const bye = () => { try { ch.postMessage({ type: 'bye', id }); } catch {} };
  addEventListener('pagehide', bye);

  return { close() { clearInterval(aliveTimer); bye(); ch.close(); } };
}
