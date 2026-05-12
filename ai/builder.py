from __future__ import annotations

import re
import shutil
import unicodedata
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, Iterable, List, Set

from files.storage import content_save, files_dir, menu_load, menu_save

from .importer import read_suggestion, source_dir

AI_ROOT_ID = "ai_sobranny_spravochnik"
AI_ROOT_TITLE = "ИИ-собранный справочник"
ALL_FILES_ID_BASE = "ai_all_archive_files"
ALL_FILES_TITLE = "Все файлы архива"


def apply_suggestion(job_id: str) -> Dict[str, Any]:
    suggestion = read_suggestion(job_id)
    if not isinstance(suggestion, dict):
        raise ValueError("suggestion.json не найден или поврежден")
    if not isinstance(suggestion.get("menu"), list) or not isinstance(suggestion.get("contents"), list):
        raise ValueError("В suggestion.json должны быть menu и contents")

    menu = menu_load()
    existing_ids = _collect_menu_ids(menu)

    now = datetime.now()
    root_exists = AI_ROOT_ID in existing_ids
    root_id = AI_ROOT_ID if not root_exists else _slug(f"{AI_ROOT_ID}_{now:%Y%m%d_%H%M}", existing_ids)
    root_title = AI_ROOT_TITLE if not root_exists else f"{AI_ROOT_TITLE} {now:%Y-%m-%d %H:%M}"
    ai_root = {"id": root_id, "title": root_title, "type": "group", "children": []}
    menu.setdefault("children", []).append(ai_root)
    existing_ids.add(root_id)

    id_map: Dict[str, str] = {}
    ai_root["children"] = [
        _normalize_node(node, existing_ids, id_map)
        for node in suggestion["menu"]
        if isinstance(node, dict)
    ]

    all_files_id = _slug(f"{root_id}_{ALL_FILES_ID_BASE}", existing_ids)
    existing_ids.add(all_files_id)
    ai_root.setdefault("children", []).append(
        {"id": all_files_id, "title": ALL_FILES_TITLE, "type": "item"}
    )
    menu_save(menu)

    archive_files = _archive_files(job_id, suggestion)
    warnings: List[str] = []
    contents_by_id = {
        str(item.get("item_id") or item.get("id")): item
        for item in suggestion.get("contents", [])
        if isinstance(item, dict) and (item.get("item_id") or item.get("id"))
    }

    copied_by_item: Dict[str, Set[str]] = {}
    applied_items = 0
    for old_id, content in contents_by_id.items():
        item_id = id_map.get(old_id)
        if not item_id:
            item_id = _slug(old_id, existing_ids)
            existing_ids.add(item_id)

        source_files = _content_source_files(content, archive_files, item_id)
        for rel in _raw_source_files(content):
            if str(rel).replace("\\", "/") not in archive_files:
                warnings.append(f"source_file не найден: {rel}")

        _clear_item_files(item_id)
        content_save(
            item_id,
            {
                "title": content.get("title") or item_id,
                "text_html": _sanitize_simple_html(content.get("text_html") or content.get("text") or ""),
                "table": {"columns": [], "rows": []},
                "description_title": "Описание",
                "docs_title": "Документы",
            },
        )
        copied_by_item[item_id] = set(source_files)
        _copy_source_files(job_id, item_id, source_files)
        applied_items += 1

    attached_files = set().union(*copied_by_item.values()) if copied_by_item else set()
    remaining_files = [rel for rel in archive_files if rel not in attached_files]
    assigned_remaining = _assign_remaining_files(remaining_files, copied_by_item)
    for item_id, rels in assigned_remaining.items():
        if rels:
            _copy_source_files(job_id, item_id, rels)
            attached_files.update(rels)

    # Страховочный раздел: все файлы архива доступны даже если модель не указала source_files.
    content_save(
        all_files_id,
        {
            "title": ALL_FILES_TITLE,
            "text_html": "<p>Все файлы, автоматически прикрепленные из исходного ZIP-архива.</p>",
            "table": {"columns": [], "rows": []},
            "description_title": "Описание",
            "docs_title": "Документы",
        },
    )
    _clear_item_files(all_files_id)
    _copy_source_files(job_id, all_files_id, archive_files)

    return {
        "applied_items": applied_items,
        "attached_files": len(archive_files),
        "warnings": warnings,
        "root_id": root_id,
    }


def _normalize_node(node: Dict[str, Any], used: Set[str], id_map: Dict[str, str]) -> Dict[str, Any]:
    old_id = str(node.get("id") or node.get("title") or "item")
    new_id = _slug(old_id, used)
    used.add(new_id)
    id_map[old_id] = new_id

    title = str(node.get("title") or old_id)
    node_type = "group" if node.get("type") == "group" or isinstance(node.get("children"), list) else "item"
    result: Dict[str, Any] = {"id": new_id, "title": title, "type": node_type}
    if node_type == "group":
        result["children"] = [
            _normalize_node(child, used, id_map)
            for child in node.get("children", []) or []
            if isinstance(child, dict)
        ]
    return result


def _copy_source_files(job_id: str, item_id: str, rel_paths: Iterable[str]) -> None:
    root = source_dir(job_id).resolve()
    dst_dir = files_dir(item_id)
    for rel in rel_paths:
        src = (root / str(rel)).resolve()
        if root != src and root not in src.parents:
            continue
        if not src.is_file():
            continue
        target = _unique_path(dst_dir, _safe_filename(src.name))
        shutil.copy2(src, target)


def _clear_item_files(item_id: str) -> None:
    folder = files_dir(item_id)
    for path in folder.iterdir():
        if path.is_file():
            path.unlink()


def _archive_files(job_id: str, suggestion: Dict[str, Any]) -> List[str]:
    meta_files = ((suggestion.get("_meta") or {}).get("archive_files") or [])
    if meta_files:
        return [str(rel).replace("\\", "/") for rel in meta_files]
    root = source_dir(job_id)
    return [path.relative_to(root).as_posix() for path in root.rglob("*") if path.is_file()]


def _valid_rel_files(rel_paths: Iterable[str], archive_files: Iterable[str]) -> List[str]:
    known = set(archive_files)
    result: List[str] = []
    for rel in rel_paths:
        normalized = str(rel).replace("\\", "/")
        if normalized in known and normalized not in result:
            result.append(normalized)
    return result


def _content_source_files(content: Dict[str, Any], archive_files: List[str], item_id: str) -> List[str]:
    exact = _valid_rel_files(_raw_source_files(content), archive_files)
    if exact:
        return exact
    return _infer_source_files(content, archive_files, item_id)


def _raw_source_files(content: Dict[str, Any]) -> List[str]:
    raw = content.get("source_files")
    if raw is None and content.get("source"):
        raw = [content.get("source")]
    if isinstance(raw, str):
        raw = [raw]
    return [str(item) for item in (raw or [])]


def _infer_source_files(content: Dict[str, Any], archive_files: List[str], item_id: str) -> List[str]:
    haystack = " ".join(
        str(value)
        for value in (
            item_id,
            content.get("id", ""),
            content.get("item_id", ""),
            content.get("title", ""),
            content.get("source", ""),
        )
    )
    tokens = _tokens(haystack)
    if not tokens:
        return []

    scored: List[tuple[int, str]] = []
    for rel in archive_files:
        rel_tokens = _tokens(rel)
        folder = rel.split("/", 1)[0] if "/" in rel else ""
        score = len(tokens & rel_tokens) + len(tokens & _tokens(folder)) * 2
        if score > 0:
            scored.append((score, rel))

    if not scored:
        return []
    max_score = max(score for score, _ in scored)
    return [rel for score, rel in scored if score == max_score]


def _tokens(value: str) -> Set[str]:
    value = value.lower()
    value = re.sub(r"\.[a-z0-9]+$", " ", value)
    value = re.sub(r"[^a-zа-яё0-9]+", " ", value, flags=re.I)
    return {part for part in value.split() if len(part) > 2}


def _assign_remaining_files(
    remaining_files: Iterable[str],
    copied_by_item: Dict[str, Set[str]],
) -> Dict[str, List[str]]:
    by_item: Dict[str, List[str]] = {item_id: [] for item_id in copied_by_item}
    folder_to_items: Dict[str, List[str]] = {}

    for item_id, rels in copied_by_item.items():
        for rel in rels:
            folder = rel.split("/", 1)[0] if "/" in rel else ""
            folder_to_items.setdefault(folder, []).append(item_id)

    for rel in remaining_files:
        folder = rel.split("/", 1)[0] if "/" in rel else ""
        candidates = folder_to_items.get(folder) or []
        if candidates and candidates[0]:
            by_item.setdefault(candidates[0], []).append(rel)

    return by_item


def _unique_path(folder: Path, filename: str) -> Path:
    candidate = folder / filename
    base = candidate.stem
    ext = candidate.suffix
    counter = 1
    while candidate.exists():
        candidate = folder / f"{base} ({counter}){ext}"
        counter += 1
    return candidate


def _safe_filename(filename: str) -> str:
    # Keep Cyrillic names readable, but remove characters that are unsafe on Windows or URLs.
    name = Path(filename).name.strip().replace("\\", "_").replace("/", "_")
    name = re.sub(r'[<>:"|?*\x00-\x1f]', "_", name)
    name = re.sub(r"\s+", " ", name).strip(" .")
    return name or "file"


def _collect_menu_ids(node: Dict[str, Any]) -> Set[str]:
    out = {str(node.get("id"))}
    for child in node.get("children", []) or []:
        if isinstance(child, dict):
            out.update(_collect_menu_ids(child))
    return out


def _slug(value: str, used: Set[str]) -> str:
    text = unicodedata.normalize("NFKD", value.lower())
    text = "".join(ch for ch in text if not unicodedata.combining(ch))
    text = re.sub(r"[^a-z0-9_]+", "_", text)
    text = re.sub(r"_+", "_", text).strip("_") or "item"
    candidate = text
    index = 2
    while candidate in used:
        candidate = f"{text}_{index}"
        index += 1
    return candidate


def _sanitize_simple_html(html: str) -> str:
    html = re.sub(r"<\s*(script|style|iframe|object|embed)[^>]*>.*?<\s*/\s*\1\s*>", "", html, flags=re.I | re.S)
    html = re.sub(r"\s(on\w+|style)\s*=\s*(['\"]).*?\2", "", html, flags=re.I | re.S)
    html = re.sub(r"</?(?!p\b|ul\b|li\b|b\b|i\b)[a-z][^>]*>", "", html, flags=re.I)
    return html.strip() or "<p>Описание сформировано по загруженным документам.</p>"
