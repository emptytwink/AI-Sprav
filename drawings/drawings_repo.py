from __future__ import annotations
from typing import List, Dict, Any

from files.db import get_db


def save_drawing_with_circles(
    *,
    project: str,
    drawing_id: str,
    original_name: str,
    image_path: str,
    processed_image_path: str | None,
    circles: List[Dict[str, Any]],
) -> None:
    """
    Сохранение чертежа и всех его кругов в одной транзакции.
    Если drawing_id уже есть — обновляем запись.
    """
    conn = get_db()
    cur = conn.cursor()

    cur.execute(
        """
        INSERT INTO drawings (id, project, name, image_path, processed_image_path)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          project = excluded.project,
          name = excluded.name,
          image_path = excluded.image_path,
          processed_image_path = excluded.processed_image_path
        """,
        (drawing_id, project, original_name, image_path, processed_image_path),
    )

    # Пересоздаём круги для этого чертежа
    cur.execute("DELETE FROM circles WHERE drawing_id = ?", (drawing_id,))
    for c in circles:
        cur.execute(
            """
            INSERT INTO circles (drawing_id, circle_key, x, y, radius)
            VALUES (?, ?, ?, ?, ?)
            """,
            (
                drawing_id,
                c.get("id"),
                float(c.get("x", 0)),
                float(c.get("y", 0)),
                float(c.get("radius", 0)),
            ),
        )

    conn.commit()


def list_project_drawings(project: str) -> List[Dict[str, Any]]:
    """
    Список всех чертежей по проекту (item_id / tab_id).
    """
    conn = get_db()
    cur = conn.cursor()
    cur.execute(
        """
        SELECT id, name, COALESCE(display_name, name) AS display_name,
               image_path, processed_image_path
        FROM drawings
        WHERE project = ?
        ORDER BY id
        """,
        (project,),
    )
    return [dict(row) for row in cur.fetchall()]


def get_drawing(drawing_id: str, project: str | None = None) -> Dict[str, Any] | None:
    """
    Загрузка одного чертежа + круги + файлы в кругах.
    """
    conn = get_db()
    cur = conn.cursor()
    if project:
        cur.execute(
            """
            SELECT id, project, name, display_name, image_path, processed_image_path
            FROM drawings
            WHERE id = ? AND project = ?
            """,
            (drawing_id, project),
        )
    else:
        cur.execute(
            """
            SELECT id, project, name, display_name, image_path, processed_image_path
            FROM drawings
            WHERE id = ?
            """,
            (drawing_id,),
        )
    row = cur.fetchone()
    if not row:
        return None

    drawing = dict(row)

    # Круги
    cur.execute(
        """
        SELECT id, circle_key, x, y, radius
        FROM circles
        WHERE drawing_id = ?
        ORDER BY id
        """,
        (drawing_id,),
    )
    circles = [dict(circle_row) for circle_row in cur.fetchall()]

    # Файлы, привязанные к кругам
    cur.execute(
        """
        SELECT cf.id, cf.filename, c.circle_key
        FROM circle_files cf
        JOIN circles c ON c.id = cf.circle_id
        WHERE c.drawing_id = ?
        """,
        (drawing_id,),
    )
    files_rows = [dict(files_row) for files_row in cur.fetchall()]

    files_map: dict[str, list[str]] = {}
    for r in files_rows:
        key = r["circle_key"]
        files_map.setdefault(key, []).append(r["filename"])

    return {
        "drawing": drawing,
        "circles": circles,
        "files": files_map,
    }


def update_drawing_display_name(drawing_id: str, display_name: str) -> None:
    """
    Переименование чертежа (display_name).
    """
    conn = get_db()
    cur = conn.cursor()
    cur.execute(
        "UPDATE drawings SET display_name = ? WHERE id = ?",
        (display_name, drawing_id),
    )
    conn.commit()


def delete_drawing(drawing_id: str) -> None:
    """
    Удаление одного чертежа.
    Важно: если нет каскадов в схеме БД, круги/файлы лучше чистить отдельно
    (но обычно FK настроены с ON DELETE CASCADE).
    """
    conn = get_db()
    cur = conn.cursor()
    cur.execute("DELETE FROM drawings WHERE id = ?", (drawing_id,))
    conn.commit()


def delete_project_drawings(project: str) -> None:
    """
    Удаляет ВСЕ чертежи проекта (и связанные круги/circle_files по каскаду).

    Используется при:
      - удалении пункта меню (item_id == project),
      - удалении доп. вкладки с чертежами (tab_id == project),
      - любом другом глобальном удалении проекта.
    """
    if not project:
        return

    conn = get_db()
    cur = conn.cursor()
    cur.execute("DELETE FROM drawings WHERE project = ?", (project,))
    conn.commit()


def set_circle_radius_for_all(drawing_id: str, radius: float) -> None:
    """
    Массовое изменение радиуса всех кругов чертежа.
    """
    conn = get_db()
    cur = conn.cursor()
    cur.execute(
        "UPDATE circles SET radius = ? WHERE drawing_id = ?",
        (radius, drawing_id),
    )
    conn.commit()


def update_circle(
    drawing_id: str,
    circle_key: str,
    *,
    x: float | None = None,
    y: float | None = None,
    radius: float | None = None,
) -> None:
    """
    Точечное обновление одного круга (координаты/радиус).
    """
    conn = get_db()
    cur = conn.cursor()

    fields: list[str] = []
    values: list[Any] = []

    if x is not None:
        fields.append("x = ?")
        values.append(float(x))
    if y is not None:
        fields.append("y = ?")
        values.append(float(y))
    if radius is not None:
        fields.append("radius = ?")
        values.append(float(radius))

    if not fields:
        return

    values.append(drawing_id)
    values.append(circle_key)

    cur.execute(
        f"""
        UPDATE circles
        SET {", ".join(fields)}
        WHERE drawing_id = ? AND circle_key = ?
        """,
        values,
    )
    conn.commit()


def delete_circle(drawing_id: str, circle_key: str) -> None:
    """
    Удаление одного круга и всех привязанных к нему файлов.
    """
    conn = get_db()
    cur = conn.cursor()
    cur.execute(
        "SELECT id FROM circles WHERE drawing_id = ? AND circle_key = ?",
        (drawing_id, circle_key),
    )
    row = cur.fetchone()
    if not row:
        return
    circle_id = row["id"]

    cur.execute("DELETE FROM circle_files WHERE circle_id = ?", (circle_id,))
    cur.execute("DELETE FROM circles WHERE id = ?", (circle_id,))
    conn.commit()


def set_circle_files(drawing_id: str, circle_key: str, filenames: list[str]) -> None:
    """
    Присвоение списка файлов одному кругу: сначала чистим старые, потом добавляем новые.
    """
    conn = get_db()
    cur = conn.cursor()
    cur.execute(
        "SELECT id FROM circles WHERE drawing_id = ? AND circle_key = ?",
        (drawing_id, circle_key),
    )
    row = cur.fetchone()
    if not row:
        return
    circle_id = row["id"]

    cur.execute("DELETE FROM circle_files WHERE circle_id = ?", (circle_id,))
    for name in filenames:
        cur.execute(
            "INSERT INTO circle_files (circle_id, filename) VALUES (?, ?)",
            (circle_id, name),
        )
    conn.commit()