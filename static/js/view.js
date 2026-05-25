(() => {
  let map = null;
  let currentProject = null;
  let currentDrawingId = null;
  let currentCircleId = null;
  let isEditMode = true;

  function getQueryParam(name) {
    const params = new URLSearchParams(window.location.search);
    return params.get(name);
  }

  function setEmptyCanvasState(isEmpty) {
    const hint = document.getElementById("map-empty-hint");
    if (!hint) return;
    hint.classList.toggle("hidden", !isEmpty);
  }

  function resetToEmptyCanvas() {
    if (map) {
      map.remove();
      map = null;
    }
    setEmptyCanvasState(true);
  }

  function tryLoadImageSequentially(urls, onSuccess, onFail) {
    let index = 0;

    function tryNext() {
      if (index >= urls.length) {
        if (onFail) onFail();
        return;
      }

      const url = urls[index++];
      if (!url) {
        tryNext();
        return;
      }

      const img = new Image();
      img.onload = () => onSuccess(url, img);
      img.onerror = () => tryNext();
      img.src = url;
    }

    tryNext();
  }

  function initMapWithImage(imageUrl, img) {
    const width = img.naturalWidth || img.width;
    const height = img.naturalHeight || img.height;
    if (!width || !height) {
      resetToEmptyCanvas();
      return;
    }

    if (map) {
      map.remove();
      map = null;
    }

    map = L.map("map", {
      crs: L.CRS.Simple,
      zoomControl: true,
      minZoom: -2,
      maxZoom: 4,
      attributionControl: false,
    });

    const southWest = [0, 0];
    const northEast = [height, width];
    const bounds = [southWest, northEast];

    L.imageOverlay(imageUrl, bounds).addTo(map);
    map.fitBounds(bounds);
    setEmptyCanvasState(false);
  }

  function renderFilesList(filesForCircle) {
    const filesListEl = document.getElementById("files-list");
    if (!filesListEl) return;
    filesListEl.innerHTML = "";

    if (Array.isArray(filesForCircle) && filesForCircle.length > 0) {
      filesForCircle.forEach((f) => {
        const row = document.createElement("div");
        row.className = "file-row";

        const nameSpan = document.createElement("span");
        nameSpan.className = "file-name";
        nameSpan.textContent = f.name;

        const sizeSpan = document.createElement("span");
        sizeSpan.className = "file-size";
        if (typeof f.size === "number") {
          const kb = f.size / 1024;
          sizeSpan.textContent = kb >= 1024 ? `${(kb / 1024).toFixed(1)} МБ` : `${kb.toFixed(1)} КБ`;
        } else {
          sizeSpan.textContent = "";
        }

        row.appendChild(nameSpan);
        row.appendChild(sizeSpan);
        filesListEl.appendChild(row);
      });
      return;
    }

    const empty = document.createElement("div");
    empty.className = "file-empty";
    empty.textContent = "К этому кругу ещё не прикреплены документы";
    filesListEl.appendChild(empty);
  }

  async function loadDataAndInit() {
    const project = currentProject;
    const drawingId = currentDrawingId;
    const circleId = currentCircleId;

    if (!project || !drawingId || !circleId) {
      alert("Не переданы параметры project / drawing_id / circle_id");
      return;
    }

    let filesMap = {};
    try {
      const resp = await fetch(
        `/circle_files/${encodeURIComponent(drawingId)}?project=${encodeURIComponent(project)}`
      );
      if (resp.ok) {
        filesMap = (await resp.json()) || {};
      }
    } catch (e) {
      console.error("Ошибка при запросе /circle_files:", e);
    }

    const filesForCircle = filesMap[circleId] || [];

    const circleLabel = document.getElementById("circle-label");
    const circleLabel2 = document.getElementById("circle-label-2");
    if (circleLabel) circleLabel.textContent = circleId;
    if (circleLabel2) circleLabel2.textContent = circleId;

    renderFilesList(filesForCircle);

    const candidateUrls = [];
    if (Array.isArray(filesForCircle) && filesForCircle.length > 0) {
      const imageExts = ["png", "jpg", "jpeg", "gif", "webp", "svg"];
      for (let i = filesForCircle.length - 1; i >= 0; i--) {
        const f = filesForCircle[i];
        const name = String(f.name || "");
        const ext = name.split(".").pop().toLowerCase();
        if (imageExts.includes(ext) && f.url) {
          candidateUrls.push(f.url);
          break;
        }
      }
    }

    if (candidateUrls.length === 0) {
      resetToEmptyCanvas();
      return;
    }

    tryLoadImageSequentially(
      candidateUrls,
      (okUrl, img) => initMapWithImage(okUrl, img),
      () => resetToEmptyCanvas()
    );
  }

  function initUploadPanel() {
    const uploadToggle = document.getElementById("upload-toggle");
    const uploadPanel = document.getElementById("upload-panel");
    const uploadInput = document.getElementById("upload-input");
    const uploadBtn = document.getElementById("upload-submit");
    const formEl = document.getElementById("upload-form");

    if (uploadToggle && uploadPanel) {
      if (!isEditMode) {
        uploadToggle.classList.add("hidden");
        uploadPanel.classList.add("hidden");
      }
      uploadToggle.addEventListener("click", () => {
        if (!isEditMode) return;
        uploadPanel.classList.toggle("hidden");
      });
    }

    if (!uploadInput || !uploadBtn || !formEl) return;

    uploadBtn.addEventListener("click", async () => {
      if (!isEditMode) return;
      const files = uploadInput.files;
      if (!files || files.length === 0) {
        alert("Выберите хотя бы один файл");
        return;
      }

      const formData = new FormData(formEl);
      for (const file of files) {
        formData.append("files", file);
      }

      try {
        const resp = await fetch("/upload_documents", {
          method: "POST",
          body: formData,
        });
        const data = await resp.json().catch(() => null);
        if (!resp.ok || !data || data.error) {
          alert((data && data.error) || "Ошибка при загрузке файлов");
          return;
        }

        uploadInput.value = "";
        uploadPanel.classList.add("hidden");
        await loadDataAndInit();
      } catch (e) {
        console.error(e);
        alert("Ошибка связи с сервером при загрузке файлов");
      }
    });
  }

  document.addEventListener("DOMContentLoaded", () => {
    currentProject = getQueryParam("project") || "home";
    currentDrawingId = getQueryParam("drawing_id");
    currentCircleId = getQueryParam("circle_id");
    isEditMode = getQueryParam("edit") === null ? true : getQueryParam("edit") === "1";

    const drawingInput = document.querySelector("input[name='drawing_id']");
    if (drawingInput) drawingInput.value = currentDrawingId || "";
    const circleInput = document.querySelector("input[name='circle_id']");
    if (circleInput) circleInput.value = currentCircleId || "";
    const projectInput = document.querySelector("input[name='project']");
    if (projectInput) projectInput.value = currentProject || "";

    initUploadPanel();
    resetToEmptyCanvas();
    loadDataAndInit();
  });
})();
