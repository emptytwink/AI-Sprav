from __future__ import annotations
import json
import shutil
import time
import zipfile
from pathlib import Path
from typing import Dict, Any, Set

from files.paths import (
    BASE_DIR,
    STATIC_DIR,
    DATA_DIR,
    CONTENTS_DIR,
    UPLOADS_DIR,
    TEMPLATES_DIR,
)
from files.storage import content_load, MENU_JSON, menu_default
from utils.json_utils import read_json


def _copytree(src: Path, dst: Path) -> None:
    if not src.exists():
        return
    for p in src.rglob("*"):
        q = dst / p.relative_to(src)
        if p.is_dir():
            q.mkdir(parents=True, exist_ok=True)
        else:
            q.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(p, q)


def _patch_static_urls(html: str) -> str:
    html = html.replace('href="/static/', 'href="./static/')
    html = html.replace("href='/static/", "href='./static/")
    html = html.replace('src="/static/', 'src="./static/')
    html = html.replace("src='/static/", "src='./static/")
    return html


def _inject_api_shim(html: str) -> str:
    shim = """
<script>
// shim для офлайна: /api/menu и /api/content/* читаем из ./data
(function() {
  var origFetch = window.fetch ? window.fetch.bind(window) : null;
  if (!origFetch) return;

  window.fetch = function(input, init) {
    var url = (typeof input === 'string') ? input : (input && input.url) || '';
    init = init || {};

    if (url === '/api/menu' || url.startsWith('/api/menu?')) {
      return origFetch('./data/menu.json', init);
    }

    var m = url.match(/^\\/api\\/content\\/([^/?#]+)/);
    if (m && (!init.method || init.method.toUpperCase() === 'GET')) {
      var id = decodeURIComponent(m[1]);
      return origFetch('./data/contents/' + id + '.json', init);
    }

    if (url.startsWith('/api/')) {
      var body = JSON.stringify({ ok: true });
      return Promise.resolve(new Response(body, {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      }));
    }

    return origFetch(input, init);
  };
})();
</script>
"""
    marker = "<!-- CDN зависимости"
    idx = html.find(marker)
    if idx == -1:
        first_script = html.find("<script")
        if first_script == -1:
            return html + shim
        return html[:first_script] + shim + html[first_script:]
    return html[:idx] + shim + html[idx:]


def _write_main_from_sprav(dest_root: Path) -> None:
    tpl = Path(TEMPLATES_DIR) / "sprav.html"
    index_path = dest_root / "index.html"

    if not tpl.exists():
        index_path.write_text(
            "<!DOCTYPE html><html><body>sprav.html not found</body></html>",
            encoding="utf-8",
        )
        return

    html = tpl.read_text(encoding="utf-8")
    html = _patch_static_urls(html)
    html = _inject_api_shim(html)

    view_mode_js = """
<script>
document.addEventListener('DOMContentLoaded', function () {
  var body = document.body;
  body.classList.remove('edit-mode');
  var toggle = document.getElementById('toggle-edit');
  if (toggle) {
    toggle.checked = false;
    toggle.style.display = 'none';
  }
  var editOnly = document.querySelectorAll('.edit-mode-only');
  editOnly.forEach(function (el) { el.style.display = 'none'; });
});
</script>
"""
    html = html.replace("</body>", view_mode_js + "\n</body>")

    index_path.write_text(html, encoding="utf-8")


def _patch_template_html(template_path: Path) -> str:
    """Преобразует шаблон с url_for('static', ...) в офлайновые пути ./static/..."""
    html = template_path.read_text(encoding="utf-8")
    import re

    pattern = re.compile(
        r"\{\{\s*url_for\('static',\s*filename=['\"]([^'\"]+)['\"]\)\s*\}\}"
    )
    # БЫЛО: html = pattern.sub(r"./static/\\1", html)
    # СТАЛО:
    html = pattern.sub(r"./static/\1", html)

    html = _patch_static_urls(html)
    return html

def _inject_drawings_shim(html: str) -> str:
    shim = """
<script>
(function() {
  var origFetch = window.fetch ? window.fetch.bind(window) : null;
  if (!origFetch) return;

  function getProjectFromUrl() {
    try {
      var params = new URLSearchParams(window.location.search);
      return params.get('project') || 'home';
    } catch (e) {
      return 'home';
    }
  }

  window.fetch = function(input, init) {
    var url = (typeof input === 'string') ? input : (input && input.url) || '';
    init = init || {};

    if (url.indexOf('/list_project_drawings') === 0) {
      var project = getProjectFromUrl();
      var localUrl = './data/drawings/' + encodeURIComponent(project) + '.json';
      return origFetch(localUrl, init);
    }

    if (url.startsWith('/upload') ||
        url.startsWith('/delete_drawing') ||
        url.startsWith('/update_drawing_name')) {
      var body = JSON.stringify({ ok: false, error: 'Offline export: read-only' });
      return Promise.resolve(new Response(body, {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      }));
    }

    return origFetch(input, init);
  };
})();
</script>
"""
    tag = '<script src="./static/js/index.js"></script>'
    idx = html.find(tag)
    if idx != -1:
        return html.replace(tag, shim + "\n" + tag, 1)
    end_body = html.rfind("</body>")
    if end_body == -1:
        return html + shim
    return html[:end_body] + shim + "\n" + html[end_body:]


def _write_drawings_pages(dest_root: Path) -> None:
    idx_tpl = Path(TEMPLATES_DIR) / "index.html"
    if idx_tpl.exists():
        patched = _patch_template_html(idx_tpl)
        patched = _inject_drawings_shim(patched)
        (dest_root / "drawings.html").write_text(patched, encoding="utf-8")

    res_tpl = Path(TEMPLATES_DIR) / "result.html"
    if res_tpl.exists():
        patched = _patch_template_html(res_tpl)
        (dest_root / "drawing_result.html").write_text(patched, encoding="utf-8")

    view_tpl = Path(TEMPLATES_DIR) / "view.html"
    if view_tpl.exists():
        patched = _patch_template_html(view_tpl)
        (dest_root / "drawing_view.html").write_text(patched, encoding="utf-8")


def _collect_menu_ids(node: Dict[str, Any], out: Set[str]) -> None:
    if not isinstance(node, dict):
        return
    nid = node.get("id")
    if isinstance(nid, str) and nid:
        out.add(nid)
    for ch in (node.get("children") or []):
        if isinstance(ch, dict):
            _collect_menu_ids(ch, out)


def _patch_tabs_editor_for_offline(static_root: Path) -> None:
    js_path = static_root / "js" / "tabsEditor.js"
    if not js_path.exists():
        return
    txt = js_path.read_text(encoding="utf-8")
    if "/drawings?project=" not in txt:
        return
    txt = txt.replace("/drawings?project=", "./drawings.html?project=")
    js_path.write_text(txt, encoding="utf-8")

def _patch_drawings_js_for_offline(static_root: Path) -> None:
    """
    Патч JS для офлайна:
      static/js/index.js  – /result? -> ./drawing_result.html?
      static/js/result.js – /view?   -> ./drawing_view.html?
                           – /load_drawing_by_project -> локальный JSON в static/<project>/state/drawings
    """
    # Галерея: переход из списка чертежей на страницу одного чертежа
    idx_js = static_root / "js" / "index.js"
    if idx_js.exists():
        txt = idx_js.read_text(encoding="utf-8")
        if "/result?drawing_id=" in txt:
            txt = txt.replace(
                "/result?drawing_id=",
                "./drawing_result.html?drawing_id=",
            )
        idx_js.write_text(txt, encoding="utf-8")

    # Страница одного чертежа
    res_js = static_root / "js" / "result.js"
    if res_js.exists():
        txt = res_js.read_text(encoding="utf-8")

        # 1) переход к кругу: /view -> drawing_view.html
        if "/view?circle_id=" in txt:
            txt = txt.replace(
                "/view?circle_id=",
                "./drawing_view.html?circle_id=",
            )

        # 2) загрузка данных чертежа: вместо /load_drawing_by_project берём локальный JSON
        old = """fetch(
    `/load_drawing_by_project?project=${encodeURIComponent(
      project
    )}&drawing_id=${encodeURIComponent(drawingId)}`
  )"""
        new = """fetch(
    `./static/${encodeURIComponent(project)}/state/drawings/drawing_${encodeURIComponent(drawingId)}.json`
  )"""

        if old in txt:
            txt = txt.replace(old, new)

        res_js.write_text(txt, encoding="utf-8")



def _build_drawings_json_for_projects(project_ids: Set[str], out_data: Path) -> None:
    drawings_root = out_data / "drawings"
    drawings_root.mkdir(parents=True, exist_ok=True)

    for project in sorted(project_ids):
        folder = STATIC_DIR / project / "state" / "drawings"
        if not folder.exists():
            continue

        items = []
        for p in sorted(folder.glob("drawing_*.json")):
            data = read_json(p)
            drawing_id = data.get("drawing_id") or p.stem.replace("drawing_", "")
            drawing_name = data.get("drawing_name") or f"drawing_{drawing_id}.png"
            display_name = data.get("display_name") or drawing_name
            items.append(
                {
                    "drawing_id": drawing_id,
                    "drawing_name": drawing_name,
                    "display_name": display_name,
                }
            )

        dst = drawings_root / f"{project}.json"
        dst.write_text(
            json.dumps(items, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )


def build_export():
    """
    Экспортирует приложение в офлайн-пакет:

    exports/sprav_export_YYYYMMDD_HHMMSS/
      index.html             – sprav.html (просмотр)
      drawings.html          – галерея чертежей
      drawing_result.html    – страница одного чертежа
      drawing_view.html      – страница круга
      static/
        ...                  – вся статика
        uploads/             – загруженные файлы
      data/
        menu.json
        contents/<id>.json
        drawings/<project>.json
    """
    ts = time.strftime("%Y%m%d_%H%M%S")
    out_root = BASE_DIR / "exports" / f"sprav_export_{ts}"
    out_static = out_root / "static"
    out_data = out_root / "data"

    # 1. Статика
    _copytree(STATIC_DIR, out_static)

    # 2. uploads
    _copytree(UPLOADS_DIR, out_static / "uploads")

    # 3. menu.json
    out_data.mkdir(parents=True, exist_ok=True)
    if MENU_JSON.exists():
        shutil.copy2(MENU_JSON, out_data / "menu.json")
        menu = json.loads(MENU_JSON.read_text(encoding="utf-8"))
    else:
        menu = menu_default()

    # 4. собираем id из меню
    ids: Set[str] = set()
    _collect_menu_ids(menu, ids)
    ids.add("home")

    # 5. contents/<id>.json
    contents_out = out_data / "contents"
    contents_out.mkdir(parents=True, exist_ok=True)

    for item_id in sorted(ids):
        data = content_load(item_id)
        dst = contents_out / f"{item_id}.json"
        dst.write_text(
            json.dumps(data, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )

    # 6. data/drawings/<project>.json
    _build_drawings_json_for_projects(ids, out_data)

    # 7. Главная страница из sprav.html
    _write_main_from_sprav(out_root)

    # 8. Страницы чертежей
    _write_drawings_pages(out_root)

    # 9. Патчи JS под офлайн-навигацию
    _patch_tabs_editor_for_offline(out_static)
    _patch_drawings_js_for_offline(out_static)

    # 10. ZIP рядом
    zip_path = out_root.with_suffix(".zip")
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as z:
        for p in out_root.rglob("*"):
            z.write(p, p.relative_to(out_root.parent))

    return out_root, zip_path
