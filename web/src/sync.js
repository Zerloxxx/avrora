/* Связь двух видов в одном браузере: инженерный ведёт, абонент следует.
   Канал — BroadcastChannel (same-origin, без сервера; ADR-0001 остаётся в силе).
   Работает только между окнами/вкладками одного браузера на одной машине: на реальном телефоне
   рядом с ноутбуком синхронизации не будет — там оба вида сходятся сами, пока идут по живому UTC.

   Такты шлём ~4 раза в секунду и передаём скорость, а не каждый кадр: ведомая страница
   доигрывает время сама (t += dt * speed) и заново привязывается к каждому такту.
   Так движение остаётся плавным на 60 кадрах при 4 сообщениях в секунду. */

const NAME = 'aurora.sync.v1';
const STORE = 'aurora.sync.last';   // последний такт ведущего на диске — чтобы ведомый догонял сразу
const TICK_MS = 250;         // как часто ведущий шлёт время
const ALIVE_MS = 2000;       // как часто ведомый напоминает о себе
const STALE_MS = 5500;       // после этого считаем, что ведомых нет
const SAVE_MS = 1000;        // не чаще раза в секунду пишем на диск
const RESTORE_MS = 120000;   // старше двух минут не восстанавливаем — это уже не «переключился», а другая сессия

export const available = () => typeof BroadcastChannel !== 'undefined';

/* Зачем диск, если есть канал. Когда пользователь уходит на другое окно, браузер тормозит
   таймеры скрытой вкладки с 250 мс до секунды, а через несколько минут — до раза в минуту
   (а то и замораживает её целиком). Ведомый в это время не получает тактов и продолжает
   показывать скорость, которая была при переключении: инженер включил ×16, у абонента ещё ×4.
   Поэтому ведущий дублирует состояние в localStorage (общий origin у обеих страниц),
   а ведомый при возврате на экран берёт его оттуда и доигрывает время сам. */
const save = rec => { try { localStorage.setItem(STORE, JSON.stringify(rec)); } catch {} };
export const loadLast = () => {
  try { const r = JSON.parse(localStorage.getItem(STORE) || 'null'); return r && Number.isFinite(r.t) ? r : null; }
  catch { return null; }
};

/* Ведущий: инженерный вид.
   getState() → { t, playing, speed }; getConfig() → base64-дифф конфигурации (#c=).
   onFollowers(n) — сколько ведомых на связи (для индикатора в шапке). */
export function startBroadcaster({ getState, getConfig, onFollowers }) {
  if (!available()) return { close() {} };
  const ch = new BroadcastChannel(NAME);
  const seen = new Map();          // id ведомого → время последнего сигнала
  let lastConfig = null;

  let record = {}, lastSaved = 0;
  const persist = extra => { record = { ...record, ...extra, at: Date.now() }; save(record); };

  // force — состояние изменилось руками (скорость, пауза, момент): шлём и пишем немедленно,
  // не дожидаясь таймера, который в скрытой вкладке может быть заторможен до раза в минуту
  const sendTick = (force = false) => {
    const st = getState();
    ch.postMessage({ type: 'tick', ...st, sentAt: Date.now() });
    if (force || Date.now() - lastSaved > SAVE_MS) { lastSaved = Date.now(); persist(st); }
  };
  const sendConfig = (force = false) => {
    const cfg = getConfig();
    if (!force && cfg === lastConfig) return;
    lastConfig = cfg;
    ch.postMessage({ type: 'config', diff: cfg });
    persist({ diff: cfg });
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
  sendConfig(true);
  return {
    configChanged: () => sendConfig(),
    stateChanged: () => sendTick(true),   // звать при смене скорости, паузы и момента
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

  /* Догоняем ведущего, не дожидаясь такта: при возврате на экран берём последнее
     сохранённое состояние и доигрываем время сами. restored: true — чтобы ведомый не считал
     это признаком живого ведущего (его окно может быть закрыто). */
  const catchUp = () => {
    const r = loadLast();
    if (!r) return;
    const age = Date.now() - r.at;
    if (age > RESTORE_MS) return;
    const secs = age / 1000;
    onTick?.({ t: r.playing ? r.t + secs * (r.speed || 0) : r.t, playing: !!r.playing, speed: r.speed, restored: true });
    if (r.diff) onConfig?.(r.diff);
  };

  ch.postMessage({ type: 'hello', id });
  catchUp();
  addEventListener('visibilitychange', () => { if (!document.hidden) catchUp(); });
  addEventListener('pageshow', catchUp);
  const aliveTimer = setInterval(() => ch.postMessage({ type: 'alive', id }), ALIVE_MS);
  // уходим со связи явно, чтобы индикатор у ведущего погас сразу
  const bye = () => { try { ch.postMessage({ type: 'bye', id }); } catch {} };
  addEventListener('pagehide', bye);

  return { close() { clearInterval(aliveTimer); bye(); ch.close(); } };
}
