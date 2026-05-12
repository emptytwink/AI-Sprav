// static/js/tabsEditor.js
(function () {
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

  const tabsRow = $("#tabs-row");
  const editorBox = $("#tab-editor");

  let addBtn = $("#btn-add-tab");
  if (!addBtn && tabsRow) {
    addBtn = document.createElement("button");
    addBtn.id = "btn-add-tab";
    addBtn.className = "tab-btn edit-mode-only";
    addBtn.type = "button";
    addBtn.textContent = "+ Вкладка";
    tabsRow.appendChild(addBtn);
  }

  let currentItem = null;    // { id, title }
  let data = null;           // { text_html, extra_tabs[], description_title, docs_title, ... }
  let activeTabKey = "desc"; // "desc" | "docs" | tab_<uuid>

  const isEdit = () => !!($("#toggle-edit") && $("#toggle-edit").checked);
  const api = (path, opts = {}) => fetch(path, opts).then(r => r.json());

  function exposeCurrentId(id) {
    // делаем ID доступным tinyEditor-у
    window.currentId = id;
    window.getCurrentContentId = () => id;
    const pane = document.getElementById("content-pane");
    if (pane) pane.dataset.currentId = id;
  }

  function syncAddButtonVisibility() {
    if (addBtn) addBtn.hidden = !isEdit();
  }
  function syncTabActionsVisibility() {
    $$(".tab-actions").forEach(el => el.hidden = !isEdit());
  }

  function setActive(key) {
    activeTabKey = key;

    $$(".tab-btn", tabsRow).forEach(b => {
      const k = b.dataset.key || b.dataset.tab;
      b.classList.toggle("active", k === key);
    });

    $$(".tab-body").forEach(sec => sec.classList.remove("active"));
    const sectionId = (key === "docs") ? "tab-docs" : "tab-content";
    const section = document.getElementById(sectionId);
    if (section) section.classList.add("active");

    $$(".tab-body").forEach(sec => sec.toggleAttribute("hidden", !sec.classList.contains("active")));

    if (key !== "docs" && editorBox) {
      const extraTabs = data?.extra_tabs || [];
      const tab = extraTabs.find(x => x.id === key);

      const isDrawingsTab =
        key !== "desc" &&
        tab &&
        (tab.view === "drawings" || /чертеж/i.test((tab.title || "")));

      if (isDrawingsTab) {
        editorBox.innerHTML = "";
        editorBox.removeAttribute("contenteditable");

        const project = currentItem?.id || "";
        const iframe = document.createElement("iframe");
        iframe.src = `/drawings?project=${encodeURIComponent(project)}`;
        iframe.style.width = "100%";
        iframe.style.height = "600px";
        iframe.loading = "lazy";
        iframe.setAttribute("frameborder", "0");

        editorBox.appendChild(iframe);
        return;
      }

      let html = "";
      if (key === "desc") html = data?.text_html || "";
      else html = tab?.html || "";

      if (window.TinyEditor?.setHtml) TinyEditor.setHtml(html || "");
      else editorBox.innerHTML = html || "";

      editorBox.setAttribute("contenteditable", isEdit() ? "true" : "false");
      window.TinyEditor?.sync();
    }
  }


  function buildBtn({ key, title, fixed }) {
    const btn = document.createElement("button");
    btn.className = "tab-btn";
    btn.dataset.key = key;
    btn.innerHTML = `<span class="tab-title">${title || ""}</span>`;

    const act = document.createElement("span");
    act.className = "tab-actions edit-mode-only";

    const bRename = document.createElement("button");
    bRename.type = "button";
    bRename.className = "tab-act tab-rename";
    bRename.title = "Переименовать";
    bRename.textContent = "✎";
    act.appendChild(bRename);

    if (!fixed) {
      const bDel = document.createElement("button");
      bDel.type = "button";
      bDel.className = "tab-act tab-del";
      bDel.title = "Удалить";
      bDel.textContent = "✖";
      act.appendChild(bDel);

      bDel.addEventListener("click", async (e) => {
        e.stopPropagation();
        if (!isEdit()) return;
        await api(`/api/content/${currentItem.id}/tabs/${key}`, { method: "DELETE" });
        data.extra_tabs = (data.extra_tabs || []).filter(x => x.id !== key);
        if (activeTabKey === key) activeTabKey = "desc";
        renderTabs();
        setActive(activeTabKey);
      });
    }

    btn.appendChild(act);

    async function doRename() {
      if (!isEdit()) return;
      const cur =
        key === "desc" ? (data.description_title || "Описание") :
        key === "docs" ? (data.docs_title || "Документация") :
        ((data.extra_tabs || []).find(x => x.id === key)?.title || "Вкладка");

      let t = prompt("Название вкладки:", cur);
      if (!t) return;
      t = t.trim();
      if (!t || t === cur) return;

      if (key === "desc") {
        data.description_title = t;
        await api(`/api/content/${currentItem.id}`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ description_title: t })
        });
      } else if (key === "docs") {
        data.docs_title = t;
        await api(`/api/content/${currentItem.id}`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ docs_title: t })
        });
      } else {
        const tab = (data.extra_tabs || []).find(x => x.id === key);
        if (!tab) return;
        tab.title = t;
        await api(`/api/content/${currentItem.id}/tabs/${key}`, {
          method: "PUT", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: t })
        });
      }
      renderTabs();
      setActive(key);
    }

    btn.addEventListener("click", () => setActive(key));
    btn.addEventListener("dblclick", (e) => { e.preventDefault(); doRename(); });
    bRename.addEventListener("click", (e) => { e.stopPropagation(); doRename(); });

    return btn;
  }

  function renderTabs() {
    if (!tabsRow || !data) return;
    tabsRow.innerHTML = "";

    tabsRow.appendChild(buildBtn({ key: "desc", title: data.description_title || "Описание", fixed: true }));

    (data.extra_tabs || []).forEach(t => {
      tabsRow.appendChild(buildBtn({ key: t.id, title: t.title || "Вкладка", fixed: false }));
    });

    tabsRow.appendChild(buildBtn({ key: "docs", title: data.docs_title || "Документация", fixed: true }));

    if (addBtn && !tabsRow.contains(addBtn)) tabsRow.appendChild(addBtn);

    const key = activeTabKey || "desc";
    const activeBtn = $(`.tab-btn[data-key="${key}"]`, tabsRow);
    if (activeBtn) activeBtn.classList.add("active");
    setActive(key);

    syncAddButtonVisibility();
    syncTabActionsVisibility();
  }

  let saveTimer = null;
  function bindEditorAutosave() {
    if (!editorBox || editorBox.dataset.autosaveBound) return;
    editorBox.dataset.autosaveBound = "1";

    editorBox.addEventListener("input", () => {
      if (window.TinyEditor) return; // Tiny сам сохраняет
      if (activeTabKey === "docs") return;

      const html = editorBox.innerHTML;
      if (activeTabKey === "desc") {
        data.text_html = html;
        queueSave(async () => {
          await api(`/api/content/${currentItem.id}`, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ text_html: html })
          });
        });
      } else {
        const tab = (data.extra_tabs || []).find(x => x.id === activeTabKey);
        if (!tab) return;
        tab.html = html;
        queueSave(async () => {
          await api(`/api/content/${currentItem.id}/tabs/${tab.id}`, {
            method: "PUT", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ html })
          });
        });
      }
    });
  }
  function queueSave(fn) {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { fn().catch(() => {}); }, 400);
  }

  async function addTab() {
    if (!isEdit()) return;
    const tabs = data.extra_tabs || [];
    if (tabs.length >= 10) {
      alert("Достигнут лимит 10 вкладок");
      return;
    }

    // спрашиваем тип вкладки
    const kind = prompt(
      "Тип вкладки:\n1 — обычный текст\n2 — галерея чертежей",
      "1"
    );
    const view = (kind === "2") ? "drawings" : "html";

    const title = view === "drawings" ? "Чертежи" : "Новая вкладка";

    const r = await api(`/api/content/${currentItem.id}/tabs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title, view })
    });

    const tab = r.tab;
    data.extra_tabs = [...tabs, tab];
    activeTabKey = tab.id;
    renderTabs();
  }


  addBtn?.addEventListener("click", (e) => { e.preventDefault(); addTab(); });

  $("#toggle-edit")?.addEventListener("change", () => {
    syncAddButtonVisibility();
    syncTabActionsVisibility();
    if (editorBox) editorBox.setAttribute("contenteditable", isEdit() ? "true" : "false");
    window.TinyEditor?.sync();
  });

  window.TabsEditor = {
    async loadAndRender(item) {
      currentItem = item;

      // <<< ВАЖНО: выставляем текущий ID, чтобы tinyEditor мог работать
      exposeCurrentId(item.id);

      const res = await fetch(`/api/content/${item.id}`);
      data = await res.json();
      if (!Array.isArray(data.extra_tabs)) data.extra_tabs = [];
      if (!data.description_title) data.description_title = "Описание";
      if (!data.docs_title) data.docs_title = "Документация";
      activeTabKey = "desc";

      renderTabs();
      bindEditorAutosave();

      syncAddButtonVisibility();
      syncTabActionsVisibility();

      // после первой загрузки даём Tiny подняться
      window.TinyEditor?.sync();
    }
  };
})();
