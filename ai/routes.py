from __future__ import annotations

import json
import os
import re
import threading
import unicodedata
import uuid
from pathlib import Path
from typing import Any, Dict, List, Tuple

from flask import Blueprint, jsonify, request

from .builder import apply_suggestion
from .extractors import collect_documents
from .importer import (
    archive_tree_depth,
    build_archive_tree,
    create_job,
    job_dir,
    now_iso,
    read_status,
    read_suggestion,
    safe_extract_zip,
    source_dir,
    write_status,
    write_suggestion,
)
from .llm_client import OllamaClient, OllamaError
from .prompts import SYSTEM_PROMPT, build_user_prompt

bp_ai = Blueprint("ai", __name__)


@bp_ai.post("/api/ai/import-archive")
def import_archive():
    archive = request.files.get("archive")
    if not archive or not archive.filename:
        return jsonify(ok=False, error="Файл archive обязателен."), 400
    if Path(archive.filename).suffix.lower() != ".zip":
        return jsonify(ok=False, error="Можно загрузить только ZIP-архив."), 400

    job_id = uuid.uuid4().hex
    client = OllamaClient()
    create_job(job_id, archive.filename)
    write_status(
        job_id,
        ollama_base_url=client.base_url,
        ollama_model=client.model,
        max_docs=int(os.getenv("AI_MAX_DOCS", "50")),
        max_chars_per_doc=int(os.getenv("AI_MAX_CHARS_PER_DOC", "4000")),
        num_predict=client.num_predict,
    )
    archive.save(job_dir(job_id) / "source.zip")

    thread = threading.Thread(target=_process_job, args=(job_id,), daemon=True)
    thread.start()
    return jsonify(ok=True, job_id=job_id)


@bp_ai.get("/api/ai/jobs/<job_id>")
def get_job(job_id: str):
    status = read_status(job_id)
    if not status:
        return jsonify(ok=False, error="Задание не найдено."), 404
    return jsonify(
        ok=True,
        suggestion=read_suggestion(job_id),
        selected_documents=_read_job_json(job_id, "selected_documents.json", []),
        skipped_files=_read_job_json(job_id, "skipped_files.json", []),
        archive_tree=_read_job_json(job_id, "archive_tree.json", None),
        **status,
    )


@bp_ai.get("/api/ai/jobs/<job_id>/debug")
def get_job_debug(job_id: str):
    status = read_status(job_id)
    if not status:
        return jsonify(ok=False, error="Задание не найдено."), 404
    d = job_dir(job_id)
    return jsonify(
        ok=True,
        status=status,
        archive_tree=_read_job_json(job_id, "archive_tree.json", None),
        selected_documents=_read_job_json(job_id, "selected_documents.json", []),
        skipped_files=_read_job_json(job_id, "skipped_files.json", []),
        suggestion=read_suggestion(job_id),
        raw_response_exists=(d / "ollama_raw_response.json").exists() or (d / "ollama_raw_response.txt").exists(),
    )


@bp_ai.post("/api/ai/jobs/<job_id>/apply")
def apply_job(job_id: str):
    status = read_status(job_id)
    if not status:
        return jsonify(ok=False, error="Задание не найдено."), 404
    if status.get("status") not in {"ready", "applied"}:
        return jsonify(ok=False, error="Результат ИИ ещё не готов к применению."), 400

    try:
        write_status(job_id, status="applying", message="Применение структуры к справочнику...", progress=95)
        result = apply_suggestion(job_id)
        write_status(
            job_id,
            status="applied",
            message="ИИ-структура добавлена отдельной веткой справочника.",
            progress=100,
            error=None,
            finished_at=now_iso(),
            attached_files_count=result.get("attached_files", 0),
        )
        return jsonify(ok=True, **result)
    except Exception as exc:
        write_status(job_id, status="failed", message="Ошибка применения результата.", error=str(exc), finished_at=now_iso())
        return jsonify(ok=False, error=str(exc)), 500


def _process_job(job_id: str) -> None:
    try:
        zip_path = job_dir(job_id) / "source.zip"
        write_status(job_id, status="extracting", message="Распаковка ZIP-архива...", progress=15)
        extracted = safe_extract_zip(zip_path, source_dir(job_id))

        archive_tree = build_archive_tree(source_dir(job_id))
        _write_job_json(job_id, "archive_tree.json", archive_tree)
        max_tree_depth = archive_tree_depth(archive_tree)

        write_status(job_id, status="selecting_documents", message="Выбор документов для анализа...", progress=30)
        documents, skipped, meta = collect_documents(source_dir(job_id))
        meta["archive_tree_depth"] = max_tree_depth
        _write_job_json(job_id, "selected_documents.json", meta["selected_documents"])
        _write_job_json(job_id, "skipped_files.json", skipped)
        write_status(
            job_id,
            total_files_in_archive=meta["total_files_in_archive"],
            total_supported_candidates=meta["total_supported_candidates"],
            selected_documents_count=meta["selected_documents_count"],
            skipped_files_count=meta["skipped_files_count"],
            max_archive_depth=meta.get("max_archive_depth"),
            archive_tree_depth=max_tree_depth,
            max_docs=meta["max_docs"],
            max_chars_per_doc=meta["max_chars_per_doc"],
            num_predict=meta["num_predict"],
        )
        if not documents:
            raise RuntimeError("Не удалось извлечь текст ни из одного документа архива.")

        client = OllamaClient()
        write_status(job_id, status="analyzing", message="Подготовка данных для ИИ-анализа...", progress=45)
        write_status(job_id, status="ollama_generating", message="Ollama формирует структуру справочника...", progress=60)
        raw_suggestion = client.chat_json(
            SYSTEM_PROMPT,
            build_user_prompt(documents, skipped, meta["folders_detected"], archive_tree=archive_tree),
            debug_dir=job_dir(job_id),
        )
        suggestion = _normalize_suggestion(raw_suggestion, documents, meta, extracted, archive_tree)
        quality = _structure_quality(suggestion.get("menu") or [])
        suggestion["_meta"] = {
            **meta,
            **quality,
            "archive_name": (read_status(job_id) or {}).get("archive_name"),
            "ollama_model": client.model,
            "ollama_base_url": client.base_url,
            "archive_files": extracted,
            "fallback_used": suggestion.get("_fallback_used", False),
            "structure_warning": suggestion.get("_structure_warning"),
        }
        write_suggestion(job_id, suggestion)
        write_status(
            job_id,
            status="ready",
            message="Предложенная структура готова к просмотру.",
            progress=100,
            error=None,
            finished_at=now_iso(),
            menu_depth=quality["menu_depth"],
            group_count=quality["group_count"],
            item_count=quality["item_count"],
        )
    except OllamaError as exc:
        write_status(job_id, status="failed", message=str(exc), progress=100, error=str(exc), finished_at=now_iso())
    except Exception as exc:
        write_status(
            job_id,
            status="failed",
            message="Ошибка ИИ-сбора справочника.",
            progress=100,
            error=str(exc),
            finished_at=now_iso(),
        )


def _normalize_suggestion(
    raw: Dict[str, Any],
    documents: List[Dict[str, Any]],
    meta: Dict[str, Any],
    archive_files: List[str],
    archive_tree: Dict[str, Any] | None = None,
) -> Dict[str, Any]:
    menu = raw.get("menu")
    contents = raw.get("contents")
    has_schema = isinstance(menu, list) and bool(menu) and isinstance(contents, list) and bool(contents)
    archive_depth = int(meta.get("archive_tree_depth") or meta.get("max_archive_depth") or 0)

    if has_schema:
        quality = _structure_quality(menu)
        # Если архив глубокий, а модель вернула плоское меню, не применяем плохой результат.
        if archive_depth >= 3 and quality["menu_depth"] < 3:
            fallback = _build_fallback_suggestion(documents, meta, archive_files)
            fallback["_fallback_used"] = True
            fallback["_structure_warning"] = (
                f"Модель вернула слишком плоскую структуру: глубина меню {quality['menu_depth']}, "
                f"глубина архива {archive_depth}. Использован fallback по реальному пути файлов."
            )
            fallback["_raw_model_quality"] = quality
            return fallback
        raw["_fallback_used"] = False
        return raw

    fallback = _build_fallback_suggestion(documents, meta, archive_files)
    fallback["_raw_model_keys"] = sorted(str(k) for k in raw.keys())
    fallback["_fallback_used"] = True
    fallback["_structure_warning"] = "Ollama вернула ответ не в формате справочника. Использован fallback по папкам архива."
    return fallback


def _build_fallback_suggestion(
    documents: List[Dict[str, Any]],
    meta: Dict[str, Any],
    archive_files: List[str],
) -> Dict[str, Any]:
    """Строит многоуровневый справочник по полному пути файла, а не по первой папке."""
    menu: List[Dict[str, Any]] = []
    contents: List[Dict[str, Any]] = []
    used_ids: set[str] = set()

    def get_or_create_group(children: List[Dict[str, Any]], part: str, prefix: str) -> Dict[str, Any]:
        title = _title_from_name(part)
        for node in children:
            if node.get("type") == "group" and node.get("title") == title:
                return node
        group_id = _slug(f"{prefix}_{part}" if prefix else part, used_ids)
        used_ids.add(group_id)
        node = {"id": group_id, "title": title, "type": "group", "children": []}
        children.append(node)
        return node

    for doc in sorted(documents, key=lambda item: str(item.get("relpath") or item.get("path") or "")):
        rel = str(doc.get("relpath") or doc.get("path") or "")
        if not rel:
            continue
        parts = [part for part in rel.split("/") if part]
        folders = parts[:-1]
        filename = parts[-1]
        children = menu
        prefix = ""
        for folder in folders:
            group = get_or_create_group(children, folder, prefix)
            children = group.setdefault("children", [])
            prefix = f"{prefix}_{folder}" if prefix else folder

        item_title = _title_from_name(Path(filename).stem or doc.get("title") or "Документ")
        item_id = _slug(f"{prefix}_{item_title}" if prefix else item_title, used_ids)
        used_ids.add(item_id)
        children.append({"id": item_id, "title": item_title, "type": "item"})
        contents.append(
            {
                "item_id": item_id,
                "title": item_title,
                "text_html": f"<p>Раздел сформирован по документу <b>{_escape_html(rel)}</b>.</p>",
                "source_files": _related_files(rel, archive_files),
            }
        )

    quality = _structure_quality(menu)
    return {
        "title": "Предложенный справочник",
        "menu": menu,
        "contents": contents,
        "processed_documents": len(documents),
        "selected_documents_count": meta.get("selected_documents_count", len(documents)),
        "_fallback_used": True,
        "_structure_warning": "Структура построена автоматически по полному пути файлов архива.",
        **quality,
    }


def _structure_quality(menu: List[Dict[str, Any]]) -> Dict[str, int]:
    def walk(nodes: List[Dict[str, Any]], depth: int) -> Tuple[int, int, int]:
        max_depth = depth
        group_count = 0
        item_count = 0
        for node in nodes or []:
            if not isinstance(node, dict):
                continue
            node_type = node.get("type")
            children = node.get("children") or []
            if node_type == "group" or children:
                group_count += 1
            else:
                item_count += 1
            if children:
                child_depth, child_groups, child_items = walk(children, depth + 1)
                max_depth = max(max_depth, child_depth)
                group_count += child_groups
                item_count += child_items
        return max_depth, group_count, item_count

    menu_depth, group_count, item_count = walk(menu, 1 if menu else 0)
    return {"menu_depth": menu_depth, "group_count": group_count, "item_count": item_count}


def _related_files(rel: str, archive_files: List[str]) -> List[str]:
    result = [rel] if rel in archive_files else []
    folder = rel.rsplit("/", 1)[0] if "/" in rel else ""
    stem = Path(rel).stem.lower()
    for candidate in archive_files:
        candidate_stem = Path(candidate).stem.lower()
        candidate_folder = candidate.rsplit("/", 1)[0] if "/" in candidate else ""
        if candidate not in result and candidate_folder == folder and (candidate_stem == stem or stem in candidate_stem or candidate_stem in stem):
            result.append(candidate)
    return result


def _title_from_name(value: str) -> str:
    name = Path(value).name
    name = re.sub(r"^\d+(?:_\d+)*[_\-\s]*", "", name)
    name = re.sub(r"\.[^.]+$", "", name)
    name = name.replace("_", " ").replace("-", " ")
    name = re.sub(r"\s+", " ", name).strip()
    return name[:1].upper() + name[1:] if name else "Раздел"


_TRANSLIT = {
    "а": "a", "б": "b", "в": "v", "г": "g", "д": "d", "е": "e", "ё": "e", "ж": "zh", "з": "z", "и": "i", "й": "y",
    "к": "k", "л": "l", "м": "m", "н": "n", "о": "o", "п": "p", "р": "r", "с": "s", "т": "t", "у": "u", "ф": "f",
    "х": "h", "ц": "c", "ч": "ch", "ш": "sh", "щ": "sch", "ъ": "", "ы": "y", "ь": "", "э": "e", "ю": "yu", "я": "ya",
}


def _slug(value: str, used: set[str]) -> str:
    raw = str(value).lower()
    raw = "".join(_TRANSLIT.get(ch, ch) for ch in raw)
    text = unicodedata.normalize("NFKD", raw)
    text = "".join(ch for ch in text if not unicodedata.combining(ch))
    text = re.sub(r"[^a-z0-9_]+", "_", text)
    text = re.sub(r"_+", "_", text).strip("_") or "item"
    candidate = text
    index = 2
    while candidate in used:
        candidate = f"{text}_{index}"
        index += 1
    return candidate


def _escape_html(value: str) -> str:
    return str(value).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def _write_job_json(job_id: str, filename: str, payload) -> None:
    (job_dir(job_id) / filename).write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")


def _read_job_json(job_id: str, filename: str, default):
    path = job_dir(job_id) / filename
    if not path.exists():
        return default
    return json.loads(path.read_text(encoding="utf-8"))
