#!/bin/sh
# Запуск Авроры: http://localhost:8765
cd "$(dirname "$0")"
(sleep 1; open http://localhost:8765 2>/dev/null || xdg-open http://localhost:8765 2>/dev/null) &
python3 -m http.server 8765
