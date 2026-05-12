// static/js/docFolderSync.js
(() => {
  const $ = (s) => document.querySelector(s);
  const log = (msg) => {
    const el = $("#doc-folder-log");
    if (el) el.textContent = (el.textContent ? el.textContent + "\n" : "") + msg;
    console.log("[DocFolderSync]", msg);
  };

  const hasFS = !!window.showDirectoryPicker;
  const DB_NAME = "doc-folder-sync-db";
  const STORE = "handles";
  let fallbackFiles = [];

  // --- Настройки ---
  let DEBUG = true;          // подробные сообщения
  let STRICT_ONLY = true;    // строгий матч: только папка == заголовку пункта
  const allow = new Set([
    "pdf","doc","docx","xls","xlsx","csv","ppt","pptx","txt","md",
    "jpg","jpeg","png","gif","webp","svg","mp4","webm","ogg","avi","mov"
  ]);

  // --- Утилиты ---
  const norm = (s) => (s || "").trim().toLowerCase();
  const slug = (s) => norm(s).replace(/[^a-zа-яё0-9]+/gi, "");
  const firstSeg = (rel) => (rel || "").split("/")[0] || "";
  const extOf = (name) => (name.split(".").pop() || "").toLowerCase();

  // === IndexedDB для сохранения dirHandle ===
  function openDB() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  async function saveHandle(handle) {
    const db = await openDB();
    await new Promise((res, rej) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(handle, "dir");
      tx.oncomplete = () => res();
      tx.onerror = () => rej(tx.error);
    });
  }
  async function loadHandle() {
    const db = await openDB();
    return new Promise((res, rej) => {
      const tx = db.transaction(STORE, "readonly");
      const rq = tx.objectStore(STORE).get("dir");
      rq.onsuccess = () => res(rq.result || null);
      rq.onerror = () => rej(rq.error);
    });
  }

  // === Обход папки: формируем file._relPath ===
  async function* iterFilesFromHandle(dirHandle, prefix = "") {
    for await (const [name, handle] of dirHandle.entries()) {
      const rel = prefix ? `${prefix}/${name}` : name;
      if (handle.kind === "file") {
        const file = await handle.getFile();
        try { file._relPath = rel; } catch {}
        yield file;
      } else if (handle.kind === "directory") {
        yield* iterFilesFromHandle(handle, rel);
      }
    }
  }

  // === Фолбэк для браузеров без FS API ===
  async function ensureFallbackInput() {
    let fb = $("#pick-doc-folder-fallback");
    if (!fb) {
      fb = document.createElement("input");
      fb.type = "file";
      fb.id = "pick-doc-folder-fallback";
      fb.multiple = true;
      fb.hidden = true;
      fb.setAttribute("webkitdirectory", "");
      document.body.appendChild(fb);
    }
    if (!fb.dataset.hooked) {
      fb.addEventListener("change", (e) => setFallbackFiles(e.target.files));
      fb.dataset.hooked = "1";
    }
    return fb;
  }
  function setFallbackFiles(list) {
    fallbackFiles = Array.from(list || []);
    for (const f of fallbackFiles) {
      if (f.webkitRelativePath && !f._relPath) {
        try { f._relPath = f.webkitRelativePath; } catch {}
      }
    }
    const status = $("#doc-folder-status");
    if (status) status.textContent = `Папка выбрана (fallback): ${fallbackFiles.length} файлов`;
    log(`fallback files: ${fallbackFiles.length}`);
  }

  async function listAllFiles() {
    if (hasFS) {
      const saved = await loadHandle();
      if (!saved) return [];
      const perm = await saved.queryPermission({ mode: "read" });
      if (perm !== "granted") {
        const req = await saved.requestPermission({ mode: "read" });
        if (req !== "granted") return [];
      }
      const files = [];
      for await (const f of iterFilesFromHandle(saved, "")) files.push(f);
      return files;
    }
    await ensureFallbackInput();
    return fallbackFiles;
  }

  // === Серверный аплоад в пункт (по имени, circle_id = menuId) ===
  async function uploadToServer({ file, menuId }) {
    const fd = new FormData();
    fd.append("file", file, file.name);
    fd.append("circle_id", menuId);
    const res = await fetch("/upload_document", { method: "POST", body: fd });
    if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
    return res.json().catch(() => ({}));
  }

  // === Получить уже существующие имена файлов в пункте (чтобы не дублировать) ===
  async function getExistingNames(menuId) {
    try {
      const r = await fetch(`/api/content/${menuId}`);
      const j = await r.json();
      const names = new Set((j.files || []).map(f => f.name.toLowerCase()));
      return names;
    } catch {
      return new Set();
    }
  }

  // === Строгий матч: берем только файлы, у которых 1-й сегмент пути == названию пункта ===
  function matchStrictByFolder(file, openedMenuTitle) {
    const rel = file._relPath || file.webkitRelativePath || "";
    const top = firstSeg(rel);                 // первый сегмент относительного пути
    if (!rel || !top) return { match: false, reason: `no-rel ${rel}` };

    const ok = slug(top) === slug(openedMenuTitle);
    return ok
      ? { match: true, reason: "top-folder" }
      : { match: false, reason: `no-match title="${openedMenuTitle}" file="${file.name}" rel="${rel}"` };
  }

  // === Публичные функции ===
  async function pickFolder() {
    const status = $("#doc-folder-status");
    if (hasFS) {
      try {
        const dir = await window.showDirectoryPicker({ mode: "read" });
        await saveHandle(dir);
        if (status) status.textContent = `Папка выбрана: ${dir.name}`;
        log(`Папка выбрана через FS API: ${dir.name}`);
      } catch (e) {
        log("Отказано в выборе папки или ошибка: " + e.message);
      }
    } else {
      const fb = await ensureFallbackInput();
      fb.click();
    }
  }

  // Ручной запуск: синхронизировать файлы для конкретного пункта
  async function syncForMenu({ id: menuId, title: menuTitle }) {
    const files = await listAllFiles();
    if (!files.length) { log("Нет выбранной папки или браузер не дал файлов."); return; }

    // имена, которые уже лежат в пункте (не заливаем повторно)
    const existing = await getExistingNames(menuId);

    let total = 0, uploaded = 0, skipped = 0, failed = 0;
    for (const file of files) {
      total++;
      const ext = extOf(file.name);
      if (!allow.has(ext)) { skipped++; if (DEBUG) log(`skip: ext '${ext}' not allowed (${file.name})`); continue; }

      const match = !STRICT_ONLY ? { match: true, reason: "all" } : matchStrictByFolder(file, menuTitle);
      if (!match.match) { skipped++; if (DEBUG) log("skip: " + match.reason); continue; }

      // пропускаем дубликат по имени
      if (existing.has(file.name.toLowerCase())) {
        skipped++; if (DEBUG) log(`skip: exists-by-name (${file.name})`); continue;
      }

      try {
        await uploadToServer({ file, menuId });
        uploaded++;
        existing.add(file.name.toLowerCase()); // чтобы в одном прогоне не слать повторно
      } catch (e) {
        failed++; log(`Ошибка загрузки "${file.name}": ${e.message}`);
      }
    }

    log(`Итог: всего=${total} загружено=${uploaded} пропущено=${skipped} ошибок=${failed}`);

    if (uploaded > 0 && typeof window.showContent === "function") {
      window.showContent(menuId, menuTitle); // обновить список файлов
    }
  }

  // Инициализация: только кнопка выбора папки, БЕЗ автозапусков при открытии пункта
  document.addEventListener("DOMContentLoaded", async () => {
    await ensureFallbackInput();
    const btn = $("#pick-doc-folder");
    if (btn && !btn.dataset.hooked) {
      btn.addEventListener("click", pickFolder);
      btn.dataset.hooked = "1";
    }
  });

  // Экспорт в window
  window.DocFolderSync = {
    pickFolder,
    syncForMenu,
    setStrict: (v) => { STRICT_ONLY = !!v; log("STRICT_ONLY=" + STRICT_ONLY); },
    setDebug:  (v) => { DEBUG = !!v;       log("DEBUG=" + DEBUG); },
  };
})();
