from __future__ import annotations

import json
import shutil
import zipfile
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List

from files.paths import DATA_DIR

AI_JOBS_DIR = DATA_DIR / "ai_jobs"
TRASH_NAMES = {".DS_Store", "Thumbs.db", "desktop.ini"}


def job_dir(job_id: str) -> Path:
    return AI_JOBS_DIR / job_id


def status_path(job_id: str) -> Path:
    return job_dir(job_id) / "status.json"


def suggestion_path(job_id: str) -> Path:
    return job_dir(job_id) / "suggestion.json"


def source_dir(job_id: str) -> Path:
    return job_dir(job_id) / "source"


def now_iso() -> str:
    return datetime.now().isoformat(timespec="seconds")


def create_job(job_id: str, archive_name: str) -> Dict[str, Any]:
    d = job_dir(job_id)
    d.mkdir(parents=True, exist_ok=True)
    source_dir(job_id).mkdir(parents=True, exist_ok=True)
    status = {
        "job_id": job_id,
        "status": "uploaded",
        "message": "Файл загружен, задание поставлено в обработку.",
        "progress": 5,
        "error": None,
        "archive_name": archive_name,
        "created_at": now_iso(),
        "finished_at": None,
        "ollama_base_url": None,
        "ollama_model": None,
        "max_docs": None,
        "max_chars_per_doc": None,
        "num_predict": None,
        "total_files_in_archive": None,
        "total_supported_candidates": None,
        "selected_documents_count": None,
        "skipped_files_count": None,
        "attached_files_count": None,
    }
    path = status_path(job_id)
    path.write_text(json.dumps(status, ensure_ascii=False, indent=2), encoding="utf-8")
    return status


def read_status(job_id: str) -> Dict[str, Any] | None:
    path = status_path(job_id)
    if not path.exists():
        return None
    return json.loads(path.read_text(encoding="utf-8"))


def write_status(job_id: str, **updates: Any) -> Dict[str, Any]:
    current = read_status(job_id) or {"job_id": job_id}
    current.update(updates)
    path = status_path(job_id)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(current, ensure_ascii=False, indent=2), encoding="utf-8")
    return current


def read_suggestion(job_id: str) -> Dict[str, Any] | None:
    path = suggestion_path(job_id)
    if not path.exists():
        return None
    return json.loads(path.read_text(encoding="utf-8"))


def write_suggestion(job_id: str, suggestion: Dict[str, Any]) -> None:
    suggestion_path(job_id).write_text(
        json.dumps(suggestion, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


def safe_extract_zip(zip_path: Path, dst_dir: Path) -> List[str]:
    if dst_dir.exists():
        shutil.rmtree(dst_dir)
    dst_dir.mkdir(parents=True, exist_ok=True)
    extracted: List[str] = []
    root = dst_dir.resolve()

    with zipfile.ZipFile(zip_path) as archive:
        for info in archive.infolist():
            normalized = _repair_zip_name(info.filename).replace("\\", "/")
            parts = [part for part in normalized.split("/") if part]
            if not parts or parts[0] == "__MACOSX" or parts[-1] in TRASH_NAMES:
                continue
            target = (dst_dir / Path(*parts)).resolve()
            if root != target and root not in target.parents:
                raise ValueError(f"Небезопасный путь в ZIP: {info.filename}")
            if info.is_dir():
                target.mkdir(parents=True, exist_ok=True)
                continue
            target.parent.mkdir(parents=True, exist_ok=True)
            with archive.open(info) as src, target.open("wb") as dst:
                shutil.copyfileobj(src, dst)
            extracted.append(target.relative_to(root).as_posix())

    return extracted


def build_archive_tree(src_dir: Path) -> Dict[str, Any]:
    """Возвращает реальное дерево распакованного архива для prompt и диагностики."""
    root = {"name": ".", "type": "dir", "children": []}

    def is_trash_rel(rel: Path) -> bool:
        return (
            any(part == "__MACOSX" for part in rel.parts)
            or any(part == "control_expected_result" for part in rel.parts)
            or rel.name in TRASH_NAMES
        )

    def node_children(node: Dict[str, Any]) -> List[Dict[str, Any]]:
        return node.setdefault("children", [])

    for path in sorted(src_dir.rglob("*")):
        rel = path.relative_to(src_dir)
        if is_trash_rel(rel):
            continue
        current = root
        parts = rel.parts
        for index, part in enumerate(parts):
            is_last = index == len(parts) - 1
            node_type = "file" if is_last and path.is_file() else "dir"
            children = node_children(current)
            found = next((item for item in children if item.get("name") == part and item.get("type") == node_type), None)
            if found is None:
                found = {"name": part, "type": node_type}
                if node_type == "dir":
                    found["children"] = []
                else:
                    found["path"] = rel.as_posix()
                    found["ext"] = path.suffix.lower()
                    found["size_bytes"] = path.stat().st_size
                children.append(found)
            current = found
    return root


def archive_tree_depth(tree: Dict[str, Any]) -> int:
    """Считает максимальную глубину папок/файлов в дереве архива."""
    def walk(node: Dict[str, Any], depth: int) -> int:
        children = node.get("children") or []
        if not children:
            return depth
        return max(walk(child, depth + 1) for child in children if isinstance(child, dict))

    return max(0, walk(tree, 0) - 1)


def _repair_zip_name(name: str) -> str:
    """Fix common ZIP archives where UTF-8 or CP866 names were decoded as CP437."""
    candidates = [name]
    for source_encoding in ("cp437", "cp866"):
        for target_encoding in ("utf-8", "cp866", "cp1251"):
            try:
                candidates.append(name.encode(source_encoding).decode(target_encoding))
            except UnicodeError:
                continue

    def score(value: str) -> int:
        mojibake = sum(value.count(ch) for ch in "ÐÑ╨╩╠╬╥╧└┴┬├─│")
        cyrillic = sum(1 for ch in value if "а" <= ch.lower() <= "я" or ch.lower() == "ё")
        replacement = value.count("�")
        return cyrillic * 3 - mojibake * 5 - replacement * 10

    return max(candidates, key=score)
