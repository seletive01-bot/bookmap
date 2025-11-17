/* ============================================================
   PDF.js worker
============================================================ */
if (window['pdfjsLib']) {
    pdfjsLib.GlobalWorkerOptions.workerSrc =
        "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/2.16.105/pdf.worker.min.js";
}

/* ============================================================
   DOM ELEMENTS
============================================================ */
const canvasLeft      = document.getElementById("pdfCanvasLeft");
const canvasRight     = document.getElementById("pdfCanvasRight");
const wrapperLeft     = document.getElementById("pageWrapperLeft");
const wrapperRight    = document.getElementById("pageWrapperRight");
const spreadShell     = document.getElementById("spreadShell");

const prevBtn         = document.getElementById("prevPageBtn");
const nextBtn         = document.getElementById("nextPageBtn");
const slider          = document.getElementById("pageSlider");
const pageLabel       = document.getElementById("pageNumberDisplay");
const totalLabel      = document.getElementById("totalPages");
const toggleViewBtn   = document.getElementById("toggleViewBtn");
const viewLabel       = toggleViewBtn?.querySelector(".view-label");

const thumbContainer  = document.getElementById("thumbContainer");
const thumbSidebar    = document.getElementById("thumbSidebar");
const thumbToggle     = document.getElementById("thumbToggle");

/* ============================================================
   STATE
============================================================ */
let pdfDoc      = null;
let currentPage = 1;
let totalPages  = 1;
let scale       = 1.2;

let viewMode    = "single";
let userForcedMode = false;

/* ============================================================
   PAGE TURN SOUND
============================================================ */
const turnSound = new Audio(
  "https://assets.mixkit.co/active_storage/sfx/2001/2001-preview.mp3"
);
turnSound.volume = 0.33;

function playTurnSound() {
  try {
    turnSound.currentTime = 0;
    turnSound.play().catch(() => {});
  } catch {}
}

/* ============================================================
   RENDER PAGE
============================================================ */
function drawPage(pageNum, canvas) {
    if (!pdfDoc || pageNum < 1 || pageNum > totalPages) {
        canvas.getContext("2d").clearRect(0, 0, canvas.width, canvas.height);
        return Promise.resolve();
    }

    return pdfDoc.getPage(pageNum).then(page => {
        const vp = page.getViewport({ scale });

        canvas.width = vp.width;
        canvas.height = vp.height;

        return page.render({
            canvasContext: canvas.getContext("2d"),
            viewport: vp
        }).promise;
    });
}

/* ============================================================
   MASTER RENDER FUNCTION
============================================================ */
function renderCurrent(direction = "next") {
    if (!pdfDoc) return;

    const isSpread = viewMode === "spread";
    const leftPageNum = currentPage;
    const rightPageNum =
        isSpread && currentPage < totalPages ? currentPage + 1 : null;

    playTurnSound();

    // Page Curl Animation
    if (isSpread) {
        if (direction === "next") {
            wrapperRight.classList.add("turning", "turn-right");
        } else {
            wrapperLeft.classList.add("turning");
        }
    } else {
        wrapperLeft.classList.add("turning");
    }

    const tasks = [drawPage(leftPageNum, canvasLeft)];

    if (rightPageNum) {
        wrapperRight.style.visibility = "visible";
        tasks.push(drawPage(rightPageNum, canvasRight));
    } else {
        wrapperRight.style.visibility = "hidden";
    }

    Promise.all(tasks).then(() => {
        wrapperLeft.classList.remove("turning", "turn-right");
        wrapperRight.classList.remove("turning", "turn-right");
    });

    slider.value = String(currentPage);
    pageLabel.textContent = String(currentPage);

    highlightThumb(currentPage);
}

/* ============================================================
   AUTO VIEW MODE (Desktop/Mobile)
============================================================ */
function autoModeFromWindow() {
    if (!pdfDoc || userForcedMode) return;

    const wide =
        window.innerWidth >= 1100 &&
        window.innerHeight >= 550 &&
        totalPages > 1;

    viewMode = wide ? "spread" : "single";

    applyViewMode(false);
}

function applyViewMode(shouldRender = true) {
    if (viewMode === "spread") {
        spreadShell.classList.remove("spread--single");
        viewLabel.textContent = "Single page";
    } else {
        spreadShell.classList.add("spread--single");
        viewLabel.textContent = "Two-page";
    }

    if (shouldRender) renderCurrent();
}

/* ============================================================
   BUTTON NAVIGATION
============================================================ */
nextBtn?.addEventListener("click", () => {
    if (currentPage < totalPages) {
        currentPage++;
        renderCurrent("next");
    }
});

prevBtn?.addEventListener("click", () => {
    if (currentPage > 1) {
        currentPage--;
        renderCurrent("back");
    }
});

/* ============================================================
   SLIDER
============================================================ */
slider?.addEventListener("input", (e) => {
    const newPage = Number(e.target.value);
    if (newPage < 1 || newPage > totalPages) return;

    const dir = newPage > currentPage ? "next" : "back";
    currentPage = newPage;
    renderCurrent(dir);
});

/* ============================================================
   TAP ZONE PAGE TURN (MOBILE SAFE)
============================================================ */
spreadShell?.addEventListener("click", (e) => {
    if (e.target.closest("#thumbToggle")) return; // avoid conflict

    const r = spreadShell.getBoundingClientRect();
    const x = e.clientX - r.left;

    const LEFT_ZONE  = r.width * 0.35;  // Bigger mobile-friendly zone
    const RIGHT_ZONE = r.width * 0.65;

    if (x < LEFT_ZONE && currentPage > 1) {
        currentPage--;
        renderCurrent("back");
    } else if (x > RIGHT_ZONE && currentPage < totalPages) {
        currentPage++;
        renderCurrent("next");
    }
});

/* ============================================================
   KEYBOARD NAVIGATION
============================================================ */
window.addEventListener("keydown", (e) => {
    if (!pdfDoc) return;

    if (e.key === "ArrowRight" && currentPage < totalPages) {
        currentPage++;
        renderCurrent("next");
    }
    if (e.key === "ArrowLeft" && currentPage > 1) {
        currentPage--;
        renderCurrent("back");
    }
});

/* ============================================================
   RESIZE — Throttled
============================================================ */
let resizeTimer = null;
window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(autoModeFromWindow, 200);
});

/* ============================================================
   HARD RESET VIEWER (Fix book mixing bug)
============================================================ */
function resetPdfViewer() {
    console.log("RESETTING VIEWER…");

    // Reset state
    pdfDoc = null;
    currentPage = 1;
    totalPages = 1;

    // Clear canvases
    [canvasLeft, canvasRight].forEach(c => {
        if (c) {
            const ctx = c.getContext("2d");
            ctx.clearRect(0, 0, c.width, c.height);
        }
    });

    // Clear thumbnails
    if (thumbContainer) {
        thumbContainer.innerHTML = "";
    }

    // Hide right page (single mode default)
    if (wrapperRight) {
        wrapperRight.style.visibility = "hidden";
    }

    // Reset slider + labels
    if (slider) slider.value = 1;
    if (totalLabel) totalLabel.textContent = "--";
    if (pageLabel) pageLabel.textContent = "1";
}

/* ============================================================
   LOAD PDF
============================================================ */
if (typeof PDF_URL === "string" && window['pdfjsLib']) {
    resetPdfViewer();   // 🔥 FIX: clear old book completely

pdfjsLib.getDocument(PDF_URL).promise
    .then(doc => {
        pdfDoc = doc;
        totalPages = doc.numPages;


            totalLabel.textContent = totalPages;
            slider.max = totalPages;

            renderSidebarThumbnails();
            highlightThumb(1);

            autoModeFromWindow();
            currentPage = 1;
            renderCurrent();
        })
        .catch(err => console.error("PDF load error:", err));
}

/* ============================================================
   SIDEBAR THUMBNAILS
============================================================ */
function renderSidebarThumbnails() {
    thumbContainer.innerHTML = "";

    for (let i = 1; i <= totalPages; i++) {
        const box = document.createElement("div");
        box.className = "thumb-page";
        box.dataset.page = i;

        const img = document.createElement("img");
        box.appendChild(img);

        pdfDoc.getPage(i).then(page => {
            const vp = page.getViewport({ scale: 0.18 });
            const c  = document.createElement("canvas");
            c.width  = vp.width;
            c.height = vp.height;

            page.render({
                canvasContext: c.getContext("2d"),
                viewport: vp
            }).promise.then(() => {
                img.src = c.toDataURL("image/png");
            });
        });

        box.addEventListener("click", () => {
            const dir = i > currentPage ? "next" : "back";
            currentPage = i;
            highlightThumb(i);
            renderCurrent(dir);

            // Auto-close on mobile
            if (window.innerWidth < 768) {
                thumbSidebar.classList.add("collapsed");
                thumbToggle.classList.remove("open");
            }
        });

        thumbContainer.appendChild(box);
    }
}

function highlightThumb(page) {
    document.querySelectorAll(".thumb-page").forEach(t => {
        t.classList.toggle("active", Number(t.dataset.page) === page);
    });
}

/* ============================================================
   SIDEBAR TOGGLE — Mobile Safe
============================================================ */
thumbToggle.addEventListener("click", (e) => {
    e.stopPropagation();  // prevent page flip on mobile

    thumbSidebar.classList.toggle("collapsed");
    thumbToggle.classList.toggle("open");

    const icon = thumbToggle.querySelector("i");

    if (thumbToggle.classList.contains("open")) {
        icon.classList.remove("fa-chevron-right");
        icon.classList.add("fa-chevron-left");
    } else {
        icon.classList.remove("fa-chevron-left");
        icon.classList.add("fa-chevron-right");
    }
});

/* Prevent iPhone ghost-click */
thumbToggle.addEventListener("touchstart", (e) => {
    e.stopPropagation();
}, { passive: true });
