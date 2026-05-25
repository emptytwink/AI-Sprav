// static/js/menuEditor.js
(() => {
  const $root = () => document.getElementById("menu-root");
  const $search = () => document.getElementById("menu-search-input");
  const $sidebar = () =>
    $root()?.closest(".accordion-menu")?.parentElement ||
    document.querySelector(".sidebar");

  const slug = (s) =>
    (s || "item")
      .toString()
      .trim()
      .toLowerCase()
      .replace(/\s+/g, "_")
      .replace(/[^\w\-а-яё]/gi, "")
      .replace(/_+/g, "_")
      .replace(/^_+|_+$/g, "");
  const genId = (title = "item") =>
    `${slug(title)}_${Date.now().toString(36)}`;

  const findById = (arr, id, path = []) => {
    for (let i = 0; i < arr.length; i++) {
      const n = arr[i],
        p = path.concat(i);
      if (n.id === id) return { node: n, path: p };
      if (n.children?.length) {
        const r = findById(n.children, id, p);
        if (r) return r;
      }
    }
    return null;
  };

  const parentArrayByPath = (rootArr, path) =>
    path.length <= 1
      ? rootArr
      : path.slice(0, -1).reduce((acc, idx) => acc[idx].children, rootArr);

  const ensureGroup = (n) => {
    if (n.type !== "group") {
      n.type = "group";
      n.children = n.children || [];
    }
  };

  let ROOT_OBJ = null,
    DATA = [],
    selectedId = null,
    dirty = false,
    EDIT_MODE = false;
  const OPEN_SET = new Set();
  let hotkeysAttached = false,
    dragId = null;

  async function fetchMenu() {
    const res = await fetch("/api/menu");
    if (!res.ok) throw new Error("Не удалось загрузить меню");
    return res.json();
  }

  async function saveMenu() {
    const payload = { ...ROOT_OBJ, children: DATA };
    const res = await fetch("/api/menu", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    if (!res.ok) throw new Error("Ошибка сохранения");
    dirty = false;
    markToolbar(false);
  }

  // --- РЕНДЕР ДЕРЕВА ---
  function renderTree() {
    const root = $root();
    if (!root) return;
    root.innerHTML = "";

    const renderLi = (node, level) => {
      const li = document.createElement("li");
      li.className = "menu-item";
      li.dataset.id = node.id;

      // даём уровни до level-6
      const lvl = Math.max(1, Math.min(level, 6));
      li.classList.add(`level-${lvl}`);

      const row = document.createElement("div");
      row.className = "menu-row";
      row.draggable = EDIT_MODE;
      row.addEventListener("click", () => select(node.id));
      row.addEventListener("dragstart", onDragStart);
      row.addEventListener("dragover", onDragOver);
      row.addEventListener("drop", onDrop);

      const head =
        node.type === "group"
          ? document.createElement("button")
          : document.createElement("span");
      head.className =
        node.type === "group" ? "accordion-btn" : "submenu-item";
      head.textContent = node.title || "(без названия)";
      head.dataset.id = node.id;

      if (node.type === "group") {
        const isOpen = OPEN_SET.has(node.id);
        head.setAttribute("aria-expanded", isOpen ? "true" : "false");
      }

      head.addEventListener("click", (e) => {
        e.stopPropagation();

        if (node.type === "group") {
          if (OPEN_SET.has(node.id)) OPEN_SET.delete(node.id);
          else OPEN_SET.add(node.id);

          li.classList.toggle("open", OPEN_SET.has(node.id));
          head.setAttribute(
            "aria-expanded",
            OPEN_SET.has(node.id) ? "true" : "false"
          );
        }

        if (typeof window.showContent === "function") {
          window.showContent(node.id, node.title || "");
        }

        updateBreadcrumbById(node.id);

        if (window.DocFolderSync?.syncForMenu) {
          window.DocFolderSync.syncForMenu({
            id: node.id,
            title: node.title || ""
          });
        }
      });

      head.addEventListener("dblclick", (e) => {
        if (EDIT_MODE) {
          e.stopPropagation();
          beginInlineEdit(node.id);
        }
      });

      row.appendChild(head);

      const addBtn = document.createElement("button");
      addBtn.textContent = "+";
      addBtn.title = "Добавить дочерний";
      addBtn.style.display = EDIT_MODE ? "" : "none";
      addBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        addChild(node);
      });
      row.appendChild(addBtn);

      li.appendChild(row);

      if (node.type === "group") {
        const ul = document.createElement("ul");
        ul.className = "submenu";
        (node.children || []).forEach((ch) =>
          ul.appendChild(renderLi(ch, level + 1))
        );
        li.appendChild(ul);
        li.classList.toggle("open", OPEN_SET.has(node.id));
      }

      if (node.id === selectedId) li.classList.add("selected");
      return li;
    };

    const frag = document.createDocumentFragment();
    DATA.forEach((n) => frag.appendChild(renderLi(n, 1)));
    root.appendChild(frag);

    applyMode();

    if (selectedId) {
      const el = root.querySelector(
        `.menu-item[data-id="${CSS.escape(selectedId)}"]`
      );
      if (el) el.scrollIntoView({ block: "nearest" });
    }
  }

  function select(id) {
    selectedId = id;
    const root = $root();
    if (!root) return;

    root
      .querySelectorAll(".selected")
      .forEach((el) => el.classList.remove("selected"));

    const li = root.querySelector(
      `.menu-item[data-id="${CSS.escape(id)}"]`
    );
    if (li) li.classList.add("selected");

    updateBreadcrumbById(id);
  }

  function beginInlineEdit(nodeId) {
    const li = document.querySelector(
      `.menu-item[data-id="${CSS.escape(nodeId)}"]`
    );
    const head = li?.querySelector(".submenu-item, .accordion-btn");
    if (!head) return;

    const input = document.createElement("input");
    input.type = "text";
    input.value = (head.textContent || "").replace("(без названия)", "");
    input.className = "inline-title";
    input.style.width = "100%";

    head.replaceChildren(input);
    input.focus();
    input.select();

    const finish = (save) => {
      const loc = findById(DATA, nodeId);
      if (!loc) return;
      if (save) {
        const v = (input.value || "").trim();
        if (v) {
          loc.node.title = v;
          setDirty();
        }
      }
      renderTree();
      select(nodeId);
      applyMode();
    };

    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        finish(true);
      }
      if (e.key === "Escape") {
        e.preventDefault();
        finish(false);
      }
    });
    input.addEventListener("blur", () => finish(true));
  }

  // операции
  function addChild(node) {
    ensureGroup(node);
    const child = {
      id: genId(node.title),
      title: "Новый пункт",
      type: "item",
      enabled: true
    };
    node.children.push(child);
    OPEN_SET.add(node.id);
    setDirty();
    renderTree();
    select(child.id);
    beginInlineEdit(child.id);
  }

  function addSiblingBelow() {
    if (!selectedId) return;
    const loc = findById(DATA, selectedId);
    if (!loc) return;
    const parentArr = parentArrayByPath(DATA, loc.path);
    const insertIndex = loc.path[loc.path.length - 1] + 1;
    const node = {
      id: genId("item"),
      title: "Новый пункт",
      type: "item",
      enabled: true
    };
    parentArr.splice(insertIndex, 0, node);
    setDirty();
    renderTree();
    select(node.id);
    beginInlineEdit(node.id);
  }

  function deleteSelected() {
    if (!selectedId) return;
    const loc = findById(DATA, selectedId);
    if (!loc) return;
    if (!confirm("Удалить пункт и всех потомков?")) return;
    const parentArr = parentArrayByPath(DATA, loc.path);
    parentArr.splice(loc.path[loc.path.length - 1], 1);
    selectedId = null;
    setDirty();
    renderTree();
  }

  function indentSelected() {
    if (!selectedId) return;
    const loc = findById(DATA, selectedId);
    if (!loc) return;
    const idx = loc.path[loc.path.length - 1];
    if (idx === 0) return;
    const parentArr = parentArrayByPath(DATA, loc.path);
    const left = parentArr[idx - 1];
    ensureGroup(left);
    const cur = parentArr.splice(idx, 1)[0];
    left.children.push(cur);
    OPEN_SET.add(left.id);
    setDirty();
    renderTree();
    select(cur.id);
  }

  function outdentSelected() {
    if (!selectedId) return;
    const loc = findById(DATA, selectedId);
    if (!loc) return;
    if (loc.path.length < 2) return;
    const parentArr = parentArrayByPath(DATA, loc.path);
    const curIndex = loc.path[loc.path.length - 1];
    const cur = parentArr.splice(curIndex, 1)[0];

    const grandPath = loc.path.slice(0, -2);
    const grandArr =
      grandPath.length === 0
        ? DATA
        : grandPath.reduce((acc, idx) => acc[idx].children, DATA);
    const parentIdx =
      grandPath.length === 0
        ? DATA.indexOf(parentArr)
        : grandPath[grandPath.length - 1];

    grandArr.splice(parentIdx + 1, 0, cur);
    setDirty();
    renderTree();
    select(cur.id);
  }

  function moveSelected(delta) {
    if (!selectedId) return;
    const loc = findById(DATA, selectedId);
    if (!loc) return;
    const parentArr = parentArrayByPath(DATA, loc.path);
    const i = loc.path[loc.path.length - 1],
      j = i + delta;
    if (j < 0 || j >= parentArr.length) return;
    [parentArr[i], parentArr[j]] = [parentArr[j], parentArr[i]];
    setDirty();
    renderTree();
    select(selectedId);
  }

  // DnD
  function onDragStart(e) {
    if (!EDIT_MODE) return e.preventDefault();
    const li = e.currentTarget.closest(".menu-item");
    dragId = li?.dataset.id || null;
    e.dataTransfer.setData("text/plain", dragId || "");
    e.dataTransfer.effectAllowed = "move";
  }

  function onDragOver(e) {
    if (!EDIT_MODE) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
  }

  function onDrop(e) {
    if (!EDIT_MODE) return;
    e.preventDefault();
    const targetLi = e.currentTarget.closest(".menu-item");
    const targetId = targetLi?.dataset.id;
    if (!dragId || !targetId || dragId === targetId) return;

    const src = findById(DATA, dragId);
    const dst = findById(DATA, targetId);
    if (!src || !dst) return;

    const srcParent = parentArrayByPath(DATA, src.path);
    const moving = srcParent.splice(src.path[src.path.length - 1], 1)[0];

    const r = targetLi.getBoundingClientRect();
    const y = e.clientY - r.top;
    const pos = e.altKey
      ? "middle"
      : y < r.height * 0.5
      ? "top"
      : "bottom";

    if (pos === "middle") {
      ensureGroup(dst.node);
      dst.node.children.push(moving);
      OPEN_SET.add(dst.node.id);
    } else {
      const dstParent = parentArrayByPath(DATA, dst.path);
      const insertAt =
        dst.path[dst.path.length - 1] + (pos === "bottom" ? 1 : 0);
      dstParent.splice(insertAt, 0, moving);
    }
    setDirty();
    renderTree();
    select(moving.id);
    dragId = null;
  }

  function onKeyDown(e) {
    if (!EDIT_MODE || !selectedId) return;
    if (e.key === "Delete") {
      e.preventDefault();
      deleteSelected();
    } else if (e.key === "Tab" && !e.shiftKey) {
      e.preventDefault();
      indentSelected();
    } else if (e.key === "Tab" && e.shiftKey) {
      e.preventDefault();
      outdentSelected();
    } else if (
      e.key === "Enter" &&
      !e.shiftKey &&
      !e.ctrlKey &&
      !e.altKey
    ) {
      e.preventDefault();
      addSiblingBelow();
    } else if ((e.ctrlKey || e.metaKey) && e.key === "ArrowUp") {
      e.preventDefault();
      moveSelected(-1);
    } else if ((e.ctrlKey || e.metaKey) && e.key === "ArrowDown") {
      e.preventDefault();
      moveSelected(1);
    } else if (e.key === "F2") {
      e.preventDefault();
      beginInlineEdit(selectedId);
    }
  }

  function ensureToolbarAndToggle() {
    const globalSaveBtn = document.getElementById("btn-save-content");
    if (globalSaveBtn) {
      globalSaveBtn.classList.add("edit-mode-only");

      if (!globalSaveBtn.dataset.menuHooked) {
        globalSaveBtn.addEventListener("click", async () => {
          try {
            await saveMenu();
            toast("Меню сохранено");
          } catch (e) {
            toast("Ошибка сохранения меню", true);
          }
        });
        globalSaveBtn.dataset.menuHooked = "1";
      }
    }

    let input = document.getElementById("toggle-edit");
    if (!input) {
      const host =
        $root()?.closest(".accordion-menu")?.parentElement ||
        document.querySelector(".sidebar");
      if (host) {
        const wrap = document.createElement("div");
        wrap.style.display = "flex";
        wrap.style.justifyContent = "flex-end";
        wrap.style.marginBottom = "8px";
        wrap.innerHTML = `
          <label class="switch">
            <input id="toggle-edit" type="checkbox" />
            <span class="slider"></span>
          </label>
          <span class="edit-toggle-label">Редактировать</span>
        `;
        host.prepend(wrap);
        input = wrap.querySelector("#toggle-edit");
      }
    }

    if (input && !input.dataset.hooked) {
      input.addEventListener("change", () => {
        EDIT_MODE = input.checked;
        applyMode();
      });
      EDIT_MODE = input.checked;
      applyMode();
      input.dataset.hooked = "1";
    }
  }

  // --- КРОШКИ ---
  function getPathLabelsById(id) {
    const loc = findById(DATA, id);
    if (!loc) return [];

    let labels = [];
    let arr = DATA;

    for (const idx of loc.path) {
      const node = arr[idx];
      labels.push(node.title || "(без названия)");
      arr = node.children || [];
    }
    return labels;
  }

  function updateBreadcrumbById(id) {
    const box = document.getElementById("breadcrumbs");
    if (!box) return;

    const labels = getPathLabelsById(id);
    if (!labels.length) {
      box.innerHTML = "";
      box.hidden = true;
      return;
    }

    box.hidden = false;
    box.innerHTML = labels.map((t) => `<span>${t}</span>`).join("");
  }

  window.getMenuPathLabels = function (id) {
    return getPathLabelsById(id);
  };

  function markToolbar(isDirty) {
    const btn = document.getElementById("btn-save-menu");
    if (btn) btn.textContent = isDirty ? "Сохранить *" : "Сохранить";
  }

  function setDirty() {
    dirty = true;
    markToolbar(true);
  }

  function toast(msg, err = false) {
    console[err ? "error" : "log"](msg);
  }

  function applyMode() {
    document.body.classList.toggle("edit-mode", EDIT_MODE);
    document.body.classList.toggle("view-mode", !EDIT_MODE);

    document
      .querySelectorAll(".menu-row button:not(.accordion-btn)")
      .forEach((el) => (el.style.display = EDIT_MODE ? "" : "none"));

    document
      .querySelectorAll(".menu-row")
      .forEach((row) => (row.draggable = EDIT_MODE));
  }

  // --- ПОИСК ---
  function hookSearch() {
    const input = $search();
    if (!input) return;

    const fileCache = {};

    const normalize = (s) =>
      (s || "")
        .toString()
        .trim()
        .toLowerCase()
        .replace(/ё/g, "е");

    const tokenize = (q) =>
      normalize(q)
        .split(/\s+/)
        .filter(Boolean);

    function levenshtein(a, b) {
      if (a === b) return 0;
      a = normalize(a);
      b = normalize(b);
      const al = a.length,
        bl = b.length;
      if (!al) return bl;
      if (!bl) return al;

      const dp = Array.from({ length: al + 1 }, () => new Array(bl + 1));
      for (let i = 0; i <= al; i++) dp[i][0] = i;
      for (let j = 0; j <= bl; j++) dp[0][j] = j;

      for (let i = 1; i <= al; i++) {
        for (let j = 1; j <= bl; j++) {
          const cost = a[i - 1] === b[j - 1] ? 0 : 1;
          dp[i][j] = Math.min(
            dp[i - 1][j] + 1,
            dp[i][j - 1] + 1,
            dp[i - 1][j - 1] + cost
          );
        }
      }
      return dp[al][bl];
    }

    function fuzzyMatchText(text, tokens) {
      if (!tokens.length) return true;
      const normText = normalize(text);
      if (!normText) return false;

      const words = normText.split(/\s+/).filter(Boolean);

      return tokens.every((token) => {
        if (normText.includes(token)) return true;

        for (const w of words) {
          if (Math.abs(w.length - token.length) > 2) continue;
          if (levenshtein(w, token) <= 1) return true;
        }
        return false;
      });
    }

    async function getFiles(menuId) {
      if (!menuId) return [];
      if (fileCache[menuId]) return fileCache[menuId];

      try {
        const res = await fetch(
          `/api/content/${encodeURIComponent(menuId)}`
        );
        if (!res.ok) return [];
        const data = await res.json();
        const files = Array.isArray(data.files) ? data.files : [];
        fileCache[menuId] = files;
        return files;
      } catch {
        return [];
      }
    }

    async function computeVisibleIds(tokens) {
      const visible = new Set();

      async function walk(list) {
        let anyMatchedHere = false;

        for (const n of list || []) {
          const title = n.title || "";
          const hasTitleMatch = fuzzyMatchText(title, tokens);

          let hasFilesMatch = false;
          if (!hasTitleMatch && tokens.length) {
            const files = await getFiles(n.id);
            const names = files
              .map((f) => f.name || "")
              .join(" ");
            hasFilesMatch = fuzzyMatchText(names, tokens);
          }

          const hasChildren =
            Array.isArray(n.children) && n.children.length > 0;
          let hasChildMatch = false;
          if (hasChildren) {
            hasChildMatch = await walk(n.children);
          }

          const matched =
            !tokens.length ||
            hasTitleMatch ||
            hasFilesMatch ||
            hasChildMatch;

          if (matched) {
            visible.add(n.id);
            anyMatchedHere = true;
          }
        }

        return anyMatchedHere;
      }

      await walk(DATA);
      return visible;
    }

    input.addEventListener("input", async (e) => {
      const query = e.target.value || "";
      const tokens = tokenize(query);
      const root = $root();
      if (!root) return;

      if (!tokens.length) {
        root.querySelectorAll(".menu-item").forEach((li) => {
          li.style.display = "";
        });
        return;
      }

      const visible = await computeVisibleIds(tokens);

      root.querySelectorAll(".menu-item").forEach((li) => {
        const id = li.dataset.id;
        li.style.display = visible.has(id) ? "" : "none";
      });
    });
  }

  async function init() {
    ROOT_OBJ = await fetchMenu();
    DATA = Array.isArray(ROOT_OBJ.children) ? ROOT_OBJ.children : [];

    ensureToolbarAndToggle();
    renderTree();
    hookSearch();

    const first = $root().querySelector(".menu-item");
    if (first) select(first.dataset.id);

    if (!hotkeysAttached) {
      document.addEventListener("keydown", onKeyDown);
      hotkeysAttached = true;
    }
    EDIT_MODE = false;
    applyMode();
  }

  if (typeof window.showContent === "function") {
    window.showContent("home", "Главная");
  }

  document.addEventListener("DOMContentLoaded", () => {
    if ($root())
      init().catch((err) => {
        console.error(err);
        $root().innerHTML = "<li>Ошибка загрузки меню</li>";
      });
  });
})();
