// static/js/tinyEditor.js
(() => {
  const $ = (s, r=document) => r.querySelector(s);
  const activeTab = () => document.querySelector('.tab-btn.active');
  const activeTabKey = () => activeTab()?.dataset.key || 'desc';
  const activeTabView = () => activeTab()?.dataset.view || activeTabKey();
  const isDescOrExtra = () => !['docs', 'drawings'].includes(activeTabView());
  const isEditMode = () => document.getElementById('toggle-edit')?.checked === true;
  const getId = () => (window.getCurrentContentId?.()) || window.currentId || $('#content-pane')?.dataset.currentId || null;
  const debounce = (fn, ms=400) => { let t; return (...a)=>{ clearTimeout(t); t=setTimeout(()=>fn(...a),ms); }; };

  async function apiJson(url, opts={}) {
    const r = await fetch(url, opts);
    if (!r.ok) throw new Error(`${opts.method||'GET'} ${url} failed`);
    return r.json();
  }
  async function uploadAsset(file, circleId) {
    const fd = new FormData();
    fd.append('file', file);
    fd.append('circle_id', circleId);
    const r = await fetch('/upload_asset', { method:'POST', body:fd });
    const j = await r.json();
    if (!r.ok || !j.ok || !j.url) throw new Error('upload_asset failed');
    return j.url;
  }

  let editor = null;
  let bound = false;
  let lastBoundId = null;

  function currentHtmlFallback() { return $('#tab-editor')?.innerHTML || ''; }
  function contentGet() { return editor ? editor.getContent({ format:'html' }) : currentHtmlFallback(); }
  function contentSet(html) {
    if (editor) editor.setContent(html || '');
    else { const el = $('#tab-editor'); if (el) el.innerHTML = html || ''; }
  }

  const saveDebounced = debounce(async () => {
    const id = getId();
    if (!id) return;

    const html = contentGet();
    const key = activeTabKey();

    try {
      if (key === 'desc') {
        await apiJson(`/api/content/${encodeURIComponent(id)}`, {
          method:'POST', headers:{'Content-Type':'application/json'},
          body: JSON.stringify({ text_html: html })
        });
      } else {
        await apiJson(`/api/content/${encodeURIComponent(id)}/tabs/${encodeURIComponent(key)}`, {
          method:'PUT', headers:{'Content-Type':'application/json'},
          body: JSON.stringify({ html })
        });
      }
    } catch (e) {
      console.error('Tiny save failed', e);
      (window.toast?.('Ошибка сохранения','err')||0);
    }
  }, 500);

  async function ensureEditor() {
    // Включаем редактор только в режиме редактирования и на вкладках описания/extra
    if (!isEditMode() || !isDescOrExtra()) { destroyEditor(); return; }

    const id = getId();

    if (editor && lastBoundId === id) return;

    destroyEditor();
    lastBoundId = id;

    tinymce.init({
      target: document.getElementById('tab-editor'),
      menubar: false,
      branding: false,
      height: 680,

      // Добавили поддержку вставки изображений.
      plugins: 'link image media table lists code',

      toolbar:
        'undo redo | blocks | bold italic underline | ' +
        'fontfamily fontsize forecolor backcolor | ' +
        'alignleft aligncenter alignright | bullist numlist | ' +
        'link image media table | removeformat | code',

      fontsize_formats: '12px 14px 16px 18px 20px 24px 28px 32px 36px',
      font_family_formats:
        'Inter=Inter,Arial,Helvetica,sans-serif;' +
        'Arial=Arial,Helvetica,sans-serif;' +
        'Georgia=Georgia,serif;' +
        'Times New Roman=Times New Roman,Times,serif;' +
        'Roboto=Roboto,Arial,Helvetica,sans-serif;' +
        'Monospace=ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace',

      // Разрешаем ручной ресайз картинок.
      object_resizing: 'img,video,iframe',  // раньше было только 'video,iframe' :contentReference[oaicite:2]{index=2}

      // стиль внутри iframe редактора
      content_style:
        'body{font-size:16px;line-height:1.55}' +
        'img{max-width:100%;height:auto;display:block}' +
        'figure{margin:12px 0}',

      paste_data_images: true,   // позволяем вставку картинок из буфера

      // единый файловый пикер для картинок и видео
      file_picker_types: 'image media',
      file_picker_callback: async (cb, _value, meta) => {
        const cid = getId();
        if (!cid) { alert('Сначала выберите пункт меню.'); return; }

        const inp = document.createElement('input');
        inp.type = 'file';
        inp.accept = meta.filetype === 'image'
          ? 'image/*'
          : 'video/mp4,video/webm,video/ogg';

        inp.onchange = async () => {
          const f = inp.files?.[0]; if (!f) return;
          try {
            const url = await uploadAsset(f, cid);
            if (meta.filetype === 'image') cb(url, { alt: '' });
            else cb(url, { source2: url, poster: '' });
          } catch {
            alert('Не удалось загрузить файл');
          }
        };
        inp.click();
      },

      // вставка изображений из буфера/drag&drop
      images_upload_handler: async (blobInfo, success, failure) => {
        try {
          const cid = getId();
          if (!cid) return failure('Не выбран пункт меню');
          const file = new File([blobInfo.blob()], blobInfo.filename(), { type: blobInfo.blob().type });
          const url = await uploadAsset(file, cid);
          success(url);
        } catch (e) {
          failure('upload failed');
        }
      },

      setup: (ed) => {
        editor = ed;
        ed.on('input undo redo change', () => saveDebounced());

        // подхватить HTML, который был отрисован во viewer до инициализации
        setTimeout(() => {
          const domHtml = currentHtmlFallback();
          if (domHtml && domHtml.trim() !== '') contentSet(domHtml);
        }, 0);
      }
    });
  }

  function destroyEditor() {
    if (editor) {
      const html = editor.getContent({ format:'html' });
      const el = $('#tab-editor'); if (el) el.innerHTML = html;
      editor.destroy();
      editor = null;
    }
  }

  function sync() { ensureEditor(); }

  function bindOnce() {
    if (bound) return;
    bound = true;

    $('#toggle-edit')?.addEventListener('change', () => sync());
    document.addEventListener('click', (e) => {
      if (e.target.closest?.('.tab-btn')) setTimeout(sync, 0);
    });
  }

  const origShow = window.showContent;
  if (typeof origShow === 'function') {
    window.showContent = async (id, title) => {
      const res = await origShow(id, title);
      lastBoundId = null;
      setTimeout(sync, 0);
      return res;
    };
  }

  document.addEventListener('DOMContentLoaded', () => {
    bindOnce();
    sync();
  });

  window.TinyEditor = {
    sync,
    getHtml: contentGet,
    setHtml: contentSet
  };
})();
// --- добавить в конец static/js/tinyEditor.js ---
(function bindManualSave() {
  const btn = document.getElementById('btn-save-content');
  if (!btn || btn.dataset.bound) return;
  btn.dataset.bound = '1';

  async function manualSave() {
    const id = (window.getCurrentContentId?.()) ||
               window.currentId ||
               document.getElementById('content-pane')?.dataset.currentId;
    if (!id) return;

    // взять HTML либо из TinyMCE, либо из #tab-editor
    const html = (window.TinyEditor?.getHtml?.()) ||
                 document.getElementById('tab-editor')?.innerHTML || '';

    const active = document.querySelector('.tab-btn.active');
    const key = active?.dataset.key || 'desc';
    const view = active?.dataset.view || key;
    if (view === 'docs' || view === 'drawings') return;

    try {
      if (key === 'desc') {
        await fetch(`/api/content/${encodeURIComponent(id)}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text_html: html })
        });
      } else {
        await fetch(`/api/content/${encodeURIComponent(id)}/tabs/${encodeURIComponent(key)}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ html })
        });
      }
      window.toast?.('Сохранено');      // ← тост ТОЛЬКО здесь
    } catch (e) {
      console.error(e);
      window.toast?.('Ошибка сохранения','err');
    }
  }

  // клик по кнопке
  btn.addEventListener('click', manualSave);

  // Ctrl+S / Cmd+S → сохранить
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'S')) {
      e.preventDefault();
      btn.click();
    }
  });
})();
