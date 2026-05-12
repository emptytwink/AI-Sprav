// static/js/fileViewer.export.js
(() => {
  const $ = (s, r=document) => r.querySelector(s);
  const isImage = n => /\.(png|jpe?g|gif|webp|svg)$/i.test(n||"");
  const isPdf   = n => /\.pdf$/i.test(n||"");
  const isDocx  = n => /\.docx$/i.test(n||"");
  const isXls   = n => /\.(xlsx?|csv)$/i.test(n||"");
  const isPptx  = n => /\.pptx$/i.test(n||"");
  const abs = u => { try { return new URL(u||"", window.location.href).href; } catch { return u; } };

  async function loadOnce(src, ok) {
    if (ok()) return true;
    await new Promise((res, rej)=>{ const s=document.createElement("script"); s.src=src; s.onload=res; s.onerror=rej; document.head.appendChild(s); });
    return ok();
  }
  function clear(){ const box=$("#doc-preview"); if(box){ box.classList.add("hidden"); box.innerHTML=""; } }

  async function renderPdfWithPdfJs(absolute, box) {
    await loadOnce("./vendor/pdf.min.js", () => !!window.pdfjsLib);
    if (!window.pdfjsLib) { box.textContent="Не удалось отобразить PDF."; return; }
    window.pdfjsLib.GlobalWorkerOptions.workerSrc = "./vendor/pdf.worker.min.js";

    const wrap = document.createElement("div");
    wrap.style.cssText = "width:100%;max-height:80vh;overflow:auto;display:grid;gap:12px";
    box.innerHTML = ""; box.appendChild(wrap);

    try {
      const doc = await window.pdfjsLib.getDocument({ url: absolute }).promise;
      for (let p = 1; p <= doc.numPages; p++) {
        const page = await doc.getPage(p);
        const viewport = page.getViewport({ scale: 1.25 });
        const canvas = document.createElement("canvas");
        canvas.width = viewport.width; canvas.height = viewport.height;
        canvas.style.width = "100%"; canvas.style.height = "auto";
        const ctx = canvas.getContext("2d");
        await page.render({ canvasContext: ctx, viewport }).promise;
        wrap.appendChild(canvas);
      }
    } catch {
      box.textContent = "Не удалось отобразить PDF.";
    }
  }

  async function show(url, name){
    const box=$("#doc-preview"); if(!box) return;
    box.classList.remove("hidden"); box.innerHTML="";
    const absolute = abs(url);

    if (isImage(name)) { box.innerHTML=`<img src="${absolute}" style="max-width:100%;max-height:80vh;object-fit:contain">`; return; }

    if (isPdf(name)) {
      // В экспорте сразу используем pdf.js (надёжно офлайн)
      await renderPdfWithPdfJs(absolute, box);
      return;
    }

    if (isDocx(name)) {
      await loadOnce("./vendor/mammoth.browser.min.js", ()=>!!window.mammoth);
      if (!window.mammoth) { box.textContent="Не удалось отобразить DOCX."; return; }
      try {
        const ab=await fetch(absolute).then(r=>r.arrayBuffer());
        const res=await window.mammoth.convertToHtml({ arrayBuffer: ab }, { convertImage: window.mammoth.images.inline() });
        box.innerHTML=`<div class="docx-html">${res.value}</div>`;
      } catch { box.textContent="Не удалось отобразить DOCX."; }
      return;
    }

    if (isXls(name)) {
      await loadOnce("./vendor/xlsx.full.min.js", ()=>!!window.XLSX);
      if (!window.XLSX) { box.textContent="Не удалось отобразить таблицу."; return; }
      try {
        const ab=await fetch(absolute).then(r=>r.arrayBuffer());
        const wb=window.XLSX.read(ab,{type:"array"});
        const tabs=document.createElement("div"); tabs.className="xlsx-tabs";
        const wrap=document.createElement("div"); wrap.className="xlsx-wrap";
        const content=document.createElement("div"); content.className="xlsx-content";
        wrap.appendChild(content); box.appendChild(tabs); box.appendChild(wrap);
        function render(nm){ const raw=window.XLSX.utils.sheet_to_html(wb.Sheets[nm],{id:"xlsx-preview",editable:false}); const tmp=document.createElement("div"); tmp.innerHTML=raw; const t=tmp.querySelector("table"); t.classList.add("xlsx-table"); content.innerHTML=""; content.appendChild(t); }
        wb.SheetNames.forEach((nm,i)=>{ const b=document.createElement("button"); b.className="xlsx-tab"+(i===0?" active":""); b.textContent=nm; b.onclick=()=>{ tabs.querySelectorAll(".xlsx-tab").forEach(x=>x.classList.remove("active")); b.classList.add("active"); render(nm); }; tabs.appendChild(b); });
        render(wb.SheetNames[0]);
      } catch { box.textContent="Не удалось отобразить таблицу."; }
      return;
    }

    if (isPptx(name)) {
      await loadOnce("./vendor/pptx-preview.min.js", ()=>!!(window.pptxPreview&&window.pptxPreview.init));
      if (!(window.pptxPreview?.init)) { box.textContent="Не удалось отобразить презентацию."; return; }
      try {
        const pv=window.pptxPreview.init(box,{width:box.clientWidth||960,height:Math.min(Math.round(window.innerHeight*0.8),720)});
        const buf=await fetch(absolute).then(r=>r.arrayBuffer());
        await pv.preview(buf);
      } catch { box.textContent="Не удалось отобразить презентацию."; }
      return;
    }

    box.textContent="Неподдерживаемый предпросмотр.";
  }

  window.FileViewer = { show, clear };
})();
