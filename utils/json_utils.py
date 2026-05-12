# utils/json_utils.py
import json
from pathlib import Path


def read_json(path):
    """
    Надёжное чтение JSON.
    Если файла нет – возвращаем пустой dict.

    Если файл повреждён (например, к валидному объекту дописан мусор),
    пробуем прочитать только первый корректный JSON-объект и
    при успехе сразу чиним файл.
    """
    path = Path(path)
    if not path.exists():
        return {}

    text = path.read_text(encoding="utf-8")

    # Сначала пробуем обычный json.loads
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        # Пытаемся вытащить первый валидный JSON-объект
        decoder = json.JSONDecoder()
        try:
            obj, end = decoder.raw_decode(text.lstrip())

            # Если удалось — переписываем файл только этим объектом
            clean_data = json.dumps(obj, ensure_ascii=False, indent=4)
            path.write_text(clean_data, encoding="utf-8")

            return obj
        except json.JSONDecodeError:
            # Совсем мёртвый JSON — пробрасываем исключение дальше,
            # чтобы увидеть ошибку в логах и починить руками.
            raise


def write_json(path, data):
    """
    Запись JSON через временный файл, чтобы не портить основной.
    """
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)

    tmp_path = path.with_suffix(path.suffix + ".tmp")

    with tmp_path.open("w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=4)

    tmp_path.replace(path)
