# utils/dinam_pyti.py
from __future__ import annotations

from pathlib import Path

from files.paths import UPLOADS_DIR


def get_block_files_folder(project: str, circle_id: str) -> Path:
    """
    Папка для файлов круга:
    data/uploads/<project>/<circle_id>/
    """
    folder = UPLOADS_DIR / project / circle_id
    folder.mkdir(parents=True, exist_ok=True)
    return folder


def get_block_file_path(project: str, circle_id: str, filename: str) -> Path:
    """
    Полный путь к конкретному файлу круга.
    """
    return get_block_files_folder(project, circle_id) / filename