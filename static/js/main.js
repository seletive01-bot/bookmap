// =============================
//   CESIUM GLOBE SETUP
// =============================

Cesium.Ion.defaultAccessToken = null;

const terrainProvider = new Cesium.EllipsoidTerrainProvider();

const imageryProvider = new Cesium.UrlTemplateImageryProvider({
  url: "https://tile.openstreetmap.org/{z}/{x}/{y}.png"
});

const viewer = new Cesium.Viewer("cesiumContainer", {
  animation: false,
  timeline: false,
  geocoder: false,
  baseLayerPicker: false,
  sceneModePicker: false,
  fullscreenButton: true,
  terrainProvider: terrainProvider,
  shadows: true,
  terrainShadows: Cesium.ShadowMode.ENABLED
});

// Disable default Cesium popup / selection indicator
if (viewer.infoBox && viewer.infoBox.viewModel) {
  viewer.infoBox.viewModel.showInfo = false;
}
if (viewer.infoBox && viewer.infoBox.container) {
  viewer.infoBox.container.style.display = "none";
}
if (viewer.selectionIndicator && viewer.selectionIndicator.viewModel) {
  viewer.selectionIndicator.viewModel.showSelection = false;
}

// Imagery & credits
viewer.imageryLayers.removeAll();
viewer.imageryLayers.addImageryProvider(imageryProvider);
viewer._cesiumWidget._creditContainer.style.display = "none";

// Starfield background
viewer.scene.skyBox = new Cesium.SkyBox({
  sources: {
    positiveX: "/static/stars/px.png",
    negativeX: "/static/stars/nx.png",
    positiveY: "/static/stars/py.png",
    negativeY: "/static/stars/ny.png",
    positiveZ: "/static/stars/pz.png",
    negativeZ: "/static/stars/nz.png"
  }
});

// Atmosphere & lighting
viewer.scene.skyAtmosphere.hueShift = 0.1;
viewer.scene.skyAtmosphere.saturationShift = -0.2;
viewer.scene.skyAtmosphere.brightnessShift = 0.4;
viewer.scene.globe.showGroundAtmosphere = true;
viewer.scene.globe.enableLighting = true;

viewer.scene.light = new Cesium.DirectionalLight({
  direction: new Cesium.Cartesian3(1, 1, 1)
});

// =============================
//   DATA SOURCES + CLUSTERING
// =============================

const bookSource = new Cesium.CustomDataSource("books");
viewer.dataSources.add(bookSource);

bookSource.clustering.enabled = true;
bookSource.clustering.pixelRange = 50;
bookSource.clustering.minimumClusterSize = 3;

let heatEntities = [];
let heatmapEnabled = false;
let lastBooks = [];

// Map entity → book mapping (for popup)
const entityBookMap = new Map();

// =============================
//   FREE GEOCODER (Nominatim)
// =============================

async function searchLocationByName(query) {
  const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(
    query
  )}&format=json&limit=1&polygon_geojson=1`;

  const res = await fetch(url, {
    headers: { "User-Agent": "BookMap/1.0 (Education Project)" }
  });

  const data = await res.json();
  if (!Array.isArray(data) || data.length === 0) return null;

  const item = data[0];
  const bbox = item.boundingbox;

  return {
    lat: parseFloat(item.lat),
    lng: parseFloat(item.lon),
    bbox: {
      south: parseFloat(bbox[0]),
      north: parseFloat(bbox[1]),
      west: parseFloat(bbox[2]),
      east: parseFloat(bbox[3])
    }
  };
}

// =============================
//     HELPER: OPEN READER
// =============================

function openReader(id) {
  window.location.href = "/book/" + id;
}
window.openReader = openReader;

// =============================
//   LOAD BOOKS IN CURRENT AREA
// =============================

let moveEndTimer = null;

viewer.camera.moveEnd.addEventListener(() => {
  clearTimeout(moveEndTimer);
  moveEndTimer = setTimeout(loadBooksInView, 300);
});

viewer.camera.moveStart.addEventListener(() => {
  hidePopup();
});

let activeTagFilter = "";
let activeCategoryFilter = "";

function applyFilters(books) {
  return books.filter((b) => {
    if (activeCategoryFilter) {
      const cat = (b.category || "").toLowerCase();
      if (!cat.includes(activeCategoryFilter)) return false;
    }
    if (activeTagFilter) {
      const tags = (b.tags || []).map((t) => String(t).toLowerCase());
      if (!tags.some((t) => t.includes(activeTagFilter))) return false;
    }
    return true;
  });
}

async function loadBooksInView() {
  const rect = viewer.camera.computeViewRectangle();
  if (!rect) return;

  // small padding for stability
  const pad = Cesium.Math.toRadians(2);

  const west = Cesium.Math.toDegrees(rect.west - pad);
  const south = Cesium.Math.toDegrees(rect.south - pad);
  const east = Cesium.Math.toDegrees(rect.east + pad);
  const north = Cesium.Math.toDegrees(rect.north + pad);

  const res = await fetch(
    `/api/books-in-bbox?min_lng=${west}&min_lat=${south}&max_lng=${east}&max_lat=${north}`
  );

  const data = await res.json();
  lastBooks = data.books || [];
  const filtered = applyFilters(lastBooks);

  renderBooks(filtered);
  renderMarkers(filtered);
  rebuildHeatmap(filtered);
}

// =============================
//   MARKERS, POPUPS, HEATMAP
// =============================

function renderMarkers(books) {
  bookSource.entities.removeAll();
  entityBookMap.clear();

  books.forEach((book) => {
    (book.locations || []).forEach((loc) => {
      const entity = bookSource.entities.add({
        position: Cesium.Cartesian3.fromDegrees(loc.lng, loc.lat),

        point: {
          pixelSize: 16,
          color: Cesium.Color.fromCssColorString("#FFD54F").withAlpha(0.95),
          outlineColor: Cesium.Color.WHITE,
          outlineWidth: 3
        },

        label: {
          text: book.title,
          font: "600 15px 'Inter', sans-serif",
          fillColor: Cesium.Color.WHITE,
          outlineColor: Cesium.Color.BLACK,
          outlineWidth: 3,
          pixelOffset: new Cesium.Cartesian2(12, -28),
          distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, 8000000)
        }
      });

      entityBookMap.set(entity, { book, loc });
    });
  });
}

function rebuildHeatmap(books) {
  heatEntities.forEach((e) => viewer.entities.remove(e));
  heatEntities = [];

  if (!heatmapEnabled) return;

  books.forEach((book) => {
    (book.locations || []).forEach((loc) => {
      const e = viewer.entities.add({
        position: Cesium.Cartesian3.fromDegrees(loc.lng, loc.lat),
        ellipse: {
          semiMinorAxis: 220000.0,
          semiMajorAxis: 220000.0,
          material: Cesium.Color.fromCssColorString("#fb7185").withAlpha(0.25),
          height: 0
        }
      });
      heatEntities.push(e);
    });
  });
}

// =============================
//   CUSTOM BOOK POPUP (HTML)
// =============================

const popupEl = document.getElementById("bookPopup");
const popupCloseBtn = document.getElementById("bookPopupClose");

function showPopup(book, position) {
  if (!popupEl) return;

  const titleEl = document.getElementById("ppTitle");
  const authorEl = document.getElementById("ppAuthor");
  const yearEl = document.getElementById("ppYear");
  const locationEl = document.getElementById("ppLocation");
  const readBtn = document.getElementById("ppReadBtn");

  if (titleEl) titleEl.textContent = book.title || "";
  if (authorEl) authorEl.textContent = "Author: " + (book.author || "Unknown");
  if (yearEl) yearEl.textContent = "Year: " + (book.year || "—");
  if (locationEl) {
    const loc = (book.locations || [])[0];
    locationEl.textContent =
      "Location: " + (loc?.place_name || loc?.country || "Unknown");
  }

  if (readBtn) {
    if (book.pdf_file) {
      readBtn.style.display = "inline-flex";
      readBtn.onclick = () => openReader(book.id);
    } else {
      readBtn.style.display = "none";
      readBtn.onclick = null;
    }
  }

  popupEl.classList.remove("hidden");

  const windowPos = Cesium.SceneTransforms.wgs84ToWindowCoordinates(
    viewer.scene,
    position
  );

  if (windowPos) {
    popupEl.style.left = windowPos.x - 130 + "px";
    popupEl.style.top = windowPos.y - 160 + "px";
  }
}

function hidePopup() {
  if (!popupEl) return;
  popupEl.classList.add("hidden");
}

if (popupCloseBtn) {
  popupCloseBtn.addEventListener("click", hidePopup);
}

// Click on globe
const clickHandler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);

clickHandler.setInputAction((movement) => {
  const picked = viewer.scene.pick(movement.position);

  if (Cesium.defined(picked) && picked.id && entityBookMap.has(picked.id)) {
    const { book, loc } = entityBookMap.get(picked.id);
    const pos = Cesium.Cartesian3.fromDegrees(loc.lng, loc.lat);
    showPopup(book, pos);
  } else {
    hidePopup();
  }
}, Cesium.ScreenSpaceEventType.LEFT_CLICK);

// =============================
//        SIDEBAR RENDER
// =============================

function renderBooks(books) {
  const list = document.getElementById("bookList");
  const countEl = document.getElementById("bookCount");
  if (!list || !countEl) return;

  countEl.innerText = `${books.length} book${books.length === 1 ? "" : "s"}`;
  list.innerHTML = "";

  books.forEach((book) => {
    const div = document.createElement("div");
    div.className = "book-card";

    const cover =
      book.cover_url && book.cover_url.trim().length
        ? `<div class="book-cover" style="background-image:url('${book.cover_url}')"></div>`
        : `<div class="book-cover placeholder">📚</div>`;

    const readButton = book.pdf_file
      ? `<button type="button" class="read-link" onclick="openReader('${book.id}')">
            <i class="fa fa-book-open"></i> Read
         </button>`
      : "";

    div.innerHTML = `
      <div class="book-card-inner">
        ${cover}
        <div class="book-main">
          <div class="book-title-row">
            <div class="book-title">${book.title}</div>
            ${readButton}
          </div>
          <div class="book-author">
            ${book.author || ""}${book.year ? " • " + book.year : ""}
          </div>
        </div>
      </div>
    `;

    // Clicking card flies camera
    div.addEventListener("click", (ev) => {
      // don't double-trigger when clicking read button
      if (ev.target.closest("button")) return;

      const loc = (book.locations || [])[0];
      if (!loc) return;
      viewer.camera.flyTo({
        destination: Cesium.Cartesian3.fromDegrees(loc.lng, loc.lat, 2500000),
        duration: 1.6,
        easingFunction: Cesium.EasingFunction.QUADRATIC_IN_OUT
      });
    });

    list.appendChild(div);
  });
}

// =============================
//        GLOBAL SEARCH BAR
// =============================

document.getElementById("globalSearch").addEventListener("input", async function () {
  const q = this.value.trim();
  if (!q) {
    hidePopup();
    loadBooksInView();
    return;
  }

  // 1) Book search
  const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
  const data = await res.json();
  if (data.books && data.books.length > 0) {
    lastBooks = data.books;
    const filtered = applyFilters(lastBooks);
    renderBooks(filtered);
    renderMarkers(filtered);
    rebuildHeatmap(filtered);
    hidePopup();
    return;
  }

  // 2) Place search
  const location = await searchLocationByName(q);
  if (location) {
    const padding = 0.3;

    const rect = Cesium.Rectangle.fromDegrees(
      location.bbox.west - padding,
      location.bbox.south - padding,
      location.bbox.east + padding,
      location.bbox.north + padding
    );

    viewer.camera.flyTo({
      destination: rect,
      duration: 1.6,
      easingFunction: Cesium.EasingFunction.QUADRATIC_IN_OUT
    });

    hidePopup();
    setTimeout(loadBooksInView, 1500);
  }
});

// =============================
//    FILTER INPUT HANDLERS
// =============================

document.getElementById("tagFilter").addEventListener("input", (e) => {
  activeTagFilter = e.target.value.trim().toLowerCase();
  const filtered = applyFilters(lastBooks);
  renderBooks(filtered);
  renderMarkers(filtered);
  rebuildHeatmap(filtered);
  hidePopup();
});

document.getElementById("categoryFilter").addEventListener("input", (e) => {
  activeCategoryFilter = e.target.value.trim().toLowerCase();
  const filtered = applyFilters(lastBooks);
  renderBooks(filtered);
  renderMarkers(filtered);
  rebuildHeatmap(filtered);
  hidePopup();
});

const heatBtn = document.getElementById("toggleHeatmapBtn");
heatBtn.addEventListener("click", () => {
  heatmapEnabled = !heatmapEnabled;
  heatBtn.classList.toggle("active", heatmapEnabled);
  const filtered = applyFilters(lastBooks);
  rebuildHeatmap(filtered);
});

// =============================
//      ADD BOOK PANEL + FORM
// =============================

const addPanel = document.getElementById("addPanel");
const addPanelToggle = document.getElementById("addPanelToggle");
const addBookFab = document.getElementById("addBookFab");
const addBookForm = document.getElementById("addBookForm");

function openAddPanel() {
  addPanel.classList.remove("collapsed");
}

function closeAddPanel() {
  addPanel.classList.add("collapsed");
}

function toggleAddPanel() {
  addPanel.classList.toggle("collapsed");
}

addPanelToggle.addEventListener("click", toggleAddPanel);
addBookFab.addEventListener("click", toggleAddPanel);

// BOOK SUBMIT
addBookForm.addEventListener("submit", async (e) => {
  e.preventDefault();

  const saveBtn = document.getElementById("saveBookBtn");

  // 🔥 START LOADING
  saveBtn.classList.add("loading");
  saveBtn.disabled = true;

  try {
    const form = new FormData(addBookForm);
    const pdfFile = document.getElementById("pdf_file").files[0] || null;

    const title = (form.get("title") || "").trim();
    const author = (form.get("author") || "").trim();
    const year = form.get("year");
    const category = (form.get("category") || "").trim();
    const tagsRaw = (form.get("tags") || "").trim();
    const cover_url = (form.get("cover_url") || "").trim();
    const place = (form.get("place") || "").trim();
    const description = (form.get("description") || "").trim();

    if (!title || !author || !place) {
      alert("Title, author and location are required.");
      return;
    }

    const loc = await searchLocationByName(place);
    if (!loc) {
      alert("Could not find that place on the map.");
      return;
    }

    const tags = tagsRaw
      ? tagsRaw.split(",").map((t) => t.trim()).filter(Boolean)
      : [];

    const payload = {
      title,
      author,
      description: description || null,
      year: year ? parseInt(year, 10) : null,
      category: category || null,
      tags,
      cover_url: cover_url || null,
      locations: [
        {
          geo: {
            type: "Point",
            coordinates: [loc.lng, loc.lat]
          },
          place_name: place,
          country: ""
        }
      ]
    };

    const fd = new FormData();
    fd.append("data", JSON.stringify(payload));
    if (pdfFile) fd.append("pdf_file", pdfFile);

    const res = await fetch("/api/book-with-pdf", {
      method: "POST",
      body: fd
    });

    if (res.ok) {
      addBookForm.reset();
      closeAddPanel();
      loadBooksInView();
    } else {
      const err = await res.json().catch(() => ({}));
      alert("Failed to save book: " + (err.error || res.statusText));
    }

  } finally {
    // 🔥 STOP LOADING
    saveBtn.classList.remove("loading");
    saveBtn.disabled = false;
  }
});


const sidebar = document.getElementById("sidebar");

function openAddPanel() {
    addPanel.classList.remove("collapsed");
    sidebar.classList.add("hide");   // 🔥 hide books
}

function closeAddPanel() {
    addPanel.classList.add("collapsed");
    sidebar.classList.remove("hide");  // 🔥 show books
}

function toggleAddPanel() {
    const isCollapsed = addPanel.classList.contains("collapsed");
    if (isCollapsed) openAddPanel();
    else closeAddPanel();
}



sidebar.addEventListener("click", function (e) {
    // Ignore clicks on book cards
    if (e.target.closest(".book-card")) return;

    sidebar.classList.toggle("expanded");
});

// =============================
//   INITIAL LOAD
// =============================

loadBooksInView();
