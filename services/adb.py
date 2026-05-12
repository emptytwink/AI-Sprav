# adb.py
from flask import Blueprint, request, jsonify, send_file
import subprocess
import os
import shutil
import zipfile
import tempfile
import time
from pathlib import Path
from werkzeug.utils import secure_filename

adb = Blueprint('adb', __name__)

# Конфигурация путей
MOBILE_APP_TEMPLATE = Path(__file__).parent.parent / "mobile_app_template"
BUILDS_DIR = Path(__file__).parent.parent / "builds"


@adb.route("/api/build", methods=["POST"])
def build_app():
    try:
        # Создаем временную директорию для сборки
        with tempfile.TemporaryDirectory() as temp_dir:
            temp_path = Path(temp_dir)

            # Копируем существующий Android проект
            build_dir = temp_path / "android_build"
            shutil.copytree(MOBILE_APP_TEMPLATE, build_dir)

            # Получаем данные для сборки
            data = request.get_json() or {}
            project_name = data.get("project_name", "Справочник")
            package_name = data.get("package_name", "com.mera.osp5")
            build_type = data.get("build_type", "release")

            # Экспортируем текущий фронтенд
            from services.export import build_export
            export_dir, _ = build_export()

            # Копируем экспортированный фронтенд в public папку Android проекта
            public_dir = build_dir / "app" / "src" / "main" / "assets" / "public"
            if public_dir.exists():
                shutil.rmtree(public_dir)
            shutil.copytree(export_dir, public_dir)

            # Обновляем конфигурационные файлы
            update_app_config(build_dir, package_name, project_name)

            # Выполняем сборку
            os.chdir(build_dir)
            result = subprocess.run(
                ["./gradlew", f"assemble{build_type.capitalize()}"],
                capture_output=True, text=True, timeout=1200
            )

            if result.returncode == 0:
                # Сохраняем собранный APK
                BUILDS_DIR.mkdir(exist_ok=True)

                # Ищем APK файл (путь может отличаться в разных проектах)
                apk_paths = [
                    build_dir / "app" / "build" / "outputs" / "apk" / build_type / f"app-{build_type}.apk",
                    build_dir / "app" / "build" / "outputs" / "apk" / f"app-{build_type}.apk",
                    build_dir / "app" / "build" / "outputs" / "apk" / build_type / "app.apk"
                ]

                apk_source = None
                for path in apk_paths:
                    if path.exists():
                        apk_source = path
                        break

                if not apk_source:
                    return jsonify({
                        "success": False,
                        "message": "APK файл не найден после сборки"
                    }), 500

                apk_dest = BUILDS_DIR / f"{secure_filename(project_name)}_{build_type}_{int(time.time())}.apk"
                shutil.copy2(apk_source, apk_dest)

                return jsonify({
                    "success": True,
                    "message": "Сборка завершена успешно",
                    "apk_path": str(apk_dest),
                    "apk_name": apk_dest.name
                })
            else:
                return jsonify({
                    "success": False,
                    "message": f"Ошибка сборки: {result.stderr}"
                }), 500

    except Exception as e:
        return jsonify({"success": False, "message": str(e)}), 500


@adb.route("/api/build/download/<apk_name>", methods=["GET"])
def download_apk(apk_name):
    """Скачивание собранного APK"""
    apk_path = BUILDS_DIR / secure_filename(apk_name)
    if not apk_path.exists():
        return jsonify({"success": False, "message": "APK не найден"}), 404

    return send_file(apk_path, as_attachment=True)


@adb.route("/api/install_and_run", methods=["POST"])
def install_and_run():
    try:
        data = request.get_json() or {}
        apk_path = data.get("apk_path")

        if not apk_path or not os.path.exists(apk_path):
            return jsonify({"success": False, "message": "APK не найден"}), 404

        # Устанавливаем приложение
        install_result = subprocess.run(
            ["adb", "install", "-r", apk_path],
            capture_output=True, text=True
        )

        if install_result.returncode != 0:
            return jsonify({
                "success": False,
                "message": f"Ошибка установки: {install_result.stderr}"
            }), 500

        # Получаем package name из apk
        package_result = subprocess.run(
            ["aapt", "dump", "badging", apk_path],
            capture_output=True, text=True
        )

        package_name = None
        if package_result.returncode == 0:
            for line in package_result.stdout.split('\n'):
                if line.startswith('package: name='):
                    package_name = line.split('=')[1].split(' ')[0].strip("'")
                    break

        # Запускаем приложение
        if package_name:
            run_result = subprocess.run(
                ["adb", "shell", "monkey", "-p", package_name, "1"],
                capture_output=True, text=True
            )
        else:
            # Альтернативный способ запуска
            run_result = subprocess.run(
                ["adb", "shell", "am", "start", "-a", "android.intent.action.MAIN", "-c",
                 "android.intent.category.LAUNCHER"],
                capture_output=True, text=True
            )

        return jsonify({
            "success": True,
            "message": "Приложение установлено и запущено"
        })

    except Exception as e:
        return jsonify({"success": False, "message": str(e)}), 500


def update_app_config(build_dir, package_name, app_name):
    """Обновляет конфигурационные файлы Android проекта"""

    # Обновляем capacitor.config.json если существует
    capacitor_config = build_dir / "capacitor.config.json"
    if capacitor_config.exists():
        import json
        config = json.loads(capacitor_config.read_text())
        config["appId"] = package_name
        config["appName"] = app_name
        capacitor_config.write_text(json.dumps(config, indent=2))

    # Обновляем AndroidManifest.xml
    manifest_path = build_dir / "app" / "src" / "main" / "AndroidManifest.xml"
    if manifest_path.exists():
        manifest_content = manifest_path.read_text()
        # Ищем и заменяем package name
        import re
        manifest_content = re.sub(
            r'package="[^"]+"',
            f'package="{package_name}"',
            manifest_content
        )
        manifest_path.write_text(manifest_content)

    # Обновляем build.gradle (app level)
    gradle_path = build_dir / "app" / "build.gradle"
    if gradle_path.exists():
        gradle_content = gradle_path.read_text()
        # Ищем и заменяем applicationId
        gradle_content = re.sub(
            r'applicationId\s+"[^"]+"',
            f'applicationId "{package_name}"',
            gradle_content
        )
        gradle_path.write_text(gradle_content)

    # Обновляем strings.xml
    strings_path = build_dir / "app" / "src" / "main" / "res" / "values" / "strings.xml"
    if strings_path.exists():
        strings_content = strings_path.read_text()
        strings_content = re.sub(
            r'<string name="app_name">[^<]+</string>',
            f'<string name="app_name">{app_name}</string>',
            strings_content
        )
        strings_path.write_text(strings_content)


# Добавьте в adb.py
def check_build_environment():
    """Проверяет наличие необходимых инструментов для сборки"""
    required_tools = ['java', 'gradle', 'adb', 'aapt']
    missing_tools = []

    for tool in required_tools:
        try:
            if tool == 'gradle':
                # Проверяем gradle через wrapper
                subprocess.run(['./gradlew', '--version'], capture_output=True, check=True, timeout=30)
            else:
                subprocess.run([tool, '--version'], capture_output=True, check=True, timeout=30)
        except (subprocess.CalledProcessError, FileNotFoundError, subprocess.TimeoutExpired):
            missing_tools.append(tool)

    return missing_tools


@adb.route("/api/build/check", methods=["GET"])
def check_build_environment_route():
    missing = check_build_environment()
    android_sdk_path = os.environ.get('ANDROID_HOME') or os.environ.get('ANDROID_SDK_ROOT')

    response = {
        "ready": len(missing) == 0,
        "missing_tools": missing,
        "android_sdk": bool(android_sdk_path),
        "android_sdk_path": android_sdk_path,
        "message": "Среда готова к сборке" if len(missing) == 0 else "Необходимые инструменты не установлены"
    }

    return jsonify(response)


@adb.route("/api/build/check", methods=["GET"])
def check_build_environment_route():
    missing = check_build_environment()
    android_sdk_path = os.environ.get('ANDROID_HOME') or os.environ.get('ANDROID_SDK_ROOT')

    response = {
        "ready": len(missing) == 0,
        "missing_tools": missing,
        "android_sdk": bool(android_sdk_path),
        "android_sdk_path": android_sdk_path,
        "message": "Среда готова к сборке" if len(missing) == 0 else "Необходимые инструменты не установлены"
    }

    return jsonify(response)


@adb.route("/api/build/download/<apk_name>", methods=["GET"])
def download_apk(apk_name):
    """Скачивание собранного APK"""
    apk_path = BUILDS_DIR / secure_filename(apk_name)
    if not apk_path.exists():
        return jsonify({"success": False, "message": "APK не найден"}), 404

    return send_file(apk_path, as_attachment=True)