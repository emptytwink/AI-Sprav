// static/js/view.js
// Просмотр документов для выбранного круга на карте Leaflet
(() => {
  let map = null;
  let currentProject = null;
  let currentDrawingId = null;
  let currentCircleId = null;

  function getQueryParam(name) {
    const params = new URLSearchParams(window.location.search);
    return params.get(name);
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
      console.error("Не удалось определить размер изображения", imageUrl);
      alert("Не удалось отобразить документ (нет размеров изображения)");
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
  }

  async function loadDataAndInit() {
    const project = currentProject;
    const drawingId = currentDrawingId;
    const circleId = currentCircleId;

    if (!project || !drawingId || !circleId) {
      alert("Не переданы параметры project / drawing_id / circle_id");
      return;
    }

    // 1. JSON чертежа
    const drawingUrl = `/load_drawing_by_project?project=${encodeURIComponent(
      project
    )}&drawing_id=${encodeURIComponent(drawingId)}`;
    let drawingData;
    try {
      const resp = await fetch(drawingUrl);
      if (!resp.ok) {
        console.error(
          "Ошибка load_drawing_by_project:",
          resp.status,
          await resp.text()
        );
        alert("Не удалось загрузить данные чертежа");
        return;
      }
      drawingData = await resp.json();
    } catch (e) {
      console.error("Ошибка сети при load_drawing_by_project:", e);
      alert("Ошибка связи с сервером (чертёж)");
      return;
    }

    // 2. Файлы круга
    let filesMap = {};
    try {
      const resp = await fetch(
        `/circle_files/${encodeURIComponent(drawingId)}?project=${encodeURIComponent(
          project
        )}`
      );
      if (resp.ok) {
        filesMap = (await resp.json()) || {};
      } else {
        console.warn(
          "circle_files ответил с ошибкой:",
          resp.status,
          await resp.text()
        );
      }
    } catch (e) {
      console.error("Ошибка при запросе /circle_files:", e);
    }

    const filesForCircle = filesMap[circleId] || [];

    // 3. Обновляем заголовки / список файлов
    const circleLabel = document.getElementById("circle-label");
    const circleLabel2 = document.getElementById("circle-label-2");
    const filesListEl = document.getElementById("files-list");

    if (circleLabel) circleLabel.textContent = circleId;
    if (circleLabel2) circleLabel2.textContent = circleId;

    if (filesListEl) {
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
            sizeSpan.textContent =
              kb >= 1024
                ? `${(kb / 1024).toFixed(1)} МБ`
                : `${kb.toFixed(1)} КБ`;
          }

          row.appendChild(nameSpan);
          row.appendChild(sizeSpan);
          filesListEl.appendChild(row);
        });
      } else {
        const empty = document.createElement("div");
        empty.className = "file-empty";
        empty.textContent = "К этому кругу ещё не прикреплены документы";
        filesListEl.appendChild(empty);
      }
    }

    // 4. Выбираем, что показать на фоне
    const candidateUrls = [];

    // 4.1. Сначала файлы круга
    if (Array.isArray(filesForCircle) && filesForCircle.length > 0) {
      const imageExts = ["png", "jpg", "jpeg", "gif", "webp", "svg"];

      for (let i = filesForCircle.length - 1; i >= 0; i--) {
        const f = filesForCircle[i];
        const name = String(f.name || "");
        const ext = name.split(".").pop().toLowerCase();

        if (imageExts.includes(ext) && f.url) {
          candidateUrls.push(f.url); // <-- просто берём URL, который дал бэк
          break;
        }
      }
    }

    // 4.2. Если подходящих файлов нет – фолбэк на сам чертёж
    if (candidateUrls.length === 0) {
      if (drawingData.original_image) {
        candidateUrls.push(drawingData.original_image);
      } else if (drawingData.processed_image) {
        candidateUrls.push(drawingData.processed_image);
      }
      if (drawingData.drawing_name) {
        const rawUrl = `/static/${encodeURIComponent(
          project
        )}/state/drawings/${encodeURIComponent(drawingData.drawing_name)}`;
        candidateUrls.push(rawUrl);
      }
    }

    if (candidateUrls.length === 0) {
      alert("Нет ни подходящих документов, ни изображения чертежа для отображения");
      return;
    }

    tryLoadImageSequentially(
      candidateUrls,
      (okUrl, img) => {
        initMapWithImage(okUrl, img);
      },
      () => {
        alert("Не удалось загрузить ни один из вариантов изображения");
      }
    );
  }

  function initUploadPanel() {
    const uploadToggle = document.getElementById("upload-toggle");
    const uploadPanel = document.getElementById("upload-panel");
    const uploadInput = document.getElementById("upload-input");
    const uploadBtn = document.getElementById("upload-submit");
    const formEl = document.getElementById("upload-form");

    if (uploadToggle && uploadPanel) {
      uploadToggle.addEventListener("click", () => {
        uploadPanel.classList.toggle("hidden");
      });
    }

    if (!uploadInput || !uploadBtn || !formEl) return;

    uploadBtn.addEventListener("click", async () => {
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
          console.error("upload_documents error:", data);
          alert((data && data.error) || "Ошибка при загрузке файлов");
          return;
        }

        alert("Файлы успешно загружены");
        await loadDataAndInit();
        uploadInput.value = "";
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

    const drawingInput = document.querySelector("input[name='drawing_id']");
    if (drawingInput) drawingInput.value = currentDrawingId || "";

    const circleInput = document.querySelector("input[name='circle_id']");
    if (circleInput) circleInput.value = currentCircleId || "";

    const projectInput = document.querySelector("input[name='project']");
    if (projectInput) projectInput.value = currentProject || "";

    initUploadPanel();
    loadDataAndInit();
  });
})();