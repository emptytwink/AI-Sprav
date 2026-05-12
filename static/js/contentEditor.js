// static/js/contentEditor.js
(() => {
  const $  = (sel, root=document) => root.querySelector(sel);
  const $$ = (sel, root=document) => Array.from(root.querySelectorAll(sel));
  const findTabBtn = (key) =>
    document.querySelector(`.tab-btn[data-tab="${key}"], .tab-btn[data-key="${key}"]`);

  let currentId = null;
  let model = null; // { id, title, text_html, files }

  function isEditMode() { return document.body.classList.contains("edit-mode"); }
  function applyViewEditVisibility() {
    $$(".view-mode-only").forEach(n => n.style.display = isEditMode() ? "none" : "");
    $$(".edit-mode-only").forEach(n => n.style.display = isEditMode() ? "" : "none");
    const titleEl = $("#project-title");
    if (titleEl) {
      titleEl.removeAttribute("contenteditable");
      titleEl.classList.remove("editable-title");
    }
  }

  // ---- API ----
  async function apiGetContent(id) {
    const res = await fetch(`/api/content/${encodeURIComponent(id)}`);
    if (!res.ok) throw new Error("load content error");
    return res.json();
  }

  async function apiSaveContent(id, payload) {
    const res = await fetch(`/api/content/${encodeURIComponent(id)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    if (!res.ok) throw new Error("save content error");
    return res.json();
  }

  async function apiUpload(id, file) {
    const fd = new FormData();
    fd.append("file", file);
    fd.append("circle_id", id);
    const res = await fetch(`/upload_document`, { method: "POST", body: fd });
    if (!res.ok) throw new Error("upload error");
    const j = await res.json();
    if (j.ok && Array.isArray(j.saved) && j.saved[0]) {
      return {
        ok: true,
        file: {
          name: j.saved[0],
          size: file.size,
          url: `/static/uploads/${encodeURIComponent(id)}/${encodeURIComponent(j.saved[0])}`
        }
      };
    }
    return { ok:false };
  }

  async function apiDeleteFile(id, name) {
    const res = await fetch(`/delete_document`, {
      method:"POST",
      headers:{ "Content-Type":"application/json" },
      body: JSON.stringify({ circle_id:id, filename:name })
    });
    if (!res.ok) throw new Error("delete file error");
    return res.json();
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (ch) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch])
    );
  }

  // ---- Текстовое описание (#tab-editor) ----
  function renderDesc() {
    const raw = model?.text_html || "";
    const cleaned = sanitizeHtml(raw);
    const editor = $("#tab-editor");
    if (editor) editor.innerHTML = cleaned;
    if (window.TinyEditor) window.TinyEditor.setHtml(cleaned);
  }

  function applyCmd(cmd, val = null) { document.execCommand(cmd, false, val); }
  function applyBlock(tag) {
    const map = { h1: "H1", h2: "H2", p: "P" };
    document.execCommand("formatBlock", false, map[tag] || "P");
  }

  function sanitizeHtml(html) {
    html = (html || "")
      .replace(/<!--[\s\S]*?-->/g, "")
      .replace(/<\/?(o|w|v):[^>]*>/gi, "")
      .replace(/\s?class=("|\')?Mso[a-zA-Z0-9\- ]*("|\')?/gi, "")
      .replace(/\s?style=("|\')[^"\']*mso-[^"\']*("|\')/gi, "")
      .replace(/<img\b[^>]*\bsrc\s*=\s*("|\')file:[^"\']*\1[^>]*>/gi, "");
    html = html.replace(/\s?style=("|\')[^"\']*("|\')/gi, (m) => {
      const safe = ["text-align", "font-weight", "font-style", "text-decoration"];
      const keep = (m.match(/([a-z\-]+)\s*:\s*[^;]+/gi) || [])
        .filter((r) => safe.some((s) => r.trim().toLowerCase().startsWith(s + ":")));
      return keep.length ? ` style="${keep.join(";")}"` : "";
    });
    return html;
  }

  function bindPasteCleaner() {
    const editor = $("#tab-editor");
    if (!editor || editor.dataset.pasteBound) return;
    editor.dataset.pasteBound = "1";

    editor.addEventListener("paste", async (e) => {
      const cd = e.clipboardData || window.clipboardData;
      if (!cd) return;

      const items = Array.from(cd.items || []);
      const imgItem = items.find((it) => it.type && it.type.startsWith("image/"));
      if (imgItem && currentId) {
        e.preventDefault();
        const file = imgItem.getAsFile?.();
        if (file) {
          try {
            const r = await apiUpload(currentId, file);
            const url = r?.file?.url || (r?.ok && r?.saved?.[0] && `/static/uploads/${currentId}/${r.saved[0]}`);
            if (url) {
              document.execCommand("insertImage", false, url);
              return;
            }
          } catch {}
        }
      }

      e.preventDefault();
      const html = cd.getData("text/html") || "";
      const text = cd.getData("text/plain") || "";
      const clean = html ? sanitizeHtml(html) : text.replace(/\n/g, "<br>");
      document.execCommand("insertHTML", false, clean);
    });
  }

  let descSaveTimer = null;
  function bindDescAutosave() {
    const editor = $("#tab-editor");
    if (!editor || editor.dataset.autosaveBound) return;
    editor.dataset.autosaveBound = "1";

    editor.addEventListener("input", () => {
      const html = editor.innerHTML;
      if (model) model.text_html = html;
      if (descSaveTimer) clearTimeout(descSaveTimer);
      descSaveTimer = setTimeout(async () => {
        if (!currentId) return;
        try {
          await api(`/api/content/${currentId}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ text_html: html })
          });
        } catch {}
      }, 400);
    });
  }

  function bindEditModeToggle() {
    const toggle = $("#toggle-edit");
    const editor = $("#tab-editor");
    if (!toggle || !editor || editor.dataset.modeBound) return;
    editor.dataset.modeBound = "1";

    const apply = () => {
      const on = !!toggle.checked;
      editor.setAttribute("contenteditable", on ? "true" : "false");
      $$(".edit-mode-only").forEach(el => el.toggleAttribute("hidden", !on));
      $$(".view-mode-only").forEach(el => el.toggleAttribute("hidden", on));
    };

    toggle.addEventListener("change", apply);
    apply();
  }

  function initDescEditor() {
    renderDesc();
    bindPasteCleaner();
    bindDescAutosave();
    bindEditModeToggle();
  }

  function bindDescToolbar(){
    $$(".rte-toolbar [data-cmd]").forEach(btn =>
      btn.addEventListener("click",()=>applyCmd(btn.dataset.cmd))
    );
    $("#rte-block")?.addEventListener("change", e=>applyBlock(e.target.value));
    $("#rte-fontsize")?.addEventListener("change", e=>applyCmd("fontSize", e.target.value));
    $("#rte-link")?.addEventListener("click", ()=>{
      const url=prompt("Ссылка (https://…):","https://");
      if(url) applyCmd("createLink", url);
    });
    $("#rte-insert-image")?.addEventListener("click", async ()=>{
      if(!currentId) return;
      const input=document.createElement("input");
      input.type="file";
      input.accept="image/*";
      input.onchange=async ()=>{
        const file=input.files?.[0];
        if(!file) return;
        const r=await apiUpload(currentId, file);
        if(r?.ok && r.file?.url){
          document.execCommand("insertImage", false, r.file.url);
          setTimeout(()=>window.ImageTools?.wrapImagesInEditor(),0);
        }
      };
      input.click();
    });
    $("#rte-insert-table")?.addEventListener("click", ()=>{
      const rows=Math.max(1,parseInt(prompt("Строк:","2")||"2",10));
      const cols=Math.max(1,parseInt(prompt("Колонок:","2")||"2",10));
      const table=document.createElement("table");
      table.style.borderCollapse="collapse";
      table.style.width="100%";
      for(let r=0;r<rows;r++){
        const tr=document.createElement("tr");
        for(let c=0;c<cols;c++){
          const td=document.createElement("td");
          td.textContent=" ";
          td.style.border="1px solid #ccc";
          td.style.padding="6px";
          tr.appendChild(td);
        }
        table.appendChild(tr);
      }
      const tmp=document.createElement("div");
      tmp.appendChild(table);
      document.execCommand("insertHTML", false, tmp.innerHTML);
    });
  }

  // ---- Документы: фильтры, ZIP-просмотр, STL ----

  function humanSize(n) {
    if (n == null) return "";
    const u = ["B", "KB", "MB", "GB", "TB"];
    let i = 0, v = Number(n) || 0;
    while (v >= 1024 && i < u.length - 1) {
      v /= 1024;
      i++;
    }
    return `${v.toFixed(i === 0 ? 0 : 1)} ${u[i]}`;
  }

  let docsSort       = "date-desc";
  let docsFilter     = "";
  let docsTypeFilter = "all"; // all | pdf | image | 3d | video | archive | other

  function getFileDateValue(f) {
    const raw =
      f.uploaded_at ||
      f.added_at ||
      f.created_at ||
      f.mtime ||
      f.mtime_iso ||
      null;
    if (!raw) return 0;
    const t = Date.parse(raw);
    return Number.isNaN(t) ? 0 : t;
  }

  function formatFileDate(f) {
    const ts = getFileDateValue(f);
    if (!ts) return "";
    const d = new Date(ts);
    const pad = (n) => String(n).padStart(2, "0");
    return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${pad(d.getFullYear())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  function getFileType(f) {
    const name = (f.name || "").toLowerCase();
    if (/\.(pdf)$/.test(name)) return "pdf";
    if (/\.(xlsx?|csv)$/.test(name)) return "excel";
    if (/\.(txt|md|log|json|xml|ya?ml|ini|conf)$/.test(name)) return "text";
    if (/\.(png|jpg|jpeg|gif|bmp|webp|tif|tiff)$/.test(name)) return "image";
    if (/\.(stl|stp|step)$/.test(name)) return "3d";
    if (/\.(mp4|webm|avi|mov|mkv)$/.test(name)) return "video";
    if (/\.(zip|rar|7z)$/.test(name)) return "archive";
    return "other";
  }

  function isStlFile(name) {
    return /\.stl$/i.test(name || "");
  }

  function isZipArchive(name) {
    return /\.zip$/i.test(name || "");
  }

  function getFileBadge(name) {
    const ext = ((name || "").split(".").pop() || "").toUpperCase();
    if (!ext) return "FILE";
    if (ext === "JPEG") return "JPG";
    if (ext === "YAML") return "YML";
    return ext.slice(0, 6);
  }

  // Просмотр содержимого ZIP-архива через JSZip
  const ArchiveViewer = {
    async show(url, name) {
      const box = $("#doc-preview");
      if (!box) return;
      box.classList.remove("hidden");
      box.innerHTML = `<div class="archive-view"><div class="archive-header">
        <div class="archive-header-title">${escapeHtml(name || "")}</div>
        <div class="archive-header-count">Загрузка архива…</div>
      </div></div>`;

      if (!window.JSZip) {
        box.innerHTML = `<div class="archive-view">
          <div class="archive-header">
            <div class="archive-header-title">${escapeHtml(name || "")}</div>
          </div>
          <div class="archive-preview">
            Не подключена библиотека JSZip. Архив можно только скачать и открыть во внешней программе.
          </div>
        </div>`;
        return;
      }

      let arrayBuf;
      try {
        const res = await fetch(url);
        if (!res.ok) throw new Error("http error");
        arrayBuf = await res.arrayBuffer();
      } catch (e) {
        box.innerHTML = `<div class="archive-view">
          <div class="archive-header">
            <div class="archive-header-title">${escapeHtml(name || "")}</div>
          </div>
          <div class="archive-preview">
            Ошибка загрузки архива.
          </div>
        </div>`;
        return;
      }

      let zip;
      try {
        zip = await JSZip.loadAsync(arrayBuf);
      } catch (e) {
        box.innerHTML = `<div class="archive-view">
          <div class="archive-header">
            <div class="archive-header-title">${escapeHtml(name || "")}</div>
          </div>
          <div class="archive-preview">
            Не удалось прочитать ZIP-архив. Попробуйте открыть во внешнем приложении.
          </div>
        </div>`;
        return;
      }

      const entries = Object.keys(zip.files)
        .map(k => zip.files[k])
        .filter(f => !f.dir)
        .sort((a, b) => a.name.localeCompare(b.name, "ru"));

      box.innerHTML = `
        <div class="archive-view">
          <div class="archive-header">
            <div class="archive-header-title">${escapeHtml(name || "")}</div>
            <div class="archive-header-count">Файлов: ${entries.length}</div>
          </div>
          <div class="archive-body">
            <div class="archive-file-list"><ul></ul></div>
            <div class="archive-preview">
              <div>Выберите файл в списке слева</div>
            </div>
          </div>
        </div>
      `;

      const listEl = box.querySelector(".archive-file-list ul");
      const previewEl = box.querySelector(".archive-preview");
      if (!listEl || !previewEl) return;

      const makeEntrySize = (f) => {
        if (!f._data || !f._data.uncompressedSize) return "";
        return humanSize(f._data.uncompressedSize);
      };

      entries.forEach((f, idx) => {
        const li = document.createElement("li");
        li.className = "archive-entry";
        li.innerHTML = `
          <span>${escapeHtml(f.name)}</span>
          <small>${makeEntrySize(f) || ""}</small>
        `;
        li.addEventListener("click", async () => {
          $$(".archive-entry", listEl).forEach(n => n.classList.remove("active"));
          li.classList.add("active");
          previewEl.innerHTML = "Загрузка…";

          const lower = f.name.toLowerCase();
          try {
            if (/\.(png|jpg|jpeg|gif|webp|bmp|tif|tiff)$/.test(lower)) {
              const blob = await f.async("blob");
              const url = URL.createObjectURL(blob);
              previewEl.innerHTML = `<img src="${url}" alt="">`;
            } else if (/\.(pdf)$/.test(lower)) {
              const blob = await f.async("blob");
              const url = URL.createObjectURL(blob);
              previewEl.innerHTML = `<iframe src="${url}" title="${escapeHtml(f.name)}"></iframe>`;
            } else if (/\.(txt|log|md|json|csv|xml|html|htm)$/.test(lower)) {
              const text = await f.async("string");
              previewEl.innerHTML = `<pre>${escapeHtml(text)}</pre>`;
            } else {
              // неизвестный тип — предлагаем скачать
              const blob = await f.async("blob");
              const url = URL.createObjectURL(blob);
              previewEl.innerHTML = `
                <div>
                  <p>Этот тип файла нельзя просмотреть в приложении.</p>
                  <p><a href="${url}" download="${escapeHtml(f.name)}">Скачать файл</a></p>
                </div>
              `;
            }
          } catch (e) {
            previewEl.innerHTML = "Ошибка при чтении файла из архива.";
          }
        });

        listEl.appendChild(li);
        if (idx === 0) li.click();
      });
    },

    clear() {
      const box = $("#doc-preview");
      if (box) box.innerHTML = "";
    }
  };

  function getFilteredFiles() {
    const all = Array.isArray(model?.files) ? [...model.files] : [];
    const q = (docsFilter || "").trim().toLowerCase();

    let result = all;

    if (docsTypeFilter !== "all") {
      result = result.filter((f) => getFileType(f) === docsTypeFilter);
    }

    if (q) {
      result = result.filter((f) => {
        const name = (f.name || "").toLowerCase();
        const ext = (f.name || "").split(".").pop().toLowerCase();
        return name.includes(q) || ext.includes(q);
      });
    }

    const [field, dir] = docsSort.split("-");
    const sign = dir === "asc" ? 1 : -1;

    result.sort((a, b) => {
      let va = 0;
      let vb = 0;

      if (field === "name") {
        va = (a.name || "").toLowerCase();
        vb = (b.name || "").toLowerCase();
        if (va < vb) return -1 * sign;
        if (va > vb) return 1 * sign;
        return 0;
      }

      if (field === "size") {
        va = Number(a.size) || 0;
        vb = Number(b.size) || 0;
      } else if (field === "date") {
        va = getFileDateValue(a);
        vb = getFileDateValue(b);
      }

      if (va < vb) return -1 * sign;
      if (va > vb) return 1 * sign;
      return 0;
    });

    return result;
  }

  function renderDocs() {
    const listV = $("#docs-view");
    const listE = $("#docs-edit-list");
    if (!listV || !listE) return;

    listV.innerHTML = "";
    listE.innerHTML = "";

    const all   = Array.isArray(model?.files) ? model.files : [];
    const files = getFilteredFiles();

    const counter = $("#docs-counter");
    if (counter) {
      if (!all.length) {
        counter.textContent = "Файлы не добавлены";
      } else if (files.length === all.length) {
        counter.textContent = `Файлов: ${all.length}`;
      } else if (!files.length) {
        counter.textContent = "Ничего не найдено";
      } else {
        counter.textContent = `Показано: ${files.length} из ${all.length}`;
      }
    }

    files.forEach((f) => {
      const dateStr = formatFileDate(f);
      const sizeStr = f.size != null ? humanSize(f.size) : "";

      const li = document.createElement("li");
      li.className = "file-item";
      li.dataset.url  = f.url;
      li.dataset.name = f.name || "";

      li.innerHTML = `
        <div class="file-main">
          <span class="file-name">${escapeHtml(f.name || "Без имени")}</span>
        </div>
        <div class="file-meta">
          <span class="file-type-badge">${escapeHtml(getFileBadge(f.name))}</span>
          ${window.FileViewer?.isText?.(f.name) || window.FileViewer?.isExcel?.(f.name) ? `<span class="file-action-label">Просмотр</span>` : ""}
          ${dateStr ? `<span class="file-date" title="Дата добавления">${dateStr}</span>` : ""}
          ${sizeStr ? `<span class="file-size">${sizeStr}</span>` : ""}
        </div>
      `;

      li.addEventListener("click", () => {
        $$("#docs-view .file-item").forEach((n) =>
          n.classList.remove("active")
        );
        li.classList.add("active");

        if (f.url && f.name) {
          const name = f.name;
          if (isStlFile(name) && window.STLViewer) {
            STLViewer.show(f.url, f.name);
          }
          // ZIP — просмотр содержимого
          else if (isZipArchive(name)) {
            ArchiveViewer.show(f.url, f.name);
          }
          // Остальное — стандартный FileViewer
          else {
            FileViewer.show(f.url, f.name, currentId);
          }

          $$(".tab-btn").forEach((b) => b.classList.remove("active"));
          $$(".tab-body").forEach((b) => b.classList.remove("active"));
          const btnDocs = findTabBtn("docs");
          if (btnDocs) btnDocs.classList.add("active");
          $("#tab-docs")?.classList.add("active");
        }
      });

      listV.appendChild(li);

      const liE = document.createElement("li");
      liE.className = "file-item";
      liE.dataset.url  = f.url;
      liE.dataset.name = f.name || "";

      liE.innerHTML = `
        <div class="file-main">
          <span class="file-name">${escapeHtml(f.name || "Без имени")}</span>
        </div>
        <div class="file-meta">
          <span class="file-type-badge">${escapeHtml(getFileBadge(f.name))}</span>
          ${dateStr ? `<span class="file-date">${dateStr}</span>` : ""}
          ${sizeStr ? `<span class="file-size">${sizeStr}</span>` : ""}
          <button type="button" class="btn danger file-delete">Удалить</button>
        </div>
      `;

      liE.querySelector(".file-delete")?.addEventListener("click", async () => {
        await apiDeleteFile(model.id, f.name);
        model.files = (model.files || []).filter((x) => x.name !== f.name);
        renderDocs();
        FileViewer.clear();
        ArchiveViewer.clear();
        if (window.STLViewer) STLViewer.clear?.();
      });

      listE.appendChild(liE);
    });

    if (files.length) {
      const first = listV.querySelector(".file-item");
      if (first && !listV.querySelector(".file-item.active")) {
        first.click();
      }
    } else {
      FileViewer.clear();
      ArchiveViewer.clear();
      if (window.STLViewer) STLViewer.clear?.();
    }
  }

  function bindDocsUpload() {
    const btn = $("#docs-btn-upload");
    const inp = $("#docs-file-input");

    if (btn && !btn.dataset.bound) {
      btn.dataset.bound = "1";
      btn.addEventListener("click", async () => {
        if (!inp || !inp.files || !inp.files.length || !currentId) return;
        const file = inp.files[0];
        const r = await apiUpload(currentId, file);
        if (r?.ok && r.file) {
          const f = r.file;
          f.uploaded_at = new Date().toISOString();
          model.files = model.files || [];
          model.files.push(f);
          renderDocs();
          inp.value = "";
        }
      });
    }

    const zone = $("#tab-docs");
    if (!zone || zone.dataset.dndBound) return;
    zone.dataset.dndBound = "1";

    ["dragenter","dragover"].forEach(ev =>
      zone.addEventListener(ev, e => {
        e.preventDefault();
        e.stopPropagation();
        zone.classList.add("dragging");
      })
    );
    ["dragleave","drop"].forEach(ev =>
      zone.addEventListener(ev, e => {
        e.preventDefault();
        e.stopPropagation();
        zone.classList.remove("dragging");
      })
    );
    zone.addEventListener("drop", async e => {
      if (!currentId) return;
      const files = Array.from(e.dataTransfer.files || []);
      for (const file of files) {
        const r = await apiUpload(currentId, file);
        if (r?.ok && r.file) {
          const f = r.file;
          f.uploaded_at = new Date().toISOString();
          model.files = model.files || [];
          model.files.push(f);
        }
      }
      renderDocs();
    });
  }

  function bindDocsToolbar() {
    const search = $("#docs-search-input");
    const sort   = $("#docs-sort-select");
    const type   = $("#docs-type-select");
    const modeButtons = $$(".docs-mode-btn"); // если решишь оставить режимы

    if (search && !search.dataset.bound) {
      search.dataset.bound = "1";
      search.addEventListener("input", () => {
        docsFilter = search.value || "";
        renderDocs();
      });
    }

    if (sort && !sort.dataset.bound) {
      sort.dataset.bound = "1";
      sort.addEventListener("change", () => {
        docsSort = sort.value || "date-desc";
        renderDocs();
      });
    }

    if (type && !type.dataset.bound) {
      type.dataset.bound = "1";
      type.addEventListener("change", () => {
        docsTypeFilter = type.value || "all";
        renderDocs();
      });
    }

    // не обязательно, но можно использовать для «быстрых режимов»
    if (modeButtons.length && !modeButtons[0].dataset.boundMode) {
      modeButtons.forEach(btn => {
        btn.dataset.boundMode = "1";
        btn.addEventListener("click", () => {
          const val = btn.dataset.mode || "all";
          docsTypeFilter = val; // например: data-mode="archive" -> фильтр только архивы
          if (type) type.value = val === "all" ? "all" : (val || "all");
          modeButtons.forEach(b => b.classList.toggle("active", b === btn));
          renderDocs();
        });
      });
    }
  }

  // ---- Сохранение ----
  async function saveAll() {
    if (!currentId || !model) return;

    const titleEl = $("#project-title");
    const newProjectTitle = titleEl ? titleEl.textContent.trim() : "";

    try {
      const home = await apiGetContent("home");
      const homePayload = {
        id: "home",
        title: newProjectTitle || (home?.title || ""),
        text_html: home?.text_html || ""
      };
      await apiSaveContent("home", homePayload);
    } catch (e) {
      console.error("Не удалось сохранить заголовок проекта (home):", e);
    }

    const payload = {
      id: model.id,
      text_html: $("#desc-editable").innerHTML
    };
    await apiSaveContent(currentId, payload);

    toast("Сохранено");
  }

  function bindSaveButton(){ $("#btn-save-content")?.addEventListener("click", saveAll); }
  function toast(m){ console.log(m); }

  // ---- Вкладки ----
  function initTabs() {
    $$(".tab-btn").forEach(btn => {
      btn.addEventListener("click", () => {
        $$(".tab-btn").forEach(b => b.classList.remove("active"));
        $$(".tab-body").forEach(b => b.classList.remove("active"));

        btn.classList.add("active");

        const k = btn.dataset.tab || btn.dataset.key;
        const body = document.getElementById(`tab-${k}`);
        if (body) body.classList.add("active");

        $$(".tab-body").forEach(sec => {
          sec.toggleAttribute("hidden", !sec.classList.contains("active"));
        });
      });
    });
  }

  // ---- Публичный хук ----
  window.showContent = async (id, title = "") => {
    currentId = id;

    window.currentId = currentId;
    window.getCurrentContentId = () => currentId;
    const pane = $("#content-pane");
    if (pane) pane.dataset.currentId = currentId;

    $("#content-title").textContent = title || (id === "home" ? "Главная" : "Без названия");
    try {
      model = await apiGetContent(id);
    } catch {
      model = { id, title, text_html: "", files: [] };
    }

    renderDesc();
    renderDocs();
    FileViewer.clear();
    ArchiveViewer.clear();
    if (window.STLViewer) STLViewer.clear?.();
    applyViewEditVisibility();

    if (window.TabsEditor && typeof TabsEditor.loadAndRender === "function") {
      await TabsEditor.loadAndRender({ id, title });
    }
  };

  // ---- Инициализация ----
  document.addEventListener("DOMContentLoaded", ()=>{
    initTabs();
    bindDocsUpload();
    bindDocsToolbar();
    bindSaveButton();
    bindDescToolbar();
    bindPasteCleaner();
    initDescEditor();

    if (typeof window.showContent === "function") window.showContent("home","Главная");

    const goHome = $("#go-home");
    if (goHome) goHome.addEventListener("click", (e)=>{
      e.preventDefault();
      if (window.showContent) window.showContent("home","Главная");
    });

    const mo=new MutationObserver(()=>applyViewEditVisibility());
    mo.observe(document.body,{ attributes:true, attributeFilter:["class"] });
    applyViewEditVisibility();
  });

  // === Авто-высота вкладок ===
  (function () {
    function px(n) { return n != null ? `${n}px` : ""; }

    function availableHeight(fromEl) {
      const rect = fromEl.getBoundingClientRect();
      const gap = 12;
      return Math.max(120, window.innerHeight - rect.top - gap);
    }

    function switchTabs(tab) {
      document.querySelectorAll(".tab-btn").forEach(b => b.classList.remove("active"));
      document.querySelectorAll(".tab-body").forEach(b => b.classList.remove("active"));

      const btn = document.querySelector(`.tab-btn[data-tab="${tab}"]`);
      const body = document.getElementById(`tab-${tab}`);

      if (btn && body) {
        btn.classList.add("active");
        body.classList.add("active");
      }
    }
    window.switchTabs = switchTabs;

    function resizeDesc() {
      const tab = document.getElementById("tab-desc");
      if (!tab || !tab.classList.contains("active")) return;

      const view = document.getElementById("desc-view");
      if (view) {
        view.style.height = "";
        view.style.maxHeight = "none";
        view.style.overflow = "visible";
      }

      const editWrap = document.getElementById("desc-edit");
      const rich = document.querySelector("#desc-edit .richbox");
      if (editWrap && rich) {
        const tb = editWrap.querySelector(".rte-toolbar");
        const tbH = tb ? tb.offsetHeight : 0;
        rich.style.minHeight = `${Math.max(200, window.innerHeight - tbH - 200)}px`;
        rich.style.height = "";
      }
    }

    function resizeDocs() {
      const tab = document.getElementById("tab-docs");
      if (!tab || !tab.classList.contains("active")) return;

      const preview = document.querySelector("#tab-docs .docs-preview");
      const box = document.getElementById("doc-preview");
      if (preview) {
        const h = availableHeight(preview);
        preview.style.height = px(h);
      }
      if (box) {
        const h = availableHeight(box);
        box.style.height = px(h);
      }
    }

    function resizeActiveTab() {
      resizeDesc();
      resizeDocs();
    }

    window.addEventListener("resize", resizeActiveTab);

    document.addEventListener("DOMContentLoaded", () => {
      document.querySelectorAll(".tab-btn").forEach(btn => {
        btn.addEventListener("click", () => {
          requestAnimationFrame(resizeActiveTab);
        });
      });
      resizeActiveTab();
    });

    window.setTimeout(resizeActiveTab, 200);
  })();

})();
