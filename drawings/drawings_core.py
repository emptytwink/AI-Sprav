from pathlib import Path
import os

from flask import request, jsonify, render_template
from werkzeug.utils import secure_filename

from main.config import Config
from .detect_circles import detect_circles
from .drawings_repo import list_project_drawings, get_drawing, delete_drawing


def _drawings_dir(project: str) -> Path:
    base = Path(Config.BASE_DIR) / "static" / project / "state" / "drawings"
    base.mkdir(parents=True, exist_ok=True)
    return base


def _next_drawing_id(folder: Path) -> str:
    used = []
    for p in folder.glob("*.png"):
        stem = p.stem
        if stem.isdigit():
            used.append(int(stem))
    return str(max(used) + 1 if used else 1)


def _remove_file_safe(path_str: str) -> None:
    if not path_str:
        return

    rel = path_str.lstrip("/")
    base_dir = Path(Config.BASE_DIR)
    full = (base_dir / rel).resolve()

    try:
        if full.is_file():
            full.unlink()
    except OSError:
        pass


def register_drawings_core_routes(app):
    @app.route("/list_project_drawings", methods=["GET"])
    def list_project_drawings_route():
        project = request.args.get("project")
        if not project:
            return jsonify({"error": "project обязателен"}), 400

        rows = list_project_drawings(project)
        items = [
            {
                "drawing_id": r["id"],
                "drawing_name": r["name"],
                "display_name": r["display_name"],
            }
            for r in rows
        ]
        return jsonify(items), 200

    @app.route("/upload", methods=["POST"])
    def upload_drawing():
        project = request.form.get("project")
        file = request.files.get("file") or request.files.get("image")

        if not project or not file:
            return jsonify({"error": "project и file обязательны"}), 400

        folder = _drawings_dir(project)
        filename = secure_filename(file.filename)
        if not filename:
            return jsonify({"error": "Некорректное имя файла"}), 400

        drawing_id = _next_drawing_id(folder)
        fs_path = folder / f"{drawing_id}.png"
        file.save(str(fs_path))

        data = detect_circles(str(fs_path), drawing_id, project)
        return jsonify(data), 200

    @app.route("/delete_drawing/<drawing_id>", methods=["DELETE"])
    def delete_drawing_route(drawing_id: str):
        project = request.args.get("project")

        drawing = get_drawing(drawing_id, project) if project else get_drawing(drawing_id)
        if not drawing:
            return jsonify({"error": "drawing not found"}), 404

        info = drawing.get("drawing") or {}
        image_path = info.get("image_path") or ""
        processed_path = info.get("processed_image_path") or ""

        _remove_file_safe(image_path)
        _remove_file_safe(processed_path)

        delete_drawing(drawing_id)

        return jsonify({"ok": True}), 200

    @app.route("/result")
    def result_page():
        drawing_id = request.args.get("drawing_id")
        project = request.args.get("project")
        if not drawing_id or not project:
            return "drawing_id и project обязательны", 400
        return render_template("result.html", drawing_id=drawing_id, project=project)