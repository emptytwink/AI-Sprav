// static/js/result.js
// Страница просмотра одного чертежа с кругами (вариант с unproject как в старом файле)

document.addEventListener("DOMContentLoaded", () => {
  const params = new URLSearchParams(window.location.search);
  const project = params.get("project");
  const drawingId = params.get("drawing_id");

  if (!project || !drawingId) {
    alert("Не переданы project или drawing_id в URL");
    return;
  }

  const mapContainer = document.getElementById("map");
  const radiusInput = document.getElementById("radius-input");
  const radiusNumberInput = document.getElementById("radius-number");
  const radiusValueEl = document.getElementById("radius-value");
  const setRadiusAllBtn = document.getElementById("set-radius-all-btn");
  const showWithFilesCheckbox = document.getElementById("show-with-files");
  const showEmptyCheckbox = document.getElementById("show-empty");
  const panelToggleBtn = document.getElementById("panel-toggle-btn");
  const projectNameEl = document.getElementById("project-name");
  const drawingTitleEl = document.getElementById("drawing-title");

  let map = null;
  let circles = []; // [{ data, layer, hasFiles }]
  let currentDrawing = null;
  let controlsHooked = false;

  const DEFAULT_RADIUS = 7;
  let currentCircleRadius = DEFAULT_RADIUS;

  // ---------- УТИЛИТЫ РАДИУСА ----------

  function clampRadius(value) {
    const num = Number(value);
    if (!Number.isFinite(num) || num <= 0) return DEFAULT_RADIUS;
    return Math.max(1, Math.min(120, Math.round(num)));
  }

  function setRadiusUI(raw) {
    const r = clampRadius(raw);
    currentCircleRadius = r;

    if (radiusInput) radiusInput.value = String(r);
    if (radiusNumberInput) radiusNumberInput.value = String(r);
    if (radiusValueEl) radiusValueEl.textContent = String(r);

    return r;
  }

  function getInitialRadiusFromDrawing(drawing) {
    if (!drawing || !Array.isArray(drawing.circles) || drawing.circles.length === 0) {
      return DEFAULT_RADIUS;
    }

    const firstValid = drawing.circles.find((c) => {
      const r = Number(c.radius);
      return Number.isFinite(r) && r > 0;
    });

    if (!firstValid) {
      return DEFAULT_RADIUS;
    }

    return clampRadius(firstValid.radius);
  }

  // стартовое значение радиуса из HTML-контролов до загрузки данных
  if (radiusInput || radiusNumberInput) {
    const start =
      (radiusNumberInput && radiusNumberInput.value) ||
      (radiusInput && radiusInput.value) ||
      DEFAULT_RADIUS;
    setRadiusUI(start);
  }

  if (radiusInput) {
    radiusInput.addEventListener("input", () => {
      setRadiusUI(radiusInput.value);
    });
  }

  if (radiusNumberInput) {
    radiusNumberInput.addEventListener("input", () => {
      setRadiusUI(radiusNumberInput.value);
    });

    radiusNumberInput.addEventListener("change", () => {
      setRadiusUI(radiusNumberInput.value);
    });
  }

  // ---------- UI: ПАНЕЛЬ ----------

  if (panelToggleBtn) {
    panelToggleBtn.addEventListener("click", () => {
      document.body.classList.toggle("panel-collapsed");
      if (map) {
        setTimeout(() => map.invalidateSize(), 260);
      }
    });
  }

  // ---------- ЗАГРУЗКА ДАННЫХ ЧЕРТЕЖА ----------

  fetch(
    `/load_drawing_by_project?project=${encodeURIComponent(
      project
    )}&drawing_id=${encodeURIComponent(drawingId)}`
  )
    .then((r) => {
      if (!r.ok) {
        throw new Error("Не удалось загрузить данные чертежа");
      }
      return r.json();
    })
    .then((drawing) => {
      currentDrawing = drawing;

      if (!drawing || !drawing.drawing_name) {
        throw new Error("В ответе нет drawing_name");
      }

      if (projectNameEl) {
        projectNameEl.textContent = project;
      }

      if (drawingTitleEl) {
        drawingTitleEl.textContent =
          drawing.display_name || drawing.drawing_name || drawing.drawing_id;
      }

      const drawingRadius = getInitialRadiusFromDrawing(drawing);
      setRadiusUI(drawingRadius);

      const imageUrl =
        drawing.original_image ||
        drawing.processed_image ||
        `/static/${encodeURIComponent(
          project
        )}/state/drawings/${encodeURIComponent(drawing.drawing_name)}`;

      const img = new Image();
      img.crossOrigin = "Anonymous";

      img.onload = () => {
        initMap(drawing, imageUrl, img.naturalWidth, img.naturalHeight);
      };

      img.onerror = () => {
        console.error("Не удалось загрузить изображение чертежа", imageUrl);
        alert("Не удалось загрузить изображение чертежа");
      };

      img.src = imageUrl;
    })
    .catch((err) => {
      console.error(err);
      alert("Ошибка загрузки данных чертежа");
    });

  // ---------- ИНИЦИАЛИЗАЦИЯ КАРТЫ ----------

  function initMap(drawing, imageUrl, imgWidth, imgHeight) {
    const width = imgWidth;
    const height = imgHeight;

    if (!mapContainer) {
      console.error("Нет контейнера карты #map");
      return;
    }

    if (map) {
      map.remove();
      map = null;
    }

    circles = [];

    map = L.map(mapContainer, {
      crs: L.CRS.Simple,
      minZoom: -2,
      maxZoom: 3,
      attributionControl: false,
    });

    const zoom = map.getMaxZoom() - 1;

    const southWest = map.unproject([0, height], zoom);
    const northEast = map.unproject([width, 0], zoom);
    const bounds = new L.LatLngBounds(southWest, northEast);

    L.imageOverlay(imageUrl, bounds).addTo(map);
    map.fitBounds(bounds);

    const filesMap = drawing.files || {};

    (drawing.circles || []).forEach((c) => {
      const latlng = map.unproject([c.x, c.y], zoom);

      const filesForCircle = filesMap[c.id] || filesMap[c.circle_key];
      const hasFiles =
        Array.isArray(filesForCircle) && filesForCircle.length > 0;

      createCircleLayer(c, latlng, hasFiles);
    });

    hookControls();
    applyVisibilityFilter();

    setTimeout(() => map.invalidateSize(), 100);
  }

  // ---------- СОЗДАНИЕ КРУГА ----------

  function createCircleLayer(circleData, latlng, hasFiles = false) {
    const radiusFromDb = Number(circleData.radius);
    const radius =
      Number.isFinite(radiusFromDb) && radiusFromDb > 0
        ? clampRadius(radiusFromDb)
        : currentCircleRadius || DEFAULT_RADIUS;

    const className = hasFiles ? "circle-with-files" : "circle-empty";

    const layer = L.circle(latlng, {
      radius: radius,
      weight: 1,
      color: hasFiles ? "#009688" : "#ff9800",
      fillColor: hasFiles ? "#009688" : "#ff9800",
      fillOpacity: hasFiles ? 0.35 : 0.12,
      className: className,
    }).addTo(map);

    circleData.radius = radius;

    const record = { data: circleData, layer, hasFiles };
    circles.push(record);

    layer.on("click", () => {
      const circleId = circleData.id || circleData.circle_key;
      const url = `/view?circle_id=${encodeURIComponent(
        circleId
      )}&drawing_id=${encodeURIComponent(
        drawingId
      )}&project=${encodeURIComponent(project)}`;
      window.location.href = url;
    });
  }

  // ---------- ФИЛЬТР КРУГОВ ----------

  function applyVisibilityFilter() {
    const showWithFiles =
      !showWithFilesCheckbox || showWithFilesCheckbox.checked;
    const showEmpty = !showEmptyCheckbox || showEmptyCheckbox.checked;

    if (!map) return;

    circles.forEach((rec) => {
      const shouldShow =
        (rec.hasFiles && showWithFiles) || (!rec.hasFiles && showEmpty);
      const isOnMap = map.hasLayer(rec.layer);

      if (shouldShow && !isOnMap) {
        rec.layer.addTo(map);
      } else if (!shouldShow && isOnMap) {
        map.removeLayer(rec.layer);
      }
    });
  }

  // ---------- ПРИВЯЗКА КОНТРОЛОВ ----------

  function hookControls() {
    if (controlsHooked) return;
    controlsHooked = true;

    if (showWithFilesCheckbox) {
      showWithFilesCheckbox.addEventListener("change", applyVisibilityFilter);
    }

    if (showEmptyCheckbox) {
      showEmptyCheckbox.addEventListener("change", applyVisibilityFilter);
    }

    if (setRadiusAllBtn && (radiusInput || radiusNumberInput)) {
      setRadiusAllBtn.addEventListener("click", async () => {
        const src = radiusNumberInput || radiusInput;
        const r = clampRadius(src.value);
        setRadiusUI(r);

        try {
          const form = new URLSearchParams();
          form.set("project", project);
          form.set("radius", String(r));

          const resp = await fetch(
            `/update_all_circles_radius/${encodeURIComponent(drawingId)}`,
            {
              method: "POST",
              headers: {
                "Content-Type":
                  "application/x-www-form-urlencoded;charset=UTF-8",
              },
              body: form.toString(),
            }
          );

          let data = null;
          try {
            data = await resp.json();
          } catch (e) {
            console.error("Ответ сервера не JSON", e);
          }

          if (!resp.ok || (data && data.error)) {
            console.error("Ошибка обновления радиуса", data);
            alert(
              (data && data.error) ||
                "Ошибка на сервере при обновлении радиуса"
            );
            return;
          }

          circles.forEach((rec) => {
            rec.data.radius = r;
            rec.layer.setRadius(r);
          });

          if (currentDrawing && Array.isArray(currentDrawing.circles)) {
            currentDrawing.circles.forEach((c) => {
              c.radius = r;
            });
          }

          alert(`Радиус всех кругов обновлён до ${r}px`);
        } catch (e) {
          console.error(e);
          alert("Ошибка связи с сервером при обновлении радиуса");
        }
      });
    }
  }
});