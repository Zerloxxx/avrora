@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo Запуск Авроры на http://localhost:8765 ...
echo Закройте это окно, чтобы остановить сервер.
start "" http://localhost:8765
python -m http.server 8765
if errorlevel 1 (
  echo.
  echo Не найден Python. Установите его с https://www.python.org/downloads/ ^(поставьте галочку "Add to PATH"^) и запустите снова.
  pause
)
