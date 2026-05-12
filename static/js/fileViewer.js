// static/js/fileViewer.js
(() => {
  const $ = (sel, root = document) => root.querySelector(sel);

  const isImage = (name = "") => /\.(png|jpe?g|gif|webp|svg)$/i.test(name);
  const isPdf = (name = "") => /\.pdf$/i.test(name);
  const isDocx = (name = "") => /\.docx$/i.test(name);
  const isExcel = (name = "") => /\.(xlsx?|csv)$/i.test(name);
  const isPptx = (name = "") => /\.pptx$/i.test(name);
  const isText = (name = "") => /\.(txt|md|log|json|xml|ya?ml|ini|conf)$/i.test(name);

  const toAbsolute = (url = "") => {
    try { return new URL(url, window.location.href).href; } catch { return url; }
  };

  async function loadOnce(src, ok) {
    if (ok()) return true;
    await new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = src;
      script.onload = resolve;
      script.onerror = reject;
      document.head.appendChild(script);
    });
    return ok();
  }

  function clear() {
    const box = $("#doc-preview");
    if (box) {
      box.classList.add("hidden");
      box.innerHTML = "";
    }
  }

  async function show(url, name, itemId = "") {
    const box = $("#doc-preview");
    if (!box) return;
    box.classList.remove("hidden");
    box.innerHTML = `<div class="viewer-state">Загрузка файла...</div>`;

    const absolute = toAbsolute(url);

    if (isImage(name)) return renderImage(box, absolute);
    if (isPdf(name)) return renderPdf(box, absolute);
    if (isDocx(name)) return renderDocx(box, absolute, name);
    if (isExcel(name)) return renderExcel(box, absolute, name);
    if (isText(name)) return renderText(box, absolute, name, itemId);
    if (isPptx(name)) return renderPptx(box, absolute);

    box.innerHTML = `
      <div class="viewer-state">
        Встроенный просмотр этого формата не поддерживается.
        <a href="${escapeAttr(absolute)}" target="_blank" rel="noopener">Открыть или скачать</a>
      </div>
    `;
  }

  function renderImage(box, absolute) {
    const img = document.createElement("img");
    img.src = absolute;
    img.alt = "";
    box.innerHTML = "";
    box.appendChild(img);
  }

  async function renderPdf(box, absolute) {
    const canEmbed = !/\bwv\b/i.test(navigator.userAgent);
    if (canEmbed) {
      box.innerHTML = `
        <embed src="${escapeAttr(absolute)}" type="application/pdf" style="width:100%;height:100%;">
        <p class="viewer-hint">Если PDF не отображается, <a href="${escapeAttr(absolute)}" target="_blank" rel="noopener">откройте в новой вкладке</a>.</p>
      `;
      setTimeout(() => {
        const embed = box.querySelector("embed");
        if (!embed || embed.clientHeight < 50) renderPdfWithPdfJs(box, absolute);
      }, 400);
      return;
    }
    await renderPdfWithPdfJs(box, absolute);
  }

  async function renderPdfWithPdfJs(box, absolute) {
    const pdfJsUrl = "https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.min.js";
    const workerUrl = "https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js";

    try {
      await loadOnce(pdfJsUrl, () => !!window.pdfjsLib);
      window.pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;
      const wrap = document.createElement("div");
      wrap.className = "pdfjs-pages";
      box.innerHTML = "";
      box.appendChild(wrap);

      const doc = await window.pdfjsLib.getDocument({ url: absolute }).promise;
      for (let pageNo = 1; pageNo <= doc.numPages; pageNo += 1) {
        const page = await doc.getPage(pageNo);
        const viewport = page.getViewport({ scale: 1.25 });
        const canvas = document.createElement("canvas");
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        const ctx = canvas.getContext("2d");
        await page.render({ canvasContext: ctx, viewport }).promise;
        wrap.appendChild(canvas);
      }
    } catch {
      box.innerHTML = `<div class="viewer-state">PDF не удалось отобразить. <a href="${escapeAttr(absolute)}" target="_blank" rel="noopener">Открыть файл</a></div>`;
    }
  }

  async function renderDocx(box, absolute, name) {
    try {
      await loadOnce("https://unpkg.com/mammoth@1.6.0/mammoth.browser.min.js", () => !!window.mammoth);
      const ab = await fetchArrayBuffer(absolute);
      const res = await window.mammoth.convertToHtml({ arrayBuffer: ab }, { convertImage: window.mammoth.images.inline() });
      box.innerHTML = `<div class="docx-html">${res.value}</div>`;
    } catch {
      const hint = /\.doc$/i.test(name || "") ? " Старый .doc лучше сохранить как .docx." : "";
      box.innerHTML = `<div class="viewer-state">Не удалось отобразить Word-документ.${hint} <a href="${escapeAttr(absolute)}" target="_blank" rel="noopener">Скачать</a></div>`;
    }
  }

  async function renderExcel(box, absolute, name) {
    try {
      await loadOnce("https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js", () => !!window.XLSX);
      const ab = await fetchArrayBuffer(absolute);
      const wb = window.XLSX.read(ab, { type: "array" });
      const tabs = document.createElement("div");
      tabs.className = "xlsx-tabs";
      const wrap = document.createElement("div");
      wrap.className = "xlsx-wrap";
      const content = document.createElement("div");
      content.className = "xlsx-content";
      wrap.appendChild(content);
      box.innerHTML = "";
      box.appendChild(tabs);
      box.appendChild(wrap);

      const renderSheet = (sheetName) => {
        const ws = wb.Sheets[sheetName];
        const raw = window.XLSX.utils.sheet_to_html(ws, { id: "xlsx-preview", editable: false });
        const tmp = document.createElement("div");
        tmp.innerHTML = raw;
        const table = tmp.querySelector("table");
        if (table) table.classList.add("xlsx-table");
        content.innerHTML = "";
        content.appendChild(table || document.createTextNode("Лист пустой."));
      };

      wb.SheetNames.forEach((sheetName, index) => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "xlsx-tab" + (index === 0 ? " active" : "");
        button.textContent = sheetName;
        button.addEventListener("click", () => {
          tabs.querySelectorAll(".xlsx-tab").forEach((node) => node.classList.remove("active"));
          button.classList.add("active");
          renderSheet(sheetName);
        });
        tabs.appendChild(button);
      });
      renderSheet(wb.SheetNames[0]);
    } catch {
      box.innerHTML = `<div class="viewer-state">Не удалось отобразить Excel-файл. <a href="${escapeAttr(absolute)}" target="_blank" rel="noopener">Скачать ${escapeHtml(name || "файл")}</a></div>`;
    }
  }

  async function renderText(box, absolute, name, itemId) {
    try {
      const data = await loadTextData(absolute, name, itemId);
      buildTextPreview(box, data, absolute);
    } catch (err) {
      box.innerHTML = `<div class="viewer-state">${escapeHtml(err.message || "Не удалось открыть текстовый файл.")} <a href="${escapeAttr(absolute)}" target="_blank" rel="noopener">Скачать</a></div>`;
    }
  }

  async function loadTextData(absolute, name, itemId) {
    if (itemId) {
      const apiUrl = `/api/text-file?item_id=${encodeURIComponent(itemId)}&filename=${encodeURIComponent(name)}`;
      const res = await fetch(apiUrl);
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || "Не удалось прочитать файл.");
      return data;
    }

    const res = await fetch(absolute);
    if (!res.ok) throw new Error("Не удалось загрузить файл.");
    const size = Number(res.headers.get("content-length")) || 0;
    if (size > 5 * 1024 * 1024) throw new Error("Файл слишком большой для встроенного просмотра.");
    const ab = await res.arrayBuffer();
    const text = decodeText(ab);
    return {
      ok: true,
      filename: name,
      ext: (name.match(/\.[^.]+$/) || [""])[0].toLowerCase(),
      encoding: "auto",
      size_bytes: ab.byteLength,
      line_count: text ? text.split(/\r\n|\r|\n/).length : 0,
      content: text,
    };
  }

  function buildTextPreview(box, data, absolute) {
    let fontSize = 14;
    let wrap = true;
    let activeIndex = 0;
    let matches = [];

    box.innerHTML = `
      <div class="text-inline-viewer">
        <div class="text-inline-toolbar">
          <input class="text-inline-search" type="search" placeholder="Поиск по тексту">
          <span class="text-inline-counter">0/0</span>
          <button type="button" data-text-prev>Предыдущее</button>
          <button type="button" data-text-next>Следующее</button>
          <label><input type="checkbox" data-text-wrap checked> Перенос строк</label>
          <button type="button" data-text-smaller>A-</button>
          <button type="button" data-text-bigger>A+</button>
          <button type="button" data-text-copy>Копировать</button>
          <a href="${escapeAttr(absolute)}" download="${escapeAttr(data.filename || "")}">Скачать</a>
          <a href="${escapeAttr(absolute)}" target="_blank" rel="noopener">Открыть</a>
        </div>
        <div class="text-inline-meta">
          ${escapeHtml(data.filename || "")} · ${escapeHtml(data.encoding || "auto")} · ${humanSize(data.size_bytes)} · строк: ${data.line_count || 0}
        </div>
        <pre class="text-inline-content"></pre>
      </div>
    `;

    const search = $(".text-inline-search", box);
    const counter = $(".text-inline-counter", box);
    const pre = $(".text-inline-content", box);

    const render = () => {
      pre.style.fontSize = `${fontSize}px`;
      pre.classList.toggle("is-nowrap", !wrap);
      const query = search.value || "";
      if (!query) {
        pre.textContent = data.content || "";
        matches = [];
        counter.textContent = "0/0";
        return;
      }
      let index = 0;
      matches = [];
      const re = new RegExp(escapeRegExp(query), "gi");
      pre.innerHTML = escapeHtml(data.content || "").replace(re, (match) => {
        const active = index === activeIndex;
        matches.push(index);
        index += 1;
        return `<mark class="${active ? "active" : ""}">${escapeHtml(match)}</mark>`;
      });
      if (matches.length && activeIndex >= matches.length) activeIndex = 0;
      counter.textContent = matches.length ? `${activeIndex + 1}/${matches.length}` : "0/0";
      pre.querySelector("mark.active")?.scrollIntoView({ block: "center" });
    };

    search.addEventListener("input", () => { activeIndex = 0; render(); });
    $("[data-text-prev]", box).addEventListener("click", () => {
      if (!matches.length) return;
      activeIndex = (activeIndex - 1 + matches.length) % matches.length;
      render();
    });
    $("[data-text-next]", box).addEventListener("click", () => {
      if (!matches.length) return;
      activeIndex = (activeIndex + 1) % matches.length;
      render();
    });
    $("[data-text-wrap]", box).addEventListener("change", (event) => {
      wrap = event.target.checked;
      render();
    });
    $("[data-text-smaller]", box).addEventListener("click", () => {
      fontSize = Math.max(10, fontSize - 1);
      render();
    });
    $("[data-text-bigger]", box).addEventListener("click", () => {
      fontSize = Math.min(28, fontSize + 1);
      render();
    });
    $("[data-text-copy]", box).addEventListener("click", () => navigator.clipboard?.writeText(data.content || ""));
    render();
  }

  async function renderPptx(box, absolute) {
    try {
      await loadOnce("https://cdn.jsdelivr.net/npm/pptx-preview@1.4.0/dist/pptx-preview.min.js", () => !!(window.pptxPreview && window.pptxPreview.init));
      const height = Math.max(Math.round(window.innerHeight * 0.85), 600);
      box.innerHTML = "";
      const preview = window.pptxPreview.init(box, { width: box.clientWidth || 960, height });
      await preview.preview(await fetchArrayBuffer(absolute));
    } catch {
      box.innerHTML = `<div class="viewer-state">Не удалось отобразить презентацию. <a href="${escapeAttr(absolute)}" target="_blank" rel="noopener">Скачать</a></div>`;
    }
  }

  async function fetchArrayBuffer(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.arrayBuffer();
  }

  function decodeText(arrayBuffer) {
    for (const encoding of ["utf-8", "windows-1251", "iso-8859-1"]) {
      try {
        return new TextDecoder(encoding, { fatal: true }).decode(arrayBuffer);
      } catch {}
    }
    return new TextDecoder("utf-8").decode(arrayBuffer);
  }

  function humanSize(n) {
    const units = ["Б", "КБ", "МБ", "ГБ"];
    let value = Number(n) || 0;
    let i = 0;
    while (value >= 1024 && i < units.length - 1) {
      value /= 1024;
      i += 1;
    }
    return `${value.toFixed(i ? 1 : 0)} ${units[i]}`;
  }

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, (ch) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    }[ch]));
  }

  function escapeAttr(value) {
    return escapeHtml(value).replace(/`/g, "&#96;");
  }

  function escapeRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  window.FileViewer = { show, clear, isText, isExcel };
})();
