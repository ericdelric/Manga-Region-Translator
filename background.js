// background.js — context menu, Referer injection, image fetcher, and the
// new "translate a region" pipeline (tab capture + Google Lens OCR +
// translation).
//
// Responsibilities:
//   1. Route the right-click "Translate" menu item to the right place
//      (unchanged: image → popup window, selection text → content script).
//   2. When the content script can't extract image bytes from the page DOM
//      (canvas tainted by cross-origin without CORS — pixiv, gelbooru, etc.)
//      fetch the image here in the background. Background fetches have
//      cross-origin read access via host_permissions=<all_urls>, AND we
//      inject the right Referer header so hotlink-protected hosts don't
//      reject us. That bypasses hotlink protection without the CORS issues
//      that come with content-script fetches.
//   3. NEW: toolbar click / Alt+Shift+T / context-menu item asks the content
//      script to start a drag-selection; content captures the visible tab and
//      sends the cropped Base64 here. We run the ORIGINAL Google Lens call
//      (lens-bundle.js, same scanByData API the popup uses) on that cropped
//      image, group the OCR lines, and translate them with the original
//      translate.googleapis.com endpoint. The content script then paints the
//      hover-to-reveal boxes over the selected area.
//
// Runs as a service worker in Chrome and an event page in Firefox. Both
// allow this file to be loaded the same way; manifest.json differs.

// Chrome exposes the extension API as `chrome.*`; Firefox exposes both
// `browser.*` and `chrome.*`. Normalize to `browser.*` everywhere so the
// same code runs on both.
if (typeof globalThis.browser === "undefined") globalThis.browser = chrome;

// ---------------------------------------------------------------------------
// Google Lens OCR engine
// ---------------------------------------------------------------------------
//
// lens-bundle.js is the same bundle popup.js uses. It is an IIFE that ends
// with `window.LensCore = ...`; service workers have no `window`, so alias it
// for the duration of the import. importScripts() must run at top level, so
// this happens when the worker boots; the parse cost is a few ms.
let LensCoreClass = null;
(function loadLensBundle() {
  try {
    // Chrome's service worker has no `window`; Firefox's background page does.
    const hadWindow = typeof self.window !== "undefined";
    if (!hadWindow) self.window = self;
    try {
      importScripts("lens-bundle.js");
    } finally {
      if (!hadWindow) {
        try { delete self.window; } catch (_) { /* ignore */ }
      }
    }
    LensCoreClass = self.LensCore || null;
    if (LensCoreClass) {
      console.log("[imgtr] Google Lens OCR engine loaded");
    } else {
      console.error("[imgtr] lens-bundle.js loaded but window.LensCore is missing");
    }
  } catch (e) {
    console.error("[imgtr] failed to load lens-bundle.js:", e);
  }
})();

// ---------------------------------------------------------------------------
// Context menu
// ---------------------------------------------------------------------------

function createContextMenus() {
  // Two independent FIRST-LEVEL context-menu items. No parentId at all.
  //   - 全图翻译: image only (needs info.srcUrl).
  //   - 框选翻译: all contexts (works on text / UI / blank page too).
  // Some browsers group extension menu items under the extension name; that
  // grouping is browser UI, not something contextMenus.create can override.
  const createAll = () => {
    const items = [
      {
        id: "translate",
        title: "全图翻译",
        contexts: ["image"]
      },
      {
        id: "translateRegion",
        title: "框选翻译",
        contexts: ["all"]
      },
      {
        id: FP_MENU_ID,
        title: "火力全开模式 (仅 ComicRead)",
        contexts: ["all"],
        visible: false
      }
    ];
    for (const item of items) {
      try {
        browser.contextMenus.create(item, () => {
          void browser.runtime.lastError;
        });
      } catch (e) {
        console.warn("[imgtr] contextMenus.create failed:", e.message);
      }
    }
  };

  // Clear every stale menu item first (including any old parent/child entries)
  // so the extension contributes exactly these two flat items.
  try {
    browser.contextMenus.removeAll(() => {
      // removeAll can fail on a reload while the old instance still owns items;
      // the create loop must run anyway.
      void browser.runtime.lastError;
      createAll();
    });
  } catch (e) {
    createAll();
  }
}

browser.runtime.onInstalled.addListener(createContextMenus);
browser.runtime.onStartup.addListener(createContextMenus);

// ---------------------------------------------------------------------------
// Full Power Mode (ComicRead only) — step 1: tab state + image URL capture
// ---------------------------------------------------------------------------
//
// ComicRead renders everything inside a closed shadow root and hides the page
// scrollbar, so the content script cannot infer "which page is the reader on"
// from document order alone. Two things are cheap and reliable:
//   1) ComicRead prefetches the next few pages itself, so every page image
//      shows up as a network request we can observe (needs "webRequest").
//   2) The currently displayed <img> is reachable through chrome.dom, and its
//      position tells us which URL is on screen right now.
// This block keeps (1) per tab and tracks which tabs sit in reading mode so the
// context menu can be shown only there.
const FP_MENU_ID = "comicFullPower";
const FP_MAX_IMAGE_URLS = 400;

// Flip to true only while debugging: the gated logs print model output, OCR text
// and image sizes, which are user content and pure noise in a shipped build.
const FP_DEBUG = false;

const fpImageUrlsByTab = new Map(); // tabId -> string[] in request order
const fpImageUrlSetsByTab = new Map(); // tabId -> Set<string> mirror of the array
const fpComicReadTabs = new Set();  // tabId -> ComicRead reading mode is on
const fpBadgeTimers = new Map();    // tabId -> pending "!" badge restore timer

function fpRememberImageUrl(tabId, url) {
  let urls = fpImageUrlsByTab.get(tabId);
  let seen = fpImageUrlSetsByTab.get(tabId);
  if (!urls) {
    urls = [];
    fpImageUrlsByTab.set(tabId, urls);
  }
  if (!seen) {
    seen = new Set(urls);
    fpImageUrlSetsByTab.set(tabId, seen);
  }
  // Set lookup: webRequest fires once per image and the array holds up to 400.
  if (seen.has(url)) return;
  seen.add(url);
  urls.push(url);
  if (urls.length > FP_MAX_IMAGE_URLS) {
    const dropped = urls.shift();
    seen.delete(dropped);
  }
}

function fpForgetImageUrls(tabId) {
  fpImageUrlsByTab.delete(tabId);
  fpImageUrlSetsByTab.delete(tabId);
}

function fpSetMenuVisible(visible) {
  try {
    browser.contextMenus.update(FP_MENU_ID, { visible: !!visible }, () => {
      void browser.runtime.lastError;
    });
  } catch (_) { /* ignore */ }
}

async function fpSyncMenuVisibility() {
  try {
    const tabs = await browser.tabs.query({ active: true, currentWindow: true });
    const tab = tabs && tabs[0];
    fpSetMenuVisible(!!(tab && fpComicReadTabs.has(tab.id)));
  } catch (_) { /* ignore */ }
}

if (browser.webRequest && browser.webRequest.onBeforeRequest) {
  browser.webRequest.onBeforeRequest.addListener(
    (details) => {
      if (!details || details.tabId == null || details.tabId < 0) return;
      if (details.type === "main_frame") {
        fpForgetImageUrls(details.tabId);
        fpComicReadTabs.delete(details.tabId);
        void fpSyncMenuVisibility();
        return;
      }
      if (details.type !== "image") return;
      // Only reading-mode ComicRead tabs consume this list; recording every other
      // tab's images grew memory with no reader that could ever use it.
      if (!fpComicReadTabs.has(details.tabId)) return;
      const url = details.url || "";
      if (!/^https?:/i.test(url)) return;
      fpRememberImageUrl(details.tabId, url);
    },
    { urls: ["<all_urls>"] }
  );
}

if (browser.tabs && browser.tabs.onActivated) {
  browser.tabs.onActivated.addListener(() => { void fpSyncMenuVisibility(); });
}
if (browser.tabs && browser.tabs.onRemoved) {
  browser.tabs.onRemoved.addListener((tabId) => {
    fpForgetImageUrls(tabId);
    fpComicReadTabs.delete(tabId);
    // Full Power state is per tab too; without these the backlog and the URL
    // window leaked after the tab closed and could resurface on tab-id reuse.
    fpBacklog.delete(tabId);
    fpTabUrls.delete(tabId);
    fpStoppedTabs.delete(tabId);
    const badgeTimer = fpBadgeTimers.get(tabId);
    if (badgeTimer) {
      clearTimeout(badgeTimer);
      fpBadgeTimers.delete(tabId);
    }
  });
}

// Ask the content script of `tab` to paint the selection overlay. If the tab
// was already open when the extension was installed/reloaded, its content
// script may be missing or belong to the previous extension version — in that
// case inject selector.js + region.js and retry. This is what makes the
// toolbar icon work immediately on old tabs instead of silently doing nothing.
async function injectRegionScripts(tabId) {
  if (!browser.scripting || !browser.scripting.executeScript) {
    throw new Error("scripting API is unavailable");
  }
  await browser.scripting.executeScript({
    target: { tabId },
    files: ["selector.js", "region.js"]
  });
}

function flashBadge(tabId) {
  if (tabId == null) return;
  const clearPending = () => {
    const timer = fpBadgeTimers.get(tabId);
    if (timer) {
      clearTimeout(timer);
      fpBadgeTimers.delete(tabId);
    }
  };
  try {
    browser.action.setBadgeBackgroundColor({ color: "#d93025" });
    browser.action.getBadgeText({ tabId }, (previousText) => {
      void browser.runtime.lastError;
      // Remember what the badge showed so the flash restores it instead of
      // blanking a long-lived counter.
      const previous = previousText || "";
      clearPending();
      try {
        browser.action.setBadgeText({ tabId, text: "!" }, () => {
          void browser.runtime.lastError;
        });
      } catch (_) { /* ignore */ }
      const timer = setTimeout(() => {
        fpBadgeTimers.delete(tabId);
        try {
          browser.action.setBadgeText({ tabId, text: previous }, () => {
            void browser.runtime.lastError;
          });
        } catch (_) { /* ignore */ }
      }, 2500);
      fpBadgeTimers.set(tabId, timer);
    });
  } catch (_) { /* ignore */ }
}

async function openImagePopup(srcUrl, targetLang, tabId) {
  const popupUrl = browser.runtime.getURL("popup.html") +
    `?src=${encodeURIComponent(srcUrl)}` +
    `&tl=${encodeURIComponent(targetLang)}` +
    `&tab=${encodeURIComponent(tabId == null ? "" : tabId)}`;
  await browser.windows.create({
    url: popupUrl,
    type: "popup",
    width: 1100,
    height: 850
  });
}

async function startRegionSelection(tab) {
  if (!tab || tab.id == null) return;

  const settings = await browser.storage.local.get({ targetLang: "en" });
  const message = {
    action: "startRegionSelect",
    targetLang: settings.targetLang || "en"
  };

  // Fast path: a live content script answers with {ok:true}.
  try {
    const resp = await browser.tabs.sendMessage(tab.id, message);
    if (resp && resp.ok) return;
  } catch (e) {
    // No receiving end — fall through to injection.
  }

  // Slow path: inject what region selection needs, then retry.
  try {
    await injectRegionScripts(tab.id);
    const resp = await browser.tabs.sendMessage(tab.id, message);
    if (resp && resp.ok) return;
    throw new Error("region script did not acknowledge");
  } catch (e) {
    // Restricted page (chrome://, Web Store, file:// without access) or the
    // tab is gone. Give the user visible feedback instead of silence.
    console.warn("[imgtr] cannot start region selection on this tab:", e.message);
    flashBadge(tab.id);
  }
}

// Toolbar icon click, and the _execute_action keyboard shortcut (Alt+Shift+T),
// both land here.
if (browser.action && browser.action.onClicked) {
  // Subscribed exactly once at module scope: registering it from a handler (or
  // per click) is what stacks duplicate listeners in a service worker.
  browser.action.onClicked.addListener((tab) => {
    (async () => {
      let target = tab;
      if (!target) {
        try {
          const tabs = await browser.tabs.query({ active: true, currentWindow: true });
          target = tabs && tabs[0];
        } catch (_) { /* ignore */ }
      }
      await startRegionSelection(target);
    })().catch((e) => {
      console.warn("[imgtr] toolbar click failed:", (e && e.message) || e);
    });
  });
}

browser.contextMenus.onClicked.addListener((info, tab) => {
  // A non-async listener: one file-local async IIFE, so a rejected promise can
  // never surface as an unhandled rejection in the service worker.
  (async () => {
    // Full Power Mode: hand off to the content-side controller.
    if (info.menuItemId === FP_MENU_ID) {
      if (!(tab && tab.id != null)) return;
      try {
        await browser.tabs.sendMessage(tab.id, { action: "startFullPower" });
      } catch (e) {
        console.warn("[imgtr] full power hand-off failed:", e.message);
      }
      return;
    }

    // Menu item 2: 框选翻译 → drag overlay, no whole-image fallback.
    if (info.menuItemId === "translateRegion") {
      await startRegionSelection(tab);
      return;
    }

    // Menu item 1: 全图翻译 → the ORIGINAL behavior, untouched.
    if (info.menuItemId !== "translate") return;

    const targetLang = await fpGetTargetLangCached();

    if (info.mediaType === "image" && info.srcUrl) {
      if (!(tab && tab.id != null)) return;
      await openImagePopup(info.srcUrl, targetLang, tab.id);
      return;
    }

    if (info.selectionText && tab && tab.id) {
      try {
        await browser.tabs.sendMessage(tab.id, {
          action: "showTranslation",
          text: info.selectionText,
          targetLang
        });
      } catch (e) {
        const fallbackUrl = browser.runtime.getURL("popup.html") +
          `?text=${encodeURIComponent(info.selectionText)}&tl=${encodeURIComponent(targetLang)}`;
        await browser.windows.create({
          url: fallbackUrl,
          type: "popup",
          width: 480,
          height: 320
        });
      }
    }
  })().catch((e) => {
    console.warn("[imgtr] context menu click failed:", (e && e.message) || e);
  });
});

// ---------------------------------------------------------------------------
// Referer injection — per-browser implementation
// ---------------------------------------------------------------------------
//
// Chrome MV3 removed blocking webRequest, so on Chrome we use
// declarativeNetRequest session rules. Firefox keeps blocking webRequest
// AND its DNR implementation doesn't reliably apply modifyHeaders rules
// to extension-initiated fetches, so on Firefox we use the webRequest path
// which has always worked there.
//
// Each manifest declares only the permissions for its path; we branch on
// what's available rather than feature-detecting the API surface (which is
// the same shape in both browsers but works differently in practice).

// Detect by API availability rather than by manifest string: each browser
// only exposes the API surface it has permission for, and this survives a
// stale install where the manifest the extension is running with differs
// from the one in the source tree.
const fetchWithReferer = (() => {
  // Chrome (MV3) still exposes webRequest.onBeforeSendHeaders but refuses to
  // register blocking listeners unless the extension is force-installed, so
  // "the object exists" is NOT a usable test: it only produces a permission
  // error on the extensions page and a listener that never fires (which means
  // no Referer/UA gets injected). declarativeNetRequest is the working path
  // there, so it wins whenever session rules are available.
  const hasSessionRules = !!(
    browser.declarativeNetRequest && browser.declarativeNetRequest.updateSessionRules
  );
  if (hasSessionRules) {
    console.log("[imgtr] Referer injection path: declarativeNetRequest");
    return makeDeclarativeNetRequestFetcher();
  }
  if (browser.webRequest && browser.webRequest.onBeforeSendHeaders) {
    try {
      console.log("[imgtr] Referer injection path: webRequest (blocking)");
      return makeWebRequestFetcher();
    } catch (e) {
      console.warn(
        "[imgtr] Blocking webRequest rejected, fetches go out without a custom Referer:",
        e && e.message
      );
    }
  }
  console.error("[imgtr] No Referer-injection API available — fetches will go out without a custom Referer");
  return async (url, referer, signal) => fetch(url, { credentials: "include", signal });
})();

// ---- Firefox path: blocking webRequest -------------------------------------
//
// pendingReferers holds (URL → Referer to inject) entries set by
// fetchWithReferer before it issues fetch(). The blocking listener pops the
// entry when the request fires and rewrites the Referer header on the wire.
// The browser would normally refuse to let us set Referer through fetch's
// headers (it's a "forbidden header"), but webRequest blocking is allowed
// to mutate it.
function makeWebRequestFetcher() {
  const pendingReferers = new Map();

  browser.webRequest.onBeforeSendHeaders.addListener(
    (details) => {
      const pending = pendingReferers.get(details.url);
      const referer = pending && pending.referer;
      const cookie = pending && pending.cookie;
      if (cookie) {
        details.requestHeaders.push({ name: "Cookie", value: cookie });
      }
      if (referer === undefined) return; // Not one of our requests
      pendingReferers.delete(details.url);

      // Strip any existing Referer, then add ours (unless empty).
      const headers = (details.requestHeaders || [])
        .filter(h => h.name.toLowerCase() !== "referer" && h.name.toLowerCase() !== "user-agent");
      if (referer) headers.push({ name: "Referer", value: referer });
      // Comic image hosts also check the UA; present the browser's own so the
      // request does not look like an automated worker fetch.
      headers.push({ name: "User-Agent", value: navigator.userAgent });
      return { requestHeaders: headers };
    },
    { urls: ["<all_urls>"] },
    ["blocking", "requestHeaders"]
  );

  return async function fetchWithRefererWR(url, referer, signal) {
    const cookieHeader = await fpCookieHeaderFor(url);
    pendingReferers.set(url, referer || "");
    try {
      return await fetch(url, { credentials: "include", signal });
    } finally {
      pendingReferers.delete(url);
    }
  };
}

// ---- Chrome path: declarativeNetRequest session rules ---------------------
//
// Before each background fetch we register a per-request session rule that
// says "modify the Referer header on requests matching this URL"; once the
// fetch completes we remove the rule. Session rules persist only for the
// life of the browser session and don't hit disk, so this is the right
// bucket for ephemeral per-fetch rules. We scope rules to non-tab requests
// (tabIds: [-1]) so we don't accidentally rewrite a page's own image loads
// that happen to share the URL.
// Some galleries gate images behind a session cookie; the extension already
// holds the host permission, so hand the cookie over too when the API exists.
async function fpCookieHeaderFor(url) {
  try {
    if (!browser.cookies || typeof browser.cookies.getAll !== "function") return "";
    const cookies = await browser.cookies.getAll({ url });
    if (!cookies || !cookies.length) return "";
    return cookies.map((c) => c.name + "=" + c.value).join("; ");
  } catch (_) {
    return "";
  }
}

function makeDeclarativeNetRequestFetcher() {
  let nextRuleId = 1;
  const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  return async function fetchWithRefererDNR(url, referer, signal) {
    const ruleId = nextRuleId++;

    // Empty referer → strip the header rather than setting it to "".
    // DNR's `set` op requires a non-empty value, so we branch.
    const requestHeaders = referer
      ? [{ header: "referer", operation: "set", value: referer }]
      : [{ header: "referer", operation: "remove" }];
    requestHeaders.push({
      header: "user-agent",
      operation: "set",
      value: navigator.userAgent
    });
    const cookieHeader = await fpCookieHeaderFor(url);
    if (cookieHeader) {
      requestHeaders.push({ header: "cookie", operation: "set", value: cookieHeader });
    }

    const rule = {
      id: ruleId,
      priority: 1,
      condition: {
        // Anchor on the exact URL so concurrent fetches for different URLs
        // can't cross-trigger each other's rules.
        regexFilter: "^" + escapeRegex(url) + "$",
        tabIds: [-1],
        resourceTypes: ["xmlhttprequest"]
      },
      action: { type: "modifyHeaders", requestHeaders }
    };

    await browser.declarativeNetRequest.updateSessionRules({
      addRules: [rule]
    });

    try {
      return await fetch(url, { credentials: "include", signal });
    } finally {
      // Best-effort cleanup. If this throws, the rule will be reaped at
      // session end; not worth surfacing the error to the caller.
      try {
        await browser.declarativeNetRequest.updateSessionRules({
          removeRuleIds: [ruleId]
        });
      } catch (_) { /* ignore */ }
    }
  };
}

// ---------------------------------------------------------------------------
// Image fetch helper (called by content script as fallback)
// ---------------------------------------------------------------------------

function arrayBufferToBase64(buf) {
  const bytes = new Uint8Array(buf);
  const chunk = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function base64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function mimeFromUrl(url) {
  const m = url.toLowerCase().match(/\.(png|jpe?g|webp|gif|bmp|tiff)(?:\?|#|$)/);
  if (!m) return "image/jpeg";
  const ext = m[1] === "jpg" ? "jpeg" : m[1];
  return `image/${ext}`;
}

// ---------------------------------------------------------------------------
// OCR line grouping (same union-find heuristics as popup.js)
// ---------------------------------------------------------------------------
//
// Lens returns one segment per text line with a pixel bounding box. We merge
// lines that belong to the same paragraph / speech bubble so the translation
// gets the full sentence instead of each line in isolation.

function orientationOf(box) {
  if (box.height === 0) return "horizontal";
  const ar = box.width / box.height;
  if (ar > 1.3) return "horizontal";
  if (ar < 0.7) return "vertical";
  return "ambiguous";
}

function shouldGroup(a, b, tight) {
  const oa = orientationOf(a);
  const ob = orientationOf(b);
  if (oa !== "ambiguous" && ob !== "ambiguous" && oa !== ob) {
    // OCR sometimes reports a short fragment with the other reading direction
    // (a few glyphs of a vertical column come back as a horizontal line). Keep
    // them together when the two boxes are glued to each other.
    const gapX = Math.max(0, Math.max(a.x, b.x) - Math.min(a.x + a.width, b.x + b.width));
    const gapY = Math.max(0, Math.max(a.y, b.y) - Math.min(a.y + a.height, b.y + b.height));
    const scale = Math.min(Math.min(a.width, a.height), Math.min(b.width, b.height));
    return gapX <= 0.6 * scale && gapY <= 0.6 * scale;
  }
  const orient =
    (oa !== "ambiguous") ? oa :
    (ob !== "ambiguous") ? ob : "horizontal";

  if (orient === "horizontal") {
    // Lines stack vertically; check vertical gap and horizontal overlap.
    const avgH = (a.height + b.height) / 2;
    const aBottom = a.y + a.height, bBottom = b.y + b.height;
    const vGap = Math.max(0, Math.max(a.y, b.y) - Math.min(aBottom, bBottom));
    if (vGap > (tight ? 0.85 : 1.0) * avgH) return false;

    const hOverlap = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
    const minW = Math.min(a.width, b.width);
    // Lines of one bubble overlap horizontally; only very loose overlaps still
    // fall back to the "centres are close" rule, otherwise two bubbles that sit
    // next to each other get glued into one sentence.
    const centerXDiff = Math.abs((a.x + a.width / 2) - (b.x + b.width / 2));
    if (hOverlap >= (tight ? 0.5 : 0.3) * minW) return true;
    if (hOverlap >= 0.15 * minW && centerXDiff <= 0.5 * Math.max(a.width, b.width)) return true;
    return false;
  } else {
    // Vertical text — columns stack horizontally; mirror the logic.
    const avgW = (a.width + b.width) / 2;
    const aRight = a.x + a.width, bRight = b.x + b.width;
    const hGap = Math.max(0, Math.max(a.x, b.x) - Math.min(aRight, bRight));
    if (hGap > (tight ? 0.85 : 1.0) * avgW) return false;

    const vOverlap = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
    const minH = Math.min(a.height, b.height);
    const centerYDiff = Math.abs((a.y + a.height / 2) - (b.y + b.height / 2));
    if (vOverlap >= (tight ? 0.5 : 0.3) * minH) return true;
    if (vOverlap >= 0.15 * minH && centerYDiff <= 0.5 * Math.max(a.height, b.height)) return true;
    return false;
  }
}

function unionFindGroup(segments, tight) {
  const n = segments.length;
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (i) => {
    while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; }
    return i;
  };
  const union = (i, j) => {
    const pi = find(i), pj = find(j);
    if (pi !== pj) parent[pi] = pj;
  };

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (shouldGroup(segments[i].bbox, segments[j].bbox, tight)) union(i, j);
    }
  }

  const buckets = new Map();
  for (let i = 0; i < n; i++) {
    const root = find(i);
    if (!buckets.has(root)) buckets.set(root, []);
    buckets.get(root).push(segments[i]);
  }
  return Array.from(buckets.values());
}

// Determine an overall reading orientation for a group and order its members.
// For vertical text we order columns right-to-left (Japanese convention);
// horizontal text orders top-to-bottom, left-to-right within rows.
function orderGroupMembers(group) {
  let hCount = 0, vCount = 0;
  for (const s of group) {
    const o = orientationOf(s.bbox);
    if (o === "horizontal") hCount++;
    else if (o === "vertical") vCount++;
  }
  const orient = vCount > hCount ? "vertical" : "horizontal";

  if (orient === "vertical") {
    // Columns right-to-left, then top-to-bottom within each column. Since
    // each line is itself one column-segment here, just sort by x descending.
    group.sort((a, b) => {
      const ax = a.bbox.x, bx = b.bbox.x;
      if (Math.abs(ax - bx) > 8) return bx - ax;  // right first
      return a.bbox.y - b.bbox.y;
    });
  } else {
    // Top-to-bottom; within roughly-equal y, left-to-right.
    group.sort((a, b) => {
      const ay = a.bbox.y, by = b.bbox.y;
      if (Math.abs(ay - by) > 8) return ay - by;
      return a.bbox.x - b.bbox.x;
    });
  }
  return { orient, members: group };
}

function groupBoundingBox(group) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const s of group) {
    const c = s.bbox;
    if (c.x < minX) minX = c.x;
    if (c.y < minY) minY = c.y;
    if (c.x + c.width > maxX) maxX = c.x + c.width;
    if (c.y + c.height > maxY) maxY = c.y + c.height;
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

function groupSegments(segments, opts) {
  if (!segments.length) return [];
  const tight = !!(opts && opts.tight);
  const rawGroups = unionFindGroup(segments, tight);
  return rawGroups.map(rawGroup => {
    const { members } = orderGroupMembers(rawGroup);
    const bbox = groupBoundingBox(members);
    const text = members
      .map(m => m.text.trim())
      .filter(Boolean)
      .join(" ");
    return { bbox, text };
  }).filter(g => g.text);
}

// ---------------------------------------------------------------------------
// Translation (same endpoint and batching strategy as popup.js)
// ---------------------------------------------------------------------------

const SLEEP_BETWEEN_CALLS_MS = 200;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// The same Google Translate endpoint has multiple hostnames. When one is
// rate-limited (HTTP 429 "unusual traffic"), the other often still answers.
// We try both before giving up, and the full error object is logged so the
// real cause (429 vs network vs malformed crop) is never hidden again.
const TRANSLATE_ENDPOINTS = [
  "https://translate.googleapis.com/translate_a/single",
  "https://translate.google.com/translate_a/single"
];

function errorDetails(e) {
  if (!e) return String(e);
  let json = "";
  try { json = JSON.stringify(e); } catch (_) { json = String(e); }
  return (e.stack || e.message || String(e)) +
    (json && json !== "{}" ? "\njson=" + json : "");
}

// The public Google endpoints answer slowly or half-hang: without a deadline a
// stuck fetch kept the caller's message port open forever.
const FP_TRANSLATE_TIMEOUT_MS = 15000;
const FP_TRANSLATE_RETRY_DELAY_MS = 400;

async function fetchTranslate(query, label) {
  let lastError = null;
  for (const endpoint of TRANSLATE_ENDPOINTS) {
    const host = new URL(endpoint).host;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        const res = await fetchWithTimeout(endpoint + "?" + query, {}, FP_TRANSLATE_TIMEOUT_MS);
        if (!res.ok) {
          const body = await res.text().catch(() => "");
          const err = new Error(`${label} HTTP ${res.status} (${host})`);
          err.status = res.status;
          err.body = body.slice(0, 300);
          err.host = host;
          lastError = err;
          console.warn("[imgtr] translate endpoint failed:", errorDetails(err));
          if (attempt < 2) await sleep(FP_TRANSLATE_RETRY_DELAY_MS * attempt);
          continue;
        }
        const ct = res.headers.get("content-type") || "";
        if (!ct.includes("json")) {
          const body = await res.text().catch(() => "");
          const err = new Error(`${label} returned non-JSON from ${host}: ${body.slice(0, 160)}`);
          err.host = host;
          lastError = err;
          console.warn("[imgtr] translate endpoint failed:", errorDetails(err));
          if (attempt < 2) await sleep(FP_TRANSLATE_RETRY_DELAY_MS * attempt);
          continue;
        }
        return res;
      } catch (e) {
        e.host = host;
        lastError = e;
        console.warn("[imgtr] translate request error:", errorDetails(e));
        if (attempt < 2) await sleep(FP_TRANSLATE_RETRY_DELAY_MS * attempt);
      }
    }
  }
  throw lastError || new Error(`${label} failed`);
}

async function translateText(text, targetLang) {
  if (!text || !text.trim()) return { translated: "", detectedSrc: "" };
  const query =
    `client=gtx&sl=auto&tl=${encodeURIComponent(targetLang)}` +
    `&dt=t&dj=1&q=${encodeURIComponent(text)}`;
  const res = await fetchTranslate(query, "Translate");
  const data = await readJsonOrThrow(res, "Translate");
  return {
    translated: (data.sentences || []).map(s => s.trans || "").join(""),
    detectedSrc: data.src || "auto"
  };
}

// Batched translate: pack N inputs into one call separated by \n, then demux
// the response by tracking which sentence chunks end on a newline in their
// `orig` field. Throws if the demux count doesn't match — caller decides
// whether to fall back to per-group translation for that bucket.
async function translateBatch(texts, targetLang) {
  const joined = texts.join("\n");
  if (!joined.trim()) return texts.map(() => "");
  const query =
    `client=gtx&sl=auto&tl=${encodeURIComponent(targetLang)}` +
    `&dt=t&dj=1&q=${encodeURIComponent(joined)}`;
  const res = await fetchTranslate(query, "Translate batch");
  const data = await readJsonOrThrow(res, "Translate batch");
  const sentences = data.sentences || [];

  const out = [];
  let current = "";
  for (const s of sentences) {
    current += s.trans || "";
    if ((s.orig || "").endsWith("\n")) {
      out.push(current.replace(/\n+$/, ""));
      current = "";
    }
  }
  if (current) out.push(current);

  if (out.length !== texts.length) {
    throw new Error(`Batch demux mismatch: got ${out.length}, expected ${texts.length}`);
  }
  return out;
}

// Classify a string by its dominant Unicode script. CJK is split into
// korean/japanese/chinese because the CJK Unified Han block is shared
// across all three — without splitting we'd send Japanese and Chinese to
// the same auto-detected batch and one would be mistranslated.
function detectScript(text) {
  let hangul = 0, hiragana = 0, katakana = 0, han = 0;
  let latin = 0, cyrillic = 0, arabic = 0;
  let hebrew = 0, thai = 0, devanagari = 0, greek = 0;
  for (const ch of text) {
    const c = ch.codePointAt(0);
    if ((c >= 0xAC00 && c <= 0xD7AF) || (c >= 0x1100 && c <= 0x11FF))
      hangul++;
    else if (c >= 0x3040 && c <= 0x309F)
      hiragana++;
    else if (c >= 0x30A0 && c <= 0x30FF)
      katakana++;
    else if ((c >= 0x4E00 && c <= 0x9FFF) || (c >= 0x3400 && c <= 0x4DBF))
      han++;
    else if ((c >= 0x0041 && c <= 0x005A) ||
             (c >= 0x0061 && c <= 0x007A) ||
             (c >= 0x00C0 && c <= 0x024F))
      latin++;
    else if (c >= 0x0400 && c <= 0x04FF) cyrillic++;
    else if (c >= 0x0600 && c <= 0x06FF) arabic++;
    else if (c >= 0x0590 && c <= 0x05FF) hebrew++;
    else if (c >= 0x0E00 && c <= 0x0E7F) thai++;
    else if (c >= 0x0900 && c <= 0x097F) devanagari++;
    else if (c >= 0x0370 && c <= 0x03FF) greek++;
  }

  if (hangul > 0) return "korean";
  if (hiragana > 0 || katakana > 0) return "japanese";
  if (han > 0) return "chinese";

  const others = { latin, cyrillic, arabic, hebrew, thai, devanagari, greek };
  let best = "other", bestCount = 0;
  for (const [k, v] of Object.entries(others)) {
    if (v > bestCount) { best = k; bestCount = v; }
  }
  return bestCount === 0 ? "other" : best;
}

// Bucket groups by Unicode script so each bucket can be sent as one batched
// translate call. sl=auto picks one source language per call, which is
// correct as long as everything in the batch is the same script.
async function translateGroups(texts, targetLang) {
  const translations = new Array(texts.length).fill("");
  const meta = { error: null, rateLimited: false };
  if (!texts.length) return { translations, ...meta };

  const buckets = new Map();
  for (let i = 0; i < texts.length; i++) {
    const script = detectScript(texts[i]);
    if (!buckets.has(script)) buckets.set(script, []);
    buckets.get(script).push(i);
  }

  const bucketList = Array.from(buckets.entries());
  for (let b = 0; b < bucketList.length; b++) {
    const [, indices] = bucketList[b];
    const bucketTexts = indices.map(i => texts[i]);
    if (b > 0) await sleep(SLEEP_BETWEEN_CALLS_MS);

    try {
      const batchResult = await translateBatch(bucketTexts, targetLang);
      for (let k = 0; k < indices.length; k++) {
        translations[indices[k]] = batchResult[k] || "";
      }
    } catch (e) {
      // Batch failed (network error or demux mismatch — the API can
      // re-tokenize across our \n separators if it merges sentences).
      console.warn("[imgtr] batch translate failed:", errorDetails(e));
      meta.error = e;

      // 429/403 means Google is rate-limiting this machine. Retrying every
      // group immediately only makes the block worse, so report it instead.
      if (e && (e.status === 429 || e.status === 403)) {
        meta.rateLimited = true;
        continue;
      }

      // Fall back to per-group translation for this bucket.
      for (let k = 0; k < indices.length; k++) {
        if (k > 0) await sleep(SLEEP_BETWEEN_CALLS_MS);
        try {
          const r = await translateText(bucketTexts[k], targetLang);
          translations[indices[k]] = r.translated;
        } catch (e2) {
          console.error("Per-group fallback failed:", errorDetails(e2));
          meta.error = e2;
          if (e2 && (e2.status === 429 || e2.status === 403)) meta.rateLimited = true;
        }
      }
    }
  }
  return { translations, ...meta };
}

// ---------------------------------------------------------------------------
// LLM translation engines (Gemini / DeepSeek)
// ---------------------------------------------------------------------------

// Primary + fallback Gemini models. The primary can be changed here; the
// fallback list comes from Options (geminiFallbackModel), defaulting to the
// lite model.
const GEMINI_MODEL = "gemini-3.8-flash";
const DEFAULT_GEMINI_FALLBACK_MODEL = "gemini-3.5-flash-lite";
const GEMINI_MAX_ATTEMPTS = 4; // initial request + 3 retries
const DEEPSEEK_ENDPOINT = "https://api.deepseek.com/chat/completions";

function geminiEndpoint(model) {
  return `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
}

function retryDelayMs(attempt) {
  // 1s, 2s, 4s ... plus up to 400ms jitter so parallel retries don't align.
  return 1000 * Math.pow(2, attempt) + Math.floor(Math.random() * 400);
}

// A 429 can tell us to come back in hours ("Please retry in 14h53m22s" /
// `"retryDelay": "53602s"`). We never sleep that long: we read the hint only to
// decide that this model is out of quota and switch to the next one right away.
function parseRetryDelayMs(detail) {
  const text = String(detail || "");
  let m = text.match(/"retryDelay"\s*:\s*"?(\d+(?:\.\d+)?)s"?/i);
  if (m) return Math.round(Number(m[1]) * 1000);
  m = text.match(/retry in\s+(?:(\d+)h)?\s*(?:(\d+)m)?\s*(?:([\d.]+)s)?/i);
  if (m && (m[1] || m[2] || m[3])) {
    return Math.round(
      (Number(m[1] || 0) * 3600 + Number(m[2] || 0) * 60 + Number(m[3] || 0)) * 1000
    );
  }
  return 0;
}

function parseFallbackModels(raw) {
  const list = String(raw || "")
    .split(",")
    .map(s => s.trim())
    .filter(Boolean);
  // Always keep the default lite model available unless explicitly listed.
  if (!list.length) list.push(DEFAULT_GEMINI_FALLBACK_MODEL);
  const seen = new Set();
  const out = [];
  for (const model of list) {
    if (model === GEMINI_MODEL || seen.has(model)) continue;
    seen.add(model);
    out.push(model);
  }
  return out;
}

const LANGUAGE_NAMES = {
  en: "English",
  ru: "Russian",
  uk: "Ukrainian",
  es: "Spanish",
  fr: "French",
  de: "German",
  it: "Italian",
  pt: "Portuguese",
  nl: "Dutch",
  pl: "Polish",
  tr: "Turkish",
  ja: "日语",
  "zh-CN": "简体中文",
  "zh-TW": "繁體中文",
  ko: "韩语",
  ar: "Arabic",
  hi: "Hindi",
  he: "Hebrew",
  vi: "Vietnamese",
  th: "Thai"
};

function languageName(code) {
  return LANGUAGE_NAMES[code] || code || "English";
}

// Appended to every LLM prompt that can see Japanese text. Romaji is optional
// metadata: a wrong or missing romaji must never break the translation.
const ROMAJI_INSTRUCTION =
  "如果原文包含日文，请提供其标准的平文式罗马音（Hepburn romanization）；" +
  "如果原文不是日文，请将 romaji 字段留空。";

function geminiPrompt(targetLang) {
  return "请识别这张图片中的所有文本，并判断其源语言。" +
    `将文本翻译成【${languageName(targetLang)}】。` +
    "请严格以 JSON 数组格式返回，不要包含任何 Markdown 标记，格式为：" +
    '[{"original": "日文原文", "translation": "中文翻译", "romaji": "罗马音"}]。' +
    ROMAJI_INSTRUCTION;
}

function deepseekPrompt(targetLang, ocrText) {
  return "请识别以下文本的源语言，并将其翻译成" +
    `【${languageName(targetLang)}】。` +
    "请严格以 JSON 数组格式返回，不要包含任何 Markdown 标记，格式为：" +
    '[{"original": "日文原文", "translation": "中文翻译", "romaji": "罗马音"}]。' +
    ROMAJI_INSTRUCTION +
    "待翻译文本：" + ocrText;
}

// Full-page prompts: one request for the whole page, so the model can use
// cross-bubble context instead of translating line by line.
// Whole-page prompt: the OCR text array is the anchor. The model must return
// the same number of entries in the same order, each carrying its index.
function fullPageIndexedPrompt(targetLang, texts) {
  return "这是一组从漫画页面提取的原文数组：" + JSON.stringify(texts) + "。" +
    `请结合上下文将它们翻译成【${languageName(targetLang)}】。` +
    "请严格以 JSON 数组格式返回，确保返回的数组长度和顺序与输入完全一致：" +
    '[{"index": 0, "translation": "译文", "romaji": "罗马音"}]。' +
    ROMAJI_INSTRUCTION;
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs || 90000);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (e) {
    if (e && e.name === "AbortError") {
      throw new Error(`请求超时（${Math.round((timeoutMs || 90000) / 1000)}s）`);
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

async function readResponseText(res) {
  try { return await res.text(); } catch (_) { return ""; }
}

async function readJsonOrThrow(res, label) {
  const raw = await readResponseText(res);
  try {
    return JSON.parse(raw);
  } catch (e) {
    console.error(`[imgtr] ${label} returned non-JSON:`, raw.slice(0, 1500));
    throw new Error(`${label} 返回非 JSON：${raw.slice(0, 200)}`);
  }
}

// Strip ```json fences and any prose around the JSON, then parse.
function parseModelJsonArray(text) {
  let cleaned = String(text || "").trim().replace(/^\uFEFF/, "");
  cleaned = cleaned.replace(/```(?:json)?/gi, "").replace(/```/g, "").trim();

  const tryParse = (value) => {
    try { return JSON.parse(value); } catch (_) { return null; }
  };

  let parsed = tryParse(cleaned);
  if (!parsed) {
    const arrayMatch = cleaned.match(/\[[\s\S]*\]/);
    if (arrayMatch) parsed = tryParse(arrayMatch[0]);
  }
  if (!parsed) {
    const objectMatch = cleaned.match(/\{[\s\S]*\}/);
    if (objectMatch) parsed = tryParse(objectMatch[0]);
  }

  if (Array.isArray(parsed)) return parsed;
  if (parsed && Array.isArray(parsed.translations)) return parsed.translations;
  if (parsed && Array.isArray(parsed.result)) return parsed.result;
  if (parsed && Array.isArray(parsed.data)) return parsed.data;

  throw new Error("模型返回不是 JSON 数组：" + cleaned.slice(0, 300));
}

function normalizeLlmItems(rawItems) {
  const items = [];
  for (const item of rawItems) {
    if (!item || typeof item !== "object") continue;
    const original = item.original ?? item.source ?? item.text ?? item.src ?? "";
    const translation = item.translation ?? item.translated ?? item.target ?? item.result ?? "";
    if (typeof original !== "string" || typeof translation !== "string") continue;
    if (!original.trim() && !translation.trim()) continue;
    const romaji = item.romaji ?? item.roma ?? item.romanization ?? item.reading ?? "";
    items.push({
      original: original.trim(),
      translation: translation.trim(),
      romaji: typeof romaji === "string" ? romaji.trim() : ""
    });
  }
  return items;
}

// Whole-page mode returns [{index, translation}]. Map strictly by index so a
// translation can never be attached to the wrong OCR bounding box.
function parseIndexedTranslations(rawText, expectedCount) {
  const rawItems = parseModelJsonArray(rawText);
  const translations = new Array(expectedCount).fill("");
  const romajis = new Array(expectedCount).fill("");
  let filled = 0;

  const everyIndexed = rawItems.length > 0 && rawItems.every(item =>
    item && typeof item === "object" && Number.isFinite(Number(item.index))
  );

  if (everyIndexed) {
    for (const item of rawItems) {
      const index = Number(item.index);
      const translation = item.translation ?? item.translated ?? item.text ?? item.target ?? "";
      if (Number.isInteger(index) && index >= 0 && index < expectedCount &&
          typeof translation === "string" && translation.trim()) {
        translations[index] = translation.trim();
        romajis[index] = typeof item.romaji === "string" ? item.romaji.trim() : "";
        filled++;
      }
    }
  } else if (rawItems.length === expectedCount) {
    // Some models omit index; only accept order when the length matches.
    for (let i = 0; i < rawItems.length; i++) {
      const item = rawItems[i];
      const translation = item && typeof item === "object"
        ? (item.translation ?? item.translated ?? item.target ?? item.text ?? "")
        : (typeof item === "string" ? item : "");
      translations[i] = String(translation).trim();
      romajis[i] = item && typeof item === "object" && typeof item.romaji === "string"
        ? item.romaji.trim()
        : "";
      if (translations[i]) filled++;
    }
  }

  const countMismatch = rawItems.length !== expectedCount || filled !== expectedCount;
  if (countMismatch) {
    console.warn(
      `[imgtr] indexed translation mismatch: expected ${expectedCount}, received ${rawItems.length}, filled ${filled}; falling back to original text`
    );
  }
  return { translations, romajis, countMismatch };
}

function normalizeForLlmMatch(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[.,!?;:'"“”‘’()\[\]{}<>、。！？；：…—–\-]/g, "");
}

// Gemini/DeepSeek return only text (no bounding boxes), so we keep the Lens
// OCR groups for layout and map the LLM's original/translation pairs onto them.
function mapLlmItemsToGroups(groups, items, preferOrder) {
  // For a whole page the prompt guarantees one item per group in reading
  // order; use index mapping directly so duplicate lines can't cross-match.
  if (preferOrder && items.length === groups.length) {
    return {
      translations: items.map(item => item.translation || ""),
      romajis: items.map(item => item.romaji || "")
    };
  }

  const translations = new Array(groups.length).fill("");
  const romajis = new Array(groups.length).fill("");
  const used = new Set();

  for (let i = 0; i < groups.length; i++) {
    const groupText = normalizeForLlmMatch(groups[i].text);
    if (!groupText) continue;

    let idx = items.findIndex((item, j) =>
      !used.has(j) && normalizeForLlmMatch(item.original) === groupText
    );
    if (idx === -1) {
      idx = items.findIndex((item, j) => {
        if (used.has(j)) return false;
        const itemText = normalizeForLlmMatch(item.original);
        return !!itemText && (itemText.includes(groupText) || groupText.includes(itemText));
      });
    }
    if (idx !== -1) {
      used.add(idx);
      translations[i] = items[idx].translation || "";
      romajis[i] = items[idx].romaji || "";
    }
  }

  // If the counts match, fill the remaining groups by order (LLMs usually
  // preserve reading order).
  if (items.length === groups.length) {
    const missing = [];
    for (let i = 0; i < translations.length; i++) {
      if (!translations[i]) missing.push(i);
    }
    const unused = items.map((_, i) => i).filter(i => !used.has(i));
    if (missing.length === unused.length) {
      for (let k = 0; k < missing.length; k++) {
        translations[missing[k]] = items[unused[k]].translation || "";
        romajis[missing[k]] = items[unused[k]].romaji || "";
      }
    }
  }

  return { translations, romajis };
}

// storage.local is an IPC hop: the Full Power pipeline used to read it once per
// tick *and* once per page. Keep the last values for a few seconds and drop the
// cache as soon as anything writes storage.local (options page, popup).
const FP_SETTINGS_TTL_MS = 5000;
let fpTargetLangCache = { at: 0, value: "" };
let fpEngineConfigCache = { at: 0, value: null };

function fpInvalidateSettingsCache() {
  fpTargetLangCache = { at: 0, value: "" };
  fpEngineConfigCache = { at: 0, value: null };
}

if (browser.storage && browser.storage.onChanged) {
  browser.storage.onChanged.addListener((changes, area) => {
    if (area === "local") fpInvalidateSettingsCache();
  });
}

async function fpGetTargetLangCached() {
  if (fpTargetLangCache.value && Date.now() - fpTargetLangCache.at < FP_SETTINGS_TTL_MS) {
    return fpTargetLangCache.value;
  }
  const settings = await browser.storage.local.get({ targetLang: "en" });
  const value = (settings && settings.targetLang) || "en";
  fpTargetLangCache = { at: Date.now(), value };
  return value;
}

// Synchronous view for handlers that must not await (Full Power cache fast path).
function fpKnownTargetLang() {
  return fpTargetLangCache.value || "";
}

async function getTranslationEngineConfig() {
  if (fpEngineConfigCache.value && Date.now() - fpEngineConfigCache.at < FP_SETTINGS_TTL_MS) {
    return fpEngineConfigCache.value;
  }
  const stored = await browser.storage.local.get({
    engine: "google",
    geminiApiKey: "",
    deepseekApiKey: "",
    geminiFallbackModel: DEFAULT_GEMINI_FALLBACK_MODEL
  });
  const name = ["google", "gemini", "deepseek"].includes(stored.engine)
    ? stored.engine
    : "google";
  const config = {
    name,
    geminiApiKey: String(stored.geminiApiKey || "").trim(),
    deepseekApiKey: String(stored.deepseekApiKey || "").trim(),
    geminiFallbackModel: String(stored.geminiFallbackModel || DEFAULT_GEMINI_FALLBACK_MODEL).trim()
  };
  fpEngineConfigCache = { at: Date.now(), value: config };
  return config;
}

async function callGeminiModel(model, body, apiKey) {
  const res = await fetchWithTimeout(geminiEndpoint(model), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": apiKey
    },
    body: JSON.stringify(body)
  }, 90000);

  if (res.ok) {
    return await readJsonOrThrow(res, `Gemini(${model})`);
  }

  const detail = await readResponseText(res);
  const err = new Error(`Gemini HTTP ${res.status} (${model}): ${detail.slice(0, 300)}`);
  err.status = res.status;
  err.detail = detail;
  err.model = model;
  err.retryable = [429, 500, 502, 503, 504].includes(res.status);
  // Quota / overload: useless to retry the same model, switch immediately.
  err.quotaExhausted = res.status === 429 || /RESOURCE_EXHAUSTED|quota/i.test(detail);
  err.retryDelayMs = parseRetryDelayMs(detail);
  err.modelUnavailable = res.status === 404 ||
    /not found|no longer available|not available|not supported/i.test(detail);
  console.error(
    `[imgtr] Gemini request failed (model=${model}, HTTP ${res.status} ${res.statusText}):`,
    detail.slice(0, 1500)
  );
  throw err;
}

async function geminiTranslateWithPrompt(args) {
  const { groups, prompt, imageBase64, mime, apiKey, fallbackModel, label, preferOrder, parseResponse } = args;

  if (!apiKey) {
    const err = new Error("未配置 Gemini API Key（请在扩展选项里填写）");
    err.code = "MISSING_KEY";
    throw err;
  }

  const parts = [{ text: prompt }];
  if (imageBase64) {
    parts.push({
      inline_data: {
        mime_type: mime || "image/png",
        data: imageBase64
      }
    });
  }

  const body = {
    contents: [{ role: "user", parts }],
    generationConfig: {
      temperature: 0.1,
      responseMimeType: "application/json"
    }
  };

  const models = [GEMINI_MODEL, ...parseFallbackModels(fallbackModel)];
  let lastError = null;

  for (let modelIndex = 0; modelIndex < models.length; modelIndex++) {
    const model = models[modelIndex];

    for (let attempt = 0; attempt < GEMINI_MAX_ATTEMPTS; attempt++) {
      try {
        if (FP_DEBUG) {
          console.log(
            `[imgtr] ${label}: model=${model}, groups=${groups.length}, ` +
            `image=${imageBase64 ? imageBase64.length : 0} chars, ` +
            `attempt=${attempt + 1}/${GEMINI_MAX_ATTEMPTS}`
          );
        }
        const data = await callGeminiModel(model, body, apiKey);
        const parts = data?.candidates?.[0]?.content?.parts || [];
        const rawText = parts.map(p => p.text || "").join("\n").trim();

        if (!rawText) {
          const block = data?.promptFeedback?.blockReason;
          const emptyErr = new Error("Gemini 返回为空" + (block ? `（blockReason=${block}）` : "（可能被安全策略拦截）"));
          emptyErr.noRetry = true;
          throw emptyErr;
        }
        if (FP_DEBUG) console.log(`[imgtr] ${label} raw text (${model}):`, rawText.slice(0, 600));

        let translations;
        let countMismatch = false;
        let romajis = [];

        if (typeof parseResponse === "function") {
          const parsed = parseResponse(rawText, groups);
          translations = Array.isArray(parsed.translations) ? parsed.translations : [];
          romajis = Array.isArray(parsed.romajis) ? parsed.romajis : [];
          countMismatch = !!parsed.countMismatch;
          if (translations.length !== groups.length) {
            translations = new Array(groups.length).fill("");
            romajis = new Array(groups.length).fill("");
            countMismatch = true;
          }
          if (countMismatch) {
            console.warn(`[imgtr] ${label}: translation count mismatch, rendering original text fallback`);
          }
        } else {
          let items;
          try {
            items = normalizeLlmItems(parseModelJsonArray(rawText));
          } catch (parseErr) {
            console.error(
              `[imgtr] ${label} JSON parse failed (model=${model}):`,
              parseErr.message,
              "\nRAW:",
              rawText.slice(0, 1000)
            );
            const jsonErr = new Error("Gemini 返回的 JSON 无法解析");
            jsonErr.noRetry = true;
            throw jsonErr;
          }
          if (!items.length) {
            const emptyJsonErr = new Error("Gemini 返回的 JSON 数组为空");
            emptyJsonErr.noRetry = true;
            throw emptyJsonErr;
          }

          const mapped = mapLlmItemsToGroups(groups, items, preferOrder);
          translations = mapped.translations;
          romajis = mapped.romajis;
          const missing = translations.filter(t => !t).length;
          if (missing) {
            console.warn(`[imgtr] ${label}: ${missing}/${groups.length} group(s) had no matching translation`);
          }
          console.log(`[imgtr] ${label} ok: model=${model}, mapped ${items.length} item(s) onto ${groups.length} group(s)`);
        }

        return { translations, romajis, error: null, rateLimited: false, engine: "gemini", model, countMismatch };
      } catch (e) {
        lastError = e;

        if (e && e.code === "MISSING_KEY") throw e;
        if (e && (e.status === 400 || e.status === 401 || e.status === 403)) {
          // Invalid key / invalid request: retrying or switching models won't help.
          throw e;
        }

        // 429 = quota exhausted, 503 = overloaded. Google may answer with a
        // "retry in 14h..." hint; sleeping on it would freeze the extension for
        // hours, so we switch to the next model immediately instead.
        if (e && (e.quotaExhausted || e.status === 429 || e.status === 503)) {
          const waitHint = e.retryDelayMs > 60000
            ? `（Google 建议等待 ${Math.round(e.retryDelayMs / 3600000)} 小时，已跳过）`
            : "";
          console.warn(`[imgtr] 主模型 ${model} ${e.status} 限流，正在切换到备用模型...${waitHint}`);
          break;
        }

        if (e && (e.noRetry || e.modelUnavailable || e.status === 404)) {
          console.warn(`[imgtr] ${label} ${model} unusable, trying fallback model`);
          break;
        }

        if (!e || !e.retryable) {
          console.warn(`[imgtr] ${label} ${model} non-retryable error, trying fallback:`, e && e.message);
          break;
        }

        if (attempt >= GEMINI_MAX_ATTEMPTS - 1) {
          console.warn(
            `[imgtr] ${label} ${model} still failing after ${GEMINI_MAX_ATTEMPTS} attempt(s), trying fallback`
          );
          break;
        }

        const delay = retryDelayMs(attempt);
        console.warn(
          `[imgtr] ${label} ${model} HTTP ${e.status}, retry ${attempt + 1}/${GEMINI_MAX_ATTEMPTS - 1} in ${delay}ms`
        );
        await sleep(delay);
      }
    }

    if (modelIndex < models.length - 1) {
      console.warn(`[imgtr] switching ${label} model: ${model} → ${models[modelIndex + 1]}`);
    }
  }

  const quotaNote = lastError && (lastError.quotaExhausted || lastError.status === 429)
    ? "；额度已耗尽，可在选项里换用其它模型，或等待额度重置"
    : "";
  const message = "Gemini 服务繁忙，请稍后重试" +
    (lastError && lastError.status ? `（HTTP ${lastError.status}）` : "") +
    `；已尝试模型：${models.join("、")}` + quotaNote;
  console.error(
    `[imgtr] ${label} failed after all retries/fallbacks:`,
    message,
    lastError ? errorDetails(lastError) : ""
  );
  const finalErr = new Error(message);
  finalErr.code = "GEMINI_FAILED";
  throw finalErr;
}

async function translateWithGemini(groups, msg, targetLang, config) {
  return geminiTranslateWithPrompt({
    groups,
    prompt: geminiPrompt(targetLang),
    imageBase64: msg.base64,
    mime: msg.mime || "image/png",
    apiKey: config.geminiApiKey,
    fallbackModel: config.geminiFallbackModel,
    label: "Gemini",
    preferOrder: false
  });
}

async function translateFullImageWithGemini(groups, targetLang, config) {
  const texts = groups.map(g => g.text);
  return geminiTranslateWithPrompt({
    groups,
    prompt: fullPageIndexedPrompt(targetLang, texts),
    imageBase64: "",
    mime: "",
    apiKey: config.geminiApiKey,
    fallbackModel: config.geminiFallbackModel,
    label: "Gemini full image",
    preferOrder: false,
    parseResponse: (rawText, grps) => parseIndexedTranslations(rawText, grps.length)
  });
}

async function deepseekTranslateWithPrompt(args) {
  const { groups, promptText, text, apiKey, label, preferOrder, parseResponse } = args;

  if (!apiKey) {
    const err = new Error("未配置 DeepSeek API Key（请在扩展选项里填写）");
    err.code = "MISSING_KEY";
    throw err;
  }

  if (!String(text || "").trim()) {
    return { translations: groups.map(() => ""), error: null, rateLimited: false, engine: "deepseek" };
  }

  const body = {
    model: "deepseek-chat",
    messages: [
      {
        role: "system",
        content: "You are a precise translation engine. Return ONLY a JSON array, no Markdown fences, no explanations."
      },
      { role: "user", content: promptText }
    ],
    temperature: 0.1,
    stream: false
  };

  console.log(`[imgtr] ${label} request: groups=${groups.length}, text=${String(text).length} chars`);

  const res = await fetchWithTimeout(DEEPSEEK_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`
    },
    body: JSON.stringify(body)
  }, 90000);

  if (!res.ok) {
    const detail = await readResponseText(res);
    console.error(`[imgtr] ${label} HTTP ${res.status} ${res.statusText}:`, detail.slice(0, 1200));
    throw new Error(`DeepSeek HTTP ${res.status}: ${detail.slice(0, 200)}`);
  }

  const data = await readJsonOrThrow(res, label);
  const rawText = data?.choices?.[0]?.message?.content || "";
  if (!rawText.trim()) {
    console.error(`[imgtr] ${label} empty response:`, JSON.stringify(data).slice(0, 1200));
    throw new Error("DeepSeek 返回为空");
  }
  if (FP_DEBUG) console.log(`[imgtr] ${label} raw text:`, rawText.slice(0, 600));

  let translations;
  let countMismatch = false;
  let romajis = [];

  if (typeof parseResponse === "function") {
    const parsed = parseResponse(rawText, groups);
    translations = Array.isArray(parsed.translations) ? parsed.translations : [];
    romajis = Array.isArray(parsed.romajis) ? parsed.romajis : [];
    countMismatch = !!parsed.countMismatch;
    if (translations.length !== groups.length) {
      translations = new Array(groups.length).fill("");
      romajis = new Array(groups.length).fill("");
      countMismatch = true;
    }
    if (countMismatch) {
      console.warn(`[imgtr] ${label}: translation count mismatch, rendering original text fallback`);
    }
  } else {
    const items = normalizeLlmItems(parseModelJsonArray(rawText));
    if (!items.length) throw new Error("DeepSeek 返回的 JSON 数组为空");

    const mapped = mapLlmItemsToGroups(groups, items, preferOrder);
    translations = mapped.translations;
    romajis = mapped.romajis;
    const missing = translations.filter(t => !t).length;
    if (missing) {
      console.warn(`[imgtr] ${label}: ${missing}/${groups.length} group(s) had no matching translation`);
    }
    console.log(`[imgtr] ${label} mapped ${items.length} item(s) onto ${groups.length} group(s)`);
  }

  return { translations, romajis, error: null, rateLimited: false, engine: "deepseek", countMismatch };
}

async function translateWithDeepSeek(groups, targetLang, config) {
  // Region mode: OCR groups are the context; one request for the whole crop.
  const ocrText = groups.map(g => g.text).join("\n");
  return deepseekTranslateWithPrompt({
    groups,
    promptText: deepseekPrompt(targetLang, ocrText),
    text: ocrText,
    apiKey: config.deepseekApiKey,
    label: "DeepSeek",
    preferOrder: false
  });
}

async function translateFullImageWithDeepSeek(groups, targetLang, config) {
  const texts = groups.map(g => g.text);
  return deepseekTranslateWithPrompt({
    groups,
    promptText: fullPageIndexedPrompt(targetLang, texts),
    text: texts.join("\n"),
    apiKey: config.deepseekApiKey,
    label: "DeepSeek full image",
    preferOrder: false,
    parseResponse: (rawText, grps) => parseIndexedTranslations(rawText, grps.length)
  });
}

async function runConfiguredEngine(groups, msg, targetLang, engineConfig) {
  if (engineConfig.name === "google") {
    const result = await translateGroups(groups.map(g => g.text), targetLang);
    return { ...result, engine: "google" };
  }

  // Never silently fall back to Google for a selected LLM engine: the error must
  // reach content.js, which shows it on the page. Callers log it (the
  // scanAndTranslateImage error branch), so no wrapper is needed here.
  if (engineConfig.name === "gemini") {
    return await translateWithGemini(groups, msg, targetLang, engineConfig);
  }
  return await translateWithDeepSeek(groups, targetLang, engineConfig);
}

// ---------------------------------------------------------------------------
// Full-image translation (used by popup.html)
// ---------------------------------------------------------------------------
//
// popup.js still owns Lens OCR + note-box rendering, but translation itself is
// routed here so the same engine setting (Google / Gemini / DeepSeek) applies
// to the whole-image flow. The whole page is translated in ONE request so the
// model can use cross-bubble context.
// Text-only translation for the selection popup. It reuses the full-image
// pipeline so the popup and the capture flows share one engine implementation:
// Gemini / DeepSeek receive the selected text (and return romaji for Japanese),
// Google falls back to its public endpoint (no romaji available).
async function translateSelectionText(msg) {
  const text = String((msg && msg.text) || "").trim();
  if (!text) return { ok: false, error: "没有可翻译的文本" };

  const settings = await browser.storage.local.get({ targetLang: "en" });
  const targetLang = msg.targetLang || settings.targetLang || "en";

  // The popup fallback asks for the direct Google text endpoint by name; it must
  // work even when the saved engine is Gemini / DeepSeek. Other requests keep
  // going through the configured engine below.
  if (msg.engine === "google") {
    const direct = await translateText(text, targetLang);
    return {
      ok: true,
      translated: direct.translated,
      romaji: "",
      detectedSrc: direct.detectedSrc || "auto",
      engine: "google",
      targetLang
    };
  }

  const result = await translateFullImage({ groups: [{ text }], targetLang });
  const translated = (result.translations && result.translations[0]) || "";
  const romaji = (result.romajis && result.romajis[0]) || "";
  return {
    ok: true,
    translated,
    romaji,
    detectedSrc: "auto",
    engine: result.engine,
    model: result.model,
    targetLang
  };
}

async function translateFullImage(msg) {
  const groups = Array.isArray(msg.groups)
    ? msg.groups
        .map(g => (typeof g === "string" ? { text: g } : { text: String((g && g.text) || "") }))
        .filter(g => g.text.trim())
    : [];

  if (!groups.length) {
    return { ok: true, translations: [], romajis: [], engine: "google" };
  }

  const settings = await browser.storage.local.get({ targetLang: "en" });
  const targetLang = msg.targetLang || settings.targetLang || "en";
  const engineConfig = await getTranslationEngineConfig();

  if (engineConfig.name === "google") {
    const result = await translateGroups(groups.map(g => g.text), targetLang);
    return { ok: true, translations: result.translations, romajis: [], engine: "google" };
  }

  if (engineConfig.name === "gemini") {
    const result = await translateFullImageWithGemini(groups, targetLang, engineConfig);
    return {
      ok: true,
      translations: result.translations,
      romajis: result.romajis || [],
      engine: "gemini",
      model: result.model,
      countMismatch: !!result.countMismatch
    };
  }

  const result = await translateFullImageWithDeepSeek(groups, targetLang, engineConfig);
  return {
    ok: true,
    translations: result.translations,
    romajis: result.romajis || [],
    engine: "deepseek",
    countMismatch: !!result.countMismatch
  };
}

// ---------------------------------------------------------------------------
// Region OCR + translate
// ---------------------------------------------------------------------------

// Shared "image bytes in, translated groups out" step. Both the region crop
// flow and the Full Power page pipeline go through it, so engine selection,
// romaji and rate-limit handling cannot drift apart.
async function scanAndTranslateImage(opts) {
  const options = opts || {};
  const base64 = String(options.base64 || "");
  const base64Length = base64.length;
  const targetLang = options.targetLang || "en";
  const mime = options.mime || "image/png";
  const label = options.label || "image";

  if (!LensCoreClass) {
    throw new Error("Lens OCR engine is not available (lens-bundle.js failed to load)");
  }

  const bytes = base64ToBytes(base64);
  const dims = [Number(options.width), Number(options.height)];
  const haveDims = dims.every(n => Number.isFinite(n) && n > 0);
  if (FP_DEBUG) {
    console.log(
      "[imgtr] %s image: base64=%d chars, bytes=%d, mime=%s, dims=%s",
      label, base64Length, bytes.length, mime,
      haveDims ? dims.join("x") : "auto"
    );
  }

  const lens = new LensCoreClass({ targetLanguage: targetLang });
  const started = Date.now();
  // scanByData cannot be aborted, so stop waiting on it instead: without this a
  // hung Lens websocket request held an OCR slot until the tab was closed.
  const result = await fpWithTimeout(
    lens.scanByData(bytes, mime, haveDims ? dims : undefined),
    FP_LENS_TIMEOUT_MS,
    "Lens OCR"
  );

  const segments = (result.segments || [])
    .map((s) => {
      const bb = s.boundingBox && s.boundingBox.pixelCoords;
      if (!bb) return null;
      const bbox = {
        x: Number(bb.x),
        y: Number(bb.y),
        width: Number(bb.width),
        height: Number(bb.height)
      };
      if (![bbox.x, bbox.y, bbox.width, bbox.height].every(Number.isFinite)) return null;
      return { text: (s.text || "").trim(), bbox };
    })
    .filter(s => s && s.text);

  if (FP_DEBUG && self.__IMGT_DEBUG_OCR) {
    console.log("[imgtr] OCR segments: " + JSON.stringify(segments.map(s => ({ t: s.text, b: s.bbox }))));
  }
  const groups = groupSegments(segments, { tight: !!options.tightGrouping });
  const engineConfig = await getTranslationEngineConfig();
  const msgLike = { base64, mime };
  const translationResult = groups.length
    ? await runConfiguredEngine(groups, msgLike, targetLang, engineConfig)
    : { translations: [], error: null, rateLimited: false, engine: engineConfig.name };
  const translations = translationResult.translations;
  const translationFailed = groups.length > 0 && translations.every(t => !t);

  console.log(
    "[imgtr] %s OCR: %d line(s) > %d group(s), %d ms, lang=%s > %s, engine=%s%s",
    label, segments.length, groups.length, Date.now() - started,
    result.language || "auto", targetLang,
    translationResult.engine || engineConfig.name,
    translationFailed
      ? (translationResult.rateLimited ? " [translate rate-limited]" : " [translate failed]")
      : ""
  );
  if (translationFailed && translationResult.error) {
    console.error("[imgtr] %s translation error:", label, errorDetails(translationResult.error));
  }

  return {
    // Every bubble failing to translate is not a success: callers that key on
    // `ok` (capture fallback, region overlay) would otherwise paint empty boxes.
    ok: !translationFailed,
    language: result.language || "",
    targetLang,
    engine: translationResult.engine || engineConfig.name,
    elapsedMs: Date.now() - started,
    translationFailed,
    rateLimited: !!translationResult.rateLimited,
    translationError: translationResult.error
      ? (translationResult.error.message || String(translationResult.error))
      : "",
    groups: groups.map((g, i) => ({
      bbox: g.bbox,
      text: g.text,
      translation: translations[i] || "",
      romaji: (Array.isArray(translationResult.romajis) && translationResult.romajis[i]) || ""
    }))
  };
}

async function translateRegion(msg) {
  const base64Length = msg && typeof msg.base64 === "string" ? msg.base64.length : -1;
  if (!msg || base64Length < 100) {
    throw new Error(
      "Invalid cropped image Base64 (length=" + base64Length + "). " +
      "The canvas capture produced an empty/too-small image."
    );
  }
  return scanAndTranslateImage({
    base64: msg.base64,
    mime: msg.mime || "image/png",
    width: msg.width,
    height: msg.height,
    targetLang: msg.targetLang,
    label: "region"
  });
}

// ---------------------------------------------------------------------------
// Full Power Mode - steps 2 & 3: page translation, silent prefetch, LRU cache
// ---------------------------------------------------------------------------
//
// Two-stage pipeline. Stage A ("OCR") fetches the page image and asks the
// bundled Lens client for text - it is free but rides Google's unofficial Lens
// endpoint, so a couple of workers are fine and the queue may be long. Stage B
// ("translate") is the billed engine call: short queue, modest concurrency,
// never more than a couple of requests in flight.
//
// Pages are picked with a *cost* window instead of a fixed page count: a blank
// page costs nothing and a page whose bubbles are all interjections costs 0.3,
// so a run of covers/credits pages pulls the window further ahead.

const FP_CACHE_MAX_PAGES = 24;      // LRU cap (translated pages kept in memory)
// A failed image fetch is cached so the tick stops retrying it forever, but the
// entry has to expire: one transient 403 used to hide that page for the whole
// browser session (the cache is also restored from storage.session on boot).
const FP_FAILED_ENTRY_TTL_MS = 60000;
const FP_CACHE_KEY = "fpPageCache";     // legacy single-blob key, migrated once
const FP_CACHE_PAGE_PREFIX = "fp:";     // storage.session key per page: fp:<url>
let fpCachePersistFailures = 0;

const FP_WINDOW_BASE = 6;           // content cost to keep ready ahead of the reader
const FP_WINDOW_MAX = 12;           // hard cap of pages scheduled per round
const FP_WINDOW_LOW_INFO_BONUS = 3; // extra pages when the current page is sparse

const FP_OCR_CONCURRENCY = 2;       // Lens requests in flight (free, but rate limited)
const FP_OCR_QUEUE_MAX = 16;        // OCR queue length
const FP_OCR_RESULT_BUFFER_MAX = 6; // OCR done, waiting for a translation slot
const FP_TRANSLATE_CONCURRENCY = 2; // paid engine calls in flight
const FP_TRANSLATE_QUEUE_MAX = 3;   // paid queue length

const FP_LOW_INFO_COST = 0.3;       // weight of a page with almost no dialogue

const fpPageCache = new Map();   // url -> entry; Map order is LRU order
const fpQueuedUrls = new Set();  // URLs already queued/in flight
// Pages the reader flipped past before their turn came, or that a full pool
// rejected. They are drained when the visible window is idle, so nothing is
// silently left untranslated.
const fpBacklog = new Map(); // tabId -> Set(url)
const FP_BACKLOG_MAX = 80;
const fpTabUrls = new Map();     // tabId -> ordered urls the reader is showing
let fpOcrBuffer = 0;             // OCR results waiting for a translation slot

// Tabs where the user explicitly stopped Full Power Mode (fullPowerStop), until
// the mode is started again (fullPowerStart). It is the billing guard: a page
// job that was admitted while the mode was on must not start a new OCR /
// translation stage after the user turned it off, and a late tick must not
// rebuild the backlog behind their back.
const fpStoppedTabs = new Set();

function fpFullPowerTabDone(tabId) {
  return tabId != null && fpStoppedTabs.has(tabId);
}

function fpCancelledError() {
  const err = new Error("full power cancelled");
  err.cancelled = true;
  return err;
}

const fpOcrPool = { name: "ocr", limit: FP_OCR_CONCURRENCY, running: 0, queue: [] };
const fpTranslatePool = { name: "translate", limit: FP_TRANSLATE_CONCURRENCY, running: 0, queue: [] };

function fpPoolRun(pool, maxQueue, task) {
  return new Promise((resolve, reject) => {
    if (pool.queue.length >= maxQueue) {
      const err = new Error(pool.name + " queue is full");
      err.queueFull = true;
      reject(err);
      return;
    }
    pool.queue.push({ task, resolve, reject });
    fpPoolPump(pool);
  });
}

function fpPoolPump(pool) {
  while (pool.running < pool.limit && pool.queue.length) {
    const job = pool.queue.shift();
    pool.running += 1;
    Promise.resolve()
      .then(job.task)
      .then(
        (value) => job.resolve(value),
        (err) => job.reject(err)
      )
      .then(() => {
        pool.running -= 1;
        fpPoolPump(pool);
      });
  }
}

// Interjections ("えっ", "はい", "……") carry no information worth a paid
// translation round trip. Anything containing a kanji is kept: it is usually a
// real line, and a swallowed "なに？" looks like a bug to the reader.
// Only unmistakable noise is dropped: a lone character, or a line made purely
// of punctuation and symbols. Short *dialogue* such as "だって" or "なに？" is
// kept -- swallowing it looks exactly like a translation bug to the reader.
const FP_PUNCT_ONLY_RE = /^[s　-〿…‥！-／：-＠［-｀｛-･!-/:-@[-`{-~]+$/;

function fpIsFillerText(text) {
  const s = String(text || "");
  if (!s.trim()) return true;
  if (s.trim().length <= 1) return true;
  return FP_PUNCT_ONLY_RE.test(s);
}

/**
 * Cheap 32x32 luminance snapshot used to drop blank pages *before* paying for
 * an OCR round trip. Returns null when the platform cannot decode.
 */
async function fpPageStats(bytes, mime) {
  if (typeof OffscreenCanvas !== "function" || typeof createImageBitmap !== "function") {
    return null;
  }
  try {
    const blob = new Blob([bytes], { type: mime || "image/jpeg" });
    const bmp = await createImageBitmap(blob);
    // Keep the real pixel size here: fpOcrPage used to decode the same image a
    // second time (fpImageDims) only to pass these two numbers on to Lens.
    const width = bmp.width;
    const height = bmp.height;
    const canvas = new OffscreenCanvas(32, 32);
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(bmp, 0, 0, 32, 32);
    if (bmp.close) bmp.close();
    const data = ctx.getImageData(0, 0, 32, 32).data;
    let sum = 0;
    let sum2 = 0;
    let white = 0;
    let n = 0;
    for (let i = 0; i < data.length; i += 4) {
      const lum = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
      sum += lum;
      sum2 += lum * lum;
      n += 1;
      if (lum > 245) white += 1;
    }
    const mean = sum / n;
    return {
      mean,
      std: Math.sqrt(Math.max(0, sum2 / n - mean * mean)),
      whiteRatio: white / n,
      width,
      height
    };
  } catch (_) {
    return null;
  }
}

function fpBlankKind(stats) {
  if (!stats) return "";
  if (stats.mean < 20 && stats.std < 10) return "black";
  if (stats.mean > 245 && stats.std < 6) return "white";
  if (stats.std < 4) return "flat";
  return "";
}

/**
 * Walk the page order from the current page and collect pages until the
 * accumulated cost reaches the target, or FP_WINDOW_MAX pages are collected.
 */
function fpWindowAhead(order, url, currentCached) {
  const out = [];
  const idx = Array.isArray(order) ? order.indexOf(url) : -1;
  if (idx < 0) return out;
  const target =
    FP_WINDOW_BASE + (currentCached && currentCached.lowInfo ? FP_WINDOW_LOW_INFO_BONUS : 0);
  let cost = 0;
  for (let k = 1; idx + k < order.length && out.length < FP_WINDOW_MAX; k += 1) {
    const next = order[idx + k];
    if (!next || next === url || out.indexOf(next) >= 0) continue;
    out.push(next);
    const known = fpPageCache.get(next);
    if (known && known.lowInfo) {
      cost += known.skipped === "blank" ? 0 : FP_LOW_INFO_COST;
    } else {
      cost += 1;
    }
    if (cost >= target) break;
  }
  return out;
}

function fpCacheCount(urls) {
  let n = 0;
  (urls || []).forEach((u) => { if (u && fpPageCache.has(u)) n += 1; });
  return n;
}

function fpCacheStorageKey(url) {
  return FP_CACHE_PAGE_PREFIX + url;
}

// One small session key per page. The old code rewrote the whole 24-entry blob
// on a 1.5s debounce: every eviction re-serialised every cached group list, and
// a service-worker shutdown before the timer fired lost the write entirely.
function fpCachePersistEntry(entry) {
  if (!browser.storage || !browser.storage.session) return;
  if (!entry || !entry.url) return;
  try {
    Promise.resolve(browser.storage.session.set({ [fpCacheStorageKey(entry.url)]: entry }))
      .catch((e) => {
        fpCachePersistFailures += 1;
        if (fpCachePersistFailures <= 3) {
          console.warn("[imgtr] full power cache: session persist failed:", (e && e.message) || e);
        }
      });
  } catch (e) {
    console.warn("[imgtr] full power cache: session persist threw:", (e && e.message) || e);
  }
}

function fpCacheForgetPersisted(url) {
  if (!browser.storage || !browser.storage.session || !url) return;
  try {
    Promise.resolve(browser.storage.session.remove([fpCacheStorageKey(url)]))
      .catch(() => { /* the key is already gone */ });
  } catch (_) { /* ignore */ }
}

function fpCacheGet(url, targetLang) {
  if (!url) return null;
  const hit = fpPageCache.get(url);
  if (!hit) return null;
  // An entry cached for a different target language is a miss: the reader
  // changed the language in the options page and must not be served the old one.
  if (targetLang && hit.targetLang && hit.targetLang !== targetLang) return null;
  // Drop expired fetch-failure markers so the page gets retried later instead of
  // staying untranslated for the whole session.
  if (hit.fetchFailed && Date.now() - (hit.failedAt || 0) > FP_FAILED_ENTRY_TTL_MS) {
    fpPageCache.delete(url);
    fpCacheForgetPersisted(url);
    return null;
  }
  // Re-insert so the least recently used page sits first in the Map.
  fpPageCache.delete(url);
  hit.at = Date.now();
  fpPageCache.set(url, hit);
  return hit;
}

function fpCachePut(entry) {
  if (!entry || !entry.url) return entry;
  fpPageCache.delete(entry.url);
  entry.at = Date.now();
  fpPageCache.set(entry.url, entry);
  while (fpPageCache.size > FP_CACHE_MAX_PAGES) {
    const oldest = fpPageCache.keys().next().value;
    fpPageCache.delete(oldest);
    fpCacheForgetPersisted(oldest);
    console.log("[imgtr] full power cache: LRU evicted", oldest);
  }
  fpCachePersistEntry(entry);
  return entry;
}

async function fpCacheRestore() {
  if (!browser.storage || !browser.storage.session) return;
  try {
    const all = (await browser.storage.session.get(null)) || {};
    const restored = new Map();
    // One-off migration of the old single-blob key.
    const legacy = all[FP_CACHE_KEY];
    if (Array.isArray(legacy)) {
      legacy.forEach((p) => {
        if (p && p.url && !restored.has(p.url)) restored.set(p.url, p);
      });
    }
    Object.keys(all).forEach((key) => {
      if (key.indexOf(FP_CACHE_PAGE_PREFIX) !== 0) return;
      const value = all[key];
      if (value && value.url) restored.set(value.url, value);
    });
    const pages = Array.from(restored.values())
      .sort((a, b) => (a.at || 0) - (b.at || 0))
      .slice(-FP_CACHE_MAX_PAGES);
    pages.forEach((p) => fpPageCache.set(p.url, p));
    if (Array.isArray(legacy)) {
      try {
        await browser.storage.session.remove(FP_CACHE_KEY);
      } catch (_) { /* the old key may already be gone */ }
      pages.forEach((p) => fpCachePersistEntry(p));
    }
    if (fpPageCache.size) {
      console.log("[imgtr] full power cache: restored " + fpPageCache.size + " page(s)");
    }
  } catch (e) {
    console.warn("[imgtr] full power cache: restore failed:", (e && e.message) || e);
  }
}

// Handlers await this before trusting fpPageCache; the restore is async and used
// to race the first fullPowerTick/fullPowerCached message after a cold start.
const fpCacheReady = fpCacheRestore();

// Image hosts differ wildly: some need our DNR-injected Referer, some choke
// on the injected User-Agent/Cookie, some only accept the native `referrer`
// option, and some simply refuse worker fetches. Try them in order; a host that
// fails every strategy just falls through to the tab-screenshot fallback.
function fpHostOf(url) {
  try {
    return new URL(url).host;
  } catch (_) {
    return "";
  }
}
async function fpFetchAttempt(kind, fn) {
  try {
    const res = await fn();
    // Always return the wrapper: a bare response here used to make the caller
    // read `out.res` as undefined and treat a success as a failure.
    // Any response at all means the network worked (a 403 is still an answer);
    // only thrown errors should push us to the next strategy.
    if (res) return { kind, ok: true, res };
    return { kind, res };
  } catch (e) {
    return { kind, error: e };
  }
}
// A network call without a deadline is how one stuck CDN connection pins an
// entire Full Power slot (each pool only has two). Everything that talks to the
// network in this file gets a hard deadline now. Lens has no abort support, so
// there the deadline only stops us waiting for the promise.
const FP_FETCH_TIMEOUT_MS = 12000;
const FP_LENS_TIMEOUT_MS = 20000;
function fpTimeoutSignal(ms) {
  const timeoutMs = ms || FP_FETCH_TIMEOUT_MS;
  if (typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function") {
    return AbortSignal.timeout(timeoutMs);
  }
  // Older Chromium: same 12s deadline through a manual controller.
  if (typeof AbortController === "function") {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), timeoutMs);
    return controller.signal;
  }
  return undefined;
}
function fpWithTimeout(promise, ms, label) {
  let timer = null;
  const guard = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error((label || "operation") + " timed out after " + ms + "ms")),
      ms
    );
  });
  return Promise.race([promise, guard]).finally(() => {
    if (timer !== null) clearTimeout(timer);
  });
}

async function fpFetchWithFallbacks(url, referer) {
  // One deadline per attempt: sharing a single signal let the slow DNR attempt
  // eat the whole budget and take the plain/referrer fallbacks down with it.
  const attempts = [
    ["dnr", () => fetchWithReferer(url, referer || "", fpTimeoutSignal())],
    ["plain", () => fetch(url, { signal: fpTimeoutSignal() })],
    ["referrer", () =>
      fetch(url, {
        referrer: referer || undefined,
        referrerPolicy: "unsafe-url",
        credentials: "include",
        signal: fpTimeoutSignal()
      })]
  ];
  let lastError = null;
  for (let i = 0; i < attempts.length; i++) {
    const kind = attempts[i][0];
    const out = await fpFetchAttempt(kind, attempts[i][1]);
    if (out.ok && out.res) {
      // A real HTTP status means the network worked; log only the fallback.
      if (kind !== "dnr") {
        console.warn("[imgtr] full power: " + kind + " fetch fallback worked for " + fpHostOf(url));
      }
      return out.res;
    }
    lastError = out.error || lastError;
    if (kind === "dnr") {
      console.warn(
        "[imgtr] full power: dnr fetch failed for " + fpHostOf(url) + ": " +
        ((out.error && out.error.message) || "unknown")
      );
    }
  }
  throw lastError || new Error("all fetch strategies failed");
}

async function fpFetchPageBytes(url, referer) {
  let res;
  try {
    res = await fpFetchWithFallbacks(url, referer);
  } catch (e) {
    console.error(
      "[imgtr] full power: image fetch failed (network) %s :: %s",
      url,
      (e && e.message) || e
    );
    throw e;
  }
  if (!res || !res.ok) {
    // Status codes are the fastest way to tell a dead link (404) from a
    // hot-link guard (403) while testing new sites.
    console.error("[imgtr] full power: image fetch failed (HTTP %s) %s", res ? res.status : "?", url);
    throw new Error("HTTP " + (res ? res.status : "?") + " while fetching " + url);
  }
  const buf = await res.arrayBuffer();
  return new Uint8Array(buf);
}

// For blob:/data: images and <canvas> readers there is no URL to fetch, so the
// content script asks us to screenshot what is on screen and translate that.
async function fpTranslateCapture(msg) {
  const tabId = msg && msg.tabId != null ? msg.tabId : null;
  // A capture request that raced "stop" must not pay for a screenshot + OCR +
  // translation of a page the user no longer wants translated.
  if (fpFullPowerTabDone(tabId)) return { ok: false, cancelled: true };
  const rect = (msg && msg.rect) || {};
  const dpr = Number(msg && msg.dpr) > 0 ? Number(msg.dpr) : 1;
  const x = Math.max(0, Math.round(Number(rect.x || 0) * dpr));
  const y = Math.max(0, Math.round(Number(rect.y || 0) * dpr));
  const w = Math.max(0, Math.round(Number(rect.w || 0) * dpr));
  const h = Math.max(0, Math.round(Number(rect.h || 0) * dpr));
  if (w < 60 || h < 60) return { ok: false, error: "capture area too small" };
  if (typeof createImageBitmap !== "function" || typeof OffscreenCanvas !== "function") {
    return { ok: false, error: "no OffscreenCanvas support" };
  }

  // Preferred path: the content script already handed us the pixels (it can
  // draw blob:/data:/same-origin images into a canvas). Only when that is
  // impossible do we screenshot the tab.
  const inline = String((msg && msg.base64) || "");
  let sw = Math.max(1, Math.round(Number((msg && msg.width) || 0)));
  let sh = Math.max(1, Math.round(Number((msg && msg.height) || 0)));
  let base64 = inline;
  if (!inline) {
    let shot = null;
    try {
      shot = await captureVisibleTabCompat(msg && msg.windowId);
    } catch (e) {
      console.error("[imgtr] full power: captureVisibleTab error:", (e && e.message) || e);
      return { ok: false, error: "captureVisibleTab: " + ((e && e.message) || e) };
    }
    if (!shot || !shot.dataUrl) {
      // Last resort: the promise-only form, which reports the real reason.
      try {
        const dataUrl = await browser.tabs.captureVisibleTab({ format: "png" });
        if (dataUrl) shot = { dataUrl };
        else throw new Error("empty screenshot");
      } catch (e) {
        console.error("[imgtr] full power: screenshot fallback unavailable:", (e && e.message) || e);
        return { ok: false, error: "captureVisibleTab: " + ((e && e.message) || e) };
      }
    }
    const blob = await (await fetch(shot.dataUrl)).blob();
    const bitmap = await createImageBitmap(blob);
    const sx = Math.min(x, Math.max(0, bitmap.width - 1));
    const sy = Math.min(y, Math.max(0, bitmap.height - 1));
    sw = Math.max(1, Math.min(w, bitmap.width - sx));
    sh = Math.max(1, Math.min(h, bitmap.height - sy));
    const canvas = new OffscreenCanvas(sw, sh);
    canvas.getContext("2d").drawImage(bitmap, sx, sy, sw, sh, 0, 0, sw, sh);
    if (bitmap.close) bitmap.close();
    const outBlob = await canvas.convertToBlob({ type: "image/png" });
    base64 = arrayBufferToBase64(await outBlob.arrayBuffer());
  }

  // The screenshot path can take a moment; re-check before paying for OCR.
  if (fpFullPowerTabDone(tabId)) return { ok: false, cancelled: true };

  const targetLang = (msg && msg.targetLang) || (await fpGetTargetLangCached());
  const result = await scanAndTranslateImage({
    base64,
    mime: "image/png",
    width: sw,
    height: sh,
    targetLang,
    label: "capture"
  });
  if (!result || !result.ok) {
    return { ok: false, error: (result && result.translationError) || "capture translation failed" };
  }
  const groups = (result.groups || [])
    .map((g) => {
      const b = g.bbox || {};
      return {
        x: sw > 0 ? Math.max(0, Math.min(1, (b.x || 0) / sw)) : 0,
        y: sh > 0 ? Math.max(0, Math.min(1, (b.y || 0) / sh)) : 0,
        w: sw > 0 ? Math.max(0, Math.min(1, (b.width || 0) / sw)) : 0,
        h: sh > 0 ? Math.max(0, Math.min(1, (b.height || 0) / sh)) : 0,
        text: g.text || "",
        translation: g.translation || "",
        romaji: g.romaji || ""
      };
    })
    .filter((g) => g.w > 0 && g.h > 0 && g.text);
  console.log("[imgtr] full power: screenshot fallback -> %d bubble(s)", groups.length);
  return {
    ok: true,
    entry: {
      url: String((msg && msg.url) || ""),
      page: (msg && msg.page) || 0,
      capture: true,
      targetLang: result.targetLang || targetLang,
      engine: result.engine || "",
      language: result.language || "",
      width: sw,
      height: sh,
      groups
    }
  };
}

function fpNotifyTab(tabId, entry, extra) {
  if (tabId == null || !entry) return;
  const urls = fpTabUrls.get(tabId) || [];
  const message = {
    action: "fpPageTranslated",
    entry,
    cachedCount: fpCacheCount(urls),
    partial: !!(extra && extra.partial)
  };
  try {
    Promise.resolve(browser.tabs.sendMessage(tabId, message))
      .catch(() => { /* tab may be gone or the page reloaded */ });
  } catch (_) { /* ignore */ }
}

/**
 * Stage A: fetch the page and read its bubbles. No billed engine call here, so
 * a couple of these may run at once.
 */
async function fpOcrPage(url, referer, targetLang) {
  const mime = mimeFromUrl(url);
  const bytes = await fpFetchPageBytes(url, referer);
  const stats = await fpPageStats(bytes, mime);
  const blank = fpBlankKind(stats);
  if (blank) return { url, blank, groups: [], lineCount: 0 };

  // Reuse the dimensions that the stats pass already decoded.
  const width = stats ? stats.width : 0;
  const height = stats ? stats.height : 0;

  if (!LensCoreClass) {
    throw new Error("Lens OCR engine is not available (lens-bundle.js failed to load)");
  }
  // scanByData accepts the bytes directly; the old arrayBufferToBase64 +
  // base64ToBytes round trip copied every page twice before OCR even started.
  const lens = new LensCoreClass({ targetLanguage: targetLang });
  const scan = await fpWithTimeout(
    lens.scanByData(
      bytes,
      mime,
      width > 0 && height > 0 ? [width, height] : undefined
    ),
    FP_LENS_TIMEOUT_MS,
    "Lens OCR"
  );
  const segments = (scan.segments || [])
    .map((s) => {
      const bb = s.boundingBox && s.boundingBox.pixelCoords;
      if (!bb) return null;
      const bbox = {
        x: Number(bb.x),
        y: Number(bb.y),
        width: Number(bb.width),
        height: Number(bb.height)
      };
      if (![bbox.x, bbox.y, bbox.width, bbox.height].every(Number.isFinite)) return null;
      return { text: (s.text || "").trim(), bbox };
    })
    .filter((s) => s && s.text);

  if (FP_DEBUG && self.__IMGT_DEBUG_OCR) {
    console.log(
      "[imgtr] OCR segments: " + JSON.stringify(segments.map((s) => ({ t: s.text, b: s.bbox })))
    );
  }

  const grouped = groupSegments(segments, { tight: true });
  const kept = grouped.filter((g) => !fpIsFillerText(g.text));
  const dropped = grouped.length - kept.length;
  if (dropped) {
    console.log("[imgtr] full power: dropped %d interjection(s) on %s", dropped, url);
  }

  return {
    url,
    mime,
    bytes,
    width,
    height,
    groups: kept,
    lineCount: segments.length,
    language: scan.language || ""
  };
}

/**
 * Stage B: the paid engine call. Only reachable for pages with real dialogue.
 */
async function fpTranslateStage(stage, targetLang) {
  const width = stage.width;
  const height = stage.height;
  const engineConfig = await getTranslationEngineConfig();
  // Gemini is the only engine that also looks at the page image, so the base64
  // is built on demand instead of for every page the Lens stage already decoded.
  const bytes = stage.bytes;
  const msgLike = engineConfig.name === "gemini" && bytes && bytes.length
    ? {
        base64: arrayBufferToBase64(
          bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
            ? bytes.buffer
            : bytes.slice().buffer
        ),
        mime: stage.mime
      }
    : { base64: "", mime: stage.mime };
  const translationResult = stage.groups.length
    ? await runConfiguredEngine(stage.groups, msgLike, targetLang, engineConfig)
    : { translations: [], error: null, rateLimited: false, engine: engineConfig.name };
  const translations = translationResult.translations || [];

  const groups = stage.groups
    .map((g, i) => {
      const b = g.bbox || {};
      const x = width > 0 ? b.x / width : 0;
      const y = height > 0 ? b.y / height : 0;
      const w = width > 0 ? b.width / width : 0;
      const h = height > 0 ? b.height / height : 0;
      return {
        x: Math.max(0, Math.min(1, x)),
        y: Math.max(0, Math.min(1, y)),
        w: Math.max(0, Math.min(1, w)),
        h: Math.max(0, Math.min(1, h)),
        text: g.text || "",
        translation: translations[i] || "",
        romaji: (Array.isArray(translationResult.romajis) && translationResult.romajis[i]) || ""
      };
    })
    .filter((g) => g.w > 0 && g.h > 0 && (g.text || g.translation || g.romaji));

  return {
    engine: translationResult.engine || engineConfig.name,
    language: stage.language || "",
    groups,
    rateLimited: !!translationResult.rateLimited,
    error: translationResult.error || null
  };
}

async function translateComicPage(url, referer, targetLang, onPartial, tabId) {
  if (fpFullPowerTabDone(tabId)) return null;
  const cached = fpCacheGet(url, targetLang);
  if (cached) return cached;

  const started = Date.now();
  let stage;
  try {
    stage = await fpPoolRun(fpOcrPool, FP_OCR_QUEUE_MAX, () => {
      if (fpFullPowerTabDone(tabId)) throw fpCancelledError();
      return fpOcrPage(url, referer, targetLang);
    });
  } catch (e) {
    if (e && e.cancelled) {
      console.log("[imgtr] full power: stopped before OCR, dropping page", url);
      return null;
    }
    if (e && e.queueFull) throw e;
    const failed = fpCachePut({
      url,
      targetLang,
      engine: "",
      language: "",
      width: 0,
      height: 0,
      groups: [],
      skipped: "fetch-failed",
      fetchFailed: true,
      failedAt: Date.now(),
      error: String((e && e.message) || e)
    });
    return failed;
  }

  if (stage.blank) {
    const entry = fpCachePut({
      url,
      targetLang,
      engine: "",
      language: "",
      width: 0,
      height: 0,
      groups: [],
      skipped: "blank",
      lowInfo: true
    });
    console.log("[imgtr] full power: skipped blank page (%s) %s", stage.blank, url);
    return entry;
  }

  if (!stage.groups.length) {
    const entry = fpCachePut({
      url,
      targetLang,
      engine: "",
      language: stage.language || "",
      width: stage.width,
      height: stage.height,
      groups: [],
      skipped: "low-info",
      lowInfo: true
    });
    console.log(
      "[imgtr] full power: skipped low-info page (%d lines, %d bubbles) %s",
      stage.lineCount,
      stage.groups.length,
      url
    );
    return entry;
  }

  // The user may have turned Full Power off while OCR was running: do not spend
  // a paid translation call on a page nobody is looking at any more.
  if (fpFullPowerTabDone(tabId)) {
    console.log("[imgtr] full power: stopped before translate, dropping page", url);
    return null;
  }

  if (typeof onPartial === "function") {
    try {
      const preview = stage.groups
        .map((g) => {
          const b = g.bbox || {};
          return {
            x: stage.width > 0 ? Math.max(0, Math.min(1, b.x / stage.width)) : 0,
            y: stage.height > 0 ? Math.max(0, Math.min(1, b.y / stage.height)) : 0,
            w: stage.width > 0 ? Math.max(0, Math.min(1, b.width / stage.width)) : 0,
            h: stage.height > 0 ? Math.max(0, Math.min(1, b.height / stage.height)) : 0,
            text: g.text || "",
            translation: "",
            romaji: ""
          };
        })
        .filter((g) => g.w > 0 && g.h > 0 && g.text);
      if (preview.length) onPartial({ url, targetLang, groups: preview });
    } catch (_) { /* progressive paint is best effort */ }
  }

  let translated = null;
  fpOcrBuffer += 1;
  try {
    translated = await fpPoolRun(fpTranslatePool, FP_TRANSLATE_QUEUE_MAX, () => {
      if (fpFullPowerTabDone(tabId)) throw fpCancelledError();
      return fpTranslateStage(stage, targetLang);
    });
  } catch (e) {
    if (e && e.cancelled) {
      console.log("[imgtr] full power: stopped while queued for translation, dropping page", url);
      return null;
    }
    throw e;
  } finally {
    fpOcrBuffer = Math.max(0, fpOcrBuffer - 1);
  }

  const entry = fpCachePut({
    url,
    targetLang,
    engine: translated.engine || "",
    language: translated.language || "",
    width: stage.width,
    height: stage.height,
    groups: translated.groups
  });

  console.log(
    "[imgtr] full power page: %s | %d bubbles | %d ms | engine=%s",
    url,
    entry.groups.length,
    Date.now() - started,
    entry.engine
  );
  return entry;
}

// Pages in the current window that the pools were too busy to take get another
// chance here, two at a time and only when both pools are idle, so they never
// compete with the visible page. The backlog only ever holds the forward window
// (see fpHandleTick), so a page the reader has left behind is not retried.
function fpDrainBacklog(tabId, referer, targetLang) {
  if (tabId == null) return;
  if (fpFullPowerTabDone(tabId)) return;
  const backlog = fpBacklog.get(tabId);
  if (!backlog || !backlog.size) return;
  if (fpOcrPool.running >= FP_OCR_CONCURRENCY) return;
  if (fpTranslatePool.running >= FP_TRANSLATE_CONCURRENCY) return;
  let drained = 0;
  for (const pageUrl of Array.from(backlog)) {
    if (drained >= 2) break;
    if (fpCacheGet(pageUrl, targetLang)) {
      backlog.delete(pageUrl);
      continue;
    }
    if (fpQueuedUrls.has(pageUrl)) continue;
    backlog.delete(pageUrl);
    fpQueuedUrls.add(pageUrl);
    drained += 1;
    Promise.resolve()
      .then(() => translateComicPage(pageUrl, referer, targetLang, null, tabId))
      .then((entry) => {
        if (entry) fpNotifyTab(tabId, entry);
      })
      .catch((e) => {
        console.error("[imgtr] full power: backlog page failed", pageUrl, errorDetails(e));
      })
      .finally(() => {
        fpQueuedUrls.delete(pageUrl);
      });
  }
}

async function fpHandleTick(msg, sender) {
  // A tick that raced the async restore used to see an empty cache.
  await fpCacheReady;
  const tabId = sender && sender.tab && sender.tab.id;
  // A tick that was already in flight when the user stopped Full Power must not
  // rebuild the backlog (and keep paying) behind their back.
  if (fpFullPowerTabDone(tabId)) return { ok: false, cached: false, stopped: true };
  // The page's own performance timeline is the trustworthy order (no other
  // tabs, no pre-wake-up misses), so keep the tab log in sync with it.
  if (tabId !== undefined && Array.isArray(msg && msg.seen) && msg.seen.length) {
    const seenUrls = msg.seen.filter((u) => typeof u === "string").slice(-FP_MAX_IMAGE_URLS);
    fpImageUrlsByTab.set(tabId, seenUrls);
    fpImageUrlSetsByTab.set(tabId, new Set(seenUrls));
  }
  const url = String((msg && msg.url) || "");
  // Where the *next* pages come from: the content script's performance
  // timeline knows the order this document loaded images in, which is the only
  // clean source. The tab-wide webRequest log is a fallback because it mixes in
  // other tabs' images and misses requests made before the worker woke up.
  const seen = msg && Array.isArray(msg.seen) ? msg.seen : [];
  const domUrls = msg && Array.isArray(msg.urls) ? msg.urls : [];
  const captured = tabId != null && fpImageUrlsByTab.get(tabId) ? fpImageUrlsByTab.get(tabId) : [];
  const order =
    seen.indexOf(url) >= 0 ? seen : domUrls.indexOf(url) >= 0 ? domUrls : captured;
  const orderIdx = order.indexOf(url);
  const knownLang = fpKnownTargetLang();
  const currentCached = fpCacheGet(url, knownLang);
  // Cost window instead of a fixed page count: blank pages are free and sparse
  // pages are cheap, so a run of covers pulls the window further ahead.
  // When the current page is missing from every known list (freshly entered
  // chapter, or the capture missed it) the content script's own order is the
  // only hint, so build a synthetic list from it and still respect the window.
  const synthetic =
    orderIdx >= 0 ? order : url ? [url].concat(domUrls) : domUrls;
  const ahead = synthetic.indexOf(url) >= 0 ? fpWindowAhead(synthetic, url, currentCached) : [];
  const urls = url ? [url].concat(ahead) : ahead;
  if (tabId != null) fpTabUrls.set(tabId, urls);

  if (tabId != null) {
    // Only pages inside the current cost window belong in the backlog. Enqueuing
    // every known URL (the reader keeps up to 400) made the drain keep OCR-ing —
    // and paying to translate — pages that had been scrolled past ages ago.
    const windowUrls = urls.filter(Boolean);
    if (windowUrls.length) {
      let backlog = fpBacklog.get(tabId);
      if (!backlog) {
        backlog = new Set();
        fpBacklog.set(tabId, backlog);
      }
      const windowSet = new Set(windowUrls);
      for (const pageUrl of windowUrls) {
        if (fpCacheGet(pageUrl, knownLang)) backlog.delete(pageUrl);
        else backlog.add(pageUrl);
      }
      // Drop whatever the reader has already left behind. A page that leaves the
      // window un-translated is simply picked up again if it scrolls back in.
      for (const pageUrl of Array.from(backlog)) {
        if (!windowSet.has(pageUrl)) backlog.delete(pageUrl);
      }
      while (backlog.size > FP_BACKLOG_MAX) {
        backlog.delete(backlog.values().next().value);
      }
    }
  }

  const cached = fpCacheGet(url, knownLang);
  if (cached) {
    // The current page is already translated, but the backlog still needs
    // draining. Resolve referer/targetLang inside the deferred call: they are
    // declared further down in this function, so reading them here hits TDZ.
    Promise.resolve()
      .then(async () => {
        const drainLang = (msg && msg.targetLang) || (await fpGetTargetLangCached());
        return fpDrainBacklog(tabId, String((msg && msg.referer) || ""), drainLang);
      })
      .catch((e) => console.warn("[imgtr] full power: backlog drain failed", e));
    return { ok: true, cached: true, entry: cached, cachedCount: fpCacheCount(urls) };
  }
  if (!url || tabId == null) {
    return { ok: false, cached: false, cachedCount: fpCacheCount(urls) };
  }

  const targetLang = (msg && msg.targetLang) || (await fpGetTargetLangCached());
  const referer = String((msg && msg.referer) || "");

  const todo = [];
  for (const pageUrl of urls) {
    if (!pageUrl || fpCacheGet(pageUrl, targetLang) || fpQueuedUrls.has(pageUrl)) continue;
    // Backpressure: when too many OCR results are already waiting for a paid
    // translation slot, stop feeding the OCR stage.
    if (fpOcrBuffer >= FP_OCR_RESULT_BUFFER_MAX) {
      console.log("[imgtr] full power: translate buffer full, throttling OCR");
      break;
    }
    todo.push(pageUrl);
  }
  if (todo.length) {
    // Reserve the whole batch up front: a tick that arrives while the batch is
    // still running must not enqueue the same pages a second time.
    todo.forEach((pageUrl) => fpQueuedUrls.add(pageUrl));
    todo.forEach((pageUrl) => {
      Promise.resolve()
        .then(() =>
          translateComicPage(pageUrl, referer, targetLang, (partial) => {
            fpNotifyTab(tabId, partial, { partial: true });
          }, tabId)
        )
        .then((entry) => {
          if (entry) fpNotifyTab(tabId, entry);
        })
        .catch((e) => {
          if (e && e.queueFull) {
            // A full pipeline is backpressure, not a failure: park the page and
            // let the backlog drain it once the pools free up.
            if (tabId != null) {
              const backlog = fpBacklog.get(tabId);
              if (backlog) backlog.add(pageUrl);
            }
            console.warn("[imgtr] full power: pipeline busy, page deferred to backlog:", pageUrl);
            return;
          }
          console.error("[imgtr] full power: page failed", pageUrl, errorDetails(e));
        })
        .finally(() => {
          fpQueuedUrls.delete(pageUrl);
        });
    });
  }

  fpDrainBacklog(tabId, referer, targetLang);

  return {
    ok: true,
    cached: false,
    cachedCount: fpCacheCount(urls),
    queued: todo.length
  };
}

// ---------------------------------------------------------------------------
// Message routing
// ---------------------------------------------------------------------------

// captureVisibleTab returns a data URL. Passing a callback works on every
// Chrome version; if the API instead returns a Promise (Firefox), use that.
function captureVisibleTabCompat(windowId) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    const fail = (e) => { if (!settled) { settled = true; reject(e); } };
    try {
      if (!browser.tabs || typeof browser.tabs.captureVisibleTab !== "function") {
        throw new Error("captureVisibleTab is unavailable");
      }
      const ret = browser.tabs.captureVisibleTab(windowId, { format: "png" }, (dataUrl) => {
        const err = browser.runtime.lastError;
        if (err) fail(new Error(err.message));
        else done(dataUrl);
      });
      if (ret && typeof ret.then === "function") ret.then(done, fail);
    } catch (e) {
      fail(e);
    }
  });
}

// Use sendResponse + `return true` rather than returning a Promise from
// onMessage. Returning a Promise only works on Chrome 122+; the callback style
// works on every supported Chrome version. This is what makes the capture /
// OCR round-trip reliable on older browsers.
browser.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return;

  // Full Power Mode: the reader started (or moved to another chapter), so the
  // tab's captured image list is stale — cover art / thumbnails requested
  // before the reader mounted would shift every page index.
  if (msg.action === "comicReadReset") {
    const tabId = sender && sender.tab && sender.tab.id;
    if (tabId != null) {
      fpForgetImageUrls(tabId);
      // The old chapter's queue has to die with its URL list. Leaving fpBacklog
      // behind kept draining pages the reader already left: the OCR pass is free
      // but the engine call it feeds is billed.
      fpBacklog.delete(tabId);
      fpTabUrls.delete(tabId);
    }
    sendResponse({ ok: true });
    return;
  }

  // Full Power Mode: the content script reports whether reading mode is on, so
  // the menu entry only appears on ComicRead pages.
  if (msg.action === "comicReadPresence") {
    const tabId = sender && sender.tab && sender.tab.id;
    if (tabId != null) {
      if (msg.detected) fpComicReadTabs.add(tabId);
      else fpComicReadTabs.delete(tabId);
      void fpSyncMenuVisibility();
    }
    sendResponse({ ok: true });
    return;
  }

  // Full Power Mode: "this page is on screen, translate it (and the next
  // couple) unless it is already cached". Cached pages answer at once; the rest
  // are queued single-file and pushed back through fpPageTranslated.
  if (msg.action === "fullPowerCapturePage") {
    fpTranslateCapture(
      Object.assign({}, msg, {
        windowId: sender && sender.tab && sender.tab.windowId,
        tabId: sender && sender.tab && sender.tab.id
      })
    )
      .then(sendResponse)
      .catch((e) => sendResponse({ ok: false, error: errorDetails(e) }));
    return true;
  }

  if (msg.action === "fullPowerTick") {
    fpHandleTick(msg, sender).then(sendResponse).catch((e) => {
      sendResponse({ ok: false, error: String((e && e.message) || e) });
    });
    return true;
  }

  if (msg.action === "fullPowerCached") {
    (async () => {
      try {
        await fpCacheReady;
        const urls = Array.isArray(msg.urls) ? msg.urls.filter(Boolean) : [];
        const entries = {};
        for (const url of urls) {
          const entry = fpCacheGet(url, msg.targetLang || fpKnownTargetLang());
          if (entry) entries[url] = entry;
        }
        const filled = Object.keys(entries);
        // count/urls are additive: region.js still consumes `entries` (it renders
        // the groups), so dropping them would break the overlay.
        sendResponse({
          ok: true,
          entries: entries,
          urls: filled,
          count: filled.length,
          cachedCount: fpCacheCount(urls)
        });
      } catch (e) {
        sendResponse({ ok: false, error: String((e && e.message) || e) });
      }
    })();
    return true;
  }

  if (msg.action === "fullPowerStop") {
    const tabId = sender && sender.tab && sender.tab.id;
    if (tabId != null) {
      // "Stop" has to mean stop: dropping only fpTabUrls left the drain loop
      // translating pages after the user turned Full Power off.
      fpStoppedTabs.add(tabId);
      fpTabUrls.delete(tabId);
      fpBacklog.delete(tabId);
    }
    sendResponse({ ok: true });
    return;
  }

  // Full Power Mode was (re)started in this tab: clear the "stopped" marker so
  // queued page jobs are allowed to run again.
  if (msg.action === "fullPowerStart") {
    const tabId = sender && sender.tab && sender.tab.id;
    if (tabId != null) fpStoppedTabs.delete(tabId);
    sendResponse({ ok: true });
    return;
  }

  // Full Power Mode: the image URLs this tab has requested so far, in order.
  if (msg.action === "getComicReadImageUrls") {
    const tabId =
      (sender && sender.tab && sender.tab.id) != null
        ? sender.tab.id
        : msg.tabId;
    sendResponse({ ok: true, urls: fpImageUrlsByTab.get(tabId) || [] });
    return;
  }

  // Fallback for the Alt+T shortcut on tabs where content.js isn't present:
  // content.js (or region.js) may ask background to inject the region scripts.
  if (msg.action === "startRegionShortcut") {
    (async () => {
      try {
        let tab = sender && sender.tab;
        if (!tab) {
          const tabs = await browser.tabs.query({ active: true, currentWindow: true });
          tab = tabs && tabs[0];
        }
        await startRegionSelection(tab);
        sendResponse({ ok: true });
      } catch (e) {
        sendResponse({ ok: false, error: String((e && e.message) || e) });
      }
    })();
    return true;
  }

  if (msg.action === "translateSelectionText") {
    translateSelectionText(msg)
      .then(res => sendResponse(res))
      .catch(err => sendResponse({ ok: false, error: err && err.message ? err.message : String(err) }));
    return true;
  }

  if (msg.action === "translateFullImage") {
    (async () => {
      try {
        sendResponse(await translateFullImage(msg));
      } catch (e) {
        console.error("[imgtr] translateFullImage failed:", errorDetails(e));
        sendResponse({ ok: false, error: String((e && e.message) || e) });
      }
    })();
    return true;
  }

  if (msg.action === "fetchImageWithReferer" && msg.url) {
    (async () => {
      try {
        // Background fetches run in the extension origin; with
        // host_permissions=<all_urls>, cross-origin responses are readable.
        // fetchWithReferer rewrites Referer for just this request via whichever
        // mechanism this browser supports.
        const res = await fetchWithReferer(msg.url, msg.referer || "", fpTimeoutSignal());

        if (!res.ok) {
          sendResponse({ ok: false, status: res.status, error: `HTTP ${res.status}` });
          return;
        }
        const buf = await res.arrayBuffer();
        const ct = res.headers.get("content-type") || "";
        // Reject obvious non-image responses (HTML anti-hotlink pages, etc.)
        if (ct && !ct.startsWith("image/") && !ct.startsWith("application/octet-stream")) {
          sendResponse({ ok: false, status: res.status,
                         error: `non-image response: ${ct}` });
          return;
        }
        sendResponse({
          ok: true,
          status: res.status,
          base64: arrayBufferToBase64(buf),
          mime: ct || mimeFromUrl(msg.url),
          length: buf.byteLength,
          method: "background-fetch+referer"
        });
      } catch (e) {
        sendResponse({ ok: false, error: String((e && e.message) || e) });
      }
    })();
    return true;
  }

  if (msg.action === "captureTab") {
    // Called by the content script after selector.js has removed its overlay.
    // The screenshot is returned as a data: URL; the content script crops it
    // with a canvas (it knows the devicePixelRatio mapping).
    (async () => {
      try {
        const windowId = sender && sender.tab && sender.tab.windowId != null
          ? sender.tab.windowId
          : null;
        const dataUrl = await captureVisibleTabCompat(windowId);
        if (!dataUrl) throw new Error("截图返回为空 / empty screenshot");
        sendResponse({ ok: true, dataUrl });
      } catch (e) {
        sendResponse({ ok: false, error: String((e && e.message) || e) });
      }
    })();
    return true;
  }

  if (msg.action === "translateRegion") {
    (async () => {
      try {
        const result = await translateRegion(msg);
        // scanAndTranslateImage reports a total translation failure with
        // translationError/ok:false; the region overlay keys on `error`.
        sendResponse(
          result && result.ok === false
            ? Object.assign({}, result, { error: result.translationError || "translation failed" })
            : result
        );
      } catch (e) {
        console.error("[imgtr] translateRegion failed:", e);
        sendResponse({ ok: false, error: String((e && e.message) || e) });
      }
    })();
    return true;
  }

  // Unknown action: answer exactly once so the caller's sendMessage promise
  // settles instead of rejecting with "message port closed".
  sendResponse({ ok: false, error: "unknown action: " + String((msg && msg.action) || "") });
  return false;
});
