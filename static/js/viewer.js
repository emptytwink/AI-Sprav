// static/js/viewer.js
(() => {
  const $  = (s, r=document) => r.querySelector(s);
  const $$ = (s, r=document) => Array.from(r.querySelectorAll(s));

  let MENU = null;

  function humanSize(n){ if(n==null) return ""; const u=["B","KB","MB","GB"]; let i=0,v=n; while(v>=1024&&i<u.length-1){v/=1024;i++;} return `${v.toFixed(i===0?0:1)} ${u[i]}`; }
  const rel = u => (u||"").replace(/^\//,"./");
  const loadJSON = p => fetch(p).then(r=>{ if(!r.ok) throw 0; return r.json(); });

  // Активируем нужную вкладку
  function setActiveTab(name){
    $$(".tab-btn").forEach(b=>b.classList.remove("active"));
    $$(".tab-body").forEach(b=>b.classList.remove("active"));
    $(`.tab-btn[data-tab="${name}"]`)?.classList.add("active");
    $(`#tab-${name}`)?.classList.add("active");
  }

  // Ищем первый "лист" внутри группы (в глубину)
  function firstLeaf(node){
    if (!node) return null;
    if (node.type !== "group") return node;
    for (const ch of (node.children || [])) {
      const leaf = firstLeaf(ch);
      if (leaf) return leaf;
    }
    return null;
  }

  // Пробуем загрузить контент: сначала экспорт, затем API; если нигде нет — вернём null
  async function tryLoadContent(id){
    try { return await loadJSON(`./data/contents/${encodeURIComponent(id)}.json`); } catch {}
    try { return await loadJSON(`/api/content/${encodeURIComponent(id)}`); } catch {}
    return null;
  }

  function renderMenu() {
    const root = $("#menu-root"); root.innerHTML = "";
    const open = new Set();

    const liOf = (node) => {
      const li = document.createElement("li"); li.className="menu-item"; li.dataset.id=node.id;
      const head = node.type==="group" ? document.createElement("button") : document.createElement("span");
      head.className = node.type==="group" ? "accordion-btn" : "submenu-item";
      head.textContent = node.title || "(без названия)";

      const activate = async (e) => {
        e.stopPropagation();
        e.preventDefault?.();

        // Снять подсветку со всех
        $$(".submenu-item").forEach(n=>n.classList.remove("active"));
        $$(".accordion-btn").forEach(n=>n.classList.remove("active"));

        if (node.type==="group") {
          // Открыть/закрыть визуально группу
          const willOpen = !open.has(node.id);
          if (willOpen) open.add(node.id); else open.delete(node.id);
          li.classList.toggle("open", open.has(node.id));

          // Переходим на "Описание"
          setActiveTab("desc");
          head.classList.add("active");

          // 1) Пытаемся показать контент самой группы
          const groupData = await tryLoadContent(node.id);
          if (groupData) {
            await showContent(node.id, node.title || "");
            return;
          }

          // 2) У группы нет страницы → открыть первый дочерний пункт
          const leaf = firstLeaf(node);
          if (leaf) {
            await showContent(leaf.id, leaf.title || "");
            // Подсветим реальный пункт
            const leafLi = Array.from(root.querySelectorAll(".menu-item")).find(el => el.dataset.id === leaf.id);
            leafLi?.querySelector(".submenu-item")?.classList.add("active");
            return;
          }

          // 3) Вообще нечего показывать — чистим описание и предпросмотр
          $("#desc-view").innerHTML = "<div style='opacity:.7'>Нет описания.</div>";
          if (window.FileViewer?.clear) window.FileViewer.clear();
        } else {
          // Обычный пункт: показываем его контент
          setActiveTab("desc");
          head.classList.add("active");
          await showContent(node.id, node.title||"");
        }
      };

      head.addEventListener("click", activate);


      li.appendChild(head);

      if (node.type==="group") {
        const ul=document.createElement("ul"); ul.className="submenu";
        (node.children||[]).forEach(ch=>ul.appendChild(liOf(ch)));
        li.appendChild(ul);
      }
      return li;
    };

    (MENU?.children||[]).forEach(n=>root.appendChild(liOf(n)));
  }

  function initTabs(){
    $$(".tab-btn").forEach(btn=>{
      btn.addEventListener("click", ()=>{
        $$(".tab-btn").forEach(b=>b.classList.remove("active"));
        $$(".tab-body").forEach(b=>b.classList.remove("active"));

        btn.classList.add("active");
        const body = $(`#tab-${btn.dataset.tab}`);
        if (body) body.classList.add("active");

        // ▶ синхронизируем атрибут hidden, чтобы неактивная секция не участвовала в раскладке
        const desc = $("#tab-desc"), docs = $("#tab-docs");
        if (desc && docs) {
          desc.toggleAttribute("hidden", !desc.classList.contains("active"));
          docs.toggleAttribute("hidden", !docs.classList.contains("active"));
        }
      });
    });
  }


  async function showContent(id, title="") {
    $("#content-title").textContent = title || (id==="home" ? "Главная" : "Без названия");
    // экспортная сборка → API → пустышка
    const data = await tryLoadContent(id) ?? {id, title, text_html:"", files:[]};
    if (id==="home" && data.title) { const t=$("#project-title"); if(t) t.textContent=data.title; }

    // Описание
    $("#desc-view").innerHTML = data.text_html || "";

    // Файлы
    const list=$("#docs-view"); list.innerHTML="";
    (data.files||[]).forEach(f=>{
      const li=document.createElement("li");
      li.className="file-item";
      li.innerHTML=`<span>${f.name}</span> <small>(${humanSize(f.size)})</small>`;
      li.onclick=()=>{
        $$("#docs-view .file-item").forEach(n=>n.classList.remove("active"));
        li.classList.add("active");
        FileViewer.show(rel(f.url), f.name);
        document.querySelector(`.tab-btn[data-tab="docs"]`)?.click();
      };
      list.appendChild(li);
    });

    if ((data.files||[]).length) list.querySelector(".file-item")?.click();
    else window.FileViewer?.clear?.();
  }

  function hookSearch(){
    const si=$("#menu-search-input"); if(!si) return;
    si.oninput=()=> {
      const q=(si.value||"").toLowerCase();
      $$("#menu-root .menu-item").forEach(li=>{
        const t = li.querySelector(".accordion-btn, .submenu-item")?.textContent?.toLowerCase() || "";
        li.style.display = !q || t.includes(q) ? "" : "none";
      });
    };
  }
  // логотип → именно главная страница (перезагрузка стартового экрана)
  {
    const el = document.querySelector('#logo-home, .logo');
    if (el) {
      el.style.cursor = 'pointer';

      const goHome = (e) => {
        e.preventDefault?.();
        const u = new URL(window.location.href);

        if (u.protocol === 'file:') {
          // экспорт/WebView: ведём на index.html в той же папке
          const base = u.href.replace(/[#?].*$/, '');
          const next = base.replace(/\/[^\/]*$/, '/index.html');
          window.location.href = next;
        } else {
          // сервер: ведём на корень приложения
          window.location.href = '/';
        }
      };

      el.addEventListener('click', goHome);
      el.setAttribute('tabindex', '0');
      el.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') goHome(e);
      });
    }
  }

  document.addEventListener("DOMContentLoaded", async ()=>{
    document.body.classList.add("view-mode");
    initTabs(); hookSearch();
    try { MENU = await loadJSON("./data/menu.json"); } catch { MENU = { children: [] }; }
    renderMenu(); showContent("home","Главная");
  });
})();
