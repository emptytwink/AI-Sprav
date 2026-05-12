// static/js/videoTools.js
(() => {
  const $  = (s, r=document) => r.querySelector(s);
  const $$ = (s, r=document) => Array.from(r.querySelectorAll(s));

  // --- интеграция с контентом ---
  const getId = () =>
    (window.getCurrentContentId?.()) ||
    window.currentId ||
    $('#content-pane')?.dataset.currentId || null;

  const editorEl = () =>
    document.getElementById('tab-editor') || document.getElementById('desc-editable');

  // --- вкладки/режим ---
  const isEditMode = () => document.getElementById('toggle-edit')?.checked === true;
  const getActiveTabKey = () => {
    const b = document.querySelector('.tab-btn.active');
    return b ? (b.dataset.key || b.dataset.tab) : 'desc';
  };
  const isDescActive = () => getActiveTabKey() === 'desc';

  // --- utils ---
  const abs = (u) => { try { return new URL(u || "", location.href).href; } catch { return u; } };
  const isVideoName = (n="") => /\.(mp4|webm|ogv?)$/i.test(n || "");
  const isLocalUpload = (url, circleId) => {
    if (!url || !circleId) return false;
    try {
      const h = abs(url);
      return /\/static\/uploads\//i.test(h) && h.includes(`/${encodeURIComponent(circleId)}/`);
    } catch { return false; }
  };

  // курсор гарантированно внутри редактора
  function ensureSelectionInEditor() {
    const ed = editorEl(); if (!ed) return;
    const sel = window.getSelection && window.getSelection();
    if (!sel || sel.rangeCount === 0 || !ed.contains(sel.anchorNode)) {
      const r = document.createRange();
      r.selectNodeContents(ed);
      r.collapse(false);
      sel.removeAllRanges();
      sel.addRange(r);
    }
  }
  function insertHtmlAtCursor(html) {
    const el = editorEl(); if (!el) return;
    el.focus(); ensureSelectionInEditor();
    document.execCommand('insertHTML', false, html);
  }
  function placeCaret(el, atEnd=0) {
    const r = document.createRange(); r.selectNodeContents(el); r.collapse(!!atEnd);
    const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(r);
  }
  function insertParagraphAfter(node) {
    const p = document.createElement('p'); p.innerHTML = '<br>';
    node.after(p); placeCaret(p, 0);
  }
  function pickToolbar() {
    // <-- ВАЖНО: у тебя тулбар теперь #desc-toolbar
    return document.querySelector('#desc-toolbar')
        || document.querySelector('#tab-content .rte-toolbar')
        || document.querySelector('#editor-toolbar')
        || document.querySelector('.content-actions')
        || null;
  }

  // --- загрузка ассета (НЕ в список "Документация") ---
  async function uploadAsset(file, circleId) {
    const fd = new FormData();
    fd.append('file', file);
    fd.append('circle_id', circleId);
    // основной путь — /upload_asset (кладёт в _assets/)
    let res = await fetch('/upload_asset', { method: 'POST', body: fd });
    if (res.ok) {
      const j = await res.json();
      if (j?.ok && j.url) return j.url;
    }
    // fallback: /upload_document (поместит в "Документацию") — нежелательно, но на крайний случай
    res = await fetch('/upload_document', { method: 'POST', body: fd });
    if (!res.ok) throw new Error('upload error');
    const j = await res.json();
    const saved = (j && j.saved && j.saved[0]) || file.name;
    return `/static/uploads/${encodeURIComponent(circleId)}/${encodeURIComponent(saved)}`;
  }

  // --- вставка блоков видео ---
  function htmlFigure(url, type='video/mp4') {
    return (
      `<figure class="video rte-video-box" style="width:100%;">
         <video controls preload="metadata" style="display:block;width:100%;height:auto;">
           <source src="${url}" type="${type}">
           Ваш браузер не поддерживает видео.
           <a href="${url}" target="_blank" rel="noopener">Скачать</a>
         </video>
         <div class="rte-video-resize" contenteditable="false" title="Потяните, чтобы изменить ширину"></div>
       </figure>`
    );
  }
  function htmlEmbed(src) {
    return (
      `<div class="video-embed rte-video-box" style="width:100%;position:relative;">
         <iframe src="${src}" allowfullscreen loading="lazy" style="display:block;width:100%;aspect-ratio:16/9;border:0;"></iframe>
         <div class="rte-video-resize" contenteditable="false" title="Потяните, чтобы изменить ширину"></div>
       </div>`
    );
  }

  function insertVideoBlock(html) {
    insertHtmlAtCursor(html);
    const ed = editorEl();
    const blk = ed?.querySelector('.rte-video-box:last-of-type');
    if (blk) {
      insertParagraphAfter(blk);
      selectVideoBox(blk);
    }
  }

  // ---- Вставка из файла ----
  async function insertFromFile() {
    if (!isEditMode() || !isDescActive()) { alert('Видео можно вставлять только во вкладку «Описание».'); return; }
    const circleId = getId();
    if (!circleId) { alert('Не определён ID страницы контента'); return; }

    const inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = 'video/*';
    inp.onchange = async () => {
      const f = inp.files?.[0]; if (!f) return;
      if (f.size > 500 * 1024 * 1024) { alert('Файл слишком большой (>500 МБ)'); return; }
      try {
        const url  = await uploadAsset(f, circleId);
        const type = (f.type && f.type.startsWith('video/')) ? f.type : 'video/mp4';
        insertVideoBlock(htmlFigure(url, type));
      } catch (e) {
        console.error(e); alert('Не удалось загрузить видео');
      }
    };
    inp.click();
  }

  // ---- Вставка по URL (YouTube/Vimeo/прямая) ----
  function yt(u){ try{const x=new URL(u); if(x.hostname.includes('youtu.be')) return `https://www.youtube.com/embed/${x.pathname.slice(1)}`; if(x.hostname.includes('youtube.com')){const id=x.searchParams.get('v'); if(id) return `https://www.youtube.com/embed/${id}`;} }catch{} return null; }
  function vimeo(u){ try{const x=new URL(u); if(x.hostname.includes('vimeo.com')){const id=x.pathname.split('/').filter(Boolean).pop(); if(id) return `https://player.vimeo.com/video/${id}`;} }catch{} return null; }
  function insertFromUrl() {
    if (!isEditMode() || !isDescActive()) { alert('Видео можно вставлять только во вкладку «Описание».'); return; }
    const url = prompt('Ссылка на видео (YouTube, Vimeo или прямая .mp4/.webm/.ogg):');
    if (!url) return;

    const y = yt(url);
    if (y) return insertVideoBlock(htmlEmbed(y));
    const v = vimeo(url);
    if (v) return insertVideoBlock(htmlEmbed(v));

    if (/\.(mp4|webm|ogv?)$/i.test(url)) {
      return insertVideoBlock(htmlFigure(url));
    }
    alert('Нужен YouTube/Vimeo или прямая ссылка на mp4/webm/ogg');
  }

  // ---- панель локальных действий над блоком ----
  let currentBlock = null;
  const panel = document.createElement('div');
  panel.className = 'video-toolbar edit-mode-only';
  panel.innerHTML = `
    <button type="button" class="btn tool-btn" data-act="para-before">Абзац ↑</button>
    <button type="button" class="btn tool-btn" data-act="para-after">Абзац ↓</button>
    <span class="sep" style="margin:0 6px;"></span>
    <label>Ширина:
      <select data-act="size">
        <option value="25">25%</option>
        <option value="50">50%</option>
        <option value="75">75%</option>
        <option value="100" selected>100%</option>
      </select>
    </label>
    <span class="sep" style="margin:0 6px;"></span>
    <button type="button" class="btn tool-btn" data-act="remove-block">Удалить блок</button>
    <button type="button" class="btn danger"   data-act="remove-file">Удалить файл</button>
  `;
  panel.style.display = 'none';
  panel.style.position = 'absolute';
  panel.style.zIndex = '1000';
  document.body.appendChild(panel);

  function placePanelNear(el) {
    const r = el.getBoundingClientRect();
    const x = Math.min(r.left, window.innerWidth - panel.offsetWidth - 8) + 8;
    const y = Math.max(r.top - panel.offsetHeight - 8, 8);
    panel.style.left = `${x}px`;
    panel.style.top  = `${y + window.scrollY}px`;
  }
  function selectVideoBox(box) {
    $$('.rte-video-box').forEach(b => b.classList.remove('selected'));
    if (box) box.classList.add('selected');
  }
  function findVideoBlock(target) {
    const ed = editorEl(); if (!ed) return null;
    let el = target;
    while (el && el !== ed) {
      if (el.matches && (el.matches('.rte-video-box') || el.matches('figure.video') || el.matches('.video-embed'))) {
        return el;
      }
      el = el.parentNode;
    }
    return null;
  }
  function hidePanel(){ panel.style.display = 'none'; currentBlock = null; }
  function showPanelFor(block) {
    currentBlock = block;
    panel.style.display = (isEditMode() && isDescActive()) ? 'inline-flex' : 'none';
    if (panel.style.display !== 'none') placePanelNear(block);
  }

  async function deleteServerFileOf(block) {
    const id = getId(); if (!id) return false;
    const s = block.querySelector('source[src], video[src]');
    const url = s?.getAttribute('src');
    if (!url || !isLocalUpload(url, id)) return false;

    let filename = '';
    try {
      const a = document.createElement('a'); a.href = abs(url);
      filename = decodeURIComponent(a.pathname.split('/').pop() || '');
    } catch {}
    if (!filename) return false;

    const r = await fetch('/delete_document', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ circle_id: id, filename })
    });
    return r.ok;
  }

  panel.addEventListener('click', async (e) => {
    const act = e.target?.dataset?.act;
    if (!act || !currentBlock) return;

    if (act === 'para-before') { insertParagraphBefore(currentBlock); hidePanel(); return; }
    if (act === 'para-after')  { insertParagraphAfter(currentBlock);  hidePanel(); return; }
    if (act === 'remove-block'){ currentBlock.remove(); hidePanel(); (window.toast?.('Видео удалено')||0); return; }
    if (act === 'remove-file') {
      const id = getId();
      const local = (() => {
        const s = currentBlock.querySelector('source[src], video[src]');
        return s && isLocalUpload(s.getAttribute('src'), id);
      })();
      if (!confirm(local
        ? 'Удалить файл с диска и блок из описания? Действие необратимо.'
        : 'Это внешнее видео. Будет удалён только блок из описания.')) return;

      let ok = true;
      if (local) { try { ok = await deleteServerFileOf(currentBlock); } catch { ok = false; } }
      currentBlock.remove(); hidePanel();
      (window.toast?.(ok ? 'Файл удалён' : 'Файл не удалось удалить (удалён только блок)')||0);
      return;
    }
  });
  panel.addEventListener('change', (e) => {
    if (e.target?.dataset?.act !== 'size' || !currentBlock) return;
    const ed = editorEl(); if (!ed) return;
    const contW = ed.getBoundingClientRect().width;
    const pct   = Number(e.target.value) || 100;
    currentBlock.style.width = Math.round(contW * pct / 100) + 'px';
  });

  // --- ручной ресайз блоков (уголок) ---
  let drag = null;
  function startResize(box, x0, w0, contW) {
    drag = { box, x0, w0, contW };
    document.addEventListener('mousemove', onResizeMove);
    document.addEventListener('mouseup', onResizeEnd, { once: true });
  }
  function onResizeMove(e) {
    if (!drag) return;
    const dx = e.clientX - drag.x0;
    let w = Math.max(240, drag.w0 + dx);
    w = Math.min(w, drag.contW);
    drag.box.style.width = w + 'px';
  }
  function onResizeEnd() {
    document.removeEventListener('mousemove', onResizeMove);
    drag = null;
  }

  function bindEditorHandlers() {
    const ed = editorEl(); if (!ed || ed.dataset.videoBound) return;
    ed.dataset.videoBound = '1';

    ed.addEventListener('click', (e) => {
      // показываем панель только в Описании и в режиме редактирования
      if (!isEditMode() || !isDescActive()) { hidePanel(); return; }

      // resize-хваталка?
      const handle = e.target.closest?.('.rte-video-resize');
      if (handle) {
        const box = handle.parentElement;
        const rect = box.getBoundingClientRect();
        const contW = ed.getBoundingClientRect().width;
        startResize(box, e.clientX, rect.width, contW);
        e.preventDefault();
        return;
      }

      const blk = findVideoBlock(e.target);
      if (blk) { selectVideoBox(blk); showPanelFor(blk); } else hidePanel();
    });

    document.addEventListener('scroll', () => {
      if (currentBlock && panel.style.display !== 'none') placePanelNear(currentBlock);
    }, { passive: true });

    document.addEventListener('click', (e) => {
      if (!panel.contains(e.target) && !editorEl()?.contains(e.target)) hidePanel();
    });
  }

  // --- кнопки в тулбаре (рисуем в JS) ---
  function attachButtons(toolbar) {
    if (!toolbar || toolbar.dataset.videoToolsReady) return false;

    const box = document.createElement('div');
    box.className = 'video-tools edit-mode-only';
    box.style.display = 'inline-flex';
    box.style.gap = '6px';
    box.style.marginLeft = '8px';

    const b1 = document.createElement('button');
    b1.type = 'button'; b1.className = 'btn tool-btn'; b1.textContent = 'Видео (файл)';
    b1.addEventListener('click', insertFromFile);

    const b2 = document.createElement('button');
    b2.type = 'button'; b2.className = 'btn tool-btn'; b2.textContent = 'Видео (URL)';
    b2.addEventListener('click', insertFromUrl);

    box.append(b1, b2);
    toolbar.appendChild(box);
    toolbar.dataset.videoToolsReady = '1';
    return true;
  }

  function syncButtonsVisibility() {
    // видны ТОЛЬКО в режиме редактирования и ТОЛЬКО при активной вкладке "Описание"
    const on = isEditMode() && isDescActive();
    $$('.video-tools').forEach(el => el.hidden = !on);
    // панель возле блока тоже скрываем, если вышли из условий
    if (!on) hidePanel();
  }

  function initButtons() {
    const tb = pickToolbar();
    if (!tb) return false;
    const ok = attachButtons(tb);
    syncButtonsVisibility();
    return ok;
  }

  function initObservers() {
    // смена режима
    document.getElementById('toggle-edit')?.addEventListener('change', syncButtonsVisibility);

    // переключение вкладок
    document.addEventListener('click', (e) => {
      const b = e.target.closest?.('.tab-btn');
      if (b) setTimeout(syncButtonsVisibility, 0);
    });

    // если тулбар подрисуется позже
    const tbObs = new MutationObserver(() => { initButtons(); });
    tbObs.observe(document.body, { childList: true, subtree: true });
  }

  // --- старт ---
  function init() {
    initButtons();
    bindEditorHandlers();
    initObservers();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  // --- экспорт для других модулей ---
  window.VideoTools = {
    isVideoName: (n) => isVideoName(n),
    renderVideoPreview: (box, url) => {
      const a = abs(url);
      box.innerHTML =
        `<video controls preload="metadata" style="max-width:100%;max-height:80vh;display:block;margin:0 auto;">
           <source src="${a}">
           Ваш браузер не поддерживает видео. <a href="${a}" target="_blank" rel="noopener">Скачать</a>
         </video>`;
    },
    addButtons: initButtons
  };
})();
