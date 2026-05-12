// static/js/index.js

document.addEventListener("DOMContentLoaded", () => {
    const params = new URLSearchParams(window.location.search);
    const project = params.get("project") || "";

    const drawingsList = document.getElementById("drawingsList");
    const uploadForm = document.getElementById("uploadForm");
    const uploadInput = document.getElementById("uploadInput");
    const searchInput = document.getElementById("searchInput");

    let allDrawings = [];

    function renderDrawings(drawings) {
        if (!drawingsList) return;

        drawingsList.innerHTML = "";

        drawings.forEach(drawing => {
            const item = document.createElement("div");
            item.className = "drawing-item";
            item.id = `drawing-card-${drawing.drawing_id}`;

            // Верхняя часть с картинкой
            const imgWrapper = document.createElement("div");
            imgWrapper.className = "drawing-image-wrapper";

            const img = document.createElement("img");
            img.src = `/static/${project}/state/drawings/${drawing.drawing_name}`;
            img.alt = drawing.drawing_name;
            img.classList.add("thumbnail");

            const link = document.createElement("a");
            link.href = `/result?drawing_id=${drawing.drawing_id}&project=${project}`;
            link.appendChild(img);

            imgWrapper.appendChild(link);

            // Нижняя часть с текстом и кнопками
            const info = document.createElement("div");
            info.className = "drawing-info";

            const nameEl = document.createElement("div");
            nameEl.className = "drawing-name";
            nameEl.textContent = drawing.display_name || drawing.drawing_name;
            nameEl.contentEditable = true;

            nameEl.addEventListener("blur", () => {
                const newName = nameEl.textContent.trim();
                if (newName && newName !== (drawing.display_name || drawing.drawing_name)) {
                    updateDrawingName(drawing.drawing_id, newName);
                } else {
                    nameEl.textContent = drawing.display_name || drawing.drawing_name;
                }
            });

            const meta = document.createElement("div");
            meta.className = "drawing-meta";
            meta.textContent = `ID: ${drawing.drawing_id}`;

            const actions = document.createElement("div");
            actions.className = "drawing-actions";

            const deleteBtn = document.createElement("button");
            deleteBtn.type = "button";
            deleteBtn.className = "drawing-delete-btn";
            deleteBtn.textContent = "Удалить";

            deleteBtn.addEventListener("click", () => {
                if (confirm("Удалить этот чертёж?")) {
                    deleteDrawing(drawing.drawing_id);
                }
            });

            actions.appendChild(deleteBtn);

            info.appendChild(nameEl);
            info.appendChild(meta);
            info.appendChild(actions);

            item.appendChild(imgWrapper);
            item.appendChild(info);

            drawingsList.appendChild(item);
        });
    }

    function loadDrawings() {
        if (!project) {
            console.error("Не указан project в URL");
            return;
        }

        fetch(`/list_project_drawings?project=${encodeURIComponent(project)}`)
            .then(r => r.json())
            .then(drawings => {
                if (!Array.isArray(drawings)) {
                    console.error("Некорректный ответ сервера:", drawings);
                    return;
                }
                allDrawings = drawings;
                renderDrawings(allDrawings);
            })
            .catch(err => {
                console.error("Ошибка загрузки списка чертежей:", err);
            });
    }

    function deleteDrawing(drawingId) {
        fetch(`/delete_drawing/${drawingId}?project=${encodeURIComponent(project)}`, {
            method: "DELETE"
        })
            .then(r => r.json())
            .then(data => {
                if (data.success) {
                    allDrawings = allDrawings.filter(d => d.drawing_id !== drawingId);
                    const card = document.getElementById(`drawing-card-${drawingId}`);
                    if (card) card.remove();
                } else {
                    alert(data.error || "Ошибка удаления чертежа");
                }
            })
            .catch(err => console.error("Ошибка удаления чертежа:", err));
    }

    function updateDrawingName(drawingId, newName) {
        fetch(`/update_drawing_name/${drawingId}?project=${encodeURIComponent(project)}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ new_name: newName })
        })
            .then(r => r.json())
            .then(data => {
                if (!data.success) {
                    alert(data.error || "Ошибка обновления названия");
                    loadDrawings();
                } else {
                    const item = allDrawings.find(d => d.drawing_id === drawingId);
                    if (item) item.display_name = newName;
                }
            })
            .catch(err => console.error("Ошибка обновления названия:", err));
    }

    function handleUpload(file) {
        if (!file || !project) return;

        const formData = new FormData();
        formData.append("file", file);
        formData.append("project", project);

        fetch("/upload", {
            method: "POST",
            body: formData
        })
            .then(r => r.json())
            .then(data => {
                if (data.drawing_id) {
                    // перезагружаем список и переходим на страницу результата
                    loadDrawings();
                    window.location.href = `/result?drawing_id=${data.drawing_id}&project=${encodeURIComponent(project)}`;
                } else {
                    alert(data.error || "Ошибка загрузки чертежа");
                }
            })
            .catch(err => console.error("Ошибка загрузки чертежа:", err));
    }

    if (uploadForm && uploadInput) {
        uploadInput.addEventListener("change", () => {
            if (uploadInput.files && uploadInput.files[0]) {
                handleUpload(uploadInput.files[0]);
                uploadForm.reset();
            }
        });
    }

    if (searchInput) {
        searchInput.addEventListener("input", () => {
            const q = searchInput.value.trim().toLowerCase();
            if (!q) {
                renderDrawings(allDrawings);
                return;
            }
            const filtered = allDrawings.filter(d => {
                const name = (d.display_name || d.drawing_name || "").toLowerCase();
                return name.includes(q);
            });
            renderDrawings(filtered);
        });
    }

    loadDrawings();
});
