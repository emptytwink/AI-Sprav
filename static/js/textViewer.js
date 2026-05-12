(() => {
  const TEXT_EXT_RE = /\.(txt|md|log|csv|json|xml|ya?ml|ini|conf)$/i;
  let state = { text: "", matches: 0, index: -1, fontSize: 14, wrap: true, downloadUrl: "", filename: "" };

  function isTextFile(name = "") {
    return TEXT_EXT_RE.test(name);
  }

  async function show(itemId, file) {
    ensureModal();
    state = { text: "", matches: 0, index: -1, fontSize: 14, wrap: true, downloadUrl: file.url, filename: file.name };
    openModal();
    setTitle(file.name);
    setBody("Загрузка файла...");
    setMeta("");
    setSearch("");

    try {
      const url = `/api/text-file?item_id=${encodeURIComponent(itemId)}&filename=${encodeURIComponent(file.name)}`;
      const res = await fetch(url);
      const data = await res.json();
      if (!res.ok || !data.ok) {
        setBody(data.error || "Не удалось открыть файл.");
        setMeta(data.size_bytes ? `Размер: ${humanSize(data.size_bytes)}` : "");
        return;
      }
      state.text = data.content || "";
      setMeta(`Кодировка: ${data.encoding} · Размер: ${humanSize(data.size_bytes)} · Строк: ${data.line_count}`);
      renderText();
    } catch (err) {
      setBody(err.message || "Ошибка чтения файла.");
    }
  }

  function ensureModal() {
    if (document.getElementById("text-viewer-modal")) return;
    const wrap = document.createElement("div");
    wrap.id = "text-viewer-modal";
    wrap.className = "text-viewer";
    wrap.hidden = true;
    wrap.innerHTML = `
      <div class="text-viewer__backdrop" data-text-close></div>
      <section class="text-viewer__panel" role="dialog" aria-modal="true">
        <header class="text-viewer__header">
          <h3 id="text-viewer-title"></h3>
          <button type="button" class="text-viewer__close" data-text-close aria-label="Закрыть">×</button>
        </header>
        <div class="text-viewer__toolbar">
          <input id="text-viewer-search" type="search" placeholder="Поиск по тексту">
          <span id="text-viewer-counter">0/0</span>
          <button id="text-viewer-prev" type="button">Предыдущее</button>
          <button id="text-viewer-next" type="button">Следующее</button>
          <label><input id="text-viewer-wrap" type="checkbox" checked> Перенос строк</label>
          <button id="text-viewer-zoom-out" type="button">A-</button>
          <button id="text-viewer-zoom-in" type="button">A+</button>
          <button id="text-viewer-copy" type="button">Копировать текст</button>
          <a id="text-viewer-download" download>Скачать файл</a>
          <a id="text-viewer-new-tab" target="_blank" rel="noopener">Открыть в новой вкладке</a>
        </div>
        <div id="text-viewer-meta" class="text-viewer__meta"></div>
        <div class="text-viewer__body">
          <pre id="text-viewer-content" class="text-viewer__content is-wrap"></pre>
        </div>
      </section>
    `;
    document.body.appendChild(wrap);
    wrap.querySelectorAll("[data-text-close]").forEach((el) => el.addEventListener("click", closeModal));
    $("#text-viewer-search").addEventListener("input", updateSearch);
    $("#text-viewer-prev").addEventListener("click", () => jump(-1));
    $("#text-viewer-next").addEventListener("click", () => jump(1));
    $("#text-viewer-wrap").addEventListener("change", (e) => {
      state.wrap = e.target.checked;
      renderText();
    });
    $("#text-viewer-zoom-out").addEventListener("click", () => {
      state.fontSize = Math.max(10, state.fontSize - 1);
      renderText();
    });
    $("#text-viewer-zoom-in").addEventListener("click", () => {
      state.fontSize = Math.min(28, state.fontSize + 1);
      renderText();
    });
    $("#text-viewer-copy").addEventListener("click", () => navigator.clipboard?.writeText(state.text));
  }

  function $(selector) {
    return document.querySelector(selector);
  }

  function openModal() { $("#text-viewer-modal").hidden = false; }
  function closeModal() { $("#text-viewer-modal").hidden = true; }
  function setTitle(text) { $("#text-viewer-title").textContent = text || ""; }
  function setMeta(text) { $("#text-viewer-meta").textContent = text || ""; }
  function setSearch(text) { $("#text-viewer-search").value = text || ""; }
  function setBody(text) {
    const pre = $("#text-viewer-content");
    pre.textContent = text || "";
    updateCounter();
  }

  function renderText() {
    const pre = $("#text-viewer-content");
    pre.style.fontSize = `${state.fontSize}px`;
    pre.classList.toggle("is-wrap", !!state.wrap);
    $("#text-viewer-wrap").checked = !!state.wrap;
    $("#text-viewer-download").href = state.downloadUrl || "#";
    $("#text-viewer-download").download = state.filename || "";
    $("#text-viewer-new-tab").href = state.downloadUrl || "#";

    const query = $("#text-viewer-search").value || "";
    if (!query) {
      pre.textContent = state.text;
      state.matches = 0;
      state.index = -1;
      updateCounter();
      return;
    }

    const re = new RegExp(escapeRegExp(query), "gi");
    let idx = 0;
    const html = escapeHtml(state.text).replace(re, (m) => {
      const active = idx === state.index ? " active" : "";
      idx += 1;
      return `<mark class="${active ? "active" : ""}">${escapeHtml(m)}</mark>`;
    });
    state.matches = idx;
    if (state.matches && state.index < 0) state.index = 0;
    pre.innerHTML = html;
    updateCounter();
    pre.querySelector("mark.active")?.scrollIntoView({ block: "center" });
  }

  function updateSearch() {
    state.index = 0;
    renderText();
  }

  function jump(delta) {
    if (!state.matches) return;
    state.index = (state.index + delta + state.matches) % state.matches;
    renderText();
  }

  function updateCounter() {
    const total = state.matches || 0;
    $("#text-viewer-counter").textContent = total ? `${state.index + 1}/${total}` : "0/0";
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
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    }[ch]));
  }

  function escapeRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  window.TextViewer = { show, isTextFile };
})();
