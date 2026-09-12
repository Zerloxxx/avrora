"""Собирает web/data/scenarios.js из JSON-сценариев папки «Данные».

Запуск из корня репозитория:  python web/tools/bundle-scenarios.py
Встраивание нужно, чтобы сайт открывался как статика без запросов к файлам.
"""
import glob
import json
import pathlib

ROOT = pathlib.Path(__file__).resolve().parents[2]
SRC = ROOT / "Данные"
DST = ROOT / "web" / "data" / "scenarios.js"

scenarios = {}
for path in sorted(glob.glob(str(SRC / "*.json"))):
    scenario = json.loads(pathlib.Path(path).read_text(encoding="utf-8"))
    scenarios[scenario["meta"]["id"]] = scenario

DST.parent.mkdir(parents=True, exist_ok=True)
DST.write_text(
    "// Сгенерировано tools/bundle-scenarios.py из папки «Данные» — не править руками.\n"
    "window.SCENARIOS = " + json.dumps(scenarios, ensure_ascii=False, indent=1) + ";\n",
    encoding="utf-8",
)
print(f"{DST.relative_to(ROOT)}: {len(scenarios)} сценариев — {', '.join(scenarios)}")
