/* Офлайн для страницы абонента.

   Две стратегии, и это важно:
   - код и разметка (HTML, CSS, JS, сценарии) — СНАЧАЛА СЕТЬ, кеш как запас. Иначе после обновления
     сайта вернувшийся посетитель получает старый JS с новыми данными, и числа расходятся;
     на защите это худший вид бага. Нет сети — отдаём копию из кеша.
   - неизменяемые тяжести (текстуры Земли, three.js, иконки) — сначала кеш. Они не меняются,
     а тянуть 7 МБ при каждом открытии бессмысленно.

   Тяжёлые текстуры кешируются при первом обращении, а не при установке, чтобы первое
   открытие не скачивало всё разом. После первого захода страница работает без сети —
   для жителя северного пункта это основной режим, а не украшение. */
const VERSION = 'aurora-abonent-v2';

// «сначала кеш» — только для того, что не меняется между версиями
const IMMUTABLE = /\/vendor\/|\.(png|jpg|jpeg|webp|woff2?|glb)$/;

// пути от корня сайта: страница лежит в /abonent/, а код и вендор — уровнем выше
const CORE = [
  './',
  './index.html',
  './style.css',
  './manifest.webmanifest',
  './icon-180.png',
  '../data/scenarios.js',
  '../src/subscriber.js',
  '../src/sim.js',
  '../src/globe.js',
  '../src/state.js',
  '../src/configlink.js',
  '../vendor/three.module.js',
  '../vendor/jsm/loaders/GLTFLoader.js',
  '../vendor/jsm/environments/RoomEnvironment.js',
];

self.addEventListener('install', ev => {
  ev.waitUntil((async () => {
    const cache = await caches.open(VERSION);
    // по одному: если какой-то файл отсутствует, не роняем всю установку
    await Promise.all(CORE.map(u => cache.add(new Request(u, { cache: 'reload' })).catch(() => {})));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', ev => {
  ev.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== VERSION) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', ev => {
  const req = ev.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;

  ev.respondWith((async () => {
    const cache = await caches.open(VERSION);
    const store = res => { if (res.ok && res.type === 'basic') cache.put(req, res.clone()); return res; };

    // неизменяемое: сначала кеш, в фоне подтягиваем свежую копию
    if (IMMUTABLE.test(url.pathname)) {
      const hit = await cache.match(req, { ignoreSearch: true });
      if (hit) {
        ev.waitUntil(fetch(req).then(r => { if (r.ok) cache.put(req, r.clone()); }).catch(() => {}));
        return hit;
      }
      return store(await fetch(req));
    }

    // код и разметка: сначала сеть, чтобы после обновления не остаться на старом JS
    try {
      return store(await fetch(req));
    } catch {
      const hit = await cache.match(req, { ignoreSearch: true });
      if (hit) return hit;
      if (req.mode === 'navigate') {
        const shell = await cache.match('./index.html');
        if (shell) return shell;
      }
      throw new Error('offline and not cached: ' + url.pathname);
    }
  })());
});
