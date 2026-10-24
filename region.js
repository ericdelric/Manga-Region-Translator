// region.js — "translate only the box I drag".
//
// Loaded as a content script on every page, right after selector.js and
// content.js. It lives in its own file (instead of inside content.js) for one
// important reason: background.js can inject selector.js + region.js into tabs
// that were already open when the extension was installed/reloaded (those tabs
// have no live content script). Re-injecting this file alone cannot duplicate
// content.js's text-selection listeners.
//
// Flow:
//   1. Toolbar icon / Alt+Shift+T sends {action:"startRegionSelect"}.
//   2. selector.js paints the drag overlay; this file captures the visible
//      tab, crops the selection with a canvas (DPR/zoom aware), and sends the
//      cropped Base64 to background.js.
//   3. background.js runs the ORIGINAL Google Lens OCR call on that crop and
//      the ORIGINAL translate endpoint, then returns grouped bboxes. This file
//      paints the danbooru-style hover-to-reveal boxes over the selected area.

(function () {
  "use strict";

  // Chrome content scripts only expose `chrome.*`; Firefox exposes both.
  if (typeof globalThis.browser === "undefined") globalThis.browser = chrome;

  // Idempotent: background.js may inject this file into already-open tabs.
  if (globalThis.__IMGT_RegionLoaded) return;
  globalThis.__IMGT_RegionLoaded = true;

  const HOST_ID          = "__imgtr_region_host__";
  const REGION_STYLE_ID  = "__imgtr_region_style__";
  const REGION_STATUS_ID = "__imgtr_region_status__";

  const DEFAULTS = { targetLang: "en" };

  let regionHost = null;           // top-level host (shadow root) above the page
  let regionRoot = null;           // host.shadowRoot — all UI lives in here
  let regionBusy = false;          // true from selector start until OCR finishes
  let regionInstances = [];        // active floating cards: { layer, close }
  const MAX_REGION_INSTANCES = 12; // sanity cap so the page cannot flood
  let regionTickerId = null;       // rAF loop keeping cards glued to their anchor
  // Region tooltip hide timers live on each instance (instance.tipHideTimer).
  let regionStatus = null;         // "识别中…" chip
  let regionStatusTimer = null;
  let regionKeyHandler = null;
  let regionHostObserver = null;
  let regionFullscreenHandler = null;
  let regionPreCapture = null;     // viewport shot taken BEFORE the overlay appears

  const REGION_CSS = `
    /* Full Power bubbles live in a viewport-fixed layer: their left/top are
       recomputed from the page image's rect on every frame. */
    .imgtr-region-layer.imgtr-fp-layer {
      position: fixed !important;
      left: 0 !important;
      top: 0 !important;
      width: 0 !important;
      height: 0 !important;
      pointer-events: none !important;
    }
    .imgtr-fp-close {
      all: initial;
      position: absolute !important;
      right: -8px !important;
      top: -8px !important;
      width: 16px !important;
      height: 16px !important;
      border-radius: 50% !important;
      background: rgba(17, 24, 39, 0.55) !important;
      color: #fff !important;
      font: 12px/16px system-ui, -apple-system, sans-serif !important;
      text-align: center !important;
      cursor: pointer !important;
      pointer-events: auto !important;
      z-index: 2147483647 !important;
      box-shadow: 0 1px 4px rgba(0, 0, 0, 0.35) !important;
      opacity: 0.45 !important;
      transition: opacity 90ms ease, background 90ms ease !important;
    }
    .imgtr-fp-close:hover {
      opacity: 1 !important;
      background: rgba(217, 48, 37, 0.92) !important;
    }
    .imgtr-region-layer .imgtr-region-box:hover .imgtr-fp-close {
      opacity: 1 !important;
    }
    .imgtr-region-layer {
      all: initial;
      position: absolute !important;
      left: 0 !important;
      top: 0 !important;
      width: 0 !important;
      height: 0 !important;
      z-index: 2147483645 !important;
      pointer-events: none !important;
      isolation: isolate !important;
    }
    .imgtr-region-layer .imgtr-region-box {
      all: initial;
      position: absolute !important;
      display: block !important;
      box-sizing: border-box !important;
      border: 1px dashed rgba(26, 26, 26, 0.30) !important;
      background: transparent !important;
      pointer-events: auto !important;
      cursor: help !important;
      transition: background 90ms ease, border-color 90ms ease !important;
    }
    .imgtr-region-layer .imgtr-region-box:hover {
      border-color: rgba(26, 26, 26, 0.85) !important;
      background: rgba(255, 250, 215, 0.26) !important;
    }
    /* Full Power Mode: bubbles rendered from the page cache. They stay nearly
       invisible so the art is untouched; hovering one shows the translation. */
    .imgtr-region-layer.imgtr-fp-layer .imgtr-region-box {
      border-color: rgba(26, 26, 26, 0.16) !important;
      background: rgba(255, 250, 215, 0.08) !important;
    }
    .imgtr-region-layer.imgtr-fp-layer .imgtr-region-box:hover {
      border-color: rgba(26, 26, 26, 0.7) !important;
      background: rgba(255, 250, 215, 0.22) !important;
    }
    .imgtr-region-layer .imgtr-region-chip,
    .imgtr-region-layer .imgtr-region-close {
      all: initial;
      position: absolute !important;
      display: flex !important;
      align-items: center !important;
      justify-content: center !important;
      box-sizing: border-box !important;
      width: 18px !important;
      height: 18px !important;
      border-radius: 50% !important;
      background: rgba(17, 24, 39, 0.70) !important;
      color: #ffffff !important;
      box-shadow: 0 1px 4px rgba(0, 0, 0, 0.35) !important;
      font-family: system-ui, -apple-system, "Segoe UI", sans-serif !important;
      font-size: 11px !important;
      line-height: 1 !important;
      cursor: pointer !important;
      pointer-events: auto !important;
      z-index: 2147483646 !important;
      user-select: none !important;
      transition: background 90ms ease !important;
    }
    .imgtr-region-layer .imgtr-region-chip:hover,
    .imgtr-region-layer .imgtr-region-close:hover {
      background: rgba(17, 24, 39, 0.95) !important;
    }
    .imgtr-region-tip {
      all: initial;
      position: absolute !important;
      display: none;
      z-index: 2147483647 !important;
      box-sizing: border-box !important;
      width: max-content !important;
      max-width: 460px !important;
      background: rgba(17, 24, 39, 0.94) !important;
      color: #f9fafb !important;
      border-radius: 6px !important;
      box-shadow: 0 6px 18px rgba(0, 0, 0, 0.35) !important;
      padding: 8px 10px !important;
      font-family: system-ui, -apple-system, "Segoe UI", sans-serif !important;
      font-size: 13px !important;
      line-height: 1.45 !important;
      text-align: left !important;
      pointer-events: none !important;
      white-space: pre-wrap !important;
      overflow-wrap: anywhere !important;
      isolation: isolate !important;
    }
    .imgtr-region-tip.visible { display: block !important; }
    .imgtr-region-tip .imgtr-region-row + .imgtr-region-row {
      border-top: 1px solid rgba(255, 255, 255, 0.16) !important;
      margin-top: 6px !important;
      padding-top: 6px !important;
    }
    .imgtr-region-tip .imgtr-region-tip-src {
      all: initial;
      display: block !important;
      color: #c3c8cf !important;
      font-size: 18px !important;
      font-style: italic !important;
      line-height: 1.45 !important;
      white-space: pre-wrap !important;
      overflow-wrap: anywhere !important;
      font-family: system-ui, -apple-system, "Segoe UI", sans-serif !important;
    }
    .imgtr-region-tip .imgtr-region-tip-ro {
      all: initial;
      display: block !important;
      color: #dfe3e8 !important;
      font-size: 19px !important;
      font-style: italic !important;
      line-height: 1.5 !important;
      margin-top: 3px !important;
      white-space: pre-wrap !important;
      overflow-wrap: anywhere !important;
      font-family: system-ui, -apple-system, "Segoe UI", sans-serif !important;
    }
    .imgtr-region-tip .imgtr-region-tip-tr {
      all: initial;
      display: block !important;
      color: #ffffff !important;
      font-size: 21px !important;
      font-weight: 500 !important;
      line-height: 1.5 !important;
      margin-top: 5px !important;
      white-space: pre-wrap !important;
      overflow-wrap: anywhere !important;
      font-family: system-ui, -apple-system, "Segoe UI", sans-serif !important;
    }
    #${REGION_STATUS_ID} {
      all: initial;
      position: fixed !important;
      display: none;
      align-items: center !important;
      gap: 7px !important;
      z-index: 2147483647 !important;
      padding: 7px 11px !important;
      background: rgba(17, 24, 39, 0.94) !important;
      color: #f9fafb !important;
      border-radius: 6px !important;
      font-family: system-ui, -apple-system, "Segoe UI", sans-serif !important;
      font-size: 12px !important;
      line-height: 1.35 !important;
      white-space: nowrap !important;
      box-shadow: 0 6px 20px rgba(0, 0, 0, 0.35) !important;
      pointer-events: none !important;
    }
    #${REGION_STATUS_ID}.visible { display: flex !important; }
    #${REGION_STATUS_ID}.error { background: rgba(127, 29, 29, 0.95) !important; }
    #${REGION_STATUS_ID}.warn  { background: rgba(120, 53, 15, 0.95) !important; }
    #${REGION_STATUS_ID} .imgtr-region-dot {
      display: block !important;
      width: 8px !important;
      height: 8px !important;
      border-radius: 50% !important;
      background: #4c9aff !important;
      animation: imgtr-region-pulse 1.1s ease-in-out infinite !important;
    }
    @keyframes imgtr-region-pulse {
      0%, 100% { opacity: 0.35; transform: scale(0.85); }
      50%      { opacity: 1;    transform: scale(1.15); }
    }
  `;

  // --- romaji preference (mirrors the options page checkbox) -----------------
  let showRomajiEnabled = true;
  async function loadShowRomaji() {
    try {
      const data = await browser.storage.local.get({ showRomaji: true });
      showRomajiEnabled = data.showRomaji !== false;
    } catch (_) { /* keep default */ }
  }
  browser.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.showRomaji) {
      showRomajiEnabled = changes.showRomaji.newValue !== false;
    }
  });
  loadShowRomaji();

  // One top-level host with a shadow root. Mounting our UI inside a shadow
  // root isolates it from ComicRead's global CSS, and the host itself is
  // attached to <html> (or to the current fullscreen element) as the LAST
  // child with the maximum possible z-index, so reading-mode containers can't
  // paint above it.
  function ensureHost() {
    if (!regionHost || !regionHost.isConnected) {
      regionHost = document.getElementById(HOST_ID);
      if (!regionHost) {
        regionHost = document.createElement("div");
        regionHost.id = HOST_ID;
        regionHost.setAttribute("aria-hidden", "true");
        regionHost.attachShadow({ mode: "open" });
      }
      const s = regionHost.style;
      s.setProperty("all", "initial", "important");
      s.setProperty("position", "absolute", "important");
      s.setProperty("left", "0px", "important");
      s.setProperty("top", "0px", "important");
      s.setProperty("width", "0px", "important");
      s.setProperty("height", "0px", "important");
      s.setProperty("z-index", "2147483647", "important");
      s.setProperty("pointer-events", "none", "important");
      s.setProperty("display", "block", "important");
      s.setProperty("overflow", "visible", "important");
      s.setProperty("isolation", "isolate", "important");
      s.setProperty("transform", "none", "important");
      regionRoot = regionHost.shadowRoot;
    }

    if (!regionRoot) {
      try { regionHost.attachShadow({ mode: "open" }); } catch (_) { /* ignore */ }
      regionRoot = regionHost.shadowRoot;
    }

    // If ComicRead/another reader is in fullscreen mode, live inside that
    // fullscreen element; otherwise attach to <html>. Appending moves the host
    // to the END of the container, so equal-z-index siblings paint above it
    // only if they came later — and we re-append before every render/hover.
    const parent = document.fullscreenElement || document.documentElement;
    if (regionHost.parentNode !== parent || parent.lastElementChild !== regionHost) {
      parent.appendChild(regionHost);
    }

    if (regionRoot && !regionRoot.getElementById(REGION_STYLE_ID)) {
      const style = document.createElement("style");
      style.id = REGION_STYLE_ID;
      style.textContent = REGION_CSS;
      regionRoot.appendChild(style);
    }
    ensureRegionWheelBridge();
    return regionRoot;
  }

  // Reading-mode scripts (ComicRead) occasionally append/reparent their
  // top-level container after our boxes are shown. Keep the host as the LAST
  // child of <html> (or of the fullscreen element) so equal z-index never
  // paints above us. The observer only listens for direct children of <html>,
  // so it stays cheap even on huge manga pages.
  function watchHostOrder() {
    if (!regionHostObserver) {
      regionHostObserver = new MutationObserver(() => {
        if (!regionInstances.length || !regionHost) return;
        const parent = document.fullscreenElement || document.documentElement;
        if (regionHost.parentNode !== parent || parent.lastElementChild !== regionHost) {
          parent.appendChild(regionHost);
        }
      });
      regionHostObserver.observe(document.documentElement, { childList: true });
    }
    if (!regionFullscreenHandler) {
      regionFullscreenHandler = () => {
        if (regionInstances.length) ensureHost();
      };
      document.addEventListener("fullscreenchange", regionFullscreenHandler, true);
    }
  }

  function clamp(v, min, max) {
    return Math.min(max, Math.max(min, v));
  }

  function waitForPaint() {
    // selector.js removes its overlay synchronously before calling us. Wait a
    // few frames BEFORE capture so:
    //   1. the dimmer is definitely gone from the screenshot, and
    //   2. hover-only tooltips (CSS :hover / mouseenter-driven UI) have time
    //      to reappear under the still-stationary mouse pointer.
    return new Promise((resolve) => {
      let done = false;
      const finish = () => { if (!done) { done = true; resolve(); } };
      requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(finish, 320)));
      setTimeout(finish, 900); // fallback if rAF is throttled
    });
  }

  function loadImageElement(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error("截图解码失败 / failed to decode screenshot"));
      img.src = src;
    });
  }

  // Batch D / P2-7: one encoder shared by the screenshot-crop path and the
  // inline-pixel path (both used to duplicate the PNG/JPEG fallback logic).
  // PNG is lossless (best for OCR); JPEG 0.92 only for very large payloads.
  function canvasToBase64(canvas, label) {
    let mime = "image/png";
    let out = canvas.toDataURL(mime);
    if (out.length > 4_000_000) {
      mime = "image/jpeg";
      out = canvas.toDataURL(mime, 0.92);
    }
    if (!out || out === "data:," || out.length < 200) {
      throw new Error((label || "Canvas") + " 导出为空（Canvas 导出失败） / empty dataURL");
    }
    const comma = out.indexOf(",");
    return { base64: comma >= 0 ? out.slice(comma + 1) : "", mime: mime };
  }

  // Capture → crop. captureVisibleTab returns device pixels (DPR- and
  // browser-zoom-scaled). The selection is in CSS pixels, so derive the exact
  // scale from the bitmap itself instead of trusting devicePixelRatio alone.
  async function cropScreenshot(dataUrl, rect, info) {
    if (typeof dataUrl !== "string" || !dataUrl.startsWith("data:image/")) {
      throw new Error("截图数据无效（不是 data:image） / invalid screenshot data");
    }
    const img = await loadImageElement(dataUrl);
    if (!img.naturalWidth || !img.naturalHeight) {
      throw new Error("截图解码后尺寸为 0 / screenshot has zero size");
    }

    const viewportW = (info && info.viewportWidth) || window.innerWidth;
    const viewportH = (info && info.viewportHeight) || window.innerHeight;
    const scaleX = img.naturalWidth / Math.max(1, viewportW);
    const scaleY = img.naturalHeight / Math.max(1, viewportH);

    const cssX = clamp(rect.x, 0, Math.max(0, viewportW - 1));
    const cssY = clamp(rect.y, 0, Math.max(0, viewportH - 1));
    const cssW = clamp(rect.width, 1, viewportW - cssX);
    const cssH = clamp(rect.height, 1, viewportH - cssY);

    const sx = clamp(Math.round(cssX * scaleX), 0, Math.max(0, img.naturalWidth - 1));
    const sy = clamp(Math.round(cssY * scaleY), 0, Math.max(0, img.naturalHeight - 1));
    const sw = clamp(Math.round(cssW * scaleX), 1, img.naturalWidth - sx);
    const sh = clamp(Math.round(cssH * scaleY), 1, img.naturalHeight - sy);

    const canvas = document.createElement("canvas");
    canvas.width = sw;
    canvas.height = sh;
    if (!canvas.width || !canvas.height) {
      throw new Error("裁剪尺寸为 0（Canvas 未绘制） / crop size is zero");
    }
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas 2D unavailable");
    ctx.drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh);

    const encoded = canvasToBase64(canvas, "裁剪图片");
    const mime = encoded.mime;
    const base64 = encoded.base64;
    if (base64.length < 100) {
      throw new Error("裁剪图片 Base64 过短（length=" + base64.length + "） / crop Base64 too short");
    }

    console.log(
      "[imgtr] crop screenshot=%dx%d css=%dx%d scale=%sx%s → %dx%d px (%s), base64=%d chars",
      img.naturalWidth, img.naturalHeight, viewportW, viewportH,
      scaleX.toFixed(3), scaleY.toFixed(3), sw, sh, mime, base64.length
    );
    return { base64, mime, width: sw, height: sh };
  }

  function showRegionStatus(rect, text, kind, autoHideMs) {
    const root = ensureHost();
    if (!regionStatus || !regionStatus.isConnected) {
      regionStatus = document.createElement("div");
      regionStatus.id = REGION_STATUS_ID;
      const dot = document.createElement("span");
      dot.className = "imgtr-region-dot";
      const txt = document.createElement("span");
      txt.className = "imgtr-region-text";
      regionStatus.append(dot, txt);
      root.appendChild(regionStatus);
    }
    const txt = regionStatus.querySelector(".imgtr-region-text");
    if (txt) txt.textContent = text;
    regionStatus.className = "visible" + (kind ? " " + kind : "");

    const w = regionStatus.offsetWidth || 180;
    let left = rect ? rect.x : (window.innerWidth - w) / 2;
    let top = rect ? rect.y + rect.height + 10 : 20;
    left = clamp(left, 8, Math.max(8, window.innerWidth - w - 8));
    if (top > window.innerHeight - 44) {
      top = rect ? Math.max(8, rect.y - 44) : 20;
    }
    regionStatus.style.left = left + "px";
    regionStatus.style.top = top + "px";

    if (regionStatusTimer) { clearTimeout(regionStatusTimer); regionStatusTimer = null; }
    if (autoHideMs && autoHideMs > 0) {
      regionStatusTimer = setTimeout(hideRegionStatus, autoHideMs);
    }
  }

  function hideRegionStatus() {
    if (regionStatusTimer) { clearTimeout(regionStatusTimer); regionStatusTimer = null; }
    if (regionStatus) regionStatus.className = "";
  }

  // --- multi-instance cards -----------------------------------------------
  // Every finished region selection owns one absolutely-positioned card in page
  // coordinates (so it scrolls with the page, not with the viewport). Cards are
  // never cleared when a new selection starts; a card's own × removes exactly
  // that card, Esc removes all of them.
  function ensureRegionEscHandler() {
    if (regionKeyHandler) return;
    regionKeyHandler = (e) => {
      if (e.key !== "Escape" && e.key !== "Esc") return;
      // Full Power Mode: Esc leaves the mode but keeps what was translated —
      // a second Esc clears the overlays.
      if (fpActive) {
        e.preventDefault();
        e.stopPropagation();
        fpStop();
        return;
      }
      if (!regionInstances.length) return;
      e.preventDefault();
      e.stopPropagation();
      clearRegionOverlay();
    };
    document.addEventListener("keydown", regionKeyHandler, true);
  }

  function stopRegionTicker() {
    if (regionTickerId) {
      cancelAnimationFrame(regionTickerId);
      regionTickerId = null;
    }
  }

  // ------------------------------------------------------------- ComicRead
  // ComicRead mounts the whole reader inside a CLOSED shadow root (#comicRead),
  // so document.querySelectorAll()/elementFromPoint() can never reach it. The
  // only way in is the extension-only chrome.dom.openOrClosedShadowRoot() API,
  // which Chromium exposes to content scripts. Roots can be nested several
  // levels deep (components mount components), so scan recursively and re-scan
  // through MutationObservers when the reader mounts/unmounts parts.
  const REGION_SHADOW_MAX_DEPTH = 8;
  const REGION_SHADOW_MAX_NODES = 6000;
  const REGION_SCROLLER_MIN_OVERFLOW = 24;

  let regionScrollSource = null;
  let regionScrollSourceAt = 0;
  let regionScrollSourceLogged = null;
  let regionShadowObservers = [];
  let regionShadowRefreshTimer = null;

  function openShadowRootOf(el, depth) {
    if (!el || el.nodeType !== 1 || depth >= REGION_SHADOW_MAX_DEPTH) return null;
    try {
      if (
        typeof chrome !== "undefined" &&
        chrome.dom &&
        typeof chrome.dom.openOrClosedShadowRoot === "function"
      ) {
        const root = chrome.dom.openOrClosedShadowRoot(el);
        if (root) return root;
      }
    } catch (_) { /* ignore */ }
    try {
      return el.shadowRoot || null;
    } catch (_) {
      return null;
    }
  }

  function collectShadowRoots(seed, depth, roots, budget) {
    if (!seed || budget.nodes >= REGION_SHADOW_MAX_NODES) return;
    const root = openShadowRootOf(seed, depth);
    if (!root) return;
    roots.push(root);
    let kids = [];
    try { kids = root.querySelectorAll("*"); } catch (_) { kids = []; }
    for (const kid of kids) {
      if (budget.nodes >= REGION_SHADOW_MAX_NODES) return;
      budget.nodes += 1;
      collectShadowRoots(kid, depth + 1, roots, budget);
    }
  }

  function discoverShadowRoots() {
    const roots = [];
    const budget = { nodes: 0 };
    // Prefer the well-known ComicRead mounts first so a huge page cannot eat the
    // whole node budget before we reach the reader.
    const seeds = [];
    for (const id of ["comicRead", "comic-read", "manga", "reader"]) {
      const el = document.getElementById(id);
      if (el) seeds.push(el);
    }
    try {
      document.querySelectorAll('[class*="comicRead"],[class*="comic-read"],[class*="mangaBox"]').forEach((el) => {
        if (seeds.indexOf(el) === -1) seeds.push(el);
      });
    } catch (_) { /* ignore */ }
    for (const seed of seeds) {
      if (budget.nodes >= REGION_SHADOW_MAX_NODES) break;
      budget.nodes += 1;
      collectShadowRoots(seed, 0, roots, budget);
    }
    if (budget.nodes < REGION_SHADOW_MAX_NODES) collectShadowRoots(document.documentElement, 0, roots, budget);
    return roots;
  }

  function scrollerScore(el) {
    // Batch D / P2-1: reject non-scrollable candidates before touching layout
    // APIs. findRegionScroller() runs this over up to 18000 elements; a
    // scrollHeight/clientHeight pair is far cheaper than getBoundingClientRect()
    // plus getComputedStyle(), and NaN (SVG etc.) fails the strict test too.
    const vertical = el.scrollHeight - el.clientHeight;
    const horizontal = el.scrollWidth - el.clientWidth;
    if (!(Math.max(vertical, horizontal) > REGION_SCROLLER_MIN_OVERFLOW)) return 0;
    let rect;
    let style;
    try {
      rect = el.getBoundingClientRect();
      style = el.ownerDocument.defaultView.getComputedStyle(el);
    } catch (_) {
      return 0;
    }
    if (!rect || rect.width < 80 || rect.height < 60) return 0;
    const oy = String(style.overflowY || "");
    const ox = String(style.overflowX || "");
    const scrollable =
      oy === "auto" || oy === "scroll" || oy === "overlay" ||
      ox === "auto" || ox === "scroll" || ox === "overlay";
    if (!scrollable) return 0;
    const visW = Math.max(0, Math.min(rect.right, window.innerWidth) - Math.max(rect.left, 0));
    const visH = Math.max(0, Math.min(rect.bottom, window.innerHeight) - Math.max(rect.top, 0));
    const area = visW * visH;
    if (area <= 0) return 0;
    let score = area / Math.max(1, window.innerWidth * window.innerHeight);
    const cls = String(el.className && el.className.baseVal !== undefined ? el.className.baseVal : el.className || "");
    const id = String(el.id || "");
    if (/mangaBox/i.test(cls) || /mangaBox/i.test(id)) score += 1.2;
    if (/manga|comic|reader|viewer|scroller/i.test(cls) || /manga|comic|reader/i.test(id)) score += 0.5;
    return score;
  }

  function findRegionScroller() {
    const roots = discoverShadowRoots();
    const holders = [document];
    for (const root of roots) holders.push(root);
    let best = null;
    let bestScore = 0;
    let scanned = 0;
    for (const holder of holders) {
      let list = [];
      try { list = holder.querySelectorAll("*"); } catch (_) { list = []; }
      for (const el of list) {
        if (scanned >= REGION_SHADOW_MAX_NODES * 3) break;
        scanned += 1;
        if (el === regionHost || (regionHost && regionHost.contains(el))) continue;
        const score = scrollerScore(el);
        if (score > bestScore) {
          bestScore = score;
          best = el;
        }
      }
    }
    return best;
  }

  // Wheel events landing on our overlay never reach the reader's own scroll
  // container, so the page feels frozen while the cursor sits on a bubble or
  // its tooltip. Forward them once, from the host in the capture phase, so
  // every bubble, chip and tooltip behaves the same way.
  let regionWheelBridge = null;

  function forwardWheelToReader(event) {
    const dx = event.deltaX || 0;
    const dy = event.deltaY || 0;
    if (!dx && !dy) return;
    let scroller = regionScrollSource;
    if (!scroller || !scroller.isConnected) {
      ensureRegionScrollSource(true);
      scroller = regionScrollSource;
    }
    if (!scroller || !scroller.isConnected) return;
    // At the ends of the container let the browser keep scrolling normally.
    const atTop = scroller.scrollTop <= 0;
    const atBottom = scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 1;
    if ((dy < 0 && atTop) || (dy > 0 && atBottom)) return;
    const before = scroller.scrollTop;
    try {
      scroller.scrollBy({ top: dy, left: dx, behavior: "auto" });
    } catch (_) {
      return;
    }
    if (scroller.scrollTop === before) return;
    event.preventDefault();
    event.stopPropagation();
  }

  function ensureRegionWheelBridge() {
    if (!regionHost || regionWheelBridge === regionHost) return;
    try {
      regionHost.addEventListener("wheel", forwardWheelToReader, {
        capture: true,
        passive: false
      });
      regionWheelBridge = regionHost;
    } catch (_) { /* ignore */ }
  }

  // Batch D / P2-2: a WeakSet marks the containers that already have a scroll
  // listener. The old expando property lived on the page's own DOM object.
  const regionScrollBound = new WeakSet();

  function attachRegionScrollListener(scroller) {
    if (!scroller || regionScrollBound.has(scroller)) return;
    try {
      regionScrollBound.add(scroller);
      scroller.addEventListener(
        "scroll",
        () => {
          regionScrollSourceAt = Date.now();
          for (const inst of regionInstances) updateInstanceAnchor(inst);
        },
        { passive: true, capture: true }
      );
    } catch (_) { /* ignore */ }
  }

  function stopRegionShadows() {
    for (const mo of regionShadowObservers) {
      try { mo.disconnect(); } catch (_) { /* ignore */ }
    }
    regionShadowObservers = [];
    if (regionShadowRefreshTimer) {
      clearTimeout(regionShadowRefreshTimer);
      regionShadowRefreshTimer = null;
    }
  }

  function scheduleRegionShadowRefresh() {
    if (regionShadowRefreshTimer || !regionInstances.length) return;
    regionShadowRefreshTimer = setTimeout(() => {
      regionShadowRefreshTimer = null;
      if (!regionInstances.length) return;
      // Cheap path: the cached container is still alive, no need to walk every
      // shadow root again (mutation churn on a reader page can be heavy).
      if (regionScrollSource && regionScrollSource.isConnected && scrollerScore(regionScrollSource) > 0) {
        regionScrollSourceAt = Date.now();
        return;
      }
      ensureRegionScrollSource(true);
    }, 250);
  }

  // Batch D / P2-6: a reader page mutates constantly, but only a newly added
  // <img> (or a node carrying one) can change what the overlay has to follow.
  // Checking the added nodes locally keeps the full re-scan (discoverShadowRoots
  // + findRegionScroller over up to 18000 nodes) off unrelated mutations.
  function regionShadowMutationAddsImage(records) {
    for (const record of records || []) {
      const added = record && record.addedNodes;
      if (!added || !added.length) continue;
      for (const node of added) {
        if (!node || node.nodeType !== 1) continue;
        if (node.tagName === "IMG") return true;
        try {
          if (node.querySelector && node.querySelector("img")) return true;
        } catch (_) { /* ignore */ }
      }
    }
    return false;
  }

  function regionShadowMutationHandler(records) {
    if (!regionInstances.length) return;
    if (!regionShadowMutationAddsImage(records)) return;
    scheduleRegionShadowRefresh();
  }

  function observeRegionShadows() {
    stopRegionShadows();
    const targets = [document].concat(discoverShadowRoots());
    for (const target of targets) {
      try {
        const mo = new MutationObserver(regionShadowMutationHandler);
        mo.observe(target, { childList: true, subtree: true });
        regionShadowObservers.push(mo);
      } catch (_) { /* ignore */ }
    }
  }

  function ensureRegionScrollSource(force) {
    const now = Date.now();
    if (!force && regionScrollSource && regionScrollSource.isConnected && now - regionScrollSourceAt < 1000) {
      return regionScrollSource;
    }
    const found = findRegionScroller();
    regionScrollSourceAt = now;
    if (found !== regionScrollSource) {
      regionScrollSource = found;
      if (found) {
        attachRegionScrollListener(found);
        observeRegionShadows();
        if (regionScrollSourceLogged !== found) {
          regionScrollSourceLogged = found;
          console.log(
            "[imgtr] inner scroll container:",
            found.tagName,
            String(found.className || "").slice(0, 60),
            "scrollHeight=" + found.scrollHeight,
            "clientHeight=" + found.clientHeight
          );
        }
      }
    }
    return found;
  }

  // Snapshot the inner scroller at render time for one selection. Returns null
  // when the selection is not inside a scrollable container (normal web pages),
  // in which case the window-scroll path is used.
  function captureRegionScrollSource(rect) {
    if (!rect) return null;
    const scroller = ensureRegionScrollSource(false);
    if (!scroller || !scroller.isConnected) return null;
    let sr;
    let hr;
    try {
      sr = scroller.getBoundingClientRect();
      hr = regionHost.getBoundingClientRect();
    } catch (_) {
      return null;
    }
    if (!(sr.width > 0 && sr.height > 0)) return null;
    const rectLeft = Number(rect.x) || 0;
    const rectTop = Number(rect.y) || 0;
    const rectRight = Number.isFinite(rect.right) ? rect.right : rectLeft + (Number(rect.width) || 0);
    const rectBottom = Number.isFinite(rect.bottom) ? rect.bottom : rectTop + (Number(rect.height) || 0);
    const inside =
      rectRight >= sr.left && rectLeft <= sr.right && rectBottom >= sr.top && rectTop <= sr.bottom;
    if (!inside) return null;
    return {
      scroller,
      scrollTop: scroller.scrollTop,
      scrollLeft: scroller.scrollLeft,
      rectW: sr.width,
      rectH: sr.height,
      clientW: scroller.clientWidth,
      clientH: scroller.clientHeight,
      hostLeft: hr.left,
      hostTop: hr.top
    };
  }

  // How far the layer must move (page px) so the boxes stay glued to the comic
  // content while the reader's inner container scrolls / is zoomed.
  function regionScrollDelta(instance) {
    const snapshot = instance && instance.source;
    if (!snapshot) return null;
    const scroller = snapshot.scroller;
    if (!scroller || !scroller.isConnected) return null;
    let sr;
    let hr;
    try {
      sr = scroller.getBoundingClientRect();
      hr = regionHost.getBoundingClientRect();
    } catch (_) {
      return null;
    }
    if (!(sr.width > 0 && sr.height > 0)) return null;
    const zoomY = sr.height / Math.max(1, snapshot.rectH);
    const zoomX = sr.width / Math.max(1, snapshot.rectW);
    const dy = -(scroller.scrollTop - snapshot.scrollTop) * zoomY;
    const dx = -(scroller.scrollLeft - snapshot.scrollLeft) * zoomX;
    // Only the inner scroll contributes here: window scrolling already moves the
    // absolutely-positioned layer together with the document.
    return { dx: dx, dy: dy };
  }

  // Batch D / P2-3: the hide timer belongs to the instance. One shared timer
  // let hovering bubble B cancel bubble A's pending hide, so A's tooltip stayed
  // on screen after the pointer had left it.
  function scheduleHideInstanceTip(instance) {
    if (!instance) return;
    if (instance.tipHideTimer) clearTimeout(instance.tipHideTimer);
    instance.tipHideTimer = setTimeout(() => {
      instance.tipHideTimer = null;
      instance.tipOpen = false;
      if (instance.tip) instance.tip.classList.remove("visible");
    }, 120);
  }

  function fpHideTipNow(instance) {
    if (!instance) return;
    instance.tipOpen = false;
    if (instance.tipHideTimer) {
      clearTimeout(instance.tipHideTimer);
      instance.tipHideTimer = null;
    }
    if (instance.tip) instance.tip.classList.remove("visible");
  }

  // Scrolling or turning a page must not leave the previous answer hanging in
  // the air: the bubble that owned it may be gone, and mouseleave never fires
  // when the element moves out from under a still pointer.
  function fpHideAllTips() {
    for (const inst of fpRenderedPages.values()) {
      if (inst && inst.tipOpen) fpHideTipNow(inst);
    }
  }

  // P3-32: intentional one-shot registration. The two window listeners below
  // live for the tab's lifetime and are deliberately never removed — do NOT
  // re-bind them (that would stack duplicate listeners).
  let fpTipHidersBound = false;
  function fpBindTipHiders() {
    if (fpTipHidersBound) return;
    fpTipHidersBound = true;
    window.addEventListener("wheel", fpHideAllTips, { capture: true, passive: true });
    window.addEventListener("scroll", fpHideAllTips, { capture: true, passive: true });
  }

  // The layer lives inside a host that already scrolls with the document. Two
  // independent sources can move the comic content under it:
  //   1. ComicRead's inner container (.mangaBox) scrollTop/scrollLeft — handled
  //      with the snapshot taken at render time (see captureRegionScrollSource).
  //   2. The old geometry of the anchor element, used as a fallback for
  //      page-flip modes where the reader moves its page with a CSS transform.
  function updateInstanceAnchor(instance) {
    if (!instance || !instance.layer) return;
    // Full Power layers are re-placed every frame from the image rect.
    if (instance.fullPower) return;
    let dx = null;
    let dy = null;

    const scrolled = regionScrollDelta(instance);
    if (scrolled) {
      dx = scrolled.dx;
      dy = scrolled.dy;
    } else {
      const el = instance.anchorEl;
      if (el && el.isConnected) {
        let r = null;
        let h = null;
        try {
          r = el.getBoundingClientRect();
          h = regionHost.getBoundingClientRect();
        } catch (_) { r = null; }
        if (r && h) {
          dx = (r.left - instance.anchorRect.left) - (h.left - instance.hostRect.left);
          dy = (r.top - instance.anchorRect.top) - (h.top - instance.hostRect.top);
        }
      }
    }
    if (dx === null || dy === null) return;
    dx = Math.round(dx * 100) / 100;
    dy = Math.round(dy * 100) / 100;
    if (dx === instance.lastDx && dy === instance.lastDy) return;
    instance.lastDx = dx;
    instance.lastDy = dy;
    instance.layer.style.setProperty(
      "transform",
      "translate3d(" + dx + "px, " + dy + "px, 0)",
      "important"
    );
    if (instance.tip) instance.tip.classList.remove("visible");
  }

  function startRegionTicker() {
    if (regionTickerId) return;
    const tick = () => {
      regionTickerId = null;
      if (!regionInstances.length) return;
      ensureRegionScrollSource(false);
      for (const inst of regionInstances) updateInstanceAnchor(inst);
      regionTickerId = requestAnimationFrame(tick);
    };
    regionTickerId = requestAnimationFrame(tick);
    ensureRegionScrollSource(true);
  }

  function positionInstanceTip(instance, box) {
    const tip = instance.tip;
    if (!tip) return;
    const layerRect = instance.layer.getBoundingClientRect();
    let vx = layerRect.left;
    let vy = layerRect.top;
    let bh = 0;
    const ref = box || instance.chip;
    if (ref) {
      const r = ref.getBoundingClientRect();
      vx = r.left;
      vy = r.top;
      bh = r.height;
    }
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const tw = tip.offsetWidth;
    const th = tip.offsetHeight;
    let left = vx;
    let top = vy + bh + 6;
    if (top + th > vh - 6 && vy - th - 6 > 6) top = vy - th - 6;
    if (left + tw > vw - 6) left = vw - tw - 6;
    if (left < 6) left = 6;
    if (top < 6) top = 6;
    tip.style.left = (left - layerRect.left) + "px";
    tip.style.top = (top - layerRect.top) + "px";
  }

  function showInstanceTip(instance, entries) {
    if (!instance || !instance.tip || !entries || !entries.length) return;
    if (instance.tipHideTimer) {
      clearTimeout(instance.tipHideTimer);
      instance.tipHideTimer = null;
    }
    const tip = instance.tip;
    instance.openItems = entries.slice(0, 4);
    const list = instance.openItems;
    tip.textContent = "";
    for (const entry of list) {
      const group = entry.group || {};
      const row = document.createElement("div");
      row.className = "imgtr-region-row";

      const srcEl = document.createElement("div");
      srcEl.className = "imgtr-region-tip-src";
      srcEl.textContent = group.text || "";

      const romaji = typeof group.romaji === "string" ? group.romaji.trim() : "";
      const roEl = document.createElement("div");
      roEl.className = "imgtr-region-tip-ro";
      roEl.textContent = romaji;
      roEl.style.setProperty("display", showRomajiEnabled && romaji ? "block" : "none", "important");

      const trEl = document.createElement("div");
      trEl.className = "imgtr-region-tip-tr";
      trEl.textContent = group.translation ||
        (group.text ? (instance.partial ? fpPartialLabel(instance) : "(no translation)") : "");

      row.append(srcEl, roEl, trEl);
      tip.appendChild(row);
    }
    if (entries.length > list.length) {
      const more = document.createElement("div");
      more.className = "imgtr-region-tip-src";
      more.textContent = "\u2026 +" + (entries.length - list.length);
      tip.appendChild(more);
    }
    tip.classList.add("visible");
    instance.tipOpen = true;
    positionInstanceTip(instance, list[0] && list[0].box);
  }

  function closeRegionInstance(instance) {
    if (instance && instance.fullPower && instance.entryUrl) {
      fpRenderedPages.delete(instance.entryUrl);
    }
    const idx = regionInstances.indexOf(instance);
    if (idx !== -1) regionInstances.splice(idx, 1);
    if (instance && instance.tipHideTimer) {
      clearTimeout(instance.tipHideTimer);
      instance.tipHideTimer = null;
    }
    fpInvalidateFrameCache();
    if (instance && instance.layer) {
      try { instance.layer.remove(); } catch (_) { /* ignore */ }
    }
    if (!regionInstances.length) {
      stopRegionTicker();
      hideRegionStatus();
    }
    // Nothing left to place and the mode is off: release the idle sync listeners.
    if (!fpActive && fpRenderedPages.size === 0) fpUnbindIdleSync();
  }

  function clearRegionOverlay() {
    for (const inst of regionInstances.slice()) closeRegionInstance(inst);
    regionInstances = [];
    fpUnbindIdleSync();
    stopRegionTicker();
    stopRegionShadows();
    hideRegionStatus();
  }

  function renderRegionGroups(result, crop, rect, info, anchorEl) {
    const groups = (result.groups || []).filter((g) => {
      if (!g || !g.bbox) return false;
      if (![g.bbox.x, g.bbox.y, g.bbox.width, g.bbox.height].every(Number.isFinite)) return false;
      const text = typeof g.text === "string" ? g.text.trim() : "";
      const tr = typeof g.translation === "string" ? g.translation.trim() : "";
      const ro = typeof g.romaji === "string" ? g.romaji.trim() : "";
      return Boolean(text || tr || ro);
    });
    // Nothing usable: render nothing at all instead of an empty anchor.
    if (!groups.length) return false;

    const root = ensureHost();
    watchHostOrder();

    const anchor = anchorEl && typeof anchorEl.getBoundingClientRect === "function"
      ? anchorEl
      : document.documentElement;
    let anchorRect;
    try {
      anchorRect = anchor.getBoundingClientRect();
    } catch (_) {
      anchorRect = document.documentElement.getBoundingClientRect();
    }

    // The host is the last child of <html> (or of the fullscreen element) with
    // z-index 2147483647. Measure its origin so page-coordinate boxes stay
    // aligned even if the containing block is shifted.
    const originRect = regionHost.getBoundingClientRect();
    const originX = originRect.left + window.scrollX;
    const originY = originRect.top + window.scrollY;

    const scrollX = info && Number.isFinite(info.scrollX) ? info.scrollX : window.scrollX;
    const scrollY = info && Number.isFinite(info.scrollY) ? info.scrollY : window.scrollY;
    const scaleX = rect.width / Math.max(1, crop.width);
    const scaleY = rect.height / Math.max(1, crop.height);

    const layer = document.createElement("div");
    layer.className = "imgtr-region-layer";
    root.appendChild(layer);

    const tip = document.createElement("div");
    tip.className = "imgtr-region-tip";

    const instance = {
      layer,
      tip,
      entries: [],
      anchorEl: anchor,
      anchorRect,
      hostRect: originRect,
      source: captureRegionScrollSource(rect),
      lastDx: 0,
      lastDy: 0,
      chip: null,
      close: null
    };

    for (const group of groups) {
      const b = group.bbox;
      const left = clamp(b.x * scaleX, 0, rect.width);
      const top = clamp(b.y * scaleY, 0, rect.height);
      const width = clamp(b.width * scaleX, 2, Math.max(2, rect.width - left));
      const height = clamp(b.height * scaleY, 2, Math.max(2, rect.height - top));

      const box = document.createElement("div");
      box.className = "imgtr-region-box";
      box.style.left = (rect.x + scrollX - originX + left) + "px";
      box.style.top = (rect.y + scrollY - originY + top) + "px";
      box.style.width = width + "px";
      box.style.height = height + "px";
      box.setAttribute("data-imgtr-text", group.text || "");
      const entry = { box, group };
      box.addEventListener("mouseenter", () => showInstanceTip(instance, [entry]));
      box.addEventListener("mouseleave", () => scheduleHideInstanceTip(instance));
      layer.appendChild(box);
      instance.entries.push(entry);
    }

    // Tiny always-visible anchor (hover = translation) plus its own close button.
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "imgtr-region-chip";
    chip.textContent = "\u8a33";
    chip.title = "hover to see the translation";
    chip.addEventListener("mousedown", (e) => { e.preventDefault(); e.stopPropagation(); });
    chip.addEventListener("mouseenter", () => showInstanceTip(instance, instance.entries));
    chip.addEventListener("mouseleave", () => scheduleHideInstanceTip(instance));
    chip.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); });

    const close = document.createElement("button");
    close.type = "button";
    close.className = "imgtr-region-close";
    close.textContent = "\u00d7";
    close.title = "close this one (Esc: close all)";
    close.addEventListener("mousedown", (e) => { e.preventDefault(); e.stopPropagation(); });
    close.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      closeRegionInstance(instance);
    });

    const chipX = clamp(rect.x + rect.width - 44, 4, Math.max(4, window.innerWidth - 44));
    const chipY = rect.y - 24 >= 4 ? rect.y - 24 : Math.max(4, rect.y + 4);
    chip.style.left = (chipX + scrollX - originX) + "px";
    chip.style.top = (chipY + scrollY - originY) + "px";
    close.style.left = (chipX + 22 + scrollX - originX) + "px";
    close.style.top = (chipY + scrollY - originY) + "px";

    layer.append(chip, close, tip);
    instance.chip = chip;

    regionInstances.push(instance);
    fpInvalidateFrameCache();
    ensureRegionEscHandler();
    startRegionTicker();
    while (regionInstances.length > MAX_REGION_INSTANCES) {
      closeRegionInstance(regionInstances[0]);
    }

    return true;
  }

  // A reloaded extension leaves this tab running the OLD content script with a
  // dead runtime: every sendMessage rejects with "Extension context
  // invalidated". Everything here is best-effort, so tear the timers down
  // quietly instead of spamming the browser's error list.
  let regionContextDead = false;
  let fpPresenceInterval = null;

  function isContextInvalidatedError(error) {
    return /Extension context invalidated/i.test(String((error && error.message) || error || ""));
  }

  function handleDeadExtensionContext() {
    if (regionContextDead) return;
    regionContextDead = true;
    try {
      // P3-33: fpStop is a hoisted function declaration, so the typeof check
      // was always true. It early-returns when Full Power is not running, so
      // the loops it would otherwise own are torn down explicitly below.
      fpStop();
      fpStopObservePageImages();
      // fpStop may have armed the on-demand overlay sync; the context is dead,
      // so drop that listener too.
      fpUnbindIdleSync();
      if (fpSyncRaf != null) {
        window.cancelAnimationFrame(fpSyncRaf);
        fpSyncRaf = null;
      }
      if (fpPollTimer) {
        clearInterval(fpPollTimer);
        fpPollTimer = null;
      }
      if (fpPresenceInterval) {
        clearInterval(fpPresenceInterval);
        fpPresenceInterval = null;
      }
      if (typeof stopRegionTicker === "function") stopRegionTicker();
      if (typeof stopRegionShadows === "function") stopRegionShadows();
      console.log("[imgtr] extension was reloaded: this page's timers are stopped");
    } catch (_) {
      /* nothing left to do */
    }
  }

  function sendMessageWithTimeout(message, timeoutMs) {
    let sending;
    try {
      sending = browser.runtime.sendMessage(message);
    } catch (error) {
      if (!isContextInvalidatedError(error)) throw error;
      handleDeadExtensionContext();
      return Promise.reject(error);
    }
    Promise.resolve(sending).catch((error) => {
      if (isContextInvalidatedError(error)) handleDeadExtensionContext();
    });
    return Promise.race([
      sending,
      new Promise((_, reject) => {
        setTimeout(() => reject(new Error("后台响应超时 / background timed out")), timeoutMs);
      })
    ]);
  }

  async function captureVisibleTabWithRetry() {
    let lastError = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const shot = await sendMessageWithTimeout({ action: "captureTab" }, 8000);
        if (shot && shot.ok && shot.dataUrl) return shot;
        lastError = (shot && shot.error) || "截图失败 / capture failed";
      } catch (e) {
        lastError = e.message;
      }
      await new Promise((r) => setTimeout(r, 150));
    }
    throw new Error(lastError || "截图失败 / capture failed");
  }

  async function handleRegionSelection(rect, info, targetLang) {
    // Immediate feedback that the drag was registered. It must be hidden again
    // before captureVisibleTab, otherwise the chip lands in the screenshot.
    showRegionStatus(rect, "已选择区域，正在截图… / capturing…", "", 0);
    await new Promise((r) => setTimeout(r, 120));
    hideRegionStatus();

    let shot = null;
    if (regionPreCapture && Date.now() - regionPreCapture.capturedAt < 30000) {
      // Screenshot taken before the overlay appeared: hover-only tooltips are
      // still visible and the dimmer is not in the shot.
      shot = { ok: true, dataUrl: regionPreCapture.dataUrl };
      regionPreCapture = null;
      console.log("[imgtr] using pre-capture (hover-safe)");
    } else {
      await waitForPaint();
      shot = await captureVisibleTabWithRetry();
      console.log("[imgtr] region capture ok");
    }
    const crop = await cropScreenshot(shot.dataUrl, rect, info);

    showRegionStatus(rect, "识别并翻译中… / OCR + translating…", "", 0);
    const result = await sendMessageWithTimeout({
      action: "translateRegion",
      base64: crop.base64,
      mime: crop.mime,
      width: crop.width,
      height: crop.height,
      targetLang
    }, 120000);
    console.log("[imgtr] region pipeline result:", result && result.ok ? "ok" : "failed");

    if (!result || !result.ok) {
      throw new Error((result && result.error) || "识别失败 / OCR failed");
    }

    hideRegionStatus();

    if (!result.groups || result.groups.length === 0) {
      showRegionStatus(rect, "未检测到文字 / no text detected", "warn", 3500);
      return;
    }

    // Anchor to the topmost element under the selection. Inside ComicRead the
    // page itself does not scroll — a reader div does — so the overlay tracks
    // that element's rect instead of relying on window.scrollX/scrollY.
    const centerX = clamp(rect.x + rect.width / 2, 0, Math.max(0, window.innerWidth - 1));
    const centerY = clamp(rect.y + rect.height / 2, 0, Math.max(0, window.innerHeight - 1));
    let anchorEl = null;
    try { anchorEl = document.elementFromPoint(centerX, centerY); } catch (_) { anchorEl = null; }
    if (!anchorEl || anchorEl === document.body) anchorEl = document.documentElement;
    console.log("[imgtr] overlay anchor:", anchorEl.tagName, String(anchorEl.className || "").slice(0, 60));
    if (!renderRegionGroups(result, crop, rect, info, anchorEl)) {
      showRegionStatus(rect, "未检测到可用译文 / nothing to render", "warn", 3500);
      return;
    }

    if (result.translationFailed) {
      showRegionStatus(
        rect,
        result.rateLimited
          ? "翻译接口被限流(429)，仅显示原文，请稍后再试 / translate rate-limited"
          : "翻译接口请求失败，仅显示原文 / translation failed",
        "warn",
        6000
      );
    }
  }

  async function startRegionTranslation(targetLangOverride) {
    if (regionBusy) return false;

    const sel = globalThis.__IMGT_Selector;
    if (!sel || typeof sel.start !== "function") {
      console.error("[imgtr] selector.js is not loaded — cannot start region selection");
      return false;
    }

    regionBusy = true;
    // Multi-select mode: cards from earlier selections stay on screen.
    ensureHost();

    let targetLang = targetLangOverride;
    if (!targetLang) {
      const settings = await browser.storage.local.get(DEFAULTS);
      targetLang = settings.targetLang || "en";
    }

    // Take the viewport screenshot BEFORE the overlay exists. Keyboard-triggered
    // selection keeps the mouse exactly where it is, so hover-only tooltips are
    // captured instead of being hidden by the overlay/dimmer.
    regionPreCapture = null;
    try {
      const preShot = await Promise.race([
        browser.runtime.sendMessage({ action: "captureTab" }),
        new Promise((resolve) => setTimeout(() => resolve(null), 1200))
      ]);
      if (preShot && preShot.ok && preShot.dataUrl) {
        regionPreCapture = {
          dataUrl: preShot.dataUrl,
          capturedAt: Date.now()
        };
        console.log("[imgtr] pre-capture ok (hover-safe)");
      } else {
        console.warn("[imgtr] pre-capture unavailable:", preShot && preShot.error);
      }
    } catch (e) {
      console.warn("[imgtr] pre-capture failed:", e.message);
    }

    sel.start({
      onSelect: (rect, info) => {
        handleRegionSelection(rect, info, targetLang)
          .catch((err) => {
            console.error("[imgtr] region translation failed:", err);
            hideRegionStatus();
            showRegionStatus(
              rect,
              "框选翻译失败：" + (err && err.message ? err.message : err),
              "error",
              6000
            );
          })
          .finally(() => { regionBusy = false; });
      },
      onCancel: (reason) => {
        regionBusy = false;
        regionPreCapture = null;
        if (reason && reason.reason === "too-small") {
          showRegionStatus(reason.rect, "选区太小，请拖大一点 / selection too small", "warn", 2200);
        }
      }
    });
    return true;
  }

  // Fallback keyboard shortcut for tabs where only selector.js + region.js were
  // injected (content.js absent). On normal pages content.js owns the shortcut.
  const FALLBACK_DEFAULT_SHORTCUT = {
    enabled: true, alt: true, ctrl: false, shift: false, key: "t"
  };
  let fallbackShortcut = { ...FALLBACK_DEFAULT_SHORTCUT };
  let fallbackShortcutReady = false;

  function normalizeFallbackShortcut(raw) {
    const s = raw && typeof raw === "object" ? raw : {};
    let key = typeof s.key === "string" ? s.key.trim().toLowerCase() : "";
    if (!key) key = "t";
    return {
      enabled: s.enabled !== false,
      alt: !!s.alt,
      ctrl: !!s.ctrl,
      shift: !!s.shift,
      key
    };
  }

  async function loadFallbackShortcut() {
    try {
      const data = await browser.storage.local.get({ shortcut: FALLBACK_DEFAULT_SHORTCUT });
      fallbackShortcut = normalizeFallbackShortcut(data.shortcut);
    } catch (_) { /* keep defaults */ }
    fallbackShortcutReady = true;
  }

  browser.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.shortcut) {
      fallbackShortcut = normalizeFallbackShortcut(changes.shortcut.newValue);
      fallbackShortcutReady = true;
    }
  });

  function isEditableFocusForShortcut() {
    const el = document.activeElement;
    if (!el) return false;
    const tag = el.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
    if (el.isContentEditable) return true;
    try {
      return !!el.closest(
        'input, textarea, select, [contenteditable=""], ' +
        '[contenteditable="true"], [contenteditable="plaintext-only"]'
      );
    } catch (_) {
      return false;
    }
  }

  function isModifierOnlyForShortcut(key) {
    return ["Alt", "Control", "Shift", "Meta", "OS"].includes(key);
  }

  function matchesFallbackShortcut(e) {
    const s = fallbackShortcut;
    if (!s.enabled) return false;
    if (isModifierOnlyForShortcut(e.key)) return false;
    if ((e.key || "").toLowerCase() !== s.key) return false;
    if (!!e.altKey !== !!s.alt) return false;
    if (!!e.ctrlKey !== !!s.ctrl) return false;
    if (!!e.shiftKey !== !!s.shift) return false;
    if (e.metaKey) return false;
    return true;
  }

  function onRegionShortcutKeyFallback(e) {
    if (e.repeat) return;
    if (!fallbackShortcutReady) return;
    if (isEditableFocusForShortcut()) return;
    if (!matchesFallbackShortcut(e)) return;
    if (globalThis.__IMGT_Selector && globalThis.__IMGT_Selector.isActive()) return;
    e.preventDefault();
    e.stopPropagation();
    startRegionTranslation(undefined);
  }

  if (!globalThis.__IMGT_ShortcutOwned) {
    globalThis.__IMGT_ShortcutOwned = true;
    window.addEventListener("keydown", onRegionShortcutKeyFallback, true);
    loadFallbackShortcut();
  }

  // Background → content trigger. Use sendResponse (works on every Chrome
  // version, unlike returning a Promise/plain object from onMessage).
  browser.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg) return;

    // Full Power Mode (ComicRead only): context menu → content controller.
    // The menu item doubles as the off switch.
    if (msg.action === "startFullPower") {
      if (fpActive) fpStop();
      else fpStart();
      sendResponse({ ok: true });
      return;
    }

    if (msg.action === "stopFullPower") {
      fpStop();
      sendResponse({ ok: true });
      return;
    }

    // Background finished (or served from cache) one page: paint it right away
    // and refresh the "已缓存 X 页" counter.
    if (msg.action === "fpPageTranslated") {
      const entry = msg && msg.entry;
      if (entry && entry.fetchFailed) {
        fpMarkFailedHost(entry.url);
        if (fpActive) {
          const visible = fpVisiblePageImages();
          const current = visible[0] || null;
          if (current && current.img) fpCaptureCurrentPage(current.img);
        }
        sendResponse({ ok: true });
        return;
      }
      if (entry && entry.url) {
        if (msg.partial) {
          // OCR is done but the translation is still running: paint the
          // bubbles now so the page does not sit blank for several seconds.
          // Right after entering the mode we hold the first paint back a beat:
          // that lets the whole window start OCR at once instead of stalling
          // the queue behind one page.
          if (fpActive && Date.now() >= fpBootstrapUntil) {
            fpRenderEntry(entry, { partial: true });
          }
        } else {
          fpLocalCache.set(entry.url, entry);
          fpPruneLocalCache();
          if (fpActive) fpRenderEntry(entry);
          fpUpdateCachedText(msg.cachedCount);
        }
      }
      sendResponse({ ok: true });
      return;
    }

    if (msg.action !== "startRegionSelect") return;

    if (!globalThis.__IMGT_Selector) {
      sendResponse({ ok: false, error: "selector.js is not loaded" });
      return;
    }
    startRegionTranslation(msg.targetLang);
    sendResponse({ ok: true });
  });

  // -------------------------------------------------------------------------
  // Full Power Mode (ComicRead only) — step 1: detection + page mapping + chip
  // -------------------------------------------------------------------------
  //
  // Reading mode lives in a closed shadow root, so we (a) detect the reader by
  // its host element, (b) walk the closed roots with chrome.dom to find the
  // <img> currently filling the viewport, and (c) map that URL onto the ordered
  // URL list the background collected from webRequest. Everything else in the
  // feature (translation, cache, prefetch queue) hangs off this mapping.

  // Safety-net poll only: page turns are driven by aria-valuenow mutations and
  // scroll events, so this no longer sets the perceived latency.
  const FP_POLL_MS = 500;
  const FP_CHIP_CLASS = "imgtr-fp-status";
  const FP_PREFETCH_PAGES = 2;      // matches the background's prefetch window
  const FP_BOOTSTRAP_MS = 500;      // let the first tick prime the queue before painting
  const FP_MAX_RENDERED_PAGES = 12; // overlays kept on screen, oldest dropped
  // A second page can share the screen with the current one while scrolling;
  // its bubbles are already translated, so paint them too instead of making
  // the reader wait for the page boundary to pass the viewport centre.
  const FP_VISIBLE_PAINT_MAX = 2;
  const FP_VISIBLE_PAINT_MIN_RATIO = 0.2;   // share of the viewport
  const FP_VISIBLE_PAINT_MIN_HEIGHT = 120;  // px actually on screen
  const FP_LOCAL_CACHE_MAX = 12;    // page results kept in the content script

  // url -> instance already painted on the page (insertion order = age)
  const fpRenderedPages = new Map();
  // url -> translated page (renders instantly on page turns / cache hits)
  const fpLocalCache = new Map();

  let fpActive = false;
  let fpBusy = false;
  let fpPollTimer = null;
  let fpLastDetected = null;
  let fpChipEl = null;
  let fpChipLabelEl = null;
  let fpChipState = null;

  /** Cached .imgtr-fp-text lookup: the chip used to be queried on every tick. */
  function fpChipLabel() {
    if (fpChipLabelEl && fpChipLabelEl.isConnected) return fpChipLabelEl;
    fpChipLabelEl = fpChipEl ? fpChipEl.querySelector(".imgtr-fp-text") : null;
    return fpChipLabelEl;
  }
  let fpBootstrapUntil = 0;
  let fpCalibration = null; // { offset } → page0 = urlIndex - offset
  let fpLastHref = "";
  // The background keeps a per-tab "stopped" marker until it sees fullPowerStart.
  // Every refresh retries until it is acknowledged, so a service-worker nap can
  // never leave the mode ticking into a marker that was never cleared.
  let fpStartAck = false;

  /** ComicRead mounts <div id="comicRead"> and adds [show] while reading. */
  function fpReaderHost() {
    const host = document.getElementById("comicRead");
    if (!host) return null;
    return host.hasAttribute("show") ? host : null;
  }

  /** Ask the background to drop this tab's captured image list. */
  // Batch D / P2-4: declared before the reset path that clears it.
  const fpCaptureDone = new Set();

  function fpResetCapture(reason) {
    fpCalibration = null;
    // Batch D / P2-4: capture keys are page number + geometry, so keys from the
    // previous chapter would make fpCaptureCurrentPage() skip a page for good.
    fpCaptureDone.clear();
    fpInvalidateFrameCache();
    sendMessageWithTimeout(
      { action: "comicReadReset", reason: reason || "" },
      4000
    ).catch(() => { /* retried on next poll */ });
    console.log("[imgtr] full power: reset capture (" + (reason || "-") + ")");
  }

  function fpReportPresence() {
    if (regionContextDead) return;
    const detected = !!fpReaderHost();
    if (detected === fpLastDetected) return;
    fpLastDetected = detected;
    // Entering reading mode means a new image batch: everything captured so
    // far is cover art / thumbnails and would only skew page indexes.
    if (detected) fpResetCapture("reading-mode-start");
    sendMessageWithTimeout(
      { action: "comicReadPresence", detected },
      4000
    ).catch(() => { /* background may sleep; retried on next poll */ });
  }

  /**
   * ComicRead keeps the real page index on its scrollbar:
   *   <div role="scrollbar" aria-valuenow={store.activePageIndex || -1}>
   * So -1 means "page 1" (0 || -1), and we get an exact 0-based page number
   * from the DOM without touching any internal store.
   */
  function fpReadDomPage() {
    const roots = [document, ...discoverShadowRoots()];
    for (const root of roots) {
      let el = null;
      try {
        el = root.querySelector('[role="scrollbar"][aria-valuenow]');
      } catch (_) {
        el = null;
      }
      if (!el) continue;
      const raw = el.getAttribute("aria-valuenow");
      const v = parseInt(raw, 10);
      if (!Number.isFinite(v)) continue;
      if (v === -1) return 0; // ComicRead writes -1 for the first page
      if (v >= 0) return v;
    }
    return -1;
  }

  const FP_URL_PAGE_PATTERNS = [
    /[?&#]page=(\d+)/i,
    /\/page\/(\d+)(?:[/?#]|$)/i,
    /[?&#]p=(\d+)(?:[&#]|$)/i
  ];

  /** Sites that put the page in the URL (not ComicRead itself). */
  function fpReadUrlPage() {
    const href = String(location.href || "");
    for (const re of FP_URL_PAGE_PATTERNS) {
      const m = href.match(re);
      if (!m) continue;
      const v = parseInt(m[1], 10);
      if (Number.isFinite(v) && v > 0) return v - 1;
    }
    return -1;
  }

  /**
   * Page resolution order:
   *   1. ComicRead DOM page (exact)
   *   2. page in the URL (sites that expose it)
   *   3. calibrate: once a trustworthy page is seen next to a known URL slot,
   *      remember the offset and apply it while the DOM is between updates.
   */
  function fpResolvePage(urls, currentUrl) {
    const urlIndex = currentUrl ? fpPageIndexFor(currentUrl, urls) : -1;
    const domPage = fpReadDomPage();
    const urlPage = domPage >= 0 ? -1 : fpReadUrlPage();
    const authoritative = domPage >= 0 ? domPage : urlPage;

    if (authoritative >= 0 && urlIndex >= 0) {
      const candidate = urlIndex - authoritative;
      // The reader's aria-valuenow lags behind the viewport by up to a page, so
      // do not re-learn the offset from a stale sample: only re-sync when the
      // drift is big enough to mean the captured list itself moved.
      if (!fpCalibration) {
        fpCalibration = { offset: candidate };
      } else if (Math.abs(urlIndex - fpCalibration.offset - authoritative) >= 2) {
        fpCalibration = { offset: candidate };
      }
    }

    // Geometry wins: whichever page covers the viewport centre is the page the
    // user is reading, no matter what the reader's own index still says.
    let page0 = authoritative;
    let source = domPage >= 0 ? "dom" : (urlPage >= 0 ? "url" : "none");
    if (urlIndex >= 0 && fpCalibration) {
      const geo = urlIndex - fpCalibration.offset;
      if (geo >= 0) {
        page0 = geo;
        source = "geometry";
      }
    }
    if (page0 < 0 && fpCalibration && urlIndex >= 0) {
      page0 = urlIndex - fpCalibration.offset;
      source = "calibrated";
    }
    return { page0, urlIndex, source, domPage, urlPage };
  }

  /** All page-sized images that are currently in (or near) the viewport. */
  function fpParseSrcset(srcset) {
    let best = "";
    let bestW = -1;
    String(srcset || "").split(",").forEach((part) => {
      const bits = String(part || "").trim().split(/\s+/);
      if (!bits[0]) return;
      const w = parseFloat(bits[1]) || 1;
      if (w >= bestW) {
        bestW = w;
        best = bits[0];
      }
    });
    return best;
  }

  // Lazy-loading galleries park the real file in data-src (or a srcset) and can
  // leave a placeholder in src, which is one reason page images used to look
  // "missing" on sites other than nhentai.
  function fpPageImageSource(img) {
    if (!img) return "";
    let url = "";
    const lazyAttrs = ["data-src", "data-original", "data-lazy-src", "data-lazy", "data-url"];
    for (const name of lazyAttrs) {
      const value = img.getAttribute && img.getAttribute(name);
      if (value) {
        url = value;
        break;
      }
    }
    if (!url) url = fpParseSrcset(img.getAttribute && img.getAttribute("srcset"));
    if (!url) url = img.currentSrc || img.src || "";
    try {
      if (url) return new URL(url, location.href).href;
    } catch (_) {
      /* keep the raw value */
    }
    return String(url || "");
  }

  function fpVisiblePageImages() {
    // Inside the reader ONLY its own trees may be treated as pages. The chapter
    // page behind the reader still holds its cover/preview <img>; taking the
    // largest light-DOM image made that stale page the "current page", which is
    // why the content you were looking at before entering got translated again.
    const shadowRoots = discoverShadowRoots();
    const roots = fpReaderHost() ? shadowRoots.slice() : [document, ...shadowRoots];
    const seen = new Set();
    const out = [];
    for (const root of roots) {
      let imgs;
      try { imgs = root.querySelectorAll("img"); } catch (_) { continue; }
      for (const img of imgs) {
        const resolved = fpPageImageSource(img);
        const remote = /^https?:/i.test(resolved);
        // A blob:/data: page cannot be fetched by the background, but it is
        // still a real page: mark it so the screenshot path can handle it.
        if (!remote && !/^(blob|data):/i.test(resolved) && !/^(blob|data):/i.test(String(img.src || ""))) {
          continue;
        }
        const src = remote ? resolved : "capture:" + (out.length + 1);
        if (seen.has(src)) continue;
        const rect = img.getBoundingClientRect();
        if (rect.width < 80 || rect.height < 80) continue;
        // Rank by what is actually visible: ComicRead keeps neighbouring pages
        // mounted, so the raw rect area would happily pick the page above.
        const vw = Math.min(rect.right, window.innerWidth) - Math.max(rect.left, 0);
        const vh = Math.min(rect.bottom, window.innerHeight) - Math.max(rect.top, 0);
        const visibleArea = vw * vh;
        if (visibleArea < 40000) continue;
        const cx = window.innerWidth / 2;
        const cy = window.innerHeight / 2;
        const coversCenter =
          rect.left <= cx && rect.right >= cx && rect.top <= cy && rect.bottom >= cy;
        seen.add(src);
        out.push({ src, img, capture: !remote, rect, area: visibleArea, coversCenter });
      }
    }
    out.sort((a, b) => (b.coversCenter - a.coversCenter) || (b.area - a.area));
    return out;
  }

  // Batch D / P2-8: page/layer lists are rebuilt at most once per animation
  // frame. fpVisiblePageImages() walks every shadow root and reads one rect per
  // <img>, and a single refresh pass used to call it three or four times; the
  // caches are dropped on the next frame and explicitly on page/chapter resets
  // (fpResetCapture / fpLeaveReadingMode / rendered-layer changes).
  let fpCacheGeneration = 0;
  let fpCachePageList = null;
  let fpCachePageGen = -1;
  let fpCacheLayerList = null;
  let fpCacheLayerGen = -1;
  let fpCacheFlushRaf = 0;

  function fpInvalidateFrameCache() {
    fpCacheGeneration += 1;
    fpCachePageList = null;
    fpCacheLayerList = null;
  }

  function fpCacheFlushNextFrame() {
    if (fpCacheFlushRaf) return;
    fpCacheFlushRaf = window.requestAnimationFrame(() => {
      fpCacheFlushRaf = 0;
      fpInvalidateFrameCache();
    });
  }

  function fpCachedPageImages() {
    if (fpCachePageGen !== fpCacheGeneration) {
      fpCachePageList = fpVisiblePageImages();
      fpCachePageGen = fpCacheGeneration;
      fpCacheFlushNextFrame();
    }
    return fpCachePageList;
  }

  function fpCachedLayerList() {
    if (fpCacheLayerGen !== fpCacheGeneration) {
      fpCacheLayerList = fpLayerList();
      fpCacheLayerGen = fpCacheGeneration;
      fpCacheFlushNextFrame();
    }
    return fpCacheLayerList;
  }

  // -------------------------------------------------------------------------
  // Page order (Full Power): a document loads its page images in reading order
  // and the performance timeline keeps that order even for requests that were
  // made before the extension's service worker woke up. This is what tells us
  // which pages come next, so they can be translated while you still read this
  // one instead of after you turn the page.
  // -------------------------------------------------------------------------
  const fpSeenUrls = [];
  const fpSeenSet = new Set();

  const FP_SEEN_SKIP = /(?:^|\/)(favicon[^/]*)|(?:\/(?:[^/]*\.(?:ico|svg|css|js|mjs|json|woff2?|ttf)(?:[?#]|$)))/i;

  // Which <img> urls are actually rendered, and where. A page image always
  // comes from inside the reader's shadow tree; a chapter cover or banner
  // only exists in the light DOM, under the reader overlay.
  let fpImgIndexCache = null;
  function fpImgUrlIndex() {
    const now = Date.now();
    if (fpImgIndexCache && now - fpImgIndexCache.at < 500) return fpImgIndexCache;
    const key = (img) =>
      String(img.currentSrc || img.src || "").split("?")[0].split("#")[0];
    const shadow = new Set();
    const light = new Set();
    for (const root of discoverShadowRoots()) {
      let imgs = [];
      try { imgs = root.querySelectorAll("img"); } catch (_) { continue; }
      for (const img of imgs) {
        const k = key(img);
        if (k) shadow.add(k);
      }
    }
    let lightImgs = [];
    try { lightImgs = document.querySelectorAll("img"); } catch (_) { lightImgs = []; }
    for (const img of lightImgs) {
      const k = key(img);
      if (k && !shadow.has(k)) light.add(k);
    }
    fpImgIndexCache = { at: now, shadow: shadow, light: light };
    return fpImgIndexCache;
  }

  function fpIsPageImageUrl(url) {
    const want = String(url || "").split("?")[0].split("#")[0];
    if (!want) return false;
    const index = fpImgUrlIndex();
    if (index.shadow.has(want)) return true;
    if (index.light.has(want)) return false;
    // Not rendered yet: most likely a page that is still loading.
    return true;
  }

  function fpRememberSeenUrl(url) {
    if (!url || !/^https?:/i.test(url) || fpSeenSet.has(url)) return;
    // Icons, styles and scripts share the same performance timeline; keep only
    // things that can plausibly be a page image.
    if (FP_SEEN_SKIP.test(url)) return;
    // Covers and banners live in the light DOM behind the reader: translating
    // them paints nonsense onto whatever page happens to be on screen.
    if (!fpIsPageImageUrl(url)) return;
    fpSeenSet.add(url);
    fpSeenUrls.push(url);
    if (fpSeenUrls.length > 300) {
      const dropped = fpSeenUrls.shift();
      if (dropped) fpSeenSet.delete(dropped);
    }
  }

  function fpHarvestPerformanceEntries() {
    let entries = [];
    try { entries = performance.getEntriesByType("resource") || []; } catch (_) { return; }
    const timed = [];
    for (const entry of entries) {
      const name = entry && entry.name;
      if (!name || !/^https?:/i.test(name)) continue;
      if (!/\.(png|jpe?g|webp|gif|avif)(\?|#|$)/i.test(name) &&
          !/\/(img|image|pic|page|manga|comic)s?\//i.test(name)) continue;
      timed.push({ name: name, start: entry.startTime || 0 });
    }
    timed.sort((a, b) => a.start - b.start);
    for (const item of timed) fpRememberSeenUrl(item.name);
  }

  let fpPerfObserver = null;
  function fpObservePageImages() {
    fpHarvestPerformanceEntries();
    if (fpPerfObserver || typeof PerformanceObserver === "undefined") return;
    try {
      fpPerfObserver = new PerformanceObserver((list) => {
        if (!fpActive) return;
        for (const entry of list.getEntries()) fpRememberSeenUrl(entry && entry.name);
      });
      fpPerfObserver.observe({ type: "resource", buffered: true });
    } catch (_) {
      fpPerfObserver = null;
    }
  }

  function fpStopObservePageImages() {
    if (!fpPerfObserver) return;
    try {
      fpPerfObserver.disconnect();
    } catch (_) {
      /* ignore */
    }
    fpPerfObserver = null;
  }

  function fpUrlTail(url) {
    const noQuery = String(url || "").split("?")[0].split("#")[0];
    return noQuery.split("/").pop() || "";
  }

  function fpPageIndexFor(src, urls) {
    if (!urls || !urls.length || !src) return -1;
    const exact = urls.indexOf(src);
    if (exact !== -1) return exact;
    const tail = fpUrlTail(src);
    if (!tail) return -1;
    return urls.findIndex((u) => fpUrlTail(u) === tail);
  }

  function fpEnsureChip() {
    const shadow = ensureHost();
    if (!shadow) return null;
    if (fpChipEl && fpChipEl.isConnected) return fpChipEl;
    if (!shadow.querySelector("." + FP_CHIP_CLASS)) {
      const style = document.createElement("style");
      style.textContent =
        "." + FP_CHIP_CLASS + " {" +
        "position: fixed !important;" +
        "right: 14px !important;" +
        "bottom: 14px !important;" +
        "z-index: 2147483646 !important;" +
        "display: flex !important;" +
        "align-items: center !important;" +
        "gap: 8px !important;" +
        "padding: 6px 8px 6px 12px !important;" +
        "border-radius: 999px !important;" +
        "background: rgba(17, 24, 39, 0.82) !important;" +
        "color: #f9fafb !important;" +
        'font: 12px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif !important;' +
        "box-shadow: 0 4px 14px rgba(0, 0, 0, 0.28) !important;" +
        "pointer-events: none !important;" +
        "user-select: none !important;" +
        "white-space: nowrap !important;" +
        "}" +
        "." + FP_CHIP_CLASS + " .imgtr-fp-text {" +
        "all: initial !important;" +
        "color: #f9fafb !important;" +
        'font: 12px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif !important;' +
        "}" +
        "." + FP_CHIP_CLASS + " .imgtr-fp-exit {" +
        "all: initial !important;" +
        "pointer-events: auto !important;" +
        "cursor: pointer !important;" +
        "box-sizing: border-box !important;" +
        "padding: 2px 9px !important;" +
        "border-radius: 999px !important;" +
        "border: 1px solid rgba(249, 250, 251, 0.45) !important;" +
        "color: #f9fafb !important;" +
        'font: 11px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif !important;' +
        "background: transparent !important;" +
        "}" +
        "." + FP_CHIP_CLASS + " .imgtr-fp-exit:hover {" +
        "background: rgba(249, 250, 251, 0.16) !important;" +
        "}" +
        "@media (prefers-color-scheme: light) {" +
        "." + FP_CHIP_CLASS + " { background: rgba(31, 41, 55, 0.88) !important; }" +
        "}";
      shadow.appendChild(style);
    }
    const chip = document.createElement("div");
    chip.className = FP_CHIP_CLASS;
    chip.setAttribute("data-imgtr-fp", "1");
    chip.style.setProperty("display", "none", "important");

    const text = document.createElement("span");
    text.className = "imgtr-fp-text";

    const exit = document.createElement("button");
    exit.type = "button";
    exit.className = "imgtr-fp-exit";
    exit.textContent = "退出";
    exit.title = "退出火力全开模式（已翻译的内容会保留）";
    exit.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      fpStop();
    });

    chip.append(text, exit);
    shadow.appendChild(chip);
    fpChipEl = chip;
    fpChipLabelEl = text;
    fpChipState = null; // fresh element: the next fpSetChip() must write through
    return chip;
  }

  function fpSetChip(text, visible) {
    const show = visible !== false;
    const nextText = String(text == null ? "" : text);
    // Batch D / P2-10: the poll calls this with the same page text every 500ms.
    // Writing the label + display again dirties layout for no reason.
    if (fpChipState && fpChipState.text === nextText && fpChipState.visible === show) return;
    const chip = fpEnsureChip();
    if (!chip) return;
    const label = fpChipLabel();
    if (label) label.textContent = nextText;
    chip.style.setProperty("display", show ? "flex" : "none", "important");
    fpChipState = { text: nextText, visible: show };
  }

  /** Swap only the "已缓存 X 页" half, so the page number is never stale-coded. */
  function fpUpdateCachedText(cachedCount) {
    const n = Number(cachedCount);
    if (!Number.isFinite(n) || n < 0) return;
    const label = fpChipLabel();
    if (!label) return;
    if (/已缓存 \d+ 页/.test(label.textContent)) {
      label.textContent = label.textContent.replace(/已缓存 \d+ 页/, "已缓存 " + n + " 页");
      if (fpChipState) fpChipState.text = label.textContent;
    }
  }

  function fpLeaveReadingMode() {
    if (!fpActive) return;
    console.log("[imgtr] full power mode: left the reader, clearing overlays");
    fpStop();
    fpPendingRenders.clear();
    if (fpPendingTimer) {
      clearInterval(fpPendingTimer);
      fpPendingTimer = null;
    }
    clearRegionOverlay();
    fpRenderedPages.clear();
    fpCaptureDone.clear();
    fpInvalidateFrameCache();
    fpSetChip("", false);
  }

  /** Pages worth painting right now: dominant page first, then the neighbour. */
  function fpVisiblePaintTargets(currentUrl) {
    const vw = Math.max(1, window.innerWidth);
    const vh = Math.max(1, window.innerHeight);
    const out = [];
    for (const item of fpCachedPageImages()) {
      if (!item || !item.src || out.indexOf(item.src) >= 0) continue;
      const rect = item.rect;
      const visibleH = Math.min(rect.bottom, vh) - Math.max(rect.top, 0);
      const visibleW = Math.min(rect.right, vw) - Math.max(rect.left, 0);
      if (!(visibleH >= FP_VISIBLE_PAINT_MIN_HEIGHT)) continue;
      if (!(visibleW > 0)) continue;
      if ((visibleH * visibleW) / (vw * vh) < FP_VISIBLE_PAINT_MIN_RATIO) continue;
      out.push(item.src);
      if (out.length >= FP_VISIBLE_PAINT_MAX) break;
    }
    if (currentUrl && out.indexOf(currentUrl) === -1) out.unshift(currentUrl);
    return out.slice(0, FP_VISIBLE_PAINT_MAX);
  }

  // Screenshot fallback: no fetchable URL (blob:/data:/canvas), so translate
  // what is actually painted on screen.
  let fpCaptureInFlight = "";

  // Blob:/data: images are same-origin to the page, so we can read their
  // pixels directly and skip the tab screenshot (which also works on https
  // pages but is slower and needs the tab to be visible).
  function fpInlinePixels(el) {
    try {
      if (!el || el.tagName !== "IMG" || !el.naturalWidth || !el.naturalHeight) return null;
      const w = el.naturalWidth;
      const h = el.naturalHeight;
      if (w < 80 || h < 80 || w * h > 45000000) return null;
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      canvas.getContext("2d").drawImage(el, 0, 0, w, h);
      const encoded = canvasToBase64(canvas, "页面像素");
      if (!encoded || !encoded.base64) return null;
      return { base64: encoded.base64, width: w, height: h };
    } catch (_) {
      // Cross-origin image without CORS: the canvas is tainted, use a screenshot.
      return null;
    }
  }

  // Sites whose images refuse a worker fetch: once a host fails, go straight
  // to pixels/screenshot for its pages instead of waiting on a doomed fetch.
  const fpFailedHosts = new Map();
  const FP_FAILED_HOST_TTL = 10 * 60 * 1000;
  function fpUrlHost(url) {
    try {
      return new URL(url, location.href).host;
    } catch (_) {
      return "";
    }
  }
  function fpMarkFailedHost(url) {
    const host = fpUrlHost(url);
    if (host) fpFailedHosts.set(host, Date.now() + FP_FAILED_HOST_TTL);
  }
  function fpIsFailedHost(url) {
    const host = fpUrlHost(url);
    if (!host) return false;
    const until = fpFailedHosts.get(host) || 0;
    if (until && until < Date.now()) {
      fpFailedHosts.delete(host);
      return false;
    }
    return until > 0;
  }

  async function fpCaptureCurrentPage(anchorEl) {
    if (!fpActive || regionContextDead || fpCaptureInFlight) return;
    const el = anchorEl || fpReaderHost();
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const vw = window.innerWidth || document.documentElement.clientWidth || 800;
    const vh = window.innerHeight || document.documentElement.clientHeight || 600;
    const x = Math.max(0, rect.left);
    const y = Math.max(0, rect.top);
    const w = Math.min(vw, rect.right) - x;
    const h = Math.min(vh, rect.bottom) - y;
    if (w < 120 || h < 120 || !(rect.width > 80 && rect.height > 80)) return;
    const domPage = fpReadDomPage();
    const key =
      "capture:" +
      (domPage >= 0 ? domPage : 0) +
      ":" +
      Math.round(rect.left) +
      ":" +
      Math.round(rect.top);
    if (fpCaptureInFlight === key || fpCaptureDone.has(key) || fpRenderedPages.has(key)) return;
    if (fpCaptureDone.size > 24) fpCaptureDone.clear();
    fpCaptureInFlight = key;
    try {
      console.log("[imgtr] full power: screenshot fallback for page", domPage + 1);
      const inline = fpInlinePixels(el);
      const payload = {
        action: "fullPowerCapturePage",
        url: key,
        page: domPage >= 0 ? domPage + 1 : 0,
        rect: { x, y, w, h },
        dpr: window.devicePixelRatio || 1
      };
      if (inline) {
        payload.base64 = inline.base64;
        payload.width = inline.width;
        payload.height = inline.height;
      }
      const res = await sendMessageWithTimeout(payload, 60000);
      if (!res || !res.ok || !res.entry) {
        console.warn(
          "[imgtr] full power: screenshot fallback failed:",
          (res && res.error) || "no entry"
        );
        return;
      }
      const entry = res.entry;
      entry.url = key;
      if (inline) {
        // Whole-image capture: boxes are already relative to the <img>.
        entry.groups = (entry.groups || []).map((g) => ({
          text: g.text,
          translation: g.translation,
          romaji: g.romaji,
          x: g.x,
          y: g.y,
          w: g.w,
          h: g.h
        }));
      } else {
        // Screenshot of the visible slice: crop-relative boxes -> anchor-relative,
        // so the normal placement code keeps them glued to the element.
        entry.groups = (entry.groups || []).map((g) => ({
          text: g.text,
          translation: g.translation,
          romaji: g.romaji,
          x: (x - rect.left + g.x * w) / (rect.width || 1),
          y: (y - rect.top + g.y * h) / (rect.height || 1),
          w: (g.w * w) / (rect.width || 1),
          h: (g.h * h) / (rect.height || 1)
        }));
      }
      fpCaptureDone.add(key);
      fpLocalCache.set(key, entry);
      fpPruneLocalCache();
      fpRenderEntry(entry, { anchorEl: el });
    } catch (e) {
      console.warn("[imgtr] full power: screenshot fallback failed:", (e && e.message) || e);
    } finally {
      fpCaptureInFlight = "";
    }
  }

  let fpPageObserver = null;
  let fpPageRefreshTimer = null;
  let fpScrollWatcherTimer = null;

  /** Page number for the chip: viewport geometry first (half a page is enough),
   *  the reader's own aria-valuenow only as the calibration/fallback source. */
  function fpPageForDisplay() {
    const domPage = fpReadDomPage();
    const imgs = fpCachedPageImages();
    const currentUrl = imgs.length ? imgs[0].src : "";
    if (currentUrl && fpSeenUrls.length && fpCalibration) {
      const urlIndex = fpPageIndexFor(currentUrl, fpSeenUrls);
      if (urlIndex >= 0) {
        const page0 = urlIndex - fpCalibration.offset;
        if (page0 >= 0) return page0;
      }
    }
    return domPage;
  }

  /** Repaint the page number from the reader's own aria-valuenow, immediately. */
  function fpUpdatePageTextNow() {
    const label = fpChipLabel();
    if (!label) return;
    const domPage = fpPageForDisplay();
    if (domPage < 0) return;
    const cached = /已缓存\s*\d+\s*页/.exec(label.textContent);
    label.textContent =
      "火力全开：第 " + (domPage + 1) + " 页" + (cached ? " · " + cached[0] : "");
    if (fpChipState) fpChipState.text = label.textContent;
  }

  /** Paint every visible page that is already cached, without touching the SW. */
  function fpPaintVisibleFromCache() {
    if (!fpActive) return;
    const first = fpCachedPageImages()[0] || null;
    for (const targetUrl of fpVisiblePaintTargets(first ? first.src : "")) {
      const local = fpLocalCache.get(targetUrl);
      if (local) fpRenderEntry(local);
    }
  }

  /** Ask the SW for cache entries of every visible page, then paint them.
   *  Without this, a half-scrolled next page only shows boxes once the tick
   *  happens to make it the "current" page. */
  function fpLoadVisibleCache() {
    if (!fpActive) return Promise.resolve();
    const first = fpCachedPageImages()[0] || null;
    const targets = fpVisiblePaintTargets(first ? first.src : "");
    const urls = targets.filter((u) => !fpLocalCache.get(u));
    if (!urls.length) return Promise.resolve();
    return sendMessageWithTimeout({ action: "fullPowerCached", urls: urls }, 4000)
      .then((res) => {
        if (!res || !res.ok || !res.entries) return;
        for (const key of Object.keys(res.entries)) {
          const entry = res.entries[key];
          if (!entry) continue;
          fpLocalCache.set(key, entry);
          if (targets.indexOf(key) >= 0) fpRenderEntry(entry);
        }
        if (typeof res.cachedCount === "number") fpUpdateCachedText(res.cachedCount);
      })
      .catch(() => {});
  }

  /** Debounced refresh after the reader changed page. */
  function fpSchedulePageRefresh(delay) {
    if (!fpActive || fpPageRefreshTimer) return;
    fpPageRefreshTimer = setTimeout(() => {
      fpPageRefreshTimer = null;
      if (!fpActive) return;
      fpUpdatePageTextNow();
      fpPaintVisibleFromCache();
      void fpLoadVisibleCache();
      fpFlushPendingRenders();
      void fpRefresh();
    }, typeof delay === "number" ? delay : 60);
  }

  /** Watch the reader's page index instead of waiting for the poll timer. */
  function fpWatchPageIndex() {
    if (fpPageObserver) {
      if (fpActive) fpPageObserver.takeRecords();
    } else {
      fpPageObserver = new MutationObserver(() => fpSchedulePageRefresh(40));
    }
    for (const root of discoverShadowRoots()) {
      try {
        fpPageObserver.observe(root, { subtree: true, attributes: true, attributeFilter: ["aria-valuenow"] });
      } catch (_) {
        /* a detached root is fine, the poll re-arms this */
      }
    }
  }

  function fpStopWatchPageIndex() {
    if (fpPageObserver) {
      fpPageObserver.disconnect();
      fpPageObserver = null;
    }
    if (fpPageRefreshTimer) {
      clearTimeout(fpPageRefreshTimer);
      fpPageRefreshTimer = null;
    }
  }

  /** Scroll repaint: the next page's boxes appear as soon as its art scrolls in. */
  function fpOnRegionScroll() {
    if (!fpActive || fpScrollWatcherTimer) return;
    fpScrollWatcherTimer = requestAnimationFrame(() => {
      fpScrollWatcherTimer = null;
      if (!fpActive) return;
      fpPaintVisibleFromCache();
      void fpLoadVisibleCache();
      fpUpdatePageTextNow();
      fpSchedulePageRefresh(150);
    });
  }

  function attachFullPowerWatchers() {
    window.addEventListener("scroll", fpOnRegionScroll, { capture: true, passive: true });
  }

  function detachFullPowerWatchers() {
    window.removeEventListener("scroll", fpOnRegionScroll, { capture: true });
    if (fpScrollWatcherTimer) {
      cancelAnimationFrame(fpScrollWatcherTimer);
      fpScrollWatcherTimer = null;
    }
  }
  async function fpRefresh() {
    if (!fpActive || fpBusy) return;
    fpBusy = true;
    try {
      fpReportPresence();
      if (!fpReaderHost()) {
        fpBusy = false;
        fpLeaveReadingMode();
        return;
      }
      const res = await sendMessageWithTimeout(
        { action: "getComicReadImageUrls" },
        5000
      ).catch(() => null);
      // The user may have stopped Full Power while that round trip was in
      // flight: do not request (billed) capture/translation work any more.
      if (!fpActive) return;
      const urls = (res && res.urls) || [];
      const current = fpCachedPageImages()[0] || null;
      const currentUrl = current ? current.src : "";
      const page = fpResolvePage(urls, currentUrl);

      // Prefetch window: the pages right after the one on screen, taken from
      // the document's own load order (see fpObservePageImages).
      const order = fpSeenUrls.indexOf(currentUrl) >= 0 ? fpSeenUrls : urls;
      const orderIdx = order.indexOf(currentUrl);
      const ahead = [];
      if (orderIdx >= 0) {
        for (let k = 1; k <= FP_PREFETCH_PAGES; k += 1) {
          const u = order[orderIdx + k];
          if (u && u !== currentUrl && ahead.indexOf(u) === -1) ahead.push(u);
        }
      }

      // Local cache first: a page turn must paint without a round trip.
      // Both the dominant page and a neighbour that is already on screen are
      // painted here, so the next page's bubbles appear as soon as its art does.
      for (const targetUrl of fpVisiblePaintTargets(currentUrl)) {
        const local = fpLocalCache.get(targetUrl);
        if (local) fpRenderEntry(local);
      }

      if (current && current.capture) {
        await fpCaptureCurrentPage(current.img);
      }
      if (!fpActive) return;

      // Make sure the background cleared its "stopped" marker before asking it
      // to do page work again; retried on every refresh until acknowledged.
      if (!fpStartAck) {
        await sendMessageWithTimeout({ action: "fullPowerStart" }, 4000)
          .then(() => {
            fpStartAck = true;
          })
          .catch(() => {
            /* background may be waking; retried on the next refresh */
          });
        if (!fpActive) return;
      }

      let cachedCount = fpRenderedPages.size;
      let tick = null;
      if (currentUrl && !(current && current.capture)) {
        tick = await sendMessageWithTimeout(
          {
            action: "fullPowerTick",
            page: page.page0 >= 0 ? page.page0 + 1 : 0,
            url: currentUrl,
            urls: ahead,
            seen: fpSeenUrls.slice(-80),
            referer: String(location.href || "")
          },
          8000
        ).catch(() => null);
      }
      if (!fpActive) return;
      if (current && !current.capture && fpIsFailedHost(current.src)) {
        // Known-bad image host: skip the round trip that would only fail.
        await fpCaptureCurrentPage(current.img);
      }
      if (tick && tick.entry && tick.entry.fetchFailed && current && !current.capture) {
        await fpCaptureCurrentPage(current.img);
      }
      if (tick) {
        const n = Number(tick.cachedCount);
        if (Number.isFinite(n)) cachedCount = n;
        if (tick.entry && tick.entry.url) {
          fpLocalCache.set(tick.entry.url, tick.entry);
          fpPruneLocalCache();
          const paintNow = fpVisiblePaintTargets(currentUrl);
          if (tick.entry.url === currentUrl || paintNow.indexOf(tick.entry.url) >= 0) {
            fpRenderEntry(tick.entry);
          }
        }
      }

      // Anything else that is on screen and already cached gets its frames too
      // (the tick above only ever answers for the dominant page).
      for (const targetUrl of fpVisiblePaintTargets(currentUrl)) {
        if (targetUrl === currentUrl) continue;
        const local = fpLocalCache.get(targetUrl);
        if (local) fpRenderEntry(local);
      }

      fpSetChip(
        "火力全开：" +
          (page.page0 >= 0 ? "第 " + (page.page0 + 1) + " 页" : "页码待定") +
          " · 已缓存 " + cachedCount + " 页"
      );

      console.log(
        "[imgtr] 真实DOM页码: %s, 匹配到的URL: %s, 旁听列表长度: %d, 列表内下标: %s, 来源: %s, 偏移: %s, 已缓存: %s, 预取: %s",
        page.domPage >= 0 ? page.domPage + 1 : "(无)",
        currentUrl || "(无)",
        urls.length,
        page.urlIndex,
        page.source,
        fpCalibration ? fpCalibration.offset : "(未校准)",
        cachedCount,
        ahead.length
      );
    } finally {
      fpBusy = false;
    }
  }

  function fpPruneLocalCache() {
    while (fpLocalCache.size > FP_LOCAL_CACHE_MAX) {
      const oldest = fpLocalCache.keys().next().value;
      fpLocalCache.delete(oldest);
    }
  }

  /** The <img> that shows `url`, preferring the largest one (page vs thumb). */
  function fpFindImgForUrl(url, exactOnly, requireShadow) {
    if (!url) return null;
    const tail = fpUrlTail(url);
    const wantSrc = String(url).split("?")[0].split("#")[0];
    const roots = requireShadow ? discoverShadowRoots() : [document, ...discoverShadowRoots()];
    const candidates = [];

    for (const root of roots) {
      let imgs;
      try { imgs = root.querySelectorAll("img"); } catch (_) { continue; }
      for (const img of imgs) {
        const src = img.currentSrc || img.src || "";
        if (!src) continue;
        const srcSrc = src.split("?")[0].split("#")[0];
        const exact = src === url || srcSrc === wantSrc;
        const tailOK = !exactOnly && tail && fpUrlTail(src) === tail;
        if (!exact && !tailOK) continue;

        if (!img.isConnected) continue;
        const rect = img.getBoundingClientRect();
        if (!(rect.width > 1 && rect.height > 1)) continue;
        // ComicRead renders page thumbnails and neighbour strips too. A bubble
        // anchored to one of those never scrolls with the page — that is the
        // "wrong frames that never move" bug. Only accept page-sized images.
        if (rect.width < 240 || rect.height < 240) continue;
        if (img.naturalWidth && img.naturalWidth < 240) continue;

        candidates.push({
          img,
          rect,
          exact: exact ? 1 : 0,
          area: rect.width * rect.height
        });
      }
    }

    if (!candidates.length) return null;
    candidates.sort((a, b) => (b.exact - a.exact) || (b.area - a.area));
    return candidates[0];
  }


  function fpPruneRendered() {
    while (fpRenderedPages.size > FP_MAX_RENDERED_PAGES) {
      const oldestUrl = fpRenderedPages.keys().next().value;
      const instance = fpRenderedPages.get(oldestUrl);
      fpRenderedPages.delete(oldestUrl);
      if (instance) {
        const idx = regionInstances.indexOf(instance);
        if (idx !== -1) closeRegionInstance(instance);
        else if (instance.layer) {
          try { instance.layer.remove(); } catch (_) { /* ignore */ }
        }
      }
    }
    if (!fpActive && fpRenderedPages.size === 0) fpUnbindIdleSync();
  }

  // -------------------------------------------------------------------------
  // Full Power bubbles
  //
  // A bubble only remembers its normalized rect (0..1 inside the page image).
  // Every frame we read that image's getBoundingClientRect() and re-place the
  // bubbles from it, so whichever container scrolls (window, ComicRead's inner
  // .mangaBox, a CSS transform) the boxes stay glued to the art.
  // -------------------------------------------------------------------------
  let fpSyncRaf = null;

  function fpLayerList() {
    const out = [];
    for (const inst of fpRenderedPages.values()) {
      if (inst && inst.layer && inst.layer.isConnected) out.push(inst);
    }
    return out;
  }

  // Placement is two-phase: measure every page first, then paint. Interleaving
  // getBoundingClientRect() with style writes forced one synchronous layout per
  // instance per frame (layout thrashing), which is what made scrolling under a
  // full overlay stutter on long chapters.
  function fpMeasureInstance(inst) {
    // ComicRead throws its <img> nodes away when a page leaves the render window
    // and builds new ones when it scrolls back in, so the element captured when
    // the bubbles were painted can be detached. Resolve the page again instead
    // of leaving the overlay hidden forever.
    let img = inst.imgEl;
    if ((!img || !img.isConnected) && inst.entryUrl) {
      const found = fpFindImgForUrl(inst.entryUrl, true, true);
      if (found && found.img) {
        img = found.img;
        inst.imgEl = img;
      }
    }
    if (!img || !img.isConnected) return null;
    const rect = img.getBoundingClientRect();
    if (!(rect.width > 1 && rect.height > 1)) return null;
    // Read the tip anchor in the same phase so the paint pass stays write-only.
    if (inst.tipOpen && inst.openItems && inst.openItems.length) {
      const br = inst.openItems[0].box.getBoundingClientRect();
      inst.__fpTipGone =
        br.bottom < 0 || br.top > window.innerHeight ||
        br.right < 0 || br.left > window.innerWidth;
    }
    return rect;
  }

  function fpSetInstanceDisplay(inst, shown) {
    const next = shown ? "" : "none";
    if (inst.__fpDisplay === next) return false;
    inst.__fpDisplay = next;
    inst.layer.style.display = next;
    return true;
  }

  function fpPlaceInstance(inst, rect) {
    if (!rect) return fpSetInstanceDisplay(inst, false);
    const margin = 240;
    const offscreen =
      rect.bottom < -margin ||
      rect.top > window.innerHeight + margin ||
      rect.right < -margin ||
      rect.left > window.innerWidth + margin;
    let changed = fpSetInstanceDisplay(inst, !offscreen);
    if (offscreen) return changed;

    // Nothing moved since the last frame (the common case while reading): do not
    // touch the style of every bubble, or the browser restyles/relayouts for
    // nothing on every single frame.
    let key = "";
    for (const item of inst.entries) {
      const g = item.g;
      key +=
        (rect.left + g.x * rect.width).toFixed(1) + "," +
        (rect.top + g.y * rect.height).toFixed(1) + "," +
        Math.max(8, g.w * rect.width).toFixed(1) + "," +
        Math.max(8, g.h * rect.height).toFixed(1) + ";";
    }
    if (key !== inst.__fpRectKey) {
      inst.__fpRectKey = key;
      changed = true;
      for (const item of inst.entries) {
        const g = item.g;
        item.box.style.left = (rect.left + g.x * rect.width).toFixed(1) + "px";
        item.box.style.top = (rect.top + g.y * rect.height).toFixed(1) + "px";
        item.box.style.width = Math.max(8, g.w * rect.width).toFixed(1) + "px";
        item.box.style.height = Math.max(8, g.h * rect.height).toFixed(1) + "px";
      }
    }

    if (inst.tipOpen && inst.openItems && inst.openItems.length) {
      if (inst.__fpTipGone) fpHideTipNow(inst);
      else positionInstanceTip(inst, inst.openItems[0].box);
    }
    return changed;
  }

  // The continuous loop only runs while Full Power is on. When the mode stops,
  // the overlay is kept readable on purpose, so placement still has to follow
  // the reader. Listening to `scroll` alone is not enough:
  //   - readers scroll inside nested containers, often inside a shadow tree,
  //     where scroll events never reach window;
  //   - trackpad momentum keeps moving after the last event.
  // Composed gesture events (wheel/pointer/key) do cross shadow boundaries, so
  // any of them starts a short rAF loop that keeps placing until the geometry
  // stops changing, then stops itself. No 60fps loop while idle.
  let fpIdleSyncRaf = 0;
  let fpIdleSyncBound = false;
  let fpIdleStill = 0;
  let fpIdlePointerDown = false;
  const FP_IDLE_STOP_FRAMES = 10;

  function fpSyncOnce() {
    const list = fpCachedLayerList();
    let changed = 0;
    if (!list.length) return changed;
    // Phase 1: reads only, so the browser can serve them from one layout pass.
    const rects = new Array(list.length);
    for (let i = 0; i < list.length; i++) rects[i] = fpMeasureInstance(list[i]);
    // Phase 2: writes only.
    for (let i = 0; i < list.length; i++) {
      if (fpPlaceInstance(list[i], rects[i])) changed++;
    }
    return changed;
  }

  function fpIdleFrame() {
    fpIdleSyncRaf = 0;
    if (fpActive || !fpIdleSyncBound) return;
    const changed = fpSyncOnce();
    fpIdleStill = changed ? 0 : fpIdleStill + 1;
    if (fpIdleStill < FP_IDLE_STOP_FRAMES) {
      fpIdleSyncRaf = window.requestAnimationFrame(fpIdleFrame);
    }
  }

  // Start (or extend) the on-demand placement loop.
  function fpKickIdleSync() {
    if (!fpIdleSyncBound || fpActive || fpIdleSyncRaf) return;
    fpIdleStill = 0;
    fpIdleSyncRaf = window.requestAnimationFrame(fpIdleFrame);
    // Opt-in diagnostics: `localStorage.imgtrDebug = "1"` in the page console.
    try {
      if (localStorage.getItem("imgtrDebug") === "1") {
        console.debug("[imgtr] idle sync kick, layers:", fpLayerList().length);
      }
    } catch (_) { /* storage blocked */ }
  }

  function fpIdleOnKey() {
    fpKickIdleSync();
  }

  function fpIdleOnPointerDown() {
    fpIdlePointerDown = true;
    fpKickIdleSync();
  }

  function fpIdleOnPointerMove() {
    if (fpIdlePointerDown) fpKickIdleSync();
  }

  function fpIdleOnPointerUp() {
    fpIdlePointerDown = false;
    fpKickIdleSync();
  }

  function fpBindIdleSync() {
    if (fpIdleSyncBound || fpActive) return;
    fpIdleSyncBound = true;
    // capture=true also catches scroll containers inside the page, as long as
    // they live in the light DOM.
    window.addEventListener("scroll", fpKickIdleSync, { capture: true, passive: true });
    window.addEventListener("resize", fpKickIdleSync, { passive: true });
    // Composed gesture events: these do reach window from shadow trees.
    window.addEventListener("wheel", fpKickIdleSync, { capture: true, passive: true });
    window.addEventListener("keydown", fpIdleOnKey, { capture: true, passive: true });
    window.addEventListener("pointerdown", fpIdleOnPointerDown, { capture: true, passive: true });
    window.addEventListener("pointermove", fpIdleOnPointerMove, { capture: true, passive: true });
    window.addEventListener("pointerup", fpIdleOnPointerUp, { capture: true, passive: true });
    window.addEventListener("pointercancel", fpIdleOnPointerUp, { capture: true, passive: true });
    // Move the kept overlay once right away; it may sit at stale stop coordinates.
    fpKickIdleSync();
    try {
      if (localStorage.getItem("imgtrDebug") === "1") {
        console.debug("[imgtr] idle sync armed, layers:", fpLayerList().length);
      }
    } catch (_) { /* storage blocked */ }
  }

  function fpUnbindIdleSync() {
    if (!fpIdleSyncBound) return;
    fpIdleSyncBound = false;
    fpIdlePointerDown = false;
    fpIdleStill = 0;
    window.removeEventListener("scroll", fpKickIdleSync, { capture: true });
    window.removeEventListener("resize", fpKickIdleSync);
    window.removeEventListener("wheel", fpKickIdleSync, { capture: true });
    window.removeEventListener("keydown", fpIdleOnKey, { capture: true });
    window.removeEventListener("pointerdown", fpIdleOnPointerDown, { capture: true });
    window.removeEventListener("pointermove", fpIdleOnPointerMove, { capture: true });
    window.removeEventListener("pointerup", fpIdleOnPointerUp, { capture: true });
    window.removeEventListener("pointercancel", fpIdleOnPointerUp, { capture: true });
    if (fpIdleSyncRaf) {
      window.cancelAnimationFrame(fpIdleSyncRaf);
      fpIdleSyncRaf = 0;
    }
  }

  function fpSyncStep() {
    fpSyncRaf = null;
    fpSyncOnce();
    // Stop rescheduling on the next frame after the mode ends; the on-demand
    // path (fpBindIdleSync) takes over from there.
    if (fpActive) fpSyncRaf = window.requestAnimationFrame(fpSyncStep);
  }

  function fpStartSync() {
    fpBindTipHiders();
    fpUnbindIdleSync();
    if (fpSyncRaf != null) return;
    fpSyncRaf = window.requestAnimationFrame(fpSyncStep);
  }

  function fpRemoveItem(inst, item) {
    const at = inst.entries.indexOf(item);
    if (at !== -1) inst.entries.splice(at, 1);
    scheduleHideInstanceTip(inst);
    try {
      item.box.remove();
    } catch (_) {
      /* ignore */
    }
    if (!inst.entries.length) closeRegionInstance(inst);
  }

  // url -> { entry, tries }: pages waiting for their <img> to show up again.
  const fpPendingRenders = new Map();
  let fpPendingTimer = null;

  function fpFlushPendingRenders() {
    if (!fpActive) {
      fpPendingRenders.clear();
      if (fpPendingTimer) {
        clearInterval(fpPendingTimer);
        fpPendingTimer = null;
      }
      return;
    }
    for (const item of Array.from(fpPendingRenders.values())) {
      if (fpRenderedPages.has(item.entry.url)) {
        fpPendingRenders.delete(item.entry.url);
        continue;
      }
      item.tries += 1;
      const painted = fpRenderEntry(item.entry, { partial: !!item.partial });
      if (painted || item.tries > 60) fpPendingRenders.delete(item.entry.url);
    }
    if (!fpPendingRenders.size && fpPendingTimer) {
      clearInterval(fpPendingTimer);
      fpPendingTimer = null;
    }
  }

  function fpQueuePendingRender(entry, partial) {
    if (!entry || !entry.url || !fpActive) return;
    if (fpRenderedPages.has(entry.url)) return;
    const pending = { entry, partial: !!partial, tries: 0 };
    const prev = fpPendingRenders.get(entry.url);
    if (prev) {
      // Never let a placeholder overwrite a finished translation.
      if (partial && !prev.partial) return;
      pending.tries = prev.tries;
    }
    fpPendingRenders.set(entry.url, pending);
    if (!fpPendingTimer) fpPendingTimer = setInterval(fpFlushPendingRenders, 300);
  }

  /** Same page arriving twice (partial + final): patch the painted bubbles. */
  function fpPartialLabel(instance) {
    const since = instance && instance.partialSince ? instance.partialSince : 0;
    if (since && Date.now() - since > 45000) return "翻译较慢，仍在重试…";
    return "翻译中…";
  }

  function fpApplyEntryData(instance, entry) {
    if (!instance || !entry) return;
    const groups = Array.isArray(entry.groups) ? entry.groups : [];
    if (!groups.length) return;
    instance.partial = false;
    for (const item of instance.entries) {
      const text = String(item.group.text || "").trim();
      const match = groups.find((c) => c && String(c.text || "").trim() === text);
      if (!match) continue;
      if (match.translation) item.group.translation = match.translation;
      if (match.romaji) item.group.romaji = match.romaji;
    }
    if (instance.tip && instance.tip.classList.contains("visible") && instance.openItems) {
      showInstanceTip(instance, instance.openItems);
    }
  }

  /**
   * Paint one translated page. Bubbles are positioned from the normalized
   * coordinates the background returns (0..1 of the image), so the same cache
   * entry works at any zoom / display width ComicRead renders at.
   */
  function fpRenderEntry(entry, renderOpts) {
    const partial = !!(renderOpts && renderOpts.partial);
    if (!fpActive || !entry || !entry.url) return false;
    if (fpRenderedPages.has(entry.url)) {
      const existing = fpRenderedPages.get(entry.url);
      if (!partial) fpApplyEntryData(existing, entry);
      return true;
    }
    const groups = Array.isArray(entry.groups) ? entry.groups : [];
    if (!groups.length) return false;

    // A gallery page shows the very same cover image; anchoring bubbles to it
    // would paint reading-mode answers on top of the gallery.
    const anchorEl = renderOpts && renderOpts.anchorEl ? renderOpts.anchorEl : null;
    const found = anchorEl
      ? { img: anchorEl, rect: anchorEl.getBoundingClientRect() }
      : fpFindImgForUrl(entry.url, true, true);
    if (!found) {
      // ComicRead rebuilds image nodes while turning pages, so even a page the
      // SW already translated may not have its <img> yet. Keep it in the
      // pending list (final entries win over partial ones) until the node shows
      // up, then paint it on the spot.
      fpQueuePendingRender(entry, partial);
      return false;
    }
    const imgEl = found.img;
    const rect = found.rect;
    if (!(rect.width > 80 && rect.height > 80)) return false;

    const root = ensureHost();
    if (!root) return false;
    watchHostOrder();

    const layer = document.createElement("div");
    layer.className = "imgtr-region-layer imgtr-fp-layer";
    layer.setAttribute("data-imgtr-page", String(entry.page || ""));

    const tip = document.createElement("div");
    tip.className = "imgtr-region-tip";

    const instance = {
      layer,
      tip,
      entries: [],
      imgEl,
      // Only used to forward the wheel to the reader's scroller.
      source: captureRegionScrollSource(rect),
      lastDx: 0,
      lastDy: 0,
      chip: null,
      close: null,
      fullPower: true,
      entryUrl: entry.url
    };

    let skippedTiny = 0;
    let skippedHuge = 0;
    let skippedUi = 0;
    for (const g of groups) {
      const bubbleW = (Number(g.w) || 0) * rect.width;
      const bubbleH = (Number(g.h) || 0) * rect.height;
      // A screenshot fallback can pick up our own status chip; it is not text.
      if (/火力全开|已缓存|退出/.test(String(g.text || ""))) {
        skippedUi += 1;
        continue;
      }
      // Vertical Japanese dialogue is often one very narrow column: 'その晩'
      // measures about 16x60 CSS px. Judging noise by width alone threw those
      // away, so tall narrow columns are always kept.
      const columnAspect = bubbleW > 0 ? bubbleH / bubbleW : 0;
      const narrowColumn = columnAspect >= 1.6 && bubbleH >= 40;
      const tinyBothCorners = bubbleW < 22 && bubbleH < 24;
      const crumb = bubbleW * bubbleH < 260 && Math.min(bubbleW, bubbleH) < 14;
      if (!narrowColumn && (tinyBothCorners || crumb)) {
        skippedTiny += 1;
        continue;
      }
      // Cover / chapter-title lettering is one or two giant glyphs. Translating
      // it produces huge boxes over the artwork, not dialogue.
      const gw = Number(g.w) || 0;
      const gh = Number(g.h) || 0;
      if (gw > 0.62 || gh > 0.55 || gw * gh > 0.30) {
        skippedHuge += 1;
        continue;
      }
      const item = {
        box: null,
        group: {
          text: g.text || "",
          translation: g.translation || "",
          romaji: g.romaji || ""
        },
        g: {
          x: clamp(Number(g.x) || 0, 0, 1),
          y: clamp(Number(g.y) || 0, 0, 1),
          w: clamp(Number(g.w) || 0, 0.004, 1),
          h: clamp(Number(g.h) || 0, 0.004, 1)
        }
      };

      const box = document.createElement("div");
      box.className = "imgtr-region-box imgtr-fp-box";
      box.setAttribute("data-imgtr-text", item.group.text);
      item.box = box;

      const shut = document.createElement("div");
      shut.className = "imgtr-fp-close";
      shut.textContent = "\u00d7";
      shut.title = "关闭这个翻译框";
      shut.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        fpRemoveItem(instance, item);
      });
      box.appendChild(shut);

      box.addEventListener("mouseenter", () => showInstanceTip(instance, [item]));
      box.addEventListener("mouseleave", () => scheduleHideInstanceTip(instance));

      layer.appendChild(box);
      instance.entries.push(item);
    }

    layer.appendChild(tip);
    root.appendChild(layer);
    regionInstances.push(instance);
    fpInvalidateFrameCache();
    instance.partial = partial;
    instance.partialSince = partial ? Date.now() : 0;
    fpRenderedPages.set(entry.url, instance);
    fpPruneRendered();
    fpPendingRenders.delete(entry.url);
    fpPlaceInstance(instance, fpMeasureInstance(instance));
    fpStartSync();
    console.log(
      "[imgtr] full power: painted " + instance.entries.length + " bubble(s) for " +
      entry.url +
      (skippedTiny ? " (skipped " + skippedTiny + " tiny fragment(s))" : "") +
      (skippedHuge ? " (skipped " + skippedHuge + " cover-sized group(s))" : "") +
      (skippedUi ? " (skipped " + skippedUi + " ui text)" : "")
    );
    return true;
  }

  function fpStart() {
    if (fpActive) {
      void fpRefresh();
      return;
    }
    if (!fpReaderHost()) {
      fpSetChip("火力全开：仅支持 ComicRead 阅读模式", true);
      return;
    }
    fpActive = true;
    fpBootstrapUntil = Date.now() + FP_BOOTSTRAP_MS;
    fpLastDetected = null;
    fpCalibration = null;
    fpLastHref = String(location.href || "");
    fpEnsureChip();
    fpObservePageImages();
    fpWatchPageIndex();
    attachFullPowerWatchers();
    // Tell the background this tab is running again (clears its "stopped"
    // marker). Retried from fpRefresh until acknowledged, so a cold service
    // worker cannot leave the mode ticking into a marker that was never cleared.
    fpStartAck = false;
    fpReportPresence();
    void fpRefresh();
    fpPollTimer = setInterval(() => {
      if (regionContextDead || !fpActive) return;
      fpReportPresence();
      // fpRefresh() ends the mode when the reader disappears, so the poll
      // has to keep running even after the reader is gone.
      // Chapter switches are usually SPA navigations on the same document.
      const href = String(location.href || "");
      if (href !== fpLastHref) {
        fpLastHref = href;
        fpResetCapture("url-change");
      }
      void fpRefresh();
    }, FP_POLL_MS);
    console.log("[imgtr] full power mode: started");
  }

  /**
   * Leave Full Power Mode. Deliberately does NOT clear the overlays: already
   * translated pages stay readable, the menu entry can start it again.
   */
  function fpStop() {
    if (!fpActive && !fpPollTimer) return;
    fpActive = false;
    // Batch D / P2-4: teardown must be all-or-nothing. If one disconnect throws,
    // the 60fps sync loop and the poll interval must still stop with the mode.
    try {
      fpStopObservePageImages();
      fpStopWatchPageIndex();
      detachFullPowerWatchers();
    } finally {
      // The overlay is kept on purpose when leaving the mode, so the self
      // scheduling sync loop would otherwise run at 60fps forever.
      if (fpSyncRaf != null) {
        window.cancelAnimationFrame(fpSyncRaf);
        fpSyncRaf = null;
      }
      // Kept overlay still has to follow scrolling: switch to the on-demand
      // sync (rAF coalesced scroll/resize) instead of a permanent loop.
      if (fpRenderedPages.size) fpBindIdleSync();
      if (fpPollTimer) {
        clearInterval(fpPollTimer);
        fpPollTimer = null;
      }
      if (fpChipEl) {
        fpChipEl.style.setProperty("display", "none", "important");
      }
      fpChipState = null;
    }
    fpFlushPendingRenders();
    sendMessageWithTimeout({ action: "fullPowerStop" }, 4000).catch(() => { /* tab may reload */ });
    console.log(
      "[imgtr] full power mode: stopped (kept " + fpRenderedPages.size + " translated page(s))"
    );
  }

  // The context-menu entry is gated on the background's per-tab flag, so the
  // flag has to be fresh before the user ever opens the menu — not only once
  // Full Power Mode is on. Only state changes produce a message.
  setTimeout(() => {
    if (!regionContextDead) fpReportPresence();
  }, 0);
  fpPresenceInterval = setInterval(() => {
    if (!regionContextDead) fpReportPresence();
  }, 2500);

  globalThis.__IMGT_Region = {
    start: startRegionTranslation,
    clear: clearRegionOverlay,
    fullPower: {
      start: fpStart,
      stop: fpStop,
      refresh: fpRefresh,
      debugFind: (url) => {
        const found = fpFindImgForUrl(url);
        const img = found && found.img;
        return img
          ? { ok: true, live: !!img.isConnected, src: img.currentSrc || img.src }
          : { ok: false };
      },
      // Support hook: what the overlay currently thinks is on screen.
      debug: () =>
        fpLayerList().map((inst) => {
          const img = inst.imgEl;
          const live = !!(img && img.isConnected);
          const rect = live ? img.getBoundingClientRect() : null;
          return {
            url: inst.entryUrl,
            imgLive: live,
            show: inst.layer.style.display || "on",
            boxes: inst.entries.length,
            tip: !!inst.tipOpen,
            rect: rect ? { x: Math.round(rect.left), y: Math.round(rect.top), w: Math.round(rect.width) } : null
          };
        })
    }
  };
})();
