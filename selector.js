// selector.js — full-screen drag-to-select overlay ("translate a region").
//
// Loaded on every page immediately before content.js (same content-script
// entry, so both files share one isolated world and can talk through the
// global below).
//
// Public API (isolated-world global):
//   __IMGT_Selector.start({ onSelect, onCancel })
//   __IMGT_Selector.cancel()
//   __IMGT_Selector.isActive()
//
// onSelect(rect, info):
//   rect = { x, y, width, height }   // CSS pixels, viewport-relative
//                                     // (same space as clientX / clientY)
//   info = { scrollX, scrollY, dpr, viewportWidth, viewportHeight, capturedAt }
//
// The overlay removes itself *before* onSelect fires, so the caller can call
// chrome.tabs.captureVisibleTab without the dimmer showing up in the shot.
// The caller is responsible for waiting a frame or two before capturing.
//
// Everything is plain DOM + CSS: no framework, no shadow root (a shadow root
// would make the overlay harder to paint over the whole viewport, and the
// existing extension already uses namespaced IDs in content.css).

(function () {
  "use strict";

  const OVERLAY_ID = "__imgtr_sel_overlay__";
  const STYLE_ID = "__imgtr_sel_style__";
  const MIN_SIZE = 6; // css px — anything smaller is treated as a click

  // Overlay state. Non-null exactly while the overlay is on screen.
  let state = null;

  // pointermove can fire faster than the compositor paints; coalesce the
  // ~20 style writes into one update per frame.
  let moveRaf = 0;
  let lastMoveX = 0;
  let lastMoveY = 0;

  // ---- Injected styles (once per page) ------------------------------------
  const CSS = `
    #${OVERLAY_ID} {
      all: initial;
      position: fixed !important;
      inset: 0 !important;
      display: block !important;
      z-index: 2147483647 !important;
      background: transparent !important;
      cursor: crosshair !important;
      user-select: none !important;
      -webkit-user-select: none !important;
      touch-action: none !important;
      overflow: hidden !important;
    }
    #${OVERLAY_ID} * {
      box-sizing: border-box !important;
      margin: 0 !important;
      padding: 0 !important;
      font-family: system-ui, -apple-system, "Segoe UI", sans-serif !important;
      user-select: none !important;
      -webkit-user-select: none !important;
    }
    #${OVERLAY_ID} .imgtr-sel-mask {
      all: initial;
      position: fixed !important;
      display: block;
      background: rgba(15, 18, 24, 0.38) !important;
      pointer-events: none !important;
    }
    #${OVERLAY_ID} .imgtr-sel-rect {
      all: initial;
      position: fixed !important;
      display: none;
      box-sizing: border-box !important;
      border: 2px solid #4c9aff !important;
      background: rgba(76, 154, 255, 0.10) !important;
      box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.65),
                  0 2px 14px rgba(0, 0, 0, 0.35) !important;
      pointer-events: none !important;
    }
    #${OVERLAY_ID} .imgtr-sel-size {
      all: initial;
      position: fixed !important;
      display: none;
      padding: 3px 7px !important;
      background: #1f2937 !important;
      color: #f9fafb !important;
      border-radius: 4px !important;
      font-size: 12px !important;
      line-height: 1.3 !important;
      font-variant-numeric: tabular-nums !important;
      white-space: nowrap !important;
      pointer-events: none !important;
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.35) !important;
    }
    #${OVERLAY_ID} .imgtr-sel-hint {
      all: initial;
      position: fixed !important;
      left: 50% !important;
      top: 18px !important;
      transform: translateX(-50%) !important;
      display: block !important;
      max-width: calc(100vw - 32px) !important;
      padding: 8px 16px !important;
      background: rgba(17, 24, 39, 0.92) !important;
      color: #f9fafb !important;
      border-radius: 999px !important;
      font-size: 13px !important;
      line-height: 1.4 !important;
      white-space: nowrap !important;
      overflow: hidden !important;
      text-overflow: ellipsis !important;
      pointer-events: none !important;
      box-shadow: 0 6px 22px rgba(0, 0, 0, 0.4) !important;
    }
  `;

  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = CSS;
    (document.head || document.documentElement).appendChild(style);
  }

  function el(tag, cls) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    return node;
  }

  function clamp(v, min, max) {
    return Math.min(max, Math.max(min, v));
  }

  // ---------------------------------------------------------------------------
  // Overlay construction / teardown
  // ---------------------------------------------------------------------------

  function start(options) {
    options = options || {};

    // Starting again while active: quietly tear down the previous overlay.
    if (state) cleanup();

    ensureStyle();
    lockScroll();

    const overlay = el("div");
    overlay.id = OVERLAY_ID;

    const maskTop = el("div", "imgtr-sel-mask");
    const maskBottom = el("div", "imgtr-sel-mask");
    const maskLeft = el("div", "imgtr-sel-mask");
    const maskRight = el("div", "imgtr-sel-mask");

    const rectEl = el("div", "imgtr-sel-rect");
    const sizeEl = el("div", "imgtr-sel-size");

    const hint = el("div", "imgtr-sel-hint");
    hint.textContent = options.hintText ||
      "拖拽选择要翻译的区域 · Esc 取消 / Drag to select · Esc to cancel";

    overlay.append(maskTop, maskBottom, maskLeft, maskRight, rectEl, sizeEl, hint);

    const s = {
      overlay,
      rectEl,
      sizeEl,
      masks: { top: maskTop, bottom: maskBottom, left: maskLeft, right: maskRight },
      dragging: false,
      startX: 0,
      startY: 0,
      rect: null,
      pointerId: null,
      listeners: [],
      onSelect: typeof options.onSelect === "function" ? options.onSelect : null,
      onCancel: typeof options.onCancel === "function" ? options.onCancel : null
    };
    state = s;

    const on = (target, type, fn, opts) => {
      target.addEventListener(type, fn, opts);
      s.listeners.push([target, type, fn, opts]);
    };

    // Shade the whole viewport until a drag starts.
    setMasks(s, { x: 0, y: 0, width: 0, height: 0 });
    overlay.addEventListener("mousedown", swallow);
    overlay.addEventListener("mouseup", swallow);
    overlay.addEventListener("pointerdown", onPointerDown);
    on(window, "pointermove", onPointerMove, true);
    on(window, "pointerup", onPointerUp, true);
    on(window, "pointercancel", onPointerCancel, true);
    on(window, "keydown", onKeyDown, true);
    on(window, "contextmenu", onContextMenu, true);
    on(overlay, "wheel", onWheel, { passive: false });

    (document.documentElement || document.body).appendChild(overlay);
  }

  function swallow(e) {
    e.preventDefault();
    e.stopPropagation();
  }

  function cleanup() {
    if (!state) return;
    if (moveRaf) {
      cancelAnimationFrame(moveRaf);
      moveRaf = 0;
    }
    const s = state;
    state = null;
    for (const [target, type, fn, opts] of s.listeners) {
      try { target.removeEventListener(type, fn, opts); } catch (_) { /* ignore */ }
    }
    s.listeners.length = 0;
    try { s.overlay.remove(); } catch (_) { /* ignore */ }
    unlockScroll();
  }

  // P3-28: wheel preventDefault alone does not stop keyboard, scrollbar or
  // programmatic scrolling, which would desync the screenshot from the CSS
  // selection. Lock document scroll (html + body) and restore the exact
  // previous inline values on cleanup. Idempotent: repeated start() while
  // active cannot overwrite the saved values.
  let scrollLock = null;

  function lockScroll() {
    if (scrollLock) return;
    const html = document.documentElement;
    const body = document.body;
    scrollLock = {
      html: html ? {
        value: html.style.getPropertyValue("overflow"),
        priority: html.style.getPropertyPriority("overflow")
      } : null,
      body: body ? {
        value: body.style.getPropertyValue("overflow"),
        priority: body.style.getPropertyPriority("overflow")
      } : null
    };
    if (html) {
      // Keep the scrollbar gutter reserved: hiding overflow removes the
      // scrollbar, and the resulting reflow can shift the captured screenshot
      // by one scrollbar width while the selection stays put.
      scrollLock.gutter = {
        value: html.style.getPropertyValue("scrollbar-gutter"),
        priority: html.style.getPropertyPriority("scrollbar-gutter")
      };
      html.style.setProperty("scrollbar-gutter", "stable", "important");
      html.style.setProperty("overflow", "hidden", "important");
    }
    if (body) body.style.setProperty("overflow", "hidden", "important");
  }

  function unlockScroll() {
    if (!scrollLock) return;
    const html = document.documentElement;
    const body = document.body;
    if (html && scrollLock.html) {
      if (scrollLock.html.value) html.style.setProperty("overflow", scrollLock.html.value, scrollLock.html.priority);
      else html.style.removeProperty("overflow");
      if (scrollLock.gutter) {
        if (scrollLock.gutter.value) html.style.setProperty("scrollbar-gutter", scrollLock.gutter.value, scrollLock.gutter.priority);
        else html.style.removeProperty("scrollbar-gutter");
      }
    }
    if (body && scrollLock.body) {
      if (scrollLock.body.value) body.style.setProperty("overflow", scrollLock.body.value, scrollLock.body.priority);
      else body.style.removeProperty("overflow");
    }
    scrollLock = null;
  }

  // ---------------------------------------------------------------------------
  // Pointer handling
  // ---------------------------------------------------------------------------

  function onPointerDown(e) {
    if (!state || state.dragging) return;
    if (e.button !== 0 && e.pointerType === "mouse") return;
    if (e.isPrimary === false) return;

    e.preventDefault();
    e.stopPropagation();

    const s = state;
    s.dragging = true;
    s.pointerId = e.pointerId != null ? e.pointerId : null;
    s.startX = clamp(e.clientX, 0, window.innerWidth);
    s.startY = clamp(e.clientY, 0, window.innerHeight);
    s.rect = { x: s.startX, y: s.startY, width: 0, height: 0 };

    try { s.overlay.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ }

    // Show a zero-size rectangle right away so the drag feels responsive.
    updateVisual(s, s.startX, s.startY);
  }

  function onPointerMove(e) {
    if (!state || !state.dragging) return;
    if (state.pointerId != null && e.pointerId !== state.pointerId) return;
    e.preventDefault();
    lastMoveX = e.clientX;
    lastMoveY = e.clientY;
    if (moveRaf) return;
    moveRaf = requestAnimationFrame(() => {
      moveRaf = 0;
      if (state && state.dragging) updateVisual(state, lastMoveX, lastMoveY);
    });
  }

  function onPointerUp(e) {
    if (!state || !state.dragging) return;
    if (state.pointerId != null && e.pointerId !== state.pointerId) return;
    e.preventDefault();
    e.stopPropagation();

    state.dragging = false;
    if (moveRaf) {
      cancelAnimationFrame(moveRaf);
      moveRaf = 0;
    }
    updateVisual(state, e.clientX, e.clientY);
    finish();
  }

  function onPointerCancel(e) {
    if (!state || !state.dragging) return;
    if (state.pointerId != null && e.pointerId !== state.pointerId) return;
    cancel();
  }

  function onKeyDown(e) {
    if (!state) return;
    if (e.key === "Escape" || e.key === "Esc") {
      e.preventDefault();
      e.stopPropagation();
      cancel();
    }
  }

  function onContextMenu(e) {
    if (!state) return;
    // Suppress the browser's native context menu while the selector is up,
    // but keep the overlay alive (do NOT cancel the selection).
    e.preventDefault();
    e.stopPropagation();
  }

  function onWheel(e) {
    // Freeze the page while selecting: the screenshot and the CSS-pixel
    // selection must describe the same viewport.
    e.preventDefault();
    e.stopPropagation();
  }

  // ---------------------------------------------------------------------------
  // Drawing
  // ---------------------------------------------------------------------------

  function updateVisual(s, cx, cy) {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const x2 = clamp(cx, 0, vw);
    const y2 = clamp(cy, 0, vh);

    const x = Math.min(s.startX, x2);
    const y = Math.min(s.startY, y2);
    const width = Math.abs(x2 - s.startX);
    const height = Math.abs(y2 - s.startY);
    const rect = { x, y, width, height };
    s.rect = rect;

    const r = s.rectEl;
    if (width < 1 || height < 1) {
      r.style.display = "none";
      s.sizeEl.style.display = "none";
    } else {
      r.style.display = "block";
      r.style.left = x + "px";
      r.style.top = y + "px";
      r.style.width = width + "px";
      r.style.height = height + "px";

      const label = `${Math.round(width)} × ${Math.round(height)}`;
      if (s.sizeEl.textContent !== label) s.sizeEl.textContent = label;
      s.sizeEl.style.display = "block";
      let lx = x + width + 6;
      let ly = y + height + 6;
      if (lx + 90 > vw) lx = Math.max(2, x + width - 90);
      if (ly + 26 > vh) ly = Math.max(2, y + height - 30);
      s.sizeEl.style.left = lx + "px";
      s.sizeEl.style.top = ly + "px";
    }

    setMasks(s, rect);
  }

  function setMasks(s, rect) {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const { x, y, width, height } = rect;

    const top = s.masks.top;
    const bottom = s.masks.bottom;
    const left = s.masks.left;
    const right = s.masks.right;

    setBox(top, 0, 0, vw, y);
    setBox(bottom, 0, y + height, vw, Math.max(0, vh - (y + height)));
    setBox(left, 0, y, x, height);
    setBox(right, x + width, y, Math.max(0, vw - (x + width)), height);
  }

  function setBox(node, x, y, w, h) {
    node.style.left = x + "px";
    node.style.top = y + "px";
    node.style.width = Math.max(0, w) + "px";
    node.style.height = Math.max(0, h) + "px";
    node.style.display = w > 0 && h > 0 ? "block" : "none";
  }

  // ---------------------------------------------------------------------------
  // Finish / cancel
  // ---------------------------------------------------------------------------

  function finish() {
    if (!state) return;
    const s = state;

    const raw = s.rect || { x: 0, y: 0, width: 0, height: 0 };
    const tooSmall = raw.width < MIN_SIZE || raw.height < MIN_SIZE;
    const onSelect = s.onSelect;
    const onCancel = s.onCancel;

    const rect = {
      x: Math.round(raw.x),
      y: Math.round(raw.y),
      width: Math.max(1, Math.round(raw.width)),
      height: Math.max(1, Math.round(raw.height))
    };
    const info = {
      scrollX: window.scrollX,
      scrollY: window.scrollY,
      dpr: window.devicePixelRatio || 1,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      capturedAt: Date.now()
    };

    // Remove the overlay BEFORE capturing the tab — otherwise the dimmer and
    // the rubber-band rectangle end up inside the screenshot.
    cleanup();

    if (tooSmall) {
      if (onCancel) { try { onCancel({ reason: "too-small", rect }); } catch (_) { /* ignore */ } }
      return;
    }

    if (onSelect) {
      try { onSelect(rect, info); } catch (e) { console.error("[imgtr] onSelect threw:", e); }
    }
  }

  function cancel() {
    if (!state) return;
    const s = state;
    cleanup();
    if (s.onCancel) { try { s.onCancel({ reason: "cancelled" }); } catch (_) { /* ignore */ } }
  }

  function isActive() {
    return state !== null;
  }

  globalThis.__IMGT_Selector = { start, cancel, isActive };
})();
