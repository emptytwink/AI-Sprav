# run.py
import os, sys, socket, threading, time, webbrowser
from pathlib import Path

# Гарантируем папку данных рядом с exe, если переменная не задана явно
if "SPRAV_DATA_DIR" not in os.environ:
    base = Path(sys.executable).parent if getattr(sys, "frozen", False) else Path(__file__).resolve().parent
    os.environ["SPRAV_DATA_DIR"] = str(base / "data")

from main.app import create_app  # noqa

def find_free_port(start=1000):
    for p in range(start, start+200):
        with socket.socket() as s:
            s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            try:
                s.bind(("127.0.0.1", p))
                return p
            except OSError:
                continue
    return 0

def open_ui(url: str):
    try:
        import webview  # pywebview (опционально)
        # Отдельный поток для Flask, чтобы UI не блокировался
        t = threading.Thread(target=lambda: webview.create_window("Справочник", url, width=1200, height=800))
        t.daemon = True
        t.start()
        webview.start()  # блокирует до закрытия окна
    except Exception:
        webbrowser.open(url)

def main():
    app = create_app()

    # фиксированный порт для работы с планшетом
    port = 1000
    url = f"http://127.0.0.1:{port}/"

    def run():
        # ВАЖНО: слушаем на всех интерфейсах, чтобы был доступ из LAN
        app.run(
            host="0.0.0.0",
            port=port,
            debug=True,
            use_reloader=False,
            threaded=True,
        )

    th = threading.Thread(target=run, daemon=True)
    th.start()

    time.sleep(0.6)
    open_ui(url)

    try:
        while th.is_alive():
            time.sleep(0.5)
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
