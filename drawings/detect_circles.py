# drawings/detect_circles.py

import os
from pathlib import Path

import cv2
import numpy as np

from main.config import Config
from .drawings_repo import save_drawing_with_circles


def _read_image_unicode_safe(image_path: str) -> np.ndarray | None:
    """
    Unicode-safe чтение изображения для Windows.
    cv2.imread может падать на путях с кириллицей.
    """
    try:
        data = np.fromfile(image_path, dtype=np.uint8)
    except OSError:
        return None

    if data.size == 0:
        return None

    return cv2.imdecode(data, cv2.IMREAD_COLOR)


def _write_image_unicode_safe(image_path: Path, image: np.ndarray) -> bool:
    """
    Unicode-safe запись изображения для Windows.
    """
    suffix = image_path.suffix.lower() or ".png"
    ext = ".jpg" if suffix in (".jpg", ".jpeg") else ".png"
    ok, encoded = cv2.imencode(ext, image)
    if not ok:
        return False
    try:
        encoded.tofile(str(image_path))
    except OSError:
        return False
    return True


def detect_circles(image_path: str, drawing_id: str, project: str) -> dict:
    """
    Обнаруживает круги на ОРИГИНАЛЬНОМ изображении (без ресайза),
    рисует их на копии, сохраняет картинку с обводкой и круги в БД.

    :param image_path: абсолютный путь к PNG чертежа
    :param drawing_id: строковый ID чертежа
    :param project: код проекта (имя папки в static)
    :return: словарь для фронтенда /upload
    """
    print(f"[detect_circles] image: {image_path}")

    img = _read_image_unicode_safe(image_path)
    if img is None:
        raise RuntimeError(f"Не удалось прочитать изображение {image_path}")

    h, w = img.shape[:2]
    print(f"[detect_circles] original size: {w}x{h}")

    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    gray = cv2.GaussianBlur(gray, (9, 9), 2)

    # Параметры взяты из твоего «хорошо работающего» варианта
    circles = cv2.HoughCircles(
        gray,
        cv2.HOUGH_GRADIENT,
        dp=1.2,
        minDist=30,
        param1=50,
        param2=30,
        minRadius=14,
        maxRadius=23,
    )

    circle_data: list[dict] = []

    if circles is not None:
        circles = np.uint16(np.around(circles[0, :]))
        print(f"[detect_circles] found {len(circles)} circles")
        for idx, (x, y, r) in enumerate(circles, start=1):
            x_i, y_i, r_i = int(x), int(y), int(r)

            if x_i < 0 or x_i >= w or y_i < 0 or y_i >= h:
                continue

            circle_data.append(
                {
                    "id": f"c{idx}",
                    "x": x_i,
                    "y": y_i,
                    "radius": r_i,
                }
            )

            # Рисуем на КОПИИ исходника — только для диагностической PNG
            cv2.circle(img, (x_i, y_i), r_i, (0, 255, 0), 2)
            cv2.circle(img, (x_i, y_i), 2, (0, 0, 255), 3)

    else:
        print("[detect_circles] circles not found")

    base_dir = Path(Config.BASE_DIR).resolve()

    detect_dir = base_dir / "static" / "detectIMG"
    detect_dir.mkdir(parents=True, exist_ok=True)

    processed_fs_path = detect_dir / f"detected_{drawing_id}.png"
    if not _write_image_unicode_safe(processed_fs_path, img):
        raise RuntimeError(f"Не удалось сохранить обработанное изображение {processed_fs_path}")
    processed_rel_url = f"/static/detectIMG/detected_{drawing_id}.png"

    image_abs = Path(image_path).resolve()
    try:
        rel_path = image_abs.relative_to(base_dir)
        image_rel_url = "/" + str(rel_path).replace(os.sep, "/")
    except ValueError:
        # если по какой-то причине не внутри BASE_DIR — даём как есть
        image_rel_url = image_path

    save_drawing_with_circles(
        project=project,
        drawing_id=drawing_id,
        original_name=os.path.basename(image_path),
        image_path=image_rel_url,                 # ОРИГИНАЛЬНЫЙ чертёж
        processed_image_path=processed_rel_url,   # PNG с обводкой (чисто для отладки)
        circles=circle_data,
    )

    return {
        "drawing_id": drawing_id,
        "drawing_name": os.path.basename(image_path),
        "processed_image": processed_rel_url,
        "circles": circle_data,
        "files": {},
    }
