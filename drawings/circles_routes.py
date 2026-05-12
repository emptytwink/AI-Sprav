from __future__ import annotations

import re
import shutil
from pathlib import Path
from files.paths import UPLOADS_DIR
from flask import request, jsonify, render_template
from werkzeug.utils import secure_filename
from files.paths import UPLOADS_DIR  # добавь импорт вверху файла
from main.config import Config
from services.doc_convert import (
    convert_doc_to_pdf,
    convert_pdf_to_png_first_page,
    DocConvertError,
)
from .drawings_repo import (
    get_drawing,
    set_circle_radius_for_all,
    update_circle,
    delete_circle,
    set_circle_files,
)
from utils.dinam_pyti import (
    get_block_files_folder,
    get_block_file_path,
)

def safe_rus_filename(name: str) -> str:
    return re.sub(r"[^\wа-яА-ЯёЁ0-9._ -]", "_", name)


def _unique_path(folder: Path, filename: str) -> Path:
    """
    Возвращает путь в папке folder, который не существует:
      123.docx → 123.docx
      (если есть) → 123 (1).docx, 123 (2).docx, ...
    """
    folder.mkdir(parents=True, exist_ok=True)
    base = Path(filename).stem
    ext = Path(filename).suffix
    candidate = folder / f"{base}{ext}"
    counter = 1

    while candidate.exists():
        candidate = folder / f"{base} ({counter}){ext}"
        counter += 1

    return candidate


def _maybe_generate_preview_png(path: Path) -> None:
    """
    Для DOC/DOCX/PDF делаем PNG-превью с тем же stem:
      123.docx → 123.png
    Ошибки конвертации не считаем фатальными.
    """
    ext = path.suffix.lower()
    if ext not in {".doc", ".docx", ".pdf"}:
        return

    try:
        # Превью кладём в ту же папку, что и оригинал
        convert_doc_to_png(path, path.parent)
    except DocConvertError as e:
        print(f"[circle_routes] preview PNG failed for {path.name}: {e}")


def register_circle_routes(app):
    @app.route("/view")
    def view_page():
        circle_id = request.args.get("circle_id")
        drawing_id = request.args.get("drawing_id")
        project = request.args.get("project")
        if not circle_id or not drawing_id or not project:
            return "circle_id, drawing_id и project обязательны", 400
        return render_template(
            "view.html",
            circle_id=circle_id,
            drawing_id=drawing_id,
            project=project,
        )

    from files.paths import UPLOADS_DIR  # если ещё не импортировано

    @app.route("/circle_files/<drawing_id>", methods=["GET"])
    def circle_files_route(drawing_id):
        project = request.args.get("project")
        if not project:
            return jsonify({"error": "project не указан"}), 400

        dto = get_drawing(drawing_id, project)
        if not dto:
            return jsonify({"error": "Чертёж не найден"}), 404

        files_map = dto["files"]
        result: dict[str, list[dict]] = {}

        for circle_key, stored_values in files_map.items():
            files_info: list[dict] = []

            for raw_value in stored_values:
                raw_value = str(raw_value or "").strip()
                if not raw_value:
                    continue

                clean_name = Path(raw_value).name
                if not clean_name:
                    continue

                candidates: list[tuple[Path, str]] = []

                # 1. Если в БД уже лежит относительный путь внутри data/uploads
                if "/" in raw_value or "\\" in raw_value:
                    rel_norm = raw_value.replace("\\", "/").lstrip("/")
                    candidates.append(
                        (
                            (UPLOADS_DIR / rel_norm).resolve(),
                            f"/static/uploads/{rel_norm}",
                        )
                    )

                # 2. Новая схема: data/uploads/<project>/<circle_id>/<filename>
                candidates.append(
                    (
                        (UPLOADS_DIR / project / circle_key / clean_name).resolve(),
                        f"/static/uploads/{project}/{circle_key}/{clean_name}",
                    )
                )

                # 3. Промежуточная схема: data/uploads/<project>/<filename>
                candidates.append(
                    (
                        (UPLOADS_DIR / project / clean_name).resolve(),
                        f"/static/uploads/{project}/{clean_name}",
                    )
                )

                # 4. Legacy-схема: static/<project>/uploads/<filename>
                legacy_path = (Path(Config.BASE_DIR) / "static" / project / "uploads" / clean_name).resolve()
                candidates.append(
                    (
                        legacy_path,
                        f"/static/{project}/uploads/{clean_name}",
                    )
                )

                found_path = None
                found_url = None

                for file_path, file_url in candidates:
                    if file_path.is_file():
                        found_path = file_path
                        found_url = file_url
                        break

                if not found_path or not found_url:
                    continue

                files_info.append(
                    {
                        "name": clean_name,
                        "size": found_path.stat().st_size,
                        "url": found_url,
                    }
                )

            result[circle_key] = files_info

        return jsonify(result), 200

    @app.route("/update_all_circles_radius/<drawing_id>", methods=["POST"])
    def update_all_circles_radius_route(drawing_id):
        project = request.form.get("project")
        if not project:
            return jsonify({"error": "project не указан"}), 400

        try:
            radius = float(request.form.get("radius") or 0)
        except ValueError:
            return jsonify({"error": "Некорректный радиус"}), 400

        set_circle_radius_for_all(drawing_id, radius)
        return jsonify({"success": True}), 200

    @app.route("/update_circle/<drawing_id>/<circle_id>", methods=["POST"])
    def update_circle_route(drawing_id, circle_id):
        project = request.form.get("project")
        if not project:
            return jsonify({"error": "project не указан"}), 400

        payload = request.get_json() or {}
        x = payload.get("x")
        y = payload.get("y")
        radius = payload.get("radius")

        try:
            x_f = float(x) if x is not None else None
            y_f = float(y) if y is not None else None
            r_f = float(radius) if radius is not None else None
        except ValueError:
            return jsonify({"error": "Некорректные координаты или радиус"}), 400

        update_circle(
            drawing_id,
            circle_id,
            x=x_f,
            y=y_f,
            radius=r_f,
        )
        return jsonify({"success": True}), 200

    @app.route("/delete_circle/<drawing_id>/<circle_id>", methods=["DELETE"])
    def delete_circle_route(drawing_id, circle_id):
        project = request.args.get("project")
        if not project:
            return jsonify({"error": "project не указан"}), 400

        folder = get_block_files_folder(project, circle_id)
        if folder.is_dir():
            shutil.rmtree(folder)

        delete_circle(drawing_id, circle_id)
        return jsonify({"success": True}), 200

    from files.paths import UPLOADS_DIR  # добавь импорт вверху файла

    @app.route("/upload_documents", methods=["POST"])
    def upload_documents_route():
        """
        Загрузка одного или нескольких файлов в круг.
        Имена делаем уникальными. Для DOC/DOCX/PDF создаём PNG-превью.
        В БД сохраняем относительные пути внутри UPLOADS_DIR.
        """
        circle_id = request.form.get("circle_id")
        drawing_id = request.form.get("drawing_id")
        project = request.form.get("project")

        if not circle_id or not drawing_id or not project:
            return jsonify({"error": "circle_id, drawing_id и project обязательны"}), 400

        files = request.files.getlist("files")
        if not files:
            return jsonify({"error": "файлы не переданы"}), 400

        folder = get_block_files_folder(project, circle_id)
        folder.mkdir(parents=True, exist_ok=True)

        saved_names: list[str] = []

        for f in files:
            if not f.filename:
                continue
            name = safe_rus_filename(f.filename)
            name = secure_filename(name)
            if not name:
                continue

            path = get_block_file_path(project, circle_id, name)
            if path.exists():
                # если не хочешь пропускать, можешь сделать _unique_path(...)
                continue

            ext = Path(name).suffix.lower()
            f.save(str(path))

            # относительный путь внутри data/uploads
            try:
                relpath = path.relative_to(UPLOADS_DIR).as_posix()
            except ValueError:
                # на всякий случай, если что-то пойдёт не так — не роняем запрос
                relpath = f"{project}/{circle_id}/{name}"
            saved_names.append(relpath)

            # ===== DOC/DOCX/PDF → превью PNG =====
            if ext in {".doc", ".docx"}:
                try:
                    pdf_path = convert_doc_to_pdf(path, path.parent)
                except DocConvertError as e:
                    print("DOC->PDF error:", e)
                    pdf_path = None
            elif ext == ".pdf":
                pdf_path = path
            else:
                pdf_path = None

            if pdf_path is not None:
                try:
                    png_path = convert_pdf_to_png_first_page(pdf_path, pdf_path.parent)
                    try:
                        rel_png = png_path.relative_to(UPLOADS_DIR).as_posix()
                    except ValueError:
                        rel_png = f"{project}/{circle_id}/{png_path.name}"
                    if rel_png not in saved_names:
                        saved_names.append(rel_png)
                except DocConvertError as e:
                    print("PDF->PNG error:", e)

        if not saved_names:
            return jsonify({"error": "Не удалось сохранить файлы"}), 400

        dto = get_drawing(drawing_id, project)
        current_files = dto["files"].get(circle_id, []) if dto else []
        all_files = sorted(set(current_files) | set(saved_names))

        set_circle_files(drawing_id, circle_id, all_files)
        return jsonify({"success": True, "files": all_files}), 200

    @app.route("/delete_document", methods=["POST"])
    def delete_document_route():
        circle_id = request.form.get("circle_id")
        drawing_id = request.form.get("drawing_id")
        project = request.form.get("project")
        filename = request.form.get("filename")

        if not circle_id or not drawing_id or not project or not filename:
            return jsonify(
                {"error": "circle_id, drawing_id, project и filename обязательны"}
            ), 400

        path = get_block_file_path(project, circle_id, filename)
        if path.is_file():
            path.unlink()

        dto = get_drawing(drawing_id, project)
        current = dto["files"].get(circle_id, []) if dto else []
        new_list = [n for n in current if n != filename]

        set_circle_files(drawing_id, circle_id, new_list)
        return jsonify({"success": True}), 200