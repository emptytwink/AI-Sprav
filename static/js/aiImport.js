(() => {
  const $ = (selector, root = document) => root.querySelector(selector);

  let currentJobId = null;
  let pollTimer = null;
  let lastJobData = null;

  function openModal() {
    const modal = $("#ai-import-modal");
    if (modal) modal.hidden = false;
  }

  function closeModal() {
    const modal = $("#ai-import-modal");
    if (modal) modal.hidden = true;
    stopPolling();
  }

  function ensureDetailsBox() {
    let box = $("#ai-status-details");
    if (!box) {
      box = document.createElement("div");
      box.id = "ai-status-details";
      box.className = "ai-status-details";
      $("#ai-status")?.after(box);
    }
    return box;
  }

  function setStatus(message, progress = 0, isError = false) {
    const status = $("#ai-status");
    const bar = $("#ai-progress-bar");
    if (status) {
      status.textContent = message || "";
      status.classList.toggle("ai-status--error", !!isError);
    }
    if (bar) bar.style.width = `${Math.max(0, Math.min(100, Number(progress) || 0))}%`;
  }

  function renderStatusDetails(data) {
    const box = ensureDetailsBox();
    if (!box) return;
    const rows = [
      ["Архив", data.archive_name],
      ["Job ID", data.job_id],
      ["Модель", data.ollama_model],
      ["Ollama", data.ollama_base_url],
      ["Этап", data.status],
      ["Выбрано документов", data.selected_documents_count],
      ["Поддерживаемых документов", data.total_supported_candidates],
      ["Пропущено файлов", data.skipped_files_count],
      ["Будет привязано файлов", data.attached_files_count],
    ].filter(([, value]) => value !== undefined && value !== null && value !== "");
    box.innerHTML = rows.map(([label, value]) => `
      <span><b>${escapeHtml(label)}:</b> ${escapeHtml(value)}</span>
    `).join("");
  }

  function clearPreview() {
    const preview = $("#ai-preview");
    const target = $("#ai-preview-content");
    if (target) target.innerHTML = "";
    if (preview) preview.hidden = true;
    const details = ensureDetailsBox();
    if (details) details.innerHTML = "";
  }

  async function uploadArchive() {
    const file = $("#ai-archive-input")?.files?.[0];
    if (!file) return setStatus("Выберите ZIP-архив.", 0, true);
    if (!file.name.toLowerCase().endsWith(".zip")) {
      return setStatus("Можно загрузить только ZIP-архив.", 0, true);
    }

    const form = new FormData();
    form.append("archive", file);
    currentJobId = null;
    lastJobData = null;
    stopPolling();
    clearPreview();
    $("#ai-upload-btn").disabled = true;
    $("#ai-apply-btn").disabled = true;
    setStatus(`Загрузка архива ${file.name}...`, 5);

    try {
      const res = await fetch("/api/ai/import-archive", { method: "POST", body: form });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || "Ошибка загрузки архива.");
      currentJobId = data.job_id;
      setStatus("Архив загружен. Начинаю анализ...", 10);
      startPolling();
    } catch (err) {
      $("#ai-upload-btn").disabled = false;
      setStatus(err.message || "Ошибка загрузки архива.", 100, true);
    }
  }

  function startPolling() {
    stopPolling();
    pollTimer = window.setInterval(loadJobStatus, 1800);
    loadJobStatus();
  }

  function stopPolling() {
    if (pollTimer) window.clearInterval(pollTimer);
    pollTimer = null;
  }

  async function loadJobStatus() {
    if (!currentJobId) return;
    try {
      const res = await fetch(`/api/ai/jobs/${encodeURIComponent(currentJobId)}`);
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || "Задание не найдено.");
      lastJobData = data;

      setStatus(data.message || data.status, data.progress || 0, data.status === "failed");
      renderStatusDetails(data);
      if (data.suggestion) renderPreview(data);

      if (data.status === "ready") {
        stopPolling();
        $("#ai-upload-btn").disabled = false;
        $("#ai-apply-btn").disabled = false;
      } else if (data.status === "failed") {
        stopPolling();
        $("#ai-upload-btn").disabled = false;
        $("#ai-apply-btn").disabled = true;
        setStatus(data.error || data.message || "Ошибка анализа.", 100, true);
      } else if (data.status === "applied") {
        stopPolling();
        $("#ai-upload-btn").disabled = false;
        $("#ai-apply-btn").disabled = true;
      }
    } catch (err) {
      stopPolling();
      $("#ai-upload-btn").disabled = false;
      setStatus(err.message || "Ошибка получения статуса.", 100, true);
    }
  }

  async function applyResult() {
    if (!currentJobId) return;
    $("#ai-apply-btn").disabled = true;
    setStatus("Добавляю ИИ-ветку в справочник...", 95);
    try {
      const res = await fetch(`/api/ai/jobs/${encodeURIComponent(currentJobId)}/apply`, { method: "POST" });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || "Ошибка применения результата.");
      setStatus("ИИ-структура добавлена. Страница будет обновлена.", 100);
      window.setTimeout(() => window.location.reload(), 900);
    } catch (err) {
      $("#ai-apply-btn").disabled = false;
      setStatus(err.message || "Ошибка применения результата.", 100, true);
    }
  }

  function renderPreview(jobData) {
    const suggestion = jobData.suggestion || {};
    const preview = $("#ai-preview");
    const target = $("#ai-preview-content");
    if (!preview || !target) return;

    const meta = suggestion._meta || {};
    const files = new Set(meta.archive_files || []);
    (suggestion.contents || []).forEach((item) => {
      (item.source_files || []).forEach((file) => files.add(file));
    });

    target.innerHTML = `
      <h3>${escapeHtml(suggestion.title || "Предложенная структура")}</h3>
      <div class="ai-preview__meta">
        <span><b>Архив:</b> ${escapeHtml(meta.archive_name || jobData.archive_name || "")}</span>
        <span><b>Модель:</b> ${escapeHtml(meta.ollama_model || jobData.ollama_model || "")}</span>
        <span><b>Ollama:</b> ${escapeHtml(meta.ollama_base_url || jobData.ollama_base_url || "")}</span>
        <span><b>Выбрано документов:</b> ${escapeHtml(meta.selected_documents_count ?? jobData.selected_documents_count ?? 0)}</span>
        <span><b>Поддерживаемых:</b> ${escapeHtml(meta.total_supported_candidates ?? jobData.total_supported_candidates ?? 0)}</span>
        <span><b>Пропущено:</b> ${escapeHtml(meta.skipped_files_count ?? jobData.skipped_files_count ?? 0)}</span>
        <span><b>Файлов будет привязано:</b> ${files.size}</span>
      </div>
      <div class="ai-preview__tree">${renderTree(suggestion.menu || [])}</div>
      ${meta.fallback_used ? `<p class="ai-warning">Ollama вернула ответ не в формате справочника, поэтому структура собрана автоматически по папкам и выбранным документам.</p>` : ""}
      <details class="ai-preview__files">
        <summary>Файлы для привязки: ${files.size}</summary>
        <ul>${Array.from(files).map((file) => `<li>${escapeHtml(file)}</li>`).join("") || "<li>Нет файлов</li>"}</ul>
      </details>
      <button id="ai-debug-toggle" class="btn small" type="button">Показать техническую диагностику</button>
      <div id="ai-debug-panel" class="ai-debug-panel" hidden>${renderDebug(jobData)}</div>
    `;
    $("#ai-debug-toggle", target)?.addEventListener("click", () => {
      const panel = $("#ai-debug-panel", target);
      if (panel) panel.hidden = !panel.hidden;
    });
    preview.hidden = false;
  }

  function renderDebug(jobData) {
    const selected = jobData.selected_documents || jobData.suggestion?._meta?.selected_documents || [];
    const skipped = jobData.skipped_files || jobData.suggestion?._meta?.skipped_files || [];
    return `
      <h4>Документы, отправленные в ИИ</h4>
      <ul>${selected.map((item) => `<li>${escapeHtml(item.relpath || item.path || "")} (${escapeHtml(item.ext || "")}, ${escapeHtml(item.chars_count || 0)} симв.)</li>`).join("") || "<li>Нет данных</li>"}</ul>
      <h4>Пропущенные файлы</h4>
      <ul>${skipped.slice(0, 200).map((item) => `<li>${escapeHtml(item.relpath || item.path || "")}: ${escapeHtml(item.skipped_reason || item.reason || "")}</li>`).join("") || "<li>Нет данных</li>"}</ul>
    `;
  }

  function renderTree(nodes) {
    if (!Array.isArray(nodes) || !nodes.length) return "<p>Структура не найдена.</p>";
    return `<ul>${nodes.map((node) => `
      <li>
        <b>${escapeHtml(node.title || node.id || "Раздел")}</b>
        ${node.children ? renderTree(node.children) : ""}
      </li>
    `).join("")}</ul>`;
  }

  function onFileSelected() {
    const file = $("#ai-archive-input")?.files?.[0];
    clearPreview();
    if (file) {
      setStatus(`Выбран архив: ${file.name}`, 0);
    } else {
      setStatus("Выберите ZIP-архив для анализа.", 0);
    }
  }

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, (ch) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;"
    }[ch]));
  }

  document.addEventListener("DOMContentLoaded", () => {
    $("#btn-ai-import")?.addEventListener("click", openModal);
    $("#ai-archive-input")?.addEventListener("change", onFileSelected);
    $("#ai-upload-btn")?.addEventListener("click", uploadArchive);
    $("#ai-apply-btn")?.addEventListener("click", applyResult);
    document.querySelectorAll("[data-ai-close]").forEach((node) => node.addEventListener("click", closeModal));
  });
})();
