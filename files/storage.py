# files/storage.py
from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Dict, List, Optional

from werkzeug.utils import secure_filename

from .paths import DATA_DIR, CONTENTS_DIR, UPLOADS_DIR, DRAWINGS_DIR
from .db import get_db

# Нужен для совместимости со старым кодом (export.py и т.п.)
MENU_JSON: Path = DATA_DIR / "menu.json"


def menu_default() -> Dict[str, Any]:
    """
    Базовый корень меню, если в БД ещё ничего нет.
    """
    return {
        "id": "root",
        "title": "Корень меню",
        "type": "group",
        "children": [],
    }


# ===================== МЕНЮ (SQLite) =====================


def _load_menu_rows() -> List[Dict[str, Any]]:
    conn = get_db()
    cur = conn.cursor()
    cur.execute(
        """
        SELECT id, title, type, parent_id, position, enabled
        FROM menu_items
        ORDER BY parent_id IS NOT NULL, parent_id, position, title
        """
    )
    return list(cur.fetchall())


def _build_menu_tree(rows: List[Dict[str, Any]]) -> Dict[str, Any]:
    """
    Собираем древовидное меню из плоских строк БД.
    """
    if not rows:
        return menu_default()

    nodes: Dict[str, Dict[str, Any]] = {}
    children_map: Dict[Optional[str], List[str]] = {}

    for r in rows:
        node_id = r["id"]
        node: Dict[str, Any] = {
            "id": node_id,
            "title": r["title"],
            "type": r["type"],
        }
        if r["type"] == "group":
            node["children"] = []
        if r.get("enabled") is not None:
            node["enabled"] = bool(r["enabled"])
        nodes[node_id] = node

        parent_id = r["parent_id"]
        children_map.setdefault(parent_id, []).append(node_id)

    # навешиваем детей на родителей
    for parent_id, ids in children_map.items():
        if parent_id is None:
            continue
        parent = nodes.get(parent_id)
        if not parent:
            continue
        ch_list = parent.setdefault("children", [])
        for cid in ids:
            child = nodes.get(cid)
            if child:
                ch_list.append(child)

    # формируем корень
    root_children_ids = children_map.get(None) or []
    root_children = [nodes[cid] for cid in root_children_ids if cid in nodes]
    root = menu_default()
    root["children"] = root_children
    return root


def menu_load() -> Dict[str, Any]:
    """
    Загрузить дерево меню из БД.
    """
    rows = _load_menu_rows()
    return _build_menu_tree(rows)


def _flatten_menu(node: Dict[str, Any], parent_id: Optional[str]) -> List[Dict[str, Any]]:
    """
    Превращаем дерево в список строк для записи в БД.
    """
    out: List[Dict[str, Any]] = []
    children = node.get("children") or []
    for pos, ch in enumerate(children):
        item = {
            "id": ch["id"],
            "title": ch.get("title") or "",
            "type": ch.get("type") or "item",
            "parent_id": parent_id,
            "position": pos,
            "enabled": 1 if ch.get("enabled", True) else 0,
        }
        out.append(item)
        if ch.get("type") == "group":
            out.extend(_flatten_menu(ch, ch["id"]))
    return out


def menu_save(menu: Dict[str, Any]) -> None:
    """
    Сохранить дерево меню в БД.
    """
    items = _flatten_menu(menu, None)
    conn = get_db()
    cur = conn.cursor()

    # удаляем узлы, которых больше нет в дереве
    new_ids = {it["id"] for it in items}
    cur.execute("SELECT id FROM menu_items")
    old_ids = {row["id"] for row in cur.fetchall()}
    to_delete = old_ids - new_ids
    if to_delete:
        cur.executemany(
            "DELETE FROM menu_items WHERE id = ?",
            [(i,) for i in to_delete],
        )

    # upsert по каждому элементу меню
    for it in items:
        cur.execute(
            """
            INSERT INTO menu_items (id, title, type, parent_id, position, enabled)
            VALUES (:id, :title, :type, :parent_id, :position, :enabled)
            ON CONFLICT(id) DO UPDATE SET
              title = excluded.title,
              type = excluded.type,
              parent_id = excluded.parent_id,
              position = excluded.position,
              enabled = excluded.enabled
            """,
            it,
        )

    conn.commit()


def menu_find(node: Dict[str, Any], node_id: str) -> Optional[Dict[str, Any]]:
    """
    Поиск узла в уже собранном дереве меню.
    """
    if node.get("id") == node_id:
        return node
    for ch in node.get("children", []) or []:
        hit = menu_find(ch, node_id)
        if hit:
            return hit
    return None


def menu_find_parent(
    node: Dict[str, Any],
    child_id: str,
    parent: Optional[Dict[str, Any]] = None,
) -> Optional[Dict[str, Any]]:
    """
    Поиск родителя по id ребёнка в дереве.
    """
    if node.get("id") == child_id:
        return parent
    for ch in node.get("children", []) or []:
        hit = menu_find_parent(ch, child_id, node)
        if hit:
            return hit
    return None


def menu_remove(node: Dict[str, Any], node_id: str) -> bool:
    """
    Удалить узел по id из дерева (в памяти).
    """
    children = node.get("children", []) or []
    for i, ch in enumerate(children):
        if ch.get("id") == node_id:
            children.pop(i)
            return True
        if menu_remove(ch, node_id):
            return True
    return False


# ===================== КОНТЕНТ (SQLite) =====================


def _ensure_content_shape(raw: Dict[str, Any]) -> Dict[str, Any]:
    """
    Гарантируем, что у контента есть все нужные поля.
    """
    raw = dict(raw or {})
    raw.setdefault("text_html", "")
    raw.setdefault(
        "table_json",
        json.dumps({"columns": [], "rows": []}, ensure_ascii=False),
    )
    raw.setdefault("description_title", "Описание")
    raw.setdefault("docs_title", "Документы")
    return raw


def content_load(item_id: str) -> Dict[str, Any]:
    """
    Загрузить контент раздела из БД (или создать пустой, если ещё нет).
    """
    conn = get_db()
    cur = conn.cursor()

    # проверяем, что раздел существует в меню
    cur.execute("SELECT id, title FROM menu_items WHERE id = ?", (item_id,))
    row = cur.fetchone()
    if not row:
        return {
            "id": item_id,
            "title": "(неизвестный раздел)",
            "text_html": "",
            "table": {"columns": [], "rows": []},
            "description_title": "Описание",
            "docs_title": "Документы",
            "extra_tabs": [],
            "files": [],
        }

    # пробуем найти уже сохранённый контент
    cur.execute(
        """
        SELECT item_id, title, text_html, table_json,
               description_title, docs_title
        FROM contents
        WHERE item_id = ?
        """,
        (item_id,),
    )
    c = cur.fetchone()
    if not c:
        content = {
            "item_id": item_id,
            "title": row["title"],
            "text_html": "",
            "table_json": json.dumps(
                {"columns": [], "rows": []},
                ensure_ascii=False,
            ),
            "description_title": "Описание",
            "docs_title": "Документы",
        }
        cur.execute(
            """
            INSERT INTO contents (
                item_id, title, text_html,
                table_json, description_title, docs_title
            )
            VALUES (:item_id, :title, :text_html,
                    :table_json, :description_title, :docs_title)
            """,
            content,
        )
        conn.commit()
        c = content
    else:
        c = dict(c)

    # подгружаем дополнительные вкладки
    cur.execute(
        """
        SELECT id, title, kind, html, view, position
        FROM extra_tabs
        WHERE item_id = ?
        ORDER BY position, title
        """,
        (item_id,),
    )
    tabs = list(cur.fetchall())

    base = _ensure_content_shape(c)
    result: Dict[str, Any] = {
        "id": item_id,
        "title": base["title"],
        "text_html": base["text_html"],
        "table": json.loads(base["table_json"] or "{}"),
        "description_title": base["description_title"],
        "docs_title": base["docs_title"],
        "extra_tabs": [
            {
                "id": t["id"],
                "title": t["title"],
                "kind": t["kind"],
                "html": t.get("html") or "",
                "view": t.get("view"),
            }
            for t in tabs
        ],
        # файлы пока остаются файловыми, а не в БД
        "files": files_list(item_id),
    }
    return result


def content_save(item_id: str, payload: Dict[str, Any]) -> None:
    """
    Сохранить контент раздела в БД + синхронизировать дополнительные вкладки (extra_tabs).
    """
    conn = get_db()
    cur = conn.cursor()

    # 1. Гарантируем, что раздел есть в menu_items
    cur.execute("SELECT id FROM menu_items WHERE id = ?", (item_id,))
    row = cur.fetchone()

    if not row:
        # Если раздела нет в меню — создаём его минимальный узел в корне
        title = (payload.get("title") or "").strip() or "(без названия)"

        # Позиция в корне: последняя + 1
        cur.execute(
            """
            SELECT COALESCE(MAX(position) + 1, 0) AS pos
            FROM menu_items
            WHERE parent_id IS NULL
            """
        )
        pos_row = cur.fetchone() or {}
        pos = pos_row.get("pos", 0)

        cur.execute(
            """
            INSERT INTO menu_items (id, title, type, parent_id, position, enabled)
            VALUES (?, ?, 'item', NULL, ?, 1)
            """,
            (item_id, title, pos),
        )

    # 2. Сохраняем основной контент в таблицу contents
    table_json = json.dumps(
        payload.get("table") or {"columns": [], "rows": []},
        ensure_ascii=False,
    )

    cur.execute(
        """
        INSERT INTO contents (
            item_id, title, text_html,
            table_json, description_title, docs_title
        )
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(item_id) DO UPDATE SET
          title = excluded.title,
          text_html = excluded.text_html,
          table_json = excluded.table_json,
          description_title = excluded.description_title,
          docs_title = excluded.docs_title
        """,
        (
            item_id,
            payload.get("title") or "",
            payload.get("text_html") or "",
            table_json,
            payload.get("description_title") or "Описание",
            payload.get("docs_title") or "Документы",
        ),
    )

    # 3. Синхронизируем дополнительные вкладки с таблицей extra_tabs
    tabs = payload.get("extra_tabs")
    if tabs is not None:
        tabs = list(tabs)

        # какие вкладки уже есть в БД
        cur.execute(
            "SELECT id FROM extra_tabs WHERE item_id = ?",
            (item_id,),
        )
        old_ids = {row["id"] for row in cur.fetchall()}

        # какие вкладки должны остаться
        new_ids = {str(t.get("id")) for t in tabs if t.get("id")}

        # удалить лишние
        to_delete = old_ids - new_ids
        if to_delete:
            cur.executemany(
                "DELETE FROM extra_tabs WHERE id = ?",
                [(tid,) for tid in to_delete],
            )

        # upsert по каждой вкладке
        for idx, t in enumerate(tabs):
            tab_id = (t.get("id") or "").strip()
            if not tab_id:
                tab_id = f"tab_{uuid.uuid4().hex[:8]}"
                t["id"] = tab_id  # на всякий случай возвращаем id в payload

            title = (t.get("title") or "").strip() or "Вкладка"

            view = (t.get("view") or "html") or "html"
            view = view.strip().lower()
            if view not in ("html", "drawings"):
                view = "html"

            # kind — более "грубый" тип вкладки для БД
            kind = (t.get("kind") or "").strip().lower()
            if not kind:
                kind = "drawing" if view == "drawings" else "html"

            html = t.get("html") or ""

            cur.execute(
                """
                INSERT INTO extra_tabs (
                  id, item_id, title, kind, html, view, position
                )
                VALUES (?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                  title = excluded.title,
                  kind = excluded.kind,
                  html = excluded.html,
                  view = excluded.view,
                  position = excluded.position
                """,
                (tab_id, item_id, title, kind, html, view, idx),
            )

    conn.commit()
# ===================== ФАЙЛЫ РАЗДЕЛОВ (на диске) =====================


def files_dir(item_id: str) -> Path:
    """
    Папка для файлов, привязанных к разделу/вкладке.
    """
    d = UPLOADS_DIR / secure_filename(item_id)
    d.mkdir(parents=True, exist_ok=True)
    return d

def _unique_filename(folder: Path, filename: str) -> Path:
    base = Path(filename).stem
    ext = Path(filename).suffix
    candidate = folder / filename
    counter = 1

    while candidate.exists():
        candidate = folder / f"{base} ({counter}){ext}"
        counter += 1

    return candidate

def files_save(item_id: str, fs_files) -> List[str]:
    """
    Сохранить загруженные файлы (из request.files) для раздела.
    Если файл с таким именем уже есть — создаём уникальное имя.
    """
    saved: List[str] = []
    d = files_dir(item_id)

    for f in fs_files:
        if not f.filename:
            continue

        name = secure_filename(f.filename)
        if not name:
            continue

        target = _unique_filename(d, name)
        f.save(str(target))
        saved.append(target.name)

    return saved


def file_delete(item_id: str, filename: str) -> bool:
    """
    Удалить конкретный файл, привязанный к разделу.
    """
    d = files_dir(item_id)
    f = d / filename
    if f.is_file():
        f.unlink()
        return True
    return False


def files_list(item_id: str) -> List[Dict[str, Any]]:
    """
    Список файлов раздела с размерами и URL для фронта.
    """
    d = files_dir(item_id)
    out: List[Dict[str, Any]] = []
    for f in sorted(d.iterdir()):
        if f.is_file():
            out.append(
                {
                    "name": f.name,
                    "size": f.stat().st_size,
                    "url": f"/static/uploads/{d.name}/{f.name}",
                }
            )
    return out


# ===================== ЧЕРТЕЖИ (пока старый файловый список) =====================


def drawings_list() -> List[Dict[str, str]]:
    """
    Старый способ: список чертежей по картинкам в STATIC_DIR/state/drawings.
    Если чертежи уже переехали в БД, можно переписать эту функцию
    под выборку из таблицы drawings.
    """
    items: List[Dict[str, str]] = []
    if not DRAWINGS_DIR.exists():
        return items

    for i, p in enumerate(sorted(DRAWINGS_DIR.iterdir())):
        if p.is_file() and p.suffix.lower() in {
            ".png",
            ".jpg",
            ".jpeg",
            ".gif",
            ".webp",
            ".svg",
        }:
            items.append(
                {
                    "drawing_id": f"d{i + 1}",
                    "drawing_name": p.name,
                    "display_name": p.stem,
                }
            )
    return items