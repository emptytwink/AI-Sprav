from __future__ import annotations

from flask import request, jsonify

from .drawings_repo import get_drawing, update_drawing_display_name


def _build_drawing_response(dto: dict) -> dict:
    drawing = dto["drawing"]
    circles = dto["circles"]
    files_map = dto["files"]

    original_image = drawing.get("image_path")
    processed_image = drawing.get("processed_image_path") or original_image

    circles_api = [
        {
            "id": c["circle_key"],
            "x": c["x"],
            "y": c["y"],
            "radius": c["radius"],
        }
        for c in circles
    ]

    files_api: dict[str, list[str]] = {}
    for circle_key, names in files_map.items():
        files_api[circle_key] = list(names)

    return {
        "drawing_id": drawing["id"],
        "drawing_name": drawing["name"],
        "display_name": drawing.get("display_name") or drawing["name"],
        "original_image": original_image,
        "processed_image": processed_image,
        "circles": circles_api,
        "files": files_api,
    }


def register_drawing_routes(app):
    @app.route("/load_drawing/<drawing_id>", methods=["GET"])
    def load_drawing_route(drawing_id):
        project = request.args.get("project")
        if not project:
            return jsonify({"error": "Проект не указан"}), 400

        dto = get_drawing(drawing_id, project)
        if not dto:
            return jsonify({"error": "Чертёж не найден"}), 404

        result = _build_drawing_response(dto)
        return jsonify(result), 200

    @app.route("/load_drawing_by_project", methods=["GET"])
    def load_drawing_by_project_route():
        drawing_id = request.args.get("drawing_id")
        project = request.args.get("project")

        if not drawing_id or not project:
            return jsonify({"error": "drawing_id и project обязательны"}), 400

        dto = get_drawing(drawing_id, project)
        if not dto:
            return jsonify({"error": "Чертёж не найден"}), 404

        result = _build_drawing_response(dto)
        return jsonify(result), 200

    @app.route("/update_drawing_name/<drawing_id>", methods=["PUT", "POST"])
    def update_drawing_name_route(drawing_id):
        payload = request.get_json(silent=True) or request.form or {}
        new_name = (payload.get("new_name") or "").strip()

        if not new_name:
            return jsonify({"error": "Новое название не может быть пустым"}), 400

        update_drawing_display_name(drawing_id, new_name)
        return jsonify({"success": True, "message": "Название обновлено"}), 200