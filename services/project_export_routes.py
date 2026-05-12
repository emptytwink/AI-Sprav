from __future__ import annotations

import io
import json
import mimetypes
import re
import sqlite3
import tempfile
from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED

from flask import Blueprint, request, send_file

from files.storage import menu_load, content_load, files_dir
from files.paths import STATIC_DIR, UPLOADS_DIR
from files.db import get_db
from utils.json_utils import read_json
from services.doc_convert import convert_doc_to_pdf, DocConvertError

bp_project_export = Blueprint("project_export", __name__)

IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".webp", ".gif"}


def _natural_key(s: str):
    s = (s or "").strip()
    return [int(t) if t.isdigit() else t.casefold() for t in re.split(r"(\d+)", s)]


def _safe_json_dumps(data, *, indent: int | None = None) -> str:
    return json.dumps(data, ensure_ascii=False, indent=indent)


def _normalize_rel_path(value: str) -> str:
    return str(value or "").replace("\\", "/").lstrip("/").strip()


# ===================== ОБЩИЕ HELPERS =====================

def _prepare_export_doc_file(src_file: Path, tmp_dir: Path) -> tuple[Path, str, str | None]:
    """
    Подготавливает файл документа для экспорта.

    Правила:
    - обычные файлы экспортируются как есть
    - doc/docx пытаемся конвертировать в pdf
    - если конвертация не удалась, экспортируем исходник
    """
    file_name = src_file.name
    src_ext = src_file.suffix.lower()

    out_path = src_file
    out_name = file_name
    out_mime = mimetypes.guess_type(file_name)[0]

    if src_ext in {".doc", ".docx"}:
        try:
            pdf = convert_doc_to_pdf(src_file, tmp_dir)
            out_path = pdf
            out_name = f"{src_file.stem}.pdf"
            out_mime = "application/pdf"
        except DocConvertError:
            out_path = src_file
            out_name = file_name
            out_mime = mimetypes.guess_type(file_name)[0]

    return out_path, out_name, out_mime


def _find_existing_circle_file(
    tab_id: str,
    circle_id: str,
    raw_name_or_relpath: str,
) -> tuple[Path | None, str | None]:
    """
    Ищем файл круга.

    Главный реальный источник для текущего проекта:
      static/<tab_id>/uploads/<filename>

    Дополнительные fallback:
      static/<tab_id>/<relative_path>
      data/uploads/<relative_path>
      data/uploads/<filename>
      data/uploads/<circle_id>/<filename>
      data/uploads/<tab_id>/<filename>
      data/uploads/<tab_id>/<circle_id>/<filename>

    Возвращает:
      (absolute_path, base_name) или (None, None)
    """
    raw_value = _normalize_rel_path(raw_name_or_relpath)
    if not raw_value:
        return None, None

    base_name = Path(raw_value).name
    if not base_name:
        return None, None

    candidates: list[Path] = []

    # 1. Основная реальная схема: static/<tab_id>/uploads/<filename>
    candidates.append((STATIC_DIR / tab_id / "uploads" / base_name).resolve())

    # 2. Если в JSON/БД уже лежит относительный путь
    if "/" in raw_value:
        candidates.append((STATIC_DIR / tab_id / raw_value).resolve())
        candidates.append((UPLOADS_DIR / raw_value).resolve())

    # 3. Fallback по data/uploads
    candidates.append((UPLOADS_DIR / base_name).resolve())
    candidates.append((UPLOADS_DIR / circle_id / base_name).resolve())
    candidates.append((UPLOADS_DIR / tab_id / base_name).resolve())
    candidates.append((UPLOADS_DIR / tab_id / circle_id / base_name).resolve())

    for candidate in candidates:
        if candidate.is_file():
            return candidate, base_name

    # 4. Рекурсивный поиск в static/<tab_id>/uploads
    static_uploads_root = (STATIC_DIR / tab_id / "uploads").resolve()
    if static_uploads_root.exists():
        hit = next(
            (p for p in static_uploads_root.rglob("*") if p.is_file() and p.name == base_name),
            None,
        )
        if hit:
            return hit.resolve(), base_name

    # 5. Рекурсивный поиск в data/uploads
    uploads_root = UPLOADS_DIR.resolve()
    if uploads_root.exists():
        hit = next(
            (p for p in uploads_root.rglob("*") if p.is_file() and p.name == base_name),
            None,
        )
        if hit:
            return hit.resolve(), base_name

    return None, None


# ===================== МЕНЮ =====================

def _build_menu_dto(project: str) -> dict:
    raw_menu = menu_load()

    def convert_node(node: dict, parent_id: str | None) -> dict:
        slug = str(node.get("id") or "").strip()
        ntype = node.get("type") or "item"
        title = node.get("title") or "(без названия)"
        enabled = bool(node.get("enabled", True))

        children_src = node.get("children") or []
        children_dto = [convert_node(ch, slug or None) for ch in children_src]

        return {
            "id": slug,
            "parentId": parent_id,
            "type": ntype,
            "title": title,
            "enabled": enabled,
            "children": children_dto,
        }

    items = [convert_node(ch, None) for ch in raw_menu.get("children", [])]
    return {"children": items}


def _menu_id_to_title() -> dict[str, str]:
    menu = menu_load()
    out: dict[str, str] = {}

    def walk(n: dict):
        sid = str(n.get("id") or "").strip()
        if sid:
            out[sid] = str(n.get("title") or sid)
        for ch in n.get("children") or []:
            walk(ch)

    for ch in menu.get("children") or []:
        walk(ch)
    return out


def _iter_menu_nodes() -> list[dict]:
    menu = menu_load()
    out: list[dict] = []

    def walk(node: dict):
        out.append(node)
        for ch in node.get("children") or []:
            walk(ch)

    for ch in menu.get("children") or []:
        walk(ch)
    return out


# ===================== КОНТЕНТ + ДОКИ =====================

def _build_content_dto_for_slug(slug: str) -> dict | None:
    raw = content_load(slug) or {}
    upload_dir = files_dir(slug)

    docs: list[dict] = []
    tmp_dir_obj = tempfile.TemporaryDirectory(prefix="export_docs_single_")
    tmp_dir = Path(tmp_dir_obj.name)

    try:
        if upload_dir.exists():
            for f in sorted(upload_dir.iterdir()):
                if not f.is_file():
                    continue

                file_name = f.name
                if file_name.startswith("~$"):
                    continue

                out_path, out_name, out_mime = _prepare_export_doc_file(f, tmp_dir)
                size_bytes = out_path.stat().st_size

                docs.append(
                    {
                        "file_name": out_name,
                        "display_name": out_name,
                        "size_bytes": size_bytes,
                        "mime_type": out_mime,
                    }
                )
    finally:
        tmp_dir_obj.cleanup()

    has_text = bool(raw.get("text_html") or raw.get("table") or raw.get("extra_tabs"))
    has_docs = bool(docs)

    if not (has_text or has_docs):
        return None

    return {
        "id": raw.get("id") or slug,
        "title": raw.get("title") or slug,
        "description_title": raw.get("description_title") or "Описание",
        "docs_title": raw.get("docs_title") or "Документация",
        "text_html": raw.get("text_html") or "",
        "table": raw.get("table") or [],
        "extra_tabs": raw.get("extra_tabs") or [],
        "files": docs,
    }


def _collect_content_and_docs(zf: ZipFile) -> None:
    menu = menu_load()
    exported_docs: set[str] = set()

    with tempfile.TemporaryDirectory(prefix="export_docs_") as tmp:
        tmp_dir = Path(tmp)

        def export_for_node(node: dict) -> None:
            slug = str(node.get("id") or "").strip()

            if slug:
                raw = content_load(slug) or {}
                upload_dir = files_dir(slug)

                docs: list[dict] = []
                if upload_dir.exists():
                    for f in sorted(upload_dir.iterdir()):
                        if not f.is_file():
                            continue

                        file_name = f.name
                        if file_name.startswith("~$"):
                            continue

                        out_path, out_name, out_mime = _prepare_export_doc_file(f, tmp_dir)
                        size_bytes = out_path.stat().st_size

                        docs.append(
                            {
                                "file_name": out_name,
                                "display_name": out_name,
                                "size_bytes": size_bytes,
                                "mime_type": out_mime,
                            }
                        )

                        if out_name not in exported_docs:
                            exported_docs.add(out_name)
                            zf.write(out_path, f"docs/{out_name}")

                has_text = bool(raw.get("text_html") or raw.get("table") or raw.get("extra_tabs"))
                has_docs = bool(docs)

                if has_text or has_docs:
                    content_dto = {
                        "id": raw.get("id") or slug,
                        "title": raw.get("title") or slug,
                        "description_title": raw.get("description_title") or "Описание",
                        "docs_title": raw.get("docs_title") or "Документация",
                        "text_html": raw.get("text_html") or "",
                        "table": raw.get("table") or [],
                        "extra_tabs": raw.get("extra_tabs") or [],
                        "files": docs,
                    }

                    zf.writestr(
                        f"contents/{slug}.json",
                        _safe_json_dumps(content_dto),
                    )

            for ch in node.get("children") or []:
                export_for_node(ch)

        for ch in menu.get("children") or []:
            export_for_node(ch)


# ===================== ЧЕРТЕЖИ: поиск вкладок =====================

def _iter_tabs_with_drawings(project_id: str | None = None) -> list[tuple[str, Path]]:
    """
    ВАЖНО:
    project_id из синка (например osp) не обязан совпадать с tab_id, где реально лежат чертежи
    (например item_mfcv3op8).

    Поэтому здесь собираем ВСЕ вкладки с чертежами.
    """
    out: list[tuple[str, Path]] = []

    if not STATIC_DIR.exists():
        return out

    for tab_dir in sorted(STATIC_DIR.iterdir()):
        if not tab_dir.is_dir():
            continue

        tab_id = tab_dir.name
        drawings_dir = tab_dir / "state" / "drawings"
        if drawings_dir.is_dir():
            out.append((tab_id, drawings_dir))

    return out


def _load_captions(drawings_dir: Path) -> dict[str, str]:
    cap = drawings_dir / "captions.json"
    if not cap.is_file():
        return {}
    try:
        raw = json.loads(cap.read_text(encoding="utf-8"))
        if isinstance(raw, dict):
            return {str(k): str(v) for k, v in raw.items()}
    except Exception:
        pass
    return {}


def _index_state_by_drawing_name(drawings_dir: Path) -> dict[str, tuple[str, Path, dict]]:
    out: dict[str, tuple[str, Path, dict]] = {}

    for p in sorted(drawings_dir.iterdir()):
        if not p.is_file():
            continue
        if p.suffix.lower() != ".json":
            continue
        if p.name == "captions.json":
            continue

        data = read_json(p) or {}
        dn = data.get("drawing_name")
        did = data.get("drawing_id")

        if isinstance(dn, str) and dn.strip() and isinstance(did, str) and did.strip():
            out[Path(dn).name] = (did.strip(), p, data)

    return out


# ===================== ФАЙЛЫ КРУГОВ =====================

def _write_circle_uploads_flat(
    zf: ZipFile,
    tab_id: str,
    used_state_jsons: list[dict],
) -> None:
    """
    В zip кладём файлы кругов в виде:
      drawings/uploads/<circleId>/<filename>
    """
    written: set[str] = set()

    for st in used_state_jsons:
        files_obj = st.get("files") or {}
        if not isinstance(files_obj, dict):
            continue

        for circle_id, file_list in files_obj.items():
            if not circle_id or not isinstance(file_list, list):
                continue

            cid = str(circle_id)

            for fn in file_list:
                if not isinstance(fn, str):
                    continue

                src, base_name = _find_existing_circle_file(
                    tab_id=tab_id,
                    circle_id=cid,
                    raw_name_or_relpath=fn,
                )
                if not src or not base_name:
                    continue

                zip_rel = f"drawings/uploads/{cid}/{base_name}"
                if zip_rel in written:
                    continue

                written.add(zip_rel)
                zf.write(src, zip_rel)


def _resolve_display_name(
    tab_title: str,
    orig_name: str,
    orig_stem: str,
    captions: dict[str, str],
    state_data: dict | None,
) -> str:
    if state_data and isinstance(state_data, dict):
        dn = state_data.get("display_name")
        if isinstance(dn, str) and dn.strip():
            return dn.strip()

    display = captions.get(orig_name) or captions.get(orig_stem) or orig_stem
    return f"{tab_title}: {display}"


# ===================== state-json из БД =====================

def _build_state_from_db(tab_id: str, drawing_id: str, drawing_name: str) -> dict | None:
    """
    tab_id здесь — это id вкладки, например item_mfcv3op8.

    В files кладём все привязанные к кругу файлы, а не только PNG.
    """
    conn = get_db()
    cur = conn.cursor()

    cur.execute(
        """
        SELECT id
        FROM drawings
        WHERE project = ? AND id = ?
        """,
        (tab_id, drawing_id),
    )
    row = cur.fetchone()
    if not row:
        return None

    drawing_pk = row["id"]

    cur.execute(
        """
        SELECT id, circle_key, x, y, radius
        FROM circles
        WHERE drawing_id = ?
        ORDER BY id
        """,
        (drawing_pk,),
    )
    circle_rows = cur.fetchall()
    if not circle_rows:
        return None

    circles: list[dict] = []
    id_to_pk: dict[str, int] = {}

    for idx, c in enumerate(circle_rows, start=1):
        key = str(c.get("circle_key") or f"c{idx}")
        id_to_pk[key] = int(c["id"])
        circles.append(
            {
                "id": key,
                "x": float(c.get("x") or 0.0),
                "y": float(c.get("y") or 0.0),
                "radius": float(c.get("radius") or 0.0),
            }
        )

    files_map: dict[str, list[str]] = {}

    if id_to_pk:
        placeholders = ",".join("?" for _ in id_to_pk.values())
        cur.execute(
            f"""
            SELECT circle_id, filename
            FROM circle_files
            WHERE circle_id IN ({placeholders})
            ORDER BY id
            """,
            tuple(id_to_pk.values()),
        )

        pk_to_key = {pk: key for key, pk in id_to_pk.items()}

        for row in cur.fetchall():
            circle_id_fk = row["circle_id"]
            filename = row["filename"]
            if not filename:
                continue

            circle_key = pk_to_key.get(circle_id_fk)
            if not circle_key:
                continue

            normalized = _normalize_rel_path(filename)
            base_name = Path(normalized).name
            if not base_name:
                continue

            files_map.setdefault(circle_key, []).append(base_name)

    state: dict = {
        "drawing_id": drawing_id,
        "drawing_name": drawing_name,
        "circles": circles,
    }
    if files_map:
        state["files"] = files_map
    return state


# ===================== ЧЕРТЕЖИ: экспорт =====================

def _write_drawings(zf: ZipFile, project_id: str) -> None:
    """
    project_id — это id проекта для Android-индекса (например osp),
    но реальные чертежи могут лежать в отдельных вкладках вида item_mfcv3op8.

    Поэтому:
    - собираем ВСЕ вкладки с чертежами
    - индекс сохраняем как drawings/<project_id>.json
    """
    tabs = _iter_tabs_with_drawings(None)
    id2title = _menu_id_to_title()

    drawings_index: list[dict] = []

    for tab_id, drawings_dir in tabs:
        captions = _load_captions(drawings_dir)
        tab_title = id2title.get(tab_id, tab_id)

        state_map = _index_state_by_drawing_name(drawings_dir)

        images: list[Path] = []
        for p in sorted(drawings_dir.iterdir()):
            if not p.is_file():
                continue
            if p.name == "captions.json":
                continue
            if p.suffix.lower() in IMAGE_EXTS:
                images.append(p)

        used_state_jsons_for_tab: list[dict] = []

        for img in images:
            orig_name = img.name
            orig_stem = img.stem

            state_data: dict | None = None
            state_path: Path | None = None

            if orig_name in state_map:
                drawing_id_from_state, state_path, state_data = state_map[orig_name]
                drawing_id = drawing_id_from_state
            else:
                drawing_id = orig_stem
                state_data = _build_state_from_db(
                    tab_id=tab_id,
                    drawing_id=drawing_id,
                    drawing_name=orig_name,
                )

            new_stem = f"{tab_id}__{drawing_id}"
            new_name = f"{new_stem}{img.suffix.lower()}"

            display_name = _resolve_display_name(
                tab_title=tab_title,
                orig_name=orig_name,
                orig_stem=orig_stem,
                captions=captions,
                state_data=state_data or {},
            )

            drawings_index.append(
                {
                    "drawing_id": new_stem,
                    "display_name": display_name,
                    "drawing_name": new_name,
                }
            )

            zf.write(img, f"drawings/{new_name}")
            zf.write(img, f"drawings/previews/{new_name}")

            if state_path and state_path.is_file():
                zf.write(state_path, f"drawings/state/drawing_{new_stem}.json")
                zf.write(state_path, f"drawings/state/{new_stem}.json")
                zf.write(state_path, f"drawings/hotspots/{new_stem}.json")
                zf.write(state_path, f"drawings/circles/{new_stem}.json")
                if state_data:
                    used_state_jsons_for_tab.append(state_data)
            elif state_data:
                payload = _safe_json_dumps(state_data)
                zf.writestr(f"drawings/state/drawing_{new_stem}.json", payload)
                zf.writestr(f"drawings/state/{new_stem}.json", payload)
                zf.writestr(f"drawings/hotspots/{new_stem}.json", payload)
                zf.writestr(f"drawings/circles/{new_stem}.json", payload)
                used_state_jsons_for_tab.append(state_data)

        _write_circle_uploads_flat(zf, tab_id, used_state_jsons_for_tab)

    drawings_index.sort(key=lambda it: _natural_key(it.get("display_name") or ""))

    zf.writestr(
        f"drawings/{project_id}.json",
        _safe_json_dumps(drawings_index).encode("utf-8"),
    )


# ===================== SQLite для планшета =====================

def _build_offline_db(project: str) -> Path:
    tmp_dir = Path(tempfile.mkdtemp(prefix="export_db_"))
    db_path = tmp_dir / "offline.db"

    conn = sqlite3.connect(db_path)
    cur = conn.cursor()
    cur.execute(
        "CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)"
    )

    menu_dto = _build_menu_dto(project)
    cur.execute(
        "INSERT OR REPLACE INTO kv(key, value) VALUES (?, ?)",
        (f"menu:{project}", _safe_json_dumps(menu_dto)),
    )

    for node in _iter_menu_nodes():
        slug = str(node.get("id") or "").strip()
        if not slug:
            continue
        dto = _build_content_dto_for_slug(slug)
        if not dto:
            continue
        cur.execute(
            "INSERT OR REPLACE INTO kv(key, value) VALUES (?, ?)",
            (f"content:{slug}", _safe_json_dumps(dto)),
        )

    conn.commit()
    conn.close()
    return db_path


# ===================== HTTP =====================

@bp_project_export.route("/export/project_data")
def export_project_data():
    project = (request.args.get("project") or "").strip() or "home"

    db_path = _build_offline_db(project)

    mem = io.BytesIO()
    with ZipFile(mem, "w", ZIP_DEFLATED) as zf:
        zf.write(db_path, "offline.db")

        menu_dto = _build_menu_dto(project)
        menu_json = _safe_json_dumps(menu_dto, indent=2)

        zf.writestr(f"menus/{project}.json", menu_json)
        zf.writestr("menu.json", menu_json)

        _collect_content_and_docs(zf)
        _write_drawings(zf, project)

    mem.seek(0)
    return send_file(
        mem,
        mimetype="application/zip",
        as_attachment=True,
        download_name=f"project_data_{project}.zip",
    )