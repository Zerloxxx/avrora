#!/usr/bin/env python3
"""Локальный сервер для разработки: как python -m http.server, но без кеширования.

Зачем отдельный скрипт: http.server не отдаёт Cache-Control, и браузер держит ES-модули
в кеше. После правки src/*.js страница продолжает грузить прежнюю версию модуля и падает
с «does not provide an export named ...» — ошибка выглядит как баг в коде, хотя код уже верный.

    python3 tools/serve.py [порт]        # по умолчанию 8765

Для показа жюри это не нужно — там статика раздаётся хостингом с нормальными ETag.
"""
import functools
import http.server
import os
import socketserver
import sys

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))   # папка web/


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        '.js': 'text/javascript',
        '.mjs': 'text/javascript',
        '.webmanifest': 'application/manifest+json',
        '.json': 'application/json',
    }

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store, must-revalidate')
        self.send_header('Service-Worker-Allowed', '/')
        super().end_headers()

    def log_message(self, fmt, *args):
        # 404 видно, остальное не засоряет вывод
        if not args or not str(args[0]).endswith(('200 -', '304 -')):
            super().log_message(fmt, *args)


class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


if __name__ == '__main__':
    handler = functools.partial(NoCacheHandler, directory=ROOT)
    with Server(('', PORT), handler) as httpd:
        print(f'Аврора: http://localhost:{PORT}  (инженерный вид)')
        print(f'         http://localhost:{PORT}/abonent/  (вид абонента)')
        print('Ctrl+C — остановить')
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            pass
