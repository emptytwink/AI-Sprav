document.addEventListener("DOMContentLoaded", () => {
  const params = new URLSearchParams(window.location.search);
  const project = params.get("project");
  const drawingId = params.get("drawing_id");
  const isEditMode = params.get("edit") === null ? true : params.get("edit") === "1";

  if (!project || !drawingId) {
    alert("Не переданы project или drawing_id в URL");
    return;
  }

  const mapContainer = document.getElementById("map");
  const panelToggleBtn = document.getElementById("panel-toggle-btn");
  const projectNameEl = document.getElementById("project-name");
  const drawingTitleEl = document.getElementById("drawing-title");

  const radiusInput = document.getElementById("radius-input");
  const radiusNumberInput = document.getElementById("radius-number");
  const radiusValueEl = document.getElementById("radius-value");
  const setRadiusSelectedBtn = document.getElementById("set-radius-selected-btn");
  const setRadiusAllBtn = document.getElementById("set-radius-all-btn");

  const addCircleBtn = document.getElementById("add-circle-btn");
  const deleteCircleBtn = document.getElementById("delete-circle-btn");
  const openCircleBtn = document.getElementById("open-circle-btn");
  const actionStatusEl = document.getElementById("circle-action-status");

  const showWithFilesCheckbox = document.getElementById("show-with-files");
  const showEmptyCheckbox = document.getElementById("show-empty");
  const resetFiltersBtn = document.getElementById("reset-filters-btn");

  const statTotalEl = document.getElementById("stat-total");
  const statWithFilesEl = document.getElementById("stat-with-files");
  const statEmptyEl = document.getElementById("stat-empty");
  const statVisibleEl = document.getElementById("stat-visible");

  let map = null;
  let imageBounds = null;
  let mapZoomForCoords = 0;
  let currentDrawing = null;
  let circles = [];
  let selectedRecord = null;
  let controlsHooked = false;
  let addCircleMode = false;

  const DEFAULT_RADIUS = 7;
  let currentCircleRadius = DEFAULT_RADIUS;

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

  function getCircleId(circleData) {
    return circleData?.id || circleData?.circle_key || "";
  }

  function setActionStatus(text) {
    if (actionStatusEl) actionStatusEl.textContent = text;
  }

  function circleViewUrl(circleData) {
    const circleId = getCircleId(circleData);
    return `/view?circle_id=${encodeURIComponent(circleId)}&drawing_id=${encodeURIComponent(
      drawingId
    )}&project=${encodeURIComponent(project)}&edit=${isEditMode ? "1" : "0"}`;
  }

  function openCircleView(circleData) {
    window.location.href = circleViewUrl(circleData);
  }

  function updateSelectionStyles() {
    circles.forEach((rec) => {
      rec.layer.setStyle({
        weight: rec === selectedRecord ? 3 : 1,
        color: rec.hasFiles ? "#009688" : "#ff9800",
      });
      const el = rec.layer.getElement();
      if (el) {
        el.classList.toggle("circle-selected", rec === selectedRecord);
      }
    });
  }

  function refreshActionButtons() {
    const hasSelection = Boolean(selectedRecord);
    if (deleteCircleBtn) deleteCircleBtn.disabled = !hasSelection || !isEditMode;
    if (openCircleBtn) openCircleBtn.disabled = !hasSelection;
    if (setRadiusSelectedBtn) setRadiusSelectedBtn.disabled = !hasSelection || !isEditMode;

    if (addCircleMode) {
      setActionStatus("Режим добавления: кликните по чертежу");
      return;
    }

    if (!selectedRecord) {
      setActionStatus("Режим просмотра");
      return;
    }

    const id = getCircleId(selectedRecord.data);
    setActionStatus(`Выбран круг: ${id}`);
  }

  function setSelectedRecord(record) {
    selectedRecord = record || null;
    if (selectedRecord) {
      setRadiusUI(selectedRecord.data.radius);
    }
    updateSelectionStyles();
    refreshActionButtons();
  }

  function updateStats() {
    const total = circles.length;
    const withFiles = circles.filter((c) => c.hasFiles).length;
    const empty = total - withFiles;
    const visible = circles.filter((c) => map && map.hasLayer(c.layer)).length;

    if (statTotalEl) statTotalEl.textContent = String(total);
    if (statWithFilesEl) statWithFilesEl.textContent = String(withFiles);
    if (statEmptyEl) statEmptyEl.textContent = String(empty);
    if (statVisibleEl) statVisibleEl.textContent = String(visible);
  }

  function getInitialRadiusFromDrawing(drawing) {
    if (!drawing || !Array.isArray(drawing.circles) || drawing.circles.length === 0) {
      return DEFAULT_RADIUS;
    }
    const firstValid = drawing.circles.find((c) => {
      const r = Number(c.radius);
      return Number.isFinite(r) && r > 0;
    });
    return firstValid ? clampRadius(firstValid.radius) : DEFAULT_RADIUS;
  }

  function getNextCircleId() {
    let maxNumeric = 0;
    circles.forEach((rec) => {
      const id = String(getCircleId(rec.data) || "");
      if (/^\d+$/.test(id)) {
        maxNumeric = Math.max(maxNumeric, Number(id));
      }
    });
    if (maxNumeric > 0) return String(maxNumeric + 1);
    return String(circles.length + 1);
  }

  function projectLatLngToImageCoords(latlng) {
    const point = map.project(latlng, mapZoomForCoords);
    return {
      x: Math.round(point.x),
      y: Math.round(point.y),
    };
  }

  function applyVisibilityFilter() {
    const showWithFiles = !showWithFilesCheckbox || showWithFilesCheckbox.checked;
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

    if (selectedRecord && map && !map.hasLayer(selectedRecord.layer)) {
      setSelectedRecord(null);
    }
    updateStats();
  }

  function createCircleLayer(circleData, latlng, hasFiles = false) {
    const radiusFromDb = Number(circleData.radius);
    const radius =
      Number.isFinite(radiusFromDb) && radiusFromDb > 0
        ? clampRadius(radiusFromDb)
        : currentCircleRadius || DEFAULT_RADIUS;

    const layer = L.circle(latlng, {
      radius: radius,
      weight: 1,
      color: hasFiles ? "#009688" : "#ff9800",
      fillColor: hasFiles ? "#009688" : "#ff9800",
      fillOpacity: hasFiles ? 0.35 : 0.12,
      className: hasFiles ? "circle-with-files" : "circle-empty",
    }).addTo(map);

    circleData.radius = radius;
    const record = { data: circleData, layer, hasFiles };
    circles.push(record);

    layer.on("click", (e) => {
      if (e?.originalEvent) L.DomEvent.stopPropagation(e.originalEvent);
      setSelectedRecord(record);
    });

    layer.on("dblclick", (e) => {
      if (e?.originalEvent) L.DomEvent.stopPropagation(e.originalEvent);
      openCircleView(circleData);
    });

    return record;
  }

  function removeRecord(record) {
    if (!record) return;
    const idx = circles.indexOf(record);
    if (idx >= 0) circles.splice(idx, 1);
    if (map && map.hasLayer(record.layer)) {
      map.removeLayer(record.layer);
    }
    if (currentDrawing && Array.isArray(currentDrawing.circles)) {
      const circleId = getCircleId(record.data);
      currentDrawing.circles = currentDrawing.circles.filter(
        (c) => getCircleId(c) !== circleId
      );
    }
  }

  function initMap(drawing, imageUrl, imgWidth, imgHeight) {
    if (!mapContainer) return;
    if (map) {
      map.remove();
      map = null;
    }

    circles = [];
    selectedRecord = null;
    addCircleMode = false;

    map = L.map(mapContainer, {
      crs: L.CRS.Simple,
      minZoom: -2,
      maxZoom: 3,
      attributionControl: false,
    });

    mapZoomForCoords = map.getMaxZoom() - 1;
    const southWest = map.unproject([0, imgHeight], mapZoomForCoords);
    const northEast = map.unproject([imgWidth, 0], mapZoomForCoords);
    imageBounds = new L.LatLngBounds(southWest, northEast);

    L.imageOverlay(imageUrl, imageBounds).addTo(map);
    map.fitBounds(imageBounds);

    const filesMap = drawing.files || {};
    (drawing.circles || []).forEach((c) => {
      const latlng = map.unproject([c.x, c.y], mapZoomForCoords);
      const filesForCircle = filesMap[c.id] || filesMap[c.circle_key];
      const hasFiles = Array.isArray(filesForCircle) && filesForCircle.length > 0;
      createCircleLayer(c, latlng, hasFiles);
    });

    hookControls();
    applyVisibilityFilter();
    refreshActionButtons();

    map.on("click", async (e) => {
      if (!addCircleMode) {
        setSelectedRecord(null);
        return;
      }

      const newCircleId = getNextCircleId();
      const r = clampRadius(currentCircleRadius);
      const coords = projectLatLngToImageCoords(e.latlng);

      try {
        const resp = await fetch(`/add_circle/${encodeURIComponent(drawingId)}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            project,
            circle_id: newCircleId,
            x: coords.x,
            y: coords.y,
            radius: r,
          }),
        });
        const data = await resp.json().catch(() => null);
        if (!resp.ok || (data && data.error)) {
          alert((data && data.error) || "Не удалось добавить круг");
          return;
        }

        const circleData = { id: newCircleId, x: coords.x, y: coords.y, radius: r };
        const record = createCircleLayer(circleData, e.latlng, false);

        if (currentDrawing && Array.isArray(currentDrawing.circles)) {
          currentDrawing.circles.push(circleData);
        }

        addCircleMode = false;
        if (addCircleBtn) addCircleBtn.classList.remove("is-active");
        setSelectedRecord(record);
        applyVisibilityFilter();
      } catch (err) {
        console.error(err);
        alert("Ошибка связи с сервером при добавлении круга");
      }
    });

    setTimeout(() => map.invalidateSize(), 100);
  }

  function hookControls() {
    if (controlsHooked) return;
    controlsHooked = true;

    if (radiusInput) {
      radiusInput.addEventListener("input", () => setRadiusUI(radiusInput.value));
    }
    if (radiusNumberInput) {
      radiusNumberInput.addEventListener("input", () => setRadiusUI(radiusNumberInput.value));
      radiusNumberInput.addEventListener("change", () => setRadiusUI(radiusNumberInput.value));
    }

    if (panelToggleBtn) {
      panelToggleBtn.addEventListener("click", () => {
        document.body.classList.toggle("panel-collapsed");
        if (map) setTimeout(() => map.invalidateSize(), 260);
      });
    }

    if (showWithFilesCheckbox) {
      showWithFilesCheckbox.addEventListener("change", applyVisibilityFilter);
    }
    if (showEmptyCheckbox) {
      showEmptyCheckbox.addEventListener("change", applyVisibilityFilter);
    }
    if (resetFiltersBtn) {
      resetFiltersBtn.addEventListener("click", () => {
        if (showWithFilesCheckbox) showWithFilesCheckbox.checked = true;
        if (showEmptyCheckbox) showEmptyCheckbox.checked = true;
        applyVisibilityFilter();
      });
    }

    if (addCircleBtn) {
      addCircleBtn.addEventListener("click", () => {
        if (!isEditMode) return;
        addCircleMode = !addCircleMode;
        addCircleBtn.classList.toggle("is-active", addCircleMode);
        refreshActionButtons();
      });
    }

    if (openCircleBtn) {
      openCircleBtn.addEventListener("click", () => {
        if (!selectedRecord) return;
        openCircleView(selectedRecord.data);
      });
    }

    if (deleteCircleBtn) {
      deleteCircleBtn.addEventListener("click", async () => {
        if (!isEditMode) return;
        if (!selectedRecord) return;
        const circleId = getCircleId(selectedRecord.data);
        if (!circleId) return;
        const ok = window.confirm(`Удалить круг ${circleId}?`);
        if (!ok) return;

        try {
          const resp = await fetch(
            `/delete_circle/${encodeURIComponent(drawingId)}/${encodeURIComponent(circleId)}?project=${encodeURIComponent(project)}`,
            { method: "DELETE" }
          );
          const data = await resp.json().catch(() => null);
          if (!resp.ok || (data && data.error)) {
            alert((data && data.error) || "Не удалось удалить круг");
            return;
          }

          const toDelete = selectedRecord;
          setSelectedRecord(null);
          removeRecord(toDelete);
          applyVisibilityFilter();
          refreshActionButtons();
        } catch (err) {
          console.error(err);
          alert("Ошибка связи с сервером при удалении круга");
        }
      });
    }

    if (setRadiusSelectedBtn) {
      setRadiusSelectedBtn.addEventListener("click", async () => {
        if (!isEditMode) return;
        if (!selectedRecord) return;
        const r = clampRadius((radiusNumberInput || radiusInput).value);
        const circleId = getCircleId(selectedRecord.data);
        if (!circleId) return;

        try {
          const resp = await fetch(
            `/update_circle/${encodeURIComponent(drawingId)}/${encodeURIComponent(circleId)}`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ project, radius: r }),
            }
          );
          const data = await resp.json().catch(() => null);
          if (!resp.ok || (data && data.error)) {
            alert((data && data.error) || "Не удалось обновить радиус круга");
            return;
          }

          selectedRecord.data.radius = r;
          selectedRecord.layer.setRadius(r);
          refreshActionButtons();
        } catch (err) {
          console.error(err);
          alert("Ошибка связи с сервером при обновлении радиуса круга");
        }
      });
    }

    if (setRadiusAllBtn) {
      setRadiusAllBtn.addEventListener("click", async () => {
        if (!isEditMode) return;
        const r = clampRadius((radiusNumberInput || radiusInput).value);
        setRadiusUI(r);

        const form = new URLSearchParams();
        form.set("project", project);
        form.set("radius", String(r));

        try {
          const resp = await fetch(
            `/update_all_circles_radius/${encodeURIComponent(drawingId)}`,
            {
              method: "POST",
              headers: {
                "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
              },
              body: form.toString(),
            }
          );
          const data = await resp.json().catch(() => null);
          if (!resp.ok || (data && data.error)) {
            alert((data && data.error) || "Не удалось обновить радиус для всех кругов");
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
        } catch (err) {
          console.error(err);
          alert("Ошибка связи с сервером при массовом обновлении радиуса");
        }
      });
    }
  }

  function applyEditModeUi() {
    if (isEditMode) return;
    if (addCircleBtn) addCircleBtn.classList.add("hidden");
    if (deleteCircleBtn) deleteCircleBtn.classList.add("hidden");
    if (setRadiusSelectedBtn) setRadiusSelectedBtn.classList.add("hidden");
    if (setRadiusAllBtn) setRadiusAllBtn.classList.add("hidden");
    setActionStatus("Режим просмотра");
  }

  const startRadius =
    (radiusNumberInput && radiusNumberInput.value) ||
    (radiusInput && radiusInput.value) ||
    DEFAULT_RADIUS;
  setRadiusUI(startRadius);
  applyEditModeUi();

  fetch(
    `/load_drawing_by_project?project=${encodeURIComponent(project)}&drawing_id=${encodeURIComponent(drawingId)}`
  )
    .then((r) => {
      if (!r.ok) throw new Error("Не удалось загрузить данные чертежа");
      return r.json();
    })
    .then((drawing) => {
      currentDrawing = drawing;
      if (projectNameEl) projectNameEl.textContent = project;
      if (drawingTitleEl) {
        drawingTitleEl.textContent =
          drawing.display_name || drawing.drawing_name || drawing.drawing_id;
      }

      setRadiusUI(getInitialRadiusFromDrawing(drawing));

      const imageUrl =
        drawing.original_image ||
        drawing.processed_image ||
        `/static/${encodeURIComponent(project)}/state/drawings/${encodeURIComponent(
          drawing.drawing_name
        )}`;

      const img = new Image();
      img.crossOrigin = "Anonymous";
      img.onload = () => initMap(drawing, imageUrl, img.naturalWidth, img.naturalHeight);
      img.onerror = () => alert("Не удалось загрузить изображение чертежа");
      img.src = imageUrl;
    })
    .catch((err) => {
      console.error(err);
      alert("Ошибка загрузки данных чертежа");
    });
});
