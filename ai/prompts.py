from __future__ import annotations

from typing import Any, Dict, Iterable, List

SYSTEM_PROMPT = """
Ты — модуль интеллектуального анализа технической документации.
Твоя задача — по архиву документов сформировать подробную МНОГОУРОВНЕВУЮ структуру электронного справочника.

Главные правила:
1. Не выдумывай факты, которых нет в документах.
2. Для большого архива формируй подробную структуру, а не 5–6 общих разделов.
3. Используй вложенность папок архива как основной ориентир.
4. Не сворачивай глубокую структуру в один уровень.
5. Если в архиве есть уровни папок, сохраняй уровни: крупный раздел -> подраздел -> тема -> конечный раздел.
6. children может содержать и group, и item.
7. group — контейнерный раздел, у него может не быть contents.
8. item — конечная страница справочника, для каждого item обязательно должна быть запись в contents.
9. К каждому item укажи source_files — реальные относительные пути файлов из архива.
10. id должен быть латиницей, snake_case, без пробелов.
11. Верни только валидный JSON без пояснений.

Желательные крупные разделы, если по ним есть документы:
- Общие сведения
- Архитектура и состав комплекса
- Требования к среде
- Монтаж и подключение
- Пусконаладка
- Эксплуатация
- Техническое обслуживание
- Диагностика и аварии
- Безопасность
- Обновление ПО
- Резервное копирование
- Интеграции и API
- Чертежи и схемы
- Комплектность и ЗИП
- Формы журналов и актов

Формат ответа строго рекурсивный:
{
  "title": "Название справочника",
  "menu": [
    {
      "id": "main_section",
      "title": "Крупный раздел",
      "type": "group",
      "children": [
        {
          "id": "subsection",
          "title": "Подраздел",
          "type": "group",
          "children": [
            {
              "id": "topic",
              "title": "Тема",
              "type": "group",
              "children": [
                {
                  "id": "final_item",
                  "title": "Конечный раздел",
                  "type": "item"
                }
              ]
            }
          ]
        }
      ]
    }
  ],
  "contents": [
    {
      "item_id": "final_item",
      "title": "Конечный раздел",
      "text_html": "<p>Краткое описание раздела.</p>",
      "source_files": ["relative/path/file.pdf", "relative/path/file.xlsx"]
    }
  ]
}

Важно:
- text_html должен быть безопасным простым HTML: p, ul, li, b, i.
- Не добавляй markdown.
- Не добавляй файлы в source_files, если их нет в дереве архива или списке выбранных документов.
- Если документ Excel содержит таблицу регламента, ведомость или журнал, учитывай его как полноценный источник.
"""


def build_user_prompt(documents, skipped_files=None, folders=None, archive_tree=None):
    skipped_files = skipped_files or []
    folders = folders or []
    lines = [
        "Сформируй подробную многоуровневую структуру электронного справочника по документам из ZIP-архива.",
        "Сохрани смысловую вложенность архива. Не делай только два уровня, если дерево архива глубже.",
        "",
        "Дерево архива:",
    ]

    if archive_tree:
        lines.extend(_render_archive_tree(archive_tree))
    elif folders:
        lines.extend(f"- {folder}/" for folder in folders)
    else:
        lines.append("- корень архива")

    lines.extend(["", "Выбранные документы для анализа:"])
    for doc in documents:
        folder_parts = doc.get("folder_parts") or []
        lines.extend(
            [
                "",
                "Документ:",
                f"Путь: {doc.get('relpath') or doc.get('path') or ''}",
                f"Папка: {doc.get('folder_path') or ''}",
                f"Уровни папок: {' / '.join(folder_parts) if folder_parts else 'корень'}",
                f"Расширение: {doc.get('ext') or ''}",
                "Текст:",
                doc.get("text") or doc.get("extracted_text") or "",
            ]
        )

    if skipped_files:
        lines.extend(["", "Файлы без текстового анализа (могут быть исходными вложениями):"])
        for item in skipped_files[:160]:
            path = item.get("relpath") or item.get("path") or ""
            reason = item.get("skipped_reason") or item.get("reason") or ""
            lines.append(f"- {path}: {reason}")

    return "\n".join(lines)


def _render_archive_tree(tree: Dict[str, Any], max_lines: int = 500) -> List[str]:
    lines: List[str] = []

    def walk(node: Dict[str, Any], level: int) -> None:
        if len(lines) >= max_lines:
            return
        name = node.get("name") or "."
        if name != ".":
            suffix = "/" if node.get("type") == "dir" else ""
            lines.append(f"{'  ' * level}- {name}{suffix}")
        for child in node.get("children") or []:
            if isinstance(child, dict):
                walk(child, level + (0 if name == "." else 1))

    walk(tree, 0)
    if len(lines) >= max_lines:
        lines.append("- ... дерево архива обрезано для prompt ...")
    return lines or ["- корень архива"]
