// content.js — runs on every page.
//
// Four responsibilities:
//   1. Show a small floating "translate" icon near a fresh text selection.
//      Click the icon → translate selection → show panel inline.
//   2. Handle right-click "Translate" on selection (message from background).
//      Both paths funnel into the same showPanel() function.
//   3. Proxy image fetches for the popup window. The popup itself runs in the
//      extension origin, so when it fetches a hotlink-protected image
//      (pixiv, gelbooru) the server rejects it for missing/wrong Referer.
//      Fetching from the content script uses the page's natural Referer,
//      which the image host already accepts (the same image rendered fine
//      on the page).
//   4. Own the configurable "start region selection" keyboard shortcut and
//      keep its cached config in sync through chrome.storage.onChanged (the
//      overlay UI itself lives in selector.js / region.js).

(function () {
  // Chrome content scripts only expose `chrome.*`; Firefox exposes both.
  // Normalize to `browser.*` so the rest of the file is browser-agnostic.
  if (typeof globalThis.browser === "undefined") globalThis.browser = chrome;

  const PANEL_ID  = "__imgtr_selection_panel__";
  const ICON_ID   = "__imgtr_selection_icon__";

  const DEFAULTS = {
    targetLang: "en",
    showSelectionIcon: true,
    showRomaji: true
  };

  let lastAnchor = null;
  let panelSize = null;       // cached offsetWidth/offsetHeight, re-measured on content change
  let repositionRaf = 0;      // scroll fires faster than paint: coalesce to one per frame
  let pendingIcon = null;     // setTimeout handle, while waiting to show icon
  let selectionTimer = 0;     // P3-29: selectionchange debounce handle
  let iconClickedText = "";   // captured at icon-creation time

  // selector.js paints a full-screen region-selection overlay; while it is
  // active it must win over the little text-selection icon.
  function isRegionSelecting() {
    const sel = globalThis.__IMGT_Selector;
    return !!(sel && typeof sel.isActive === "function" && sel.isActive());
  }

  // ---------------------------------------------------------------------------
  // Translate API — same shape as sienori/simple-translate.
  // ---------------------------------------------------------------------------
  // Prefer the engine configured in the options page (Gemini / DeepSeek /
  // Google). The direct Google endpoint is only a fallback for the case where
  // the background worker cannot be reached; an engine error is surfaced to
  // the panel instead of silently degrading to Google.
  async function translate(text, targetLang) {
    try {
      const res = await browser.runtime.sendMessage({
        action: "translateSelectionText",
        text,
        targetLang
      });
      if (res && res.ok) {
        return {
          translated: String(res.translated || ""),
          detectedSrc: res.detectedSrc || "auto",
          romaji: typeof res.romaji === "string" ? res.romaji : "",
          engine: res.engine || ""
        };
      }
      if (res && res.error) {
        const err = new Error(res.error);
        err.fromEngine = true;
        throw err;
      }
    } catch (e) {
      if (e && e.fromEngine) throw e;
      console.warn("[imgtr] background translate unavailable, using direct Google:", e && e.message);
    }

    const url =
      "https://translate.googleapis.com/translate_a/single" +
      `?client=gtx&sl=auto&tl=${encodeURIComponent(targetLang)}` +
      `&dt=t&dj=1&q=${encodeURIComponent(text)}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    return {
      translated: (data.sentences || []).map(s => s.trans || "").join(""),
      detectedSrc: data.src || "auto",
      romaji: "",
      engine: "google"
    };
  }

  // ---------------------------------------------------------------------------
  // Romaji (options page → showRomaji, default on)
  // ---------------------------------------------------------------------------
  let showRomajiEnabled = true;

  async function loadShowRomaji() {
    try {
      const data = await browser.storage.local.get(DEFAULTS);
      showRomajiEnabled = data.showRomaji !== false;
    } catch (_) { /* keep default */ }
  }

  function renderRomaji(el, value) {
    if (!el) return;
    const text = typeof value === "string" ? value.trim() : "";
    if (!showRomajiEnabled || !text) {
      el.textContent = "";
      el.hidden = true;
      return;
    }
    el.textContent = text;
    el.hidden = false;
  }

  // P2-24: cached romaji of the open panel, so flipping showRomaji at runtime
  // re-renders it immediately instead of waiting for a page reload.
  let lastPanelRomaji = "";

  function syncRomajiOnOpenPanel() {
    const el = document.querySelector("#" + PANEL_ID + " .imgtr-panel-romaji");
    if (el) renderRomaji(el, lastPanelRomaji);
  }

  // ---------------------------------------------------------------------------
  // Inline panel
  // ---------------------------------------------------------------------------
  function removePanel() {
    if (repositionRaf) {
      cancelAnimationFrame(repositionRaf);
      repositionRaf = 0;
    }
    panelSize = null;
    if (selectionTimer) { clearTimeout(selectionTimer); selectionTimer = 0; }
    const old = document.getElementById(PANEL_ID);
    if (old) old.remove();
    document.removeEventListener("mousedown", outsideClickHandler, true);
    window.removeEventListener("scroll", repositionHandler, true);
    window.removeEventListener("resize", repositionHandler);
  }

  function outsideClickHandler(e) {
    const panel = document.getElementById(PANEL_ID);
    if (panel && !panel.contains(e.target)) removePanel();
  }

  function repositionHandler(event) {
    if (event && event.type === "resize") panelSize = null;
    if (repositionRaf) return;
    repositionRaf = requestAnimationFrame(() => {
      repositionRaf = 0;
      const panel = document.getElementById(PANEL_ID);
      if (panel && lastAnchor) positionPanel(panel, lastAnchor);
    });
  }

  function positionPanel(panel, anchor) {
    const margin = 6;
    // offsetWidth/offsetHeight force a synchronous layout; after the first
    // measure the panel size only changes when its content does.
    if (!panelSize) panelSize = { w: panel.offsetWidth, h: panel.offsetHeight };
    const pw = panelSize.w;
    const ph = panelSize.h;
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    // P3-26: the panel is position:fixed, so it takes client coordinates.
    // Re-derive them from the page-space anchor captured at open time: the scroll
    // delta keeps the panel glued to the text (an absolute panel did that for
    // free), while point+scroll with position:absolute drifted on host pages
    // whose body has a transform/filter (those establish a containing block).
    const dx = window.scrollX - (anchor.scrollX || 0);
    const dy = window.scrollY - (anchor.scrollY || 0);
    const aLeft = anchor.left - dx;
    const aTop = anchor.top - dy;
    const aBottom = anchor.bottom - dy;

    let left = aLeft;
    let top  = aBottom + margin;

    if (top + ph > vh - 4 && aTop - margin - ph > 4) {
      top = aTop - margin - ph;
    }
    if (left + pw > vw - 4) left = vw - pw - 4;
    if (left < 4) left = 4;

    panel.style.left = left + "px";
    panel.style.top  = top + "px";
  }

  function buildPanel(text, targetLang) {
    removePanel();

    const panel = document.createElement("div");
    panel.id = PANEL_ID;
    panel.className = "imgtr-panel";

    const header = document.createElement("div");
    header.className = "imgtr-panel-header";
    const title = document.createElement("span");
    title.className = "imgtr-panel-title";
    title.textContent = `→ ${targetLang}`;
    const closeBtn = document.createElement("button");
    closeBtn.className = "imgtr-panel-close";
    closeBtn.type = "button";
    closeBtn.setAttribute("aria-label", "Close");
    closeBtn.textContent = "×";
    closeBtn.addEventListener("click", removePanel);
    header.append(title, closeBtn);

    const orig = document.createElement("div");
    orig.className = "imgtr-panel-orig";
    orig.textContent = text;

    const romaji = document.createElement("div");
    romaji.className = "imgtr-panel-romaji";
    romaji.hidden = true;

    const result = document.createElement("div");
    result.className = "imgtr-panel-result";
    result.textContent = "Translating…";

    panel.append(header, orig, romaji, result);
    document.body.appendChild(panel);

    panel.addEventListener("mousedown", e => e.stopPropagation());
    return { panel, result, romaji };
  }

  // Position panel near `anchor` (DOMRect). If anchor is null, center it.
  async function showPanel(text, targetLang, anchor) {
    if (!anchor) {
      anchor = {
        left: window.innerWidth / 2 - 100,
        top:  window.innerHeight / 2,
        right: window.innerWidth / 2 + 100,
        bottom: window.innerHeight / 2,
        width: 200, height: 0,
        // Same page-space contract as selectionAnchor(): keep the centering
        // stable under scroll instead of drifting by one scroll offset.
        scrollX: window.scrollX, scrollY: window.scrollY
      };
    }
    lastAnchor = anchor;
    const { panel, result, romaji: romajiEl } = buildPanel(text, targetLang);
    positionPanel(panel, anchor);

    // P2-22: register the interaction listeners BEFORE awaiting the network
    // round trip. While "Translating…" is shown the panel must already be
    // dismissible and follow scroll/resize; awaiting first left it inert, and
    // a panel closed during the await then got listeners attached to a
    // detached node.
    document.addEventListener("mousedown", outsideClickHandler, true);
    window.addEventListener("scroll", repositionHandler, true);
    window.addEventListener("resize", repositionHandler);

    try {
      const { translated, detectedSrc, romaji } = await translate(text, targetLang);
      if (!panel.isConnected) return; // closed while the request was in flight
      result.textContent = translated || "(no translation)";
      lastPanelRomaji = romaji;
      renderRomaji(romajiEl, romaji);
      const titleEl = panel.querySelector(".imgtr-panel-title");
      if (titleEl) titleEl.textContent = `${detectedSrc} → ${targetLang}`;
    } catch (e) {
      if (!panel.isConnected) return; // closed while the request was in flight
      result.textContent = "Error: " + e.message;
      result.classList.add("imgtr-error");
    }
    if (!panel.isConnected) return; // closed while the request was in flight
    // The result text changed the panel height: measure once, then reuse.
    panelSize = null;
    positionPanel(panel, anchor);
  }

  // ---------------------------------------------------------------------------
  // Selection icon
  // ---------------------------------------------------------------------------

  function removeIcon() {
    if (pendingIcon) { clearTimeout(pendingIcon); pendingIcon = null; }
    window.removeEventListener("scroll", removeIcon);
    const old = document.getElementById(ICON_ID);
    if (old) old.remove();
  }

  // Position icon at the bottom-right of the *last line* of the selection
  // (so it sits at the natural "end" rather than middle for multi-line).
  function getEndOfSelectionPoint(sel) {
    if (!sel.rangeCount) return null;
    const range = sel.getRangeAt(0);
    const rects = range.getClientRects();
    if (!rects || rects.length === 0) {
      const r = range.getBoundingClientRect();
      if (!r || (r.width === 0 && r.height === 0)) return null;
      return { x: r.right, y: r.bottom };
    }
    const last = rects[rects.length - 1];
    return { x: last.right, y: last.bottom };
  }

  // P3-26: the viewport rect of the current selection plus the scroll offsets it
  // was captured at. positionPanel turns it back into client coordinates on every
  // reposition frame, which keeps the fixed panel glued to the text while
  // scrolling (the pre-fix absolute panel followed scroll for free).
  function selectionAnchor() {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
    const r = sel.getRangeAt(0).getBoundingClientRect();
    if (!r || (r.width === 0 && r.height === 0)) return null;
    return {
      left: r.left, top: r.top, bottom: r.bottom, right: r.right,
      scrollX: window.scrollX, scrollY: window.scrollY
    };
  }

  function showIcon(text, point) {
    removeIcon();
    const icon = document.createElement("div");
    icon.id = ICON_ID;
    // P3-23: no stylesheet ever targeted .imgtr-selection-icon (all styling is
    // by id), so the class was dropped instead of adding a dead CSS rule.
    icon.setAttribute("role", "button");
    // P3-24: div[role=button] is not keyboard-activatable without a tabindex.
    icon.setAttribute("tabindex", "0");
    icon.setAttribute("aria-label", "Translate selection");
    icon.title = "Translate selection";

    // Translation glyph (SVG). Inlined so host page CSS can't restyle it.
    icon.innerHTML =
      '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor"' +
      ' stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<path d="M5 8h7M5 4h11M9 4v4M5 14c0 0 2-3 5-3s4 2 5 4 1 4 1 4M11 14h6"/>' +
      '<path d="M16 14l4 8M20 14l-4 8"/>' +
      '</svg>';

    // P3-26: the icon is position:fixed too, so it takes client coordinates.
    icon.style.left = (point.x + 4) + "px";
    icon.style.top  = (point.y + 2) + "px";

    iconClickedText = text;

    async function activateIcon() {
      // P3-25: after an extension reload storage/sendMessage can throw; a plain
      // click must never surface as an unhandled rejection.
      let settings = null;
      try {
        settings = await browser.storage.local.get(DEFAULTS);
      } catch (e) {
        console.warn("[imgtr] storage read failed, assuming defaults:", e && e.message);
      }
      const targetLang = (settings && settings.targetLang) || "en";

      // Snapshot anchor before dismissing the icon (client coordinates, the
      // same space the position:fixed panel uses).
      const anchor = selectionAnchor();
      removeIcon();
      try {
        await showPanel(iconClickedText, targetLang, anchor);
      } catch (e) {
        console.warn("[imgtr] showPanel failed:", e && e.message);
      }
    }

    icon.addEventListener("mousedown", e => {
      // Don't lose the page selection or trigger outside-click teardown.
      e.preventDefault();
      e.stopPropagation();
    });
    icon.addEventListener("click", (e) => {
      e.stopPropagation();
      activateIcon();
    });
    // P3-24: Enter / Space activate the role=button widget.
    icon.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      e.preventDefault();
      e.stopPropagation();
      activateIcon();
    });

    // The fixed-position icon would detach from the text on scroll; it is
    // transient, so scrolling dismisses it (listener removed in removeIcon).
    window.addEventListener("scroll", removeIcon, { passive: true });
    document.body.appendChild(icon);
  }

  // mouseup: schedule icon if there's a non-trivial selection.
  document.addEventListener("mouseup", async (e) => {
    if (e.target && e.target.closest && (
      e.target.closest("#" + PANEL_ID) || e.target.closest("#" + ICON_ID)
    )) return;

    // Don't let the region-selection overlay spawn the text-selection icon.
    if (isRegionSelecting()) return;

    if (pendingIcon) { clearTimeout(pendingIcon); pendingIcon = null; }

    // Small delay: lets the browser finalize the selection, and avoids
    // flicker on quick double-click word selection.
    pendingIcon = setTimeout(async () => {
      pendingIcon = null;

      // P2-23: cheap synchronous gate first — most mouseups carry no meaningful
      // selection, so do not pay a storage IPC for every click.
      const preSel = window.getSelection();
      const preText = preSel ? preSel.toString().trim() : "";
      if (!preText || preText.length < 2) {
        removeIcon();
        return;
      }

      let settings = null;
      try {
        settings = await browser.storage.local.get(DEFAULTS);
      } catch (e) {
        console.warn("[imgtr] storage read failed, assuming defaults:", e && e.message);
      }
      if (settings && settings.showSelectionIcon === false) return;

      // Re-read after the await: the selection may have changed meanwhile.
      const sel = window.getSelection();
      const text = sel ? sel.toString().trim() : "";
      if (!text || text.length < 2) {
        removeIcon();
        return;
      }
      const point = getEndOfSelectionPoint(sel);
      if (!point) { removeIcon(); return; }
      showIcon(text, point);
    }, 250);
  });

  // mousedown elsewhere → dismiss icon (and panel via outsideClickHandler).
  document.addEventListener("mousedown", (e) => {
    const t = e.target;
    if (t && t.closest && (t.closest("#" + ICON_ID) || t.closest("#" + PANEL_ID))) return;
    removeIcon();
  });

  // Selection going away (Esc key, programmatic) → tear down the icon.
  document.addEventListener("selectionchange", () => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) {
      // P3-29: selectionchange fires in bursts; keep the handle so a pending
      // teardown cannot kill an icon that was just re-created, and clear it
      // when the panel closes (removePanel).
      if (selectionTimer) clearTimeout(selectionTimer);
      selectionTimer = setTimeout(() => {
        selectionTimer = 0;
        const s = window.getSelection();
        if (!s || s.isCollapsed) removeIcon();
      }, 50);
    }
  });

  // ---------------------------------------------------------------------------
  // Background → content messages
  // ---------------------------------------------------------------------------

  // ---------------------------------------------------------------------------
  // Image extraction
  // ---------------------------------------------------------------------------

  // Strategy 1: read bytes from the loaded <img> via canvas. No network call.
  // Works for same-origin images and CORS-enabled cross-origin images.
  // Fails (returns null) if the canvas is tainted (cross-origin without CORS),
  // which is exactly the case for hotlink-protected hosts (pixiv, gelbooru).
  // P3-30: compare candidates by URL pathname (origin + pathname) instead of
  // by raw string, so CDN query variants ("?w=800", cache timestamps) and
  // percent-encoding differences are handled consistently.
  function pathKey(raw) {
    try {
      const u = new URL(String(raw || ""), location.href);
      return u.origin + u.pathname;
    } catch (_) {
      return String(raw || "").split("?")[0].split("#")[0];
    }
  }

  function tryCanvasExtraction(url) {
    // Find the matching <img>. Try a direct src/currentSrc match first, then a
    // relaxed pathname match (some CDNs append differing query strings).
    const candidates = document.querySelectorAll("img");
    let target = null;
    for (const img of candidates) {
      if (img.src === url || img.currentSrc === url) { target = img; break; }
    }
    if (!target) {
      const baseKey = pathKey(url);
      let bestWidth = 0;
      // Among several same-path images prefer the largest, not the first in DOM
      // order: the first one may be a thumbnail of the same path.
      for (const img of candidates) {
        if (pathKey(img.currentSrc || img.src) !== baseKey) continue;
        const w = img.naturalWidth || 0;
        if (!target || w > bestWidth) { target = img; bestWidth = w; }
      }
    }
    if (!target) return null;
    if (!target.complete || target.naturalWidth === 0) return null;

    try {
      const canvas = document.createElement("canvas");
      canvas.width = target.naturalWidth;
      canvas.height = target.naturalHeight;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(target, 0, 0);

      // toDataURL throws SecurityError if canvas is tainted. Try it first
      // (synchronous and lets us fail fast without an async toBlob roundtrip).
      const dataUrl = canvas.toDataURL("image/png");
      // dataUrl is "data:image/png;base64,XXXX"
      const commaIdx = dataUrl.indexOf(",");
      if (commaIdx === -1) return null;
      const base64 = dataUrl.slice(commaIdx + 1);
      return {
        ok: true,
        base64,
        mime: "image/png",
        method: "canvas"
      };
    } catch (e) {
      // SecurityError → tainted canvas. Cross-origin without CORS.
      console.log("[imgtr] Canvas extraction failed (likely tainted):", e.message);
      return null;
    }
  }

  // Strategy 2: ask the background to fetch with Referer injection. Background
  // is in extension origin (cross-origin reads OK with host_permissions) and
  // uses webRequest.onBeforeSendHeaders to set the Referer header — which
  // fetch() itself isn't allowed to set (it's a forbidden header).
  async function tryBackgroundFetch(url) {
    try {
      const resp = await browser.runtime.sendMessage({
        action: "fetchImageWithReferer",
        url,
        referer: location.href
      });
      return resp || { ok: false, error: "no response from background" };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  // ---------------------------------------------------------------------------
  // Keyboard shortcut for region selection.
  //
  // Stored config: { shortcut: { enabled, alt, ctrl, shift, key } }.
  // It is cached in memory and kept in sync through storage.onChanged, because
  // keydown must decide synchronously whether to preventDefault (storage.get is
  // async). The cache is always derived from chrome.storage.local.
  // ---------------------------------------------------------------------------
  const DEFAULT_SHORTCUT = { enabled: true, alt: true, ctrl: false, shift: false, key: "t" };

  let currentShortcut = { ...DEFAULT_SHORTCUT };
  let shortcutReady = false;

  // NOTE (P2-30): this is a hand-synced copy of the normalizer in options.js
  // and background.js. A shared module would need manifest/HTML changes, so the
  // rules below must stay identical in all three copies.
  function normalizeShortcut(raw) {
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

  async function loadShortcutConfig() {
    try {
      const data = await browser.storage.local.get({ shortcut: DEFAULT_SHORTCUT });
      currentShortcut = normalizeShortcut(data.shortcut);
    } catch (_) { /* keep defaults */ }
    shortcutReady = true;
  }

  browser.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes.shortcut) {
      currentShortcut = normalizeShortcut(changes.shortcut.newValue);
      shortcutReady = true;
    }
    // P2-24: the options page flips showRomaji at runtime; update the cached
    // flag and any open panel here instead of only reading it once at startup.
    if (changes.showRomaji) {
      showRomajiEnabled = changes.showRomaji.newValue !== false;
      syncRomajiOnOpenPanel();
    }
  });

  function isEditableFocus() {
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

  function isModifierOnly(key) {
    return ["Alt", "Control", "Shift", "Meta", "OS"].includes(key);
  }

  function matchesShortcut(e, s) {
    // Core guard 2: disabled in options → never match.
    if (!s.enabled) return false;
    if (isModifierOnly(e.key)) return false;
    if ((e.key || "").toLowerCase() !== s.key) return false;
    if (!!e.altKey !== !!s.alt) return false;
    if (!!e.ctrlKey !== !!s.ctrl) return false;
    if (!!e.shiftKey !== !!s.shift) return false;
    if (e.metaKey) return false;
    return true;
  }

  function startRegionFromPage() {
    const selector = globalThis.__IMGT_Selector;
    if (selector && typeof selector.isActive === "function" && selector.isActive()) return;

    const region = globalThis.__IMGT_Region;
    if (region && typeof region.start === "function") {
      browser.storage.local.get(DEFAULTS).then((settings) => {
        region.start(settings.targetLang || "en");
      }).catch(() => region.start());
      return;
    }

    // Very old tab where region.js wasn't injected yet: let background inject.
    browser.runtime.sendMessage({ action: "startRegionShortcut" }).catch(() => {});
  }

  function onRegionShortcutKey(e) {
    if (e.repeat) return;
    if (!shortcutReady) return;              // config not loaded yet
    // Core guard 1: never trigger while typing.
    if (isEditableFocus()) return;
    if (!matchesShortcut(e, currentShortcut)) return;
    if (globalThis.__IMGT_Selector &&
        typeof globalThis.__IMGT_Selector.isActive === "function" &&
        globalThis.__IMGT_Selector.isActive()) return;

    e.preventDefault();
    e.stopPropagation();
    startRegionFromPage();
  }

  if (!globalThis.__IMGT_ShortcutOwned) {
    globalThis.__IMGT_ShortcutOwned = true;
    window.addEventListener("keydown", onRegionShortcutKey, true);
  }
  loadShortcutConfig();
  loadShowRomaji();

  // ---------------------------------------------------------------------------
  // Runtime messages
  // ---------------------------------------------------------------------------

  browser.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg) return;

    if (msg.action === "showTranslation") {
      const { text, targetLang } = msg;
      const anchor = selectionAnchor();
      removeIcon();
      showPanel(text, targetLang, anchor);
      return; // No response needed
    }

    if (msg.action === "fetchImage" && msg.url) {
      // sendResponse + return true works on every Chrome version (returning a
      // Promise only works on Chrome 122+).
      (async () => {
        // Strategy 1: canvas extraction (uses already-loaded bytes)
        const fromCanvas = tryCanvasExtraction(msg.url);
        if (fromCanvas) {
          sendResponse(fromCanvas);
          return;
        }
        // Strategy 2: background fetch with Referer injection
        sendResponse(await tryBackgroundFetch(msg.url));
      })().catch((e) => {
        // P2-25: always answer the popup, and swallow the rejection when the
        // message port is already gone (popup closed mid-request).
        try {
          sendResponse({ ok: false, error: (e && e.message) || String(e) });
        } catch (_) { /* channel already closed */ }
      });
      return true;
    }
  });
})();
