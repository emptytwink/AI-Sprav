# services/sync.py
from __future__ import annotations
import os, threading
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, Optional, Dict, Set
from shutil import copy2
from werkzeug.utils import secure_filename

from files.paths import UPLOADS_DIR, DATA_DIR

DEFAULT_EXTS: Set[str] = {
    "pdf","doc","docx","xls","xlsx","csv","ppt","pptx","txt","md",
    "jpg","jpeg","png","gif","webp","svg","mp4","webm","ogg","avi","mov"
}
DEFAULT_INTERVAL = 15

def _norm(s: str) -> str:
    # Нормализуем для сравнения (обрезаем пробелы + casefold)
    return (s or "").strip().casefold()

@dataclass
class SyncConfig:
    sync_dir: Path
    exts: Set[str] = None
    interval_sec: int = DEFAULT_INTERVAL
    autostart: bool = False
    recursive: bool = False       # рекурсивно обходить подпапки конкретного пункта?
    prune_missing: bool = False   # удалять в uploads файлы, которых уже нет в источнике
    overwrite_if_same_name: bool = False  # перезаписывать, если имя совпало (по умолчанию: НЕТ)

    def __post_init__(self):
        if self.exts is None:
            self.exts = set(DEFAULT_EXTS)

class SyncService:
    """
    Строгая синхронизация:
      - для каждого пункта меню ищем папку <SYNC_DIR>/<title> (точное совпадение по нормализованному имени);
      - копируем только из этой папки (без догадок по имени файла и без «чужих» папок);
      - если файл с ТАКИМ ЖЕ ИМЕНЕМ уже есть в uploads у пункта — НЕ копируем повторно (пропускаем);
      - опционально: recursive/prune_missing/overwrite_if_same_name управляют деталями поведения.
    """
    def __init__(self, cfg: SyncConfig) -> None:
        self.config = cfg
        self._stop = threading.Event()
        self._thread: Optional[threading.Thread] = None

    def set_sync_dir(self, path: Path):
        self.config.sync_dir = Path(path)

    # --- Вспомогалки ---

    def _iter_files_one_level(self, folder: Path) -> Iterable[Path]:
        for p in sorted(folder.iterdir()):
            if p.is_file() and p.suffix.lower().lstrip(".") in self.config.exts:
                yield p

    def _iter_files_recursive(self, folder: Path) -> Iterable[Path]:
        for p in folder.rglob("*"):
            if p.is_file() and p.suffix.lower().lstrip(".") in self.config.exts:
                yield p

    def _list_menu_items(self) -> list[dict]:
        import json
        p = DATA_DIR / "menu.json"
        if not p.exists():
            return []
        data = json.loads(p.read_text(encoding="utf-8"))
        out: list[dict] = []
        def walk(n: dict):
            if (n or {}).get("type") == "item":
                out.append({"id": n.get("id"), "title": n.get("title","")})
            for ch in (n or {}).get("children", []) or []:
                walk(ch)
        for ch in (data or {}).get("children", []) or []:
            walk(ch)
        return out

    def _dst_dir_for(self, menu_id: str) -> Path:
        d = UPLOADS_DIR / (secure_filename(menu_id) or "unknown")
        d.mkdir(parents=True, exist_ok=True)
        return d

    # --- Основная логика ---

    def scan_once(self) -> dict:
        """
        Сканируем <SYNC_DIR> и копируем файлы ТОЛЬКО из папок,
        чьё имя == названию пункта меню (сравнение в нормализованном виде).
        Пропускаем копирование, если в целевой папке пункта уже существует файл с таким же именем.
        """
        stats = {"processed": 0, "copied": 0, "skipped": 0, "errors": 0}

        root = self.config.sync_dir
        if not root or not root.exists():
            return stats

        # Маппинг "нормализованное_название" -> (оригинальное название, id)
        title_map: Dict[str, tuple[str, str]] = {}
        for m in self._list_menu_items():
            t = m.get("title", "")
            i = m.get("id")
            if not t or not i:
                continue
            title_map[_norm(t)] = (t, i)

        # Папки первого уровня в SYNC_DIR
        try:
            subdirs = [p for p in sorted(root.iterdir()) if p.is_dir()]
        except FileNotFoundError:
            subdirs = []

        # Для каждого пункта меню — ищем соответствующую папку и синхроним
        for norm_title, (orig_title, menu_id) in title_map.items():
            src_dir = None
            for d in subdirs:
                if _norm(d.name) == norm_title:
                    src_dir = d
                    break
            if not src_dir:
                # Для данного пункта нет исходной папки — пропускаем
                continue

            dst_dir = self._dst_dir_for(menu_id)

            # учёт исходных имён (для prune)
            present_src_rel: Set[str] = set()

            iter_files = self._iter_files_recursive if self.config.recursive else self._iter_files_one_level

            for src in iter_files(src_dir):
                stats["processed"] += 1

                # относительное имя внутри папки пункта
                rel_name = src.relative_to(src_dir).as_posix()
                present_src_rel.add(rel_name)

                dst = dst_dir / rel_name
                dst.parent.mkdir(parents=True, exist_ok=True)

                # правило: если файл с таким именем уже лежит у пункта — НЕ копируем повторно
                if dst.exists() and not self.config.overwrite_if_same_name:
                    stats["skipped"] += 1
                    continue

                try:
                    copy2(src, dst)
                    stats["copied"] += 1
                except Exception:
                    stats["errors"] += 1

            # опционально удаляем из dst то, чего нет в src
            if self.config.prune_missing:
                try:
                    for p in dst_dir.rglob("*"):
                        if not p.is_file():
                            continue
                        rel = p.relative_to(dst_dir).as_posix()
                        if rel not in present_src_rel:
                            try:
                                p.unlink()
                            except Exception:
                                pass
                except Exception:
                    pass

        return stats

    def _loop(self):
        while not self._stop.is_set():
            try:
                self.scan_once()
            except Exception:
                pass
            self._stop.wait(self.config.interval_sec)

    def start(self):
        if self._thread and self._thread.is_alive():
            return
        self._stop.clear()
        self._thread = threading.Thread(target=self._loop, name="SyncServiceStrict", daemon=True)
        self._thread.start()

    def stop(self):
        self._stop.set()
        if self._thread and self._thread.is_alive():
            self._thread.join(timeout=2)

# --- Синглтон ---

_singleton: Optional[SyncService] = None

def get_sync_service() -> SyncService:
    """
    Источники конфигурации:
      SYNC_DIR, SYNC_INTERVAL, SYNC_AUTOSTART, SYNC_RECURSIVE, SYNC_PRUNE, SYNC_OVERWRITE_IF_SAME_NAME
    """
    global _singleton
    if _singleton:
        return _singleton

    sync_dir = Path(os.getenv("SYNC_DIR", "sync")).expanduser()
    interval = int(os.getenv("SYNC_INTERVAL", DEFAULT_INTERVAL))
    autostart = str(os.getenv("SYNC_AUTOSTART", "false")).lower() == "true"
    recursive = str(os.getenv("SYNC_RECURSIVE", "false")).lower() == "true"
    prune = str(os.getenv("SYNC_PRUNE", "false")).lower() == "true"
    overwrite = str(os.getenv("SYNC_OVERWRITE_IF_SAME_NAME", "false")).lower() == "true"

    cfg = SyncConfig(
        sync_dir=sync_dir,
        interval_sec=interval,
        autostart=autostart,
        recursive=recursive,
        prune_missing=prune,
        overwrite_if_same_name=overwrite,
    )
    _singleton = SyncService(cfg)
    if cfg.autostart:
        _singleton.start()
    return _singleton
# Временно добавь в services/sync.py
print("SYNC MODULE LOADED FROM:", __file__)
