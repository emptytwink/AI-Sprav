from __future__ import annotations

from pathlib import Path

import fitz  # PyMuPDF


class DocConvertError(RuntimeError):
    pass


def convert_doc_to_pdf(src: Path, out_dir: Path) -> Path:
    """
    Пустая заглушка для DOC/DOCX.
    Без LibreOffice/Word корректная конвертация DOC/DOCX в PDF недоступна,
    поэтому здесь кидаем понятную ошибку.
    """
    raise DocConvertError(
        f"Конвертация {src.suffix} в PDF не поддерживается без LibreOffice/Word"
    )


def convert_pdf_to_png_first_page(src: Path, out_dir: Path, dpi: int = 150) -> Path:
    """
    Конвертация первой страницы PDF в PNG с помощью PyMuPDF (fitz).
    Никаких внешних exe не используется.
    """
    src = Path(src)
    out_dir = Path(out_dir)
    if not src.is_file():
        raise DocConvertError(f"PDF-файл не найден: {src}")

    out_dir.mkdir(parents=True, exist_ok=True)
    png_path = out_dir / (src.stem + ".png")

    try:
        doc = fitz.open(src)
    except Exception as e:
        raise DocConvertError(f"Не удалось открыть PDF: {e}") from e

    if doc.page_count == 0:
        doc.close()
        raise DocConvertError("У PDF нет страниц")

    try:
        page = doc.load_page(0)
        mat = fitz.Matrix(dpi / 72, dpi / 72)
        pix = page.get_pixmap(matrix=mat)
        pix.save(png_path.as_posix())
    except Exception as e:
        doc.close()
        raise DocConvertError(f"Ошибка рендера PDF в PNG: {e}") from e

    doc.close()

    if not png_path.exists() or png_path.stat().st_size == 0:
        raise DocConvertError("PNG-превью не создано или пустое")

    return png_path