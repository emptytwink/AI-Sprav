# files/paths.py
from __future__ import annotations
from pathlib import Path
import os, sys

# Где лежит неизменяемый bundle (templates/static) и где сам exe
if getattr(sys, "frozen", False):                          # ← PyInstaller
    BUNDLE_DIR  = Path(getattr(sys, "_MEIPASS", Path(sys.executable).parent))
    RUNTIME_DIR = Path(sys.executable).parent              # ← папка, где лежит .exe
else:                                                      # ← запуск из исходников
    BUNDLE_DIR  = Path(__file__).resolve().parents[1]
    RUNTIME_DIR = BUNDLE_DIR

# ✅ Совместимость со старым кодом (export.py ждёт BASE_DIR)
BASE_DIR = RUNTIME_DIR

# Папка данных (записываемая). Можно переопределить через SPRAV_DATA_DIR
DATA_DIR     = Path(os.getenv("SPRAV_DATA_DIR") or (RUNTIME_DIR / "data"))
CONTENTS_DIR = DATA_DIR / "contents"
UPLOADS_DIR  = DATA_DIR / "uploads"   # ВАЖНО: загрузки храним в data/uploads

# Неизменяемая статика и шаблоны — внутри bundle
STATIC_DIR    = BUNDLE_DIR / "static"
DRAWINGS_DIR  = STATIC_DIR / "state" / "drawings"
TEMPLATES_DIR = BUNDLE_DIR / "templates"

# Создаём только записываемые папки
for p in (DATA_DIR, CONTENTS_DIR, UPLOADS_DIR):
    p.mkdir(parents=True, exist_ok=True)
