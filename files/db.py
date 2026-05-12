# files/db.py
from __future__ import annotations

import sqlite3
from pathlib import Path
from typing import Iterable, Any, Dict

from .paths import DATA_DIR

DB_PATH = DATA_DIR / "sprav.sqlite3"

_connection: sqlite3.Connection | None = None


def dict_factory(cursor: sqlite3.Cursor, row: Iterable[Any]) -> Dict[str, Any]:
    """
    Преобразуем строки SQLite в dict: {"col": value, ...}
    """
    return {col[0]: row[idx] for idx, col in enumerate(cursor.description)}


def get_db() -> sqlite3.Connection:
    """
    Возвращаем singleton-подключение к SQLite с row_factory=dict.
    """
    global _connection
    if _connection is None:
        DB_PATH.parent.mkdir(parents=True, exist_ok=True)
        conn = sqlite3.connect(DB_PATH, check_same_thread=False)
        conn.row_factory = dict_factory
        conn.execute("PRAGMA foreign_keys = ON")
        _connection = conn
    return _connection


def init_db() -> None:
    """
    Создаём все нужные таблицы, если их ещё нет.
    """
    conn = get_db()
    cur = conn.cursor()

    cur.executescript(
        """
        -- ========== МЕНЮ ==========

        CREATE TABLE IF NOT EXISTS menu_items (
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          type TEXT NOT NULL,        -- 'item' или 'group'
          parent_id TEXT NULL REFERENCES menu_items(id) ON DELETE CASCADE,
          position INTEGER NOT NULL DEFAULT 0,
          enabled INTEGER NOT NULL DEFAULT 1
        );

        -- ========== КОНТЕНТ РАЗДЕЛОВ ==========

        CREATE TABLE IF NOT EXISTS contents (
          item_id TEXT PRIMARY KEY REFERENCES menu_items(id) ON DELETE CASCADE,
          title TEXT NOT NULL,
          text_html TEXT,
          table_json TEXT,
          description_title TEXT,
          docs_title TEXT
        );

        -- ========== ДОПОЛНИТЕЛЬНЫЕ ВКЛАДКИ ==========

        CREATE TABLE IF NOT EXISTS extra_tabs (
          id TEXT PRIMARY KEY,
          item_id TEXT NOT NULL REFERENCES menu_items(id) ON DELETE CASCADE,
          title TEXT NOT NULL,
          kind TEXT NOT NULL,      -- 'html', 'drawing' и т.п.
          html TEXT,
          view TEXT,
          position INTEGER NOT NULL DEFAULT 0
        );

        -- На будущее, если захочешь хранить метаданные файлов
        CREATE TABLE IF NOT EXISTS attachments (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          owner_type TEXT NOT NULL, -- 'item', 'circle', 'tab'
          owner_id TEXT NOT NULL,
          filename TEXT NOT NULL,
          size INTEGER NOT NULL,
          uploaded_at TEXT NOT NULL
        );

        -- ========== ЧЕРТЕЖИ ==========

        CREATE TABLE IF NOT EXISTS drawings (
          id TEXT PRIMARY KEY,            -- drawing_id, например "1"
          project TEXT NOT NULL,
          name TEXT NOT NULL,            -- имя исходного файла
          display_name TEXT,             -- пользовательское имя
          image_path TEXT NOT NULL,      -- путь к исходному изображению
          processed_image_path TEXT,     -- путь к картинке с обведёнными кругами
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );

        -- Круги на чертеже
        CREATE TABLE IF NOT EXISTS circles (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          drawing_id TEXT NOT NULL REFERENCES drawings(id) ON DELETE CASCADE,
          circle_key TEXT NOT NULL,      -- то, что было в JSON: "c1", "c2"
          x REAL NOT NULL,
          y REAL NOT NULL,
          radius REAL NOT NULL
        );

        CREATE UNIQUE INDEX IF NOT EXISTS idx_circles_drawing_key
          ON circles(drawing_id, circle_key);

        -- Файлы, привязанные к кругу
        CREATE TABLE IF NOT EXISTS circle_files (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          circle_id INTEGER NOT NULL REFERENCES circles(id) ON DELETE CASCADE,
          filename TEXT NOT NULL
        );
        """
    )

    conn.commit()


def reset_db() -> None:
    """
    Полный дроп всех таблиц и создание заново.
    Осторожно: удалит все данные.
    """
    conn = get_db()
    cur = conn.cursor()
    cur.executescript(
        """
        DROP TABLE IF EXISTS circle_files;
        DROP TABLE IF EXISTS circles;
        DROP TABLE IF EXISTS drawings;
        DROP TABLE IF EXISTS attachments;
        DROP TABLE IF EXISTS extra_tabs;
        DROP TABLE IF EXISTS contents;
        DROP TABLE IF EXISTS menu_items;
        """
    )
    conn.commit()
    init_db()