from __future__ import annotations

from pathlib import Path

from flask import Flask, render_template, send_from_directory, abort, request

from files.paths import STATIC_DIR, TEMPLATES_DIR, UPLOADS_DIR
from files.db import init_db
from files.api import bp as api_bp
from ai import bp_ai

from services.project_export_routes import bp_project_export
from services.ping import bp_ping
from services.sync import get_sync_service
from services.adb import adb  # можно удалить, если не нужен

from drawings import (
    register_drawings_core_routes,
    register_circle_routes,
    register_drawing_routes,
)


def create_app():
    app = Flask(
        __name__,
        static_folder=str(STATIC_DIR),
        template_folder=str(TEMPLATES_DIR),
    )

    # создаём все таблицы (menu_items, contents, extra_tabs, drawings, circles, ...)
    init_db()

    # Базовые настройки
    app.config.setdefault("UPLOAD_DIR", str(UPLOADS_DIR))
    app.config.setdefault("SYNC_DIR", "sync")
    app.config.setdefault("SYNC_INTERVAL", 15)
    app.config.setdefault("SYNC_AUTOSTART", "false")

    # ----- Blueprints / API -----
    app.register_blueprint(api_bp)           # основной API справочника
    app.register_blueprint(bp_ai)
    app.register_blueprint(bp_project_export)
    app.register_blueprint(bp_ping)

    # роуты чертежей / кругов / файлов
    register_drawings_core_routes(app)
    register_circle_routes(app)
    register_drawing_routes(app)

    # ----- Обычные view -----

    @app.get("/")
    def index():
        return render_template("sprav.html")

    @app.get("/health")
    def health():
        return {"status": "ok"}

    @app.get("/drawings")
    def drawings_page():
        project = request.args.get("project", "")
        return render_template("index.html", project=project)

    @app.get("/static/uploads/<path:relpath>")
    def _static_uploads(relpath: str):
        root = Path(UPLOADS_DIR).resolve()
        full = (root / relpath).resolve()
        # защита от выхода из директории загрузок
        if not str(full).startswith(str(root)):
            abort(403)
        return send_from_directory(root, relpath)

    # Автостарт sync-службы, если включено в конфиге
    if str(app.config.get("SYNC_AUTOSTART", "false")).lower() == "true":
        get_sync_service().start()

    return app
