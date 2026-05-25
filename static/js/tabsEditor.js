// static/js/tabsEditor.js
(function () {
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

  const tabsRow = $("#tabs-row");
  const editorBox = $("#tab-editor");
  const drawingsPane = $("#drawings-gallery-pane");

  let addBtn = $("#btn-add-tab");
  if (!addBtn && tabsRow) {
    addBtn = document.createElement("button");
    addBtn.id = "btn-add-tab";
    addBtn.className = "tab-btn edit-mode-only";
    addBtn.type = "button";
    addBtn.textContent = "+";
    addBtn.title = "Добавить вкладку";
    addBtn.setAttribute("aria-label", "Добавить вкладку");
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

  function getTabView(key) {
    if (key === "desc" || key === "docs") return key;
    const tab = (data?.extra_tabs || []).find(x => x.id === key);
    if (!tab) return "html";
    if (tab.view === "drawings" || /чертеж/i.test((tab.title || ""))) return "drawings";
    return "html";
  }

  function ensureDrawingsFrame(project) {
    if (!drawingsPane) return;

    let frame = drawingsPane.querySelector("iframe");
    const edit = isEdit() ? "1" : "0";
    const src = `/drawings?project=${encodeURIComponent(project || "")}&edit=${edit}`;

    if (!frame) {
      frame = document.createElement("iframe");
      frame.className = "drawings-gallery-frame";
      frame.title = "Галерея чертежей";
      frame.setAttribute("frameborder", "0");
      drawingsPane.appendChild(frame);
    }

    if (frame.getAttribute("src") !== src) {
      frame.setAttribute("src", src);
    }
  }

  function hideDrawingsPane() {
    if (drawingsPane) drawingsPane.hidden = true;
    if (editorBox) editorBox.hidden = false;
  }

  function showDrawingsPane() {
    if (editorBox) {
      editorBox.hidden = true;
      editorBox.removeAttribute("contenteditable");
    }
    if (drawingsPane) drawingsPane.hidden = false;
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
      if (getTabView(key) === "drawings") {
        window.TinyEditor?.sync();
        const project = currentItem?.id || "";
        ensureDrawingsFrame(project);
        showDrawingsPane();
        return;
      }

      hideDrawingsPane();
      const extraTabs = data?.extra_tabs || [];
      const tab = extraTabs.find(x => x.id === key);
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
    btn.dataset.view = getTabView(key);
    btn.innerHTML = `<span class="tab-title">${title || ""}</span>`;

    const act = document.createElement("span");
    act.className = "tab-actions edit-mode-only";

    const bRename = document.createElement("button");
    bRename.type = "button";
    bRename.className = "tab-act tab-rename";
    bRename.title = "Переименовать";
    bRename.setAttribute("aria-label", "Переименовать");
    act.appendChild(bRename);

    if (!fixed) {
      const bDel = document.createElement("button");
      bDel.type = "button";
      bDel.className = "tab-act tab-del";
      bDel.title = "Удалить";
      bDel.setAttribute("aria-label", "Удалить");
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

  function closeTabTypeMenu() {
    document.querySelector(".tab-type-menu")?.remove();
    document.removeEventListener("click", onOutsideTabTypeMenu);
    document.removeEventListener("keydown", onTabTypeKeydown);
  }

  function onOutsideTabTypeMenu(e) {
    const menu = document.querySelector(".tab-type-menu");
    if (!menu) return;
    if (menu.contains(e.target) || addBtn?.contains(e.target)) return;
    closeTabTypeMenu();
  }

  function onTabTypeKeydown(e) {
    if (e.key === "Escape") closeTabTypeMenu();
  }

  function openTabTypeMenu() {
    closeTabTypeMenu();
    if (!addBtn) return;

    const menu = document.createElement("div");
    menu.className = "tab-type-menu";
    menu.innerHTML = `
      <button type="button" class="tab-type-option" data-view="html">
        <span class="tab-type-icon tab-type-icon-text" aria-hidden="true"></span>
        <span class="tab-type-content">
          <strong>Текстовая вкладка</strong>
          <small>Для описаний, таблиц, изображений и заметок</small>
        </span>
      </button>
      <button type="button" class="tab-type-option" data-view="drawings">
        <span class="tab-type-icon tab-type-icon-drawings" aria-hidden="true"></span>
        <span class="tab-type-content">
          <strong>Галерея чертежей</strong>
          <small>Отдельная страница с загрузкой и поиском чертежей</small>
        </span>
      </button>
    `;

    document.body.appendChild(menu);
    const rect = addBtn.getBoundingClientRect();
    const menuWidth = 320;
    menu.style.left = `${Math.min(rect.left, window.innerWidth - menuWidth - 12)}px`;
    menu.style.top = `${rect.bottom + 8}px`;

    menu.querySelectorAll(".tab-type-option").forEach((option) => {
      option.addEventListener("click", () => {
        const view = option.dataset.view === "drawings" ? "drawings" : "html";
        closeTabTypeMenu();
        addTab(view);
      });
    });

    setTimeout(() => {
      document.addEventListener("click", onOutsideTabTypeMenu);
      document.addEventListener("keydown", onTabTypeKeydown);
    }, 0);
  }

  async function addTab(view = "html") {
    if (!isEdit()) return;
    const tabs = data.extra_tabs || [];
    if (tabs.length >= 10) {
      alert("Достигнут лимит 10 вкладок");
      return;
    }

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


  addBtn?.addEventListener("click", (e) => {
    e.preventDefault();
    if (!isEdit()) return;
    openTabTypeMenu();
  });

  $("#toggle-edit")?.addEventListener("change", () => {
    syncAddButtonVisibility();
    syncTabActionsVisibility();
    if (editorBox) editorBox.setAttribute("contenteditable", isEdit() ? "true" : "false");
    if (getTabView(activeTabKey) === "drawings" && currentItem?.id) {
      ensureDrawingsFrame(currentItem.id);
    }
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
