from __future__ import annotations

import uuid
from typing import Any, Dict, List

from flask import Blueprint, jsonify, request, abort, send_file
from werkzeug.utils import secure_filename
from pathlib import Path
import re, unicodedata, string

from .storage import (
    menu_load, menu_save, menu_find, menu_find_parent, menu_remove,
    content_load, content_save,
    files_save, file_delete, drawings_list, files_dir,
)

from services.sync import get_sync_service
from .paths import UPLOADS_DIR

# >>> ДОБАВЛЕНО: импорт экспортёра <<<
from services.export import build_export

# ===== вспомогательные функции для ID и слага =================================

_RU = "абвгдеёжзийклмнопрстуфхцчшщьыъэюя"
_LAT = [
    "a", "b", "v", "g", "d", "e", "e", "zh", "z", "i", "y", "k", "l", "m",
    "n", "o", "p", "r", "s", "t", "u", "f", "h", "ts", "ch", "sh", "sch",
    "", "", "e", "yu", "ya"
]
_TR = {ord(c): t for c, t in zip(_RU, _LAT)}
_TR.update({ord(c.upper()): t.capitalize() for c, t in zip(_RU, _LAT)})


def _slug_ascii(s: str) -> str:
    """Преобразует строку в безопасный латинский ID."""
    s = s.translate(_TR)
    s = unicodedata.normalize("NFKD", s)
    allowed = set(string.ascii_letters + string.digits + "-_")
    s = "".join(ch if ch in allowed else "_" for ch in s)
    s = re.sub(r"_+", "_", s).strip("_").lower()
    return s or "item"


def _sanitize_menu_ids(node):
    """Рекурсивно заменяет русские буквы в id и у детей."""
    if isinstance(node, dict):
        if "id" in node:
            node["id"] = _slug_ascii(str(node["id"]))
        if "children" in node and isinstance(node["children"], list):
            node["children"] = [_sanitize_menu_ids(ch) for ch in node["children"]]
    return node


ALLOWED_VIDEO = {"mp4", "webm", "ogg"}
TEXT_PREVIEW_EXTS = {".txt", ".md", ".log", ".csv", ".json", ".xml", ".yaml", ".yml", ".ini", ".conf"}
TEXT_PREVIEW_MAX_BYTES = 5 * 1024 * 1024

# один-единственный Blueprint на весь файл
bp = Blueprint("api", __name__)

# ===== MENU ================================================================


@bp.get("/api/menu")
def api_get_menu():
    return jsonify(menu_load())


@bp.post("/api/menu")
def api_set_menu():
    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        abort(400, "invalid json")
    data = _sanitize_menu_ids(data)
    menu_save(data)
    return jsonify({"ok": True})


@bp.post("/api/menu/item")
def api_create_item():
    body = request.get_json(silent=True) or {}
    title = (body.get("title") or "").strip()
    ntype = (body.get("type") or "item").strip()
    parent_id = body.get("parent_id") or "root"

    if not title:
        abort(400, "title is required")
    if ntype not in ("item", "group"):
        abort(400, "bad type")

    menu = menu_load()
    parent = menu_find(menu, parent_id)
    if not parent or parent.get("type") != "group":
        abort(400, "parent must be group")

    new_id = _slug_ascii(body.get("id") or uuid.uuid4().hex)

    node: Dict[str, Any] = {"id": new_id, "title": title, "type": ntype}
    if ntype == "group":
        node["children"] = []
    parent.setdefault("children", []).append(node)
    menu_save(menu)
    return jsonify({"ok": True, "item": node})


@bp.put("/api/menu/item/<item_id>")
def api_update_item(item_id: str):
    body = request.get_json(silent=True) or {}
    menu = menu_load()
    node = menu_find(menu, item_id)
    if not node:
        abort(404, "not found")

    if "title" in body:
        t = (body.get("title") or "").strip()
        if t:
            node["title"] = t

    if "type" in body:
        t = body["type"]
        if t not in ("item", "group"):
            abort(400, "bad type")
        if t == "group" and "children" not in node:
            node["children"] = []
        if t == "item":
            node.pop("children", None)
        node["type"] = t

    if "move_to" in body:
        parent_old = menu_find_parent(menu, item_id)
        parent_new = menu_find(menu, body["move_to"])
        if not parent_new or parent_new.get("type") != "group":
            abort(400, "move_to must be group")
        if parent_old and parent_old is not parent_new:
            menu_remove(menu, item_id)
            parent_new.setdefault("children", []).append(node)

    if "position" in body:
        pos = body["position"]
        if not isinstance(pos, int) or pos < 0:
            abort(400, "bad position")
        parent = menu_find_parent(menu, item_id)
        if not parent:
            abort(400, "no parent")
        children = parent.setdefault("children", [])
        for i, ch in enumerate(children):
            if ch.get("id") == item_id:
                it = children.pop(i)
                break
        else:
            abort(400, "not in parent")
        pos = min(pos, len(children))
        children.insert(pos, it)

    menu_save(menu)
    return jsonify({"ok": True, "item": node})


@bp.delete("/api/menu/item/<item_id>")
def api_delete_item(item_id: str):
    if item_id == "root":
        abort(400, "cannot remove root")
    menu = menu_load()
    if not menu_remove(menu, item_id):
        abort(404, "not found")
    menu_save(menu)
    return jsonify({"ok": True})


# ===== CONTENT =============================================================


@bp.get("/api/content/<item_id>")
def api_get_content(item_id: str):
    return jsonify(content_load(item_id))


@bp.post("/api/content/<item_id>")
def api_save_content(item_id: str):
    payload = request.get_json(silent=True) or {}
    if not isinstance(payload, dict):
        abort(400, "invalid json")
    current = content_load(item_id)

    # базовые поля
    for k in ("title", "text_html", "table"):
        if k in payload:
            current[k] = payload[k]

    # заголовки фиксированных вкладок
    if "description_title" in payload:
        t = (payload["description_title"] or "").strip()
        if t:
            current["description_title"] = t
    if "docs_title" in payload:
        t = (payload["docs_title"] or "").strip()
        if t:
            current["docs_title"] = t

    content_save(item_id, current)
    return jsonify({"ok": True, "item": current})


# ===== FILES ===============================================================


@bp.post("/upload_document")
def upload_document():
    circle_id = request.form.get("circle_id") or request.form.get("block_id") or "unknown"
    fs_files = request.files.getlist("file")
    if not fs_files:
        abort(400, "no files")
    saved = files_save(circle_id, fs_files)
    return jsonify({"ok": True, "saved": saved})


@bp.post("/delete_document")
def delete_document():
    circle_id = request.form.get("circle_id") or (request.json or {}).get("circle_id")
    fname = request.form.get("filename") or (request.json or {}).get("filename")
    if not circle_id or not fname:
        abort(400, "circle_id and filename required")
    if not file_delete(circle_id, fname):
        abort(404, "file not found")
    return jsonify({"ok": True})


@bp.get("/list_drawings")
def list_drawings():
    return jsonify(drawings_list())


@bp.get("/api/text-file")
def api_text_file():
    item_id = (request.args.get("item_id") or "").strip()
    filename = (request.args.get("filename") or "").strip()
    if not item_id or not filename:
        return jsonify(ok=False, error="item_id and filename required"), 400
    if Path(item_id).is_absolute() or ".." in Path(item_id).parts or any(ch in item_id for ch in "\\/"):
        return jsonify(ok=False, error="Недопустимый item_id"), 400
    if Path(filename).is_absolute() or ".." in Path(filename).parts:
        return jsonify(ok=False, error="Недопустимое имя файла"), 400

    ext = Path(filename).suffix.lower()
    if ext not in TEXT_PREVIEW_EXTS:
        return jsonify(ok=False, error="Формат не поддерживается встроенным текстовым просмотрщиком"), 400

    root = files_dir(item_id).resolve()
    target = (root / filename).resolve()
    if root != target and root not in target.parents:
        return jsonify(ok=False, error="Недопустимый путь файла"), 403
    if not target.is_file():
        return jsonify(ok=False, error="Файл не найден"), 404

    size = target.stat().st_size
    if size > TEXT_PREVIEW_MAX_BYTES:
        return jsonify(
            ok=False,
            error="Файл слишком большой для встроенного просмотра",
            size_bytes=size,
            max_size_bytes=TEXT_PREVIEW_MAX_BYTES,
        ), 413

    content, encoding = _read_text_safely(target)
    return jsonify(
        ok=True,
        filename=target.name,
        ext=ext,
        encoding=encoding,
        size_bytes=size,
        line_count=content.count("\n") + (1 if content else 0),
        content=content,
    )


def _read_text_safely(path: Path) -> tuple[str, str]:
    data = path.read_bytes()
    for encoding in ("utf-8-sig", "utf-8", "cp1251", "latin-1"):
        try:
            return data.decode(encoding), encoding
        except UnicodeDecodeError:
            continue
    return data.decode("latin-1", errors="replace"), "latin-1"


# ===== EXPORT ===============================================================


@bp.get("/export/zip")
def export_zip():
    """
    Собрать полный офлайновый пакет справочника и вернуть ZIP.

    Внутри:
      - index.html (режим просмотра)
      - static/ (CSS, JS, изображения, drawings, detectIMG и т.п.)
      - static/uploads/... (документы вкладок)
      - data/menu.json
      - data/contents/<id>.json
    """
    out_root, zip_path = build_export()
    return send_file(zip_path, as_attachment=True, download_name=zip_path.name)


@bp.get("/export/folder")
def export_folder():
    """
    Вспомогательный эндпоинт: вернуть путь к распакованной папке экспорта.
    Удобно для отладки (например, открыть index.html прямо из файловой системы).
    """
    out_root, zip_path = build_export()
    return jsonify({"ok": True, "folder": str(out_root), "zip": str(zip_path)})


# ===== SYNC ================================================================


@bp.get("/api/sync/config")
def sync_config_get():
    svc = get_sync_service()
    cfg = svc.config
    running = bool(svc._thread and svc._thread.is_alive())
    return jsonify(
        {
            "sync_dir": str(cfg.sync_dir),
            "exts": sorted(cfg.exts),
            "interval_sec": cfg.interval_sec,
            "autostart": cfg.autostart,
            "running": running,
        }
    )


@bp.post("/api/sync/config")
def sync_config_set():
    svc = get_sync_service()
    data = request.get_json(force=True, silent=False) or {}
    if "sync_dir" in data:
        from pathlib import Path as _P

        svc.set_sync_dir(_P(data["sync_dir"]).expanduser())
    if "exts" in data and isinstance(data["exts"], list):
        svc.config.exts = {str(e).lower().lstrip(".") for e in data["exts"]}
    if "interval_sec" in data:
        svc.config.interval_sec = int(data["interval_sec"])
    if "autostart" in data:
        svc.config.autostart = bool(data["autostart"])
    return jsonify({"ok": True})


@bp.post("/api/sync/scan")
def sync_scan():
    stats = get_sync_service().scan_once()
    return jsonify({"ok": True, "stats": stats})


@bp.post("/api/sync/start")
def sync_start():
    get_sync_service().start()
    return jsonify({"ok": True, "running": True})


@bp.post("/api/sync/stop")
def sync_stop():
    get_sync_service().stop()
    return jsonify({"ok": True, "running": False})


# ==== EXTRA TABS CRUD ======================================================


def _find_tab(data: Dict[str, Any], tab_id: str) -> Dict[str, Any] | None:
    for t in data.get("extra_tabs", []):
        if t.get("id") == tab_id:
            return t
    return None


@bp.get("/api/content/<item_id>/tabs")
def tabs_list(item_id: str):
    data = content_load(item_id)
    tabs = data.get("extra_tabs", [])
    return jsonify(
        {
            "tabs": [
                {
                    "id": t["id"],
                    "title": t["title"],
                    "view": t.get("view", "html"),
                }
                for t in tabs
            ]
        }
    )


@bp.post("/api/content/<item_id>/tabs")
def tabs_create(item_id: str):
    data = content_load(item_id)
    tabs: List[Dict[str, Any]] = data.get("extra_tabs", [])
    if len(tabs) >= 10:
        abort(400, "limit 10 tabs")

    body = request.get_json(silent=True) or {}
    title = (body.get("title") or "").strip() or "Новая вкладка"

    view = (body.get("view") or "html").strip().lower()
    if view not in ("html", "drawings"):
        view = "html"

    tab = {
        "id": f"tab_{uuid.uuid4().hex[:8]}",
        "title": title,
        "html": "",
        "view": view,
    }
    tabs.append(tab)
    data["extra_tabs"] = tabs
    content_save(item_id, data)
    return jsonify({"ok": True, "tab": tab})


@bp.put("/api/content/<item_id>/tabs/<tab_id>")
def tabs_update(item_id: str, tab_id: str):
    data = content_load(item_id)
    tab = _find_tab(data, tab_id)
    if not tab:
        abort(404, "tab not found")
    body = request.get_json(silent=True) or {}

    if "title" in body:
        t = (body["title"] or "").strip()
        if t:
            tab["title"] = t

    if "html" in body:
        tab["html"] = body["html"] or ""

    if "view" in body:
        v = (body["view"] or "html").strip().lower()
        if v in ("html", "drawings"):
            tab["view"] = v

    content_save(item_id, data)
    return jsonify({"ok": True, "tab": tab})


@bp.delete("/api/content/<item_id>/tabs/<tab_id>")
def tabs_delete(item_id: str, tab_id: str):
    data = content_load(item_id)
    tabs = data.get("extra_tabs", [])
    new_tabs = [t for t in tabs if t.get("id") != tab_id]
    if len(new_tabs) == len(tabs):
        abort(404, "tab not found")
    data["extra_tabs"] = new_tabs
    content_save(item_id, data)
    return jsonify({"ok": True})


@bp.post("/api/content/<item_id>/tabs/reorder")
def tabs_reorder(item_id: str):
    data = content_load(item_id)
    body = request.get_json(silent=True) or {}
    order = body.get("order")
    if not isinstance(order, list):
        abort(400, "order must be list of tab ids")

    existing = {t["id"]: t for t in data.get("extra_tabs", [])}
    new_list: List[Dict[str, Any]] = []
    added = set()

    for tid in order:
        if tid in existing and tid not in added:
            new_list.append(existing[tid])
            added.add(tid)

    # Плюс неупомянутые в хвост (на всякий случай)
    for tid, t in existing.items():
        if tid not in added:
            new_list.append(t)

    if len(new_list) > 10:
        new_list = new_list[:10]

    data["extra_tabs"] = new_list
    content_save(item_id, data)
    return jsonify(
        {
            "ok": True,
            "tabs": [
                {"id": t["id"], "title": t["title"], "view": t.get("view", "html")}
                for t in new_list
            ],
        }
    )


# ===== UPLOAD ASSET ДЛЯ КРУГОВ/БЛОКОВ ======================================


def _unique_path(dst_dir: Path, name: str) -> Path:
    name = secure_filename(name) or "file"
    base = Path(name).stem
    ext = Path(name).suffix
    p = dst_dir / name
    i = 1
    while p.exists():
        p = dst_dir / f"{base} ({i}){ext}"
        i += 1
    return p


@bp.route("/upload_asset", methods=["POST"])
def upload_asset():
    circle_id = (request.form.get("circle_id") or "").strip()
    file = request.files.get("file")
    if not circle_id or not file:
        return jsonify(ok=False, error="circle_id and file required"), 400

    ext = (Path(file.filename).suffix or "").lstrip(".").lower()
    if ext not in (ALLOWED_VIDEO | {"jpg", "jpeg", "png", "gif", "webp", "svg"}):
        return jsonify(ok=False, error=f"ext '{ext}' not allowed"), 400

    safe_id = secure_filename(circle_id) or "unknown"
    dst_dir = UPLOADS_DIR / safe_id / "_assets"
    dst_dir.mkdir(parents=True, exist_ok=True)

    path = _unique_path(dst_dir, file.filename)
    file.save(path)

    # Отдаём прямой URL, но НЕ добавляем в model.files
    return jsonify(
        ok=True,
        url=f"/static/uploads/{safe_id}/_assets/{path.name}",
        name=path.name,
    )
