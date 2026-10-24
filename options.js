// options.js — settings page.
//
// Stored shape (chrome.storage.local):
//   {
//     targetLang: "en",
//     showSelectionIcon: true,
//     showRomaji: true,          // 日语罗马音（仅 LLM 引擎返回）
//     shortcut: { enabled: true, alt: true, ctrl: false, shift: false, key: "t" },
//     engine: "google",            // "google" | "gemini" | "deepseek"
//     geminiApiKey: "",
//     deepseekApiKey: ""
//   }

// Chrome only exposes `chrome.*` in extension pages; Firefox exposes both.
if (typeof globalThis.browser === "undefined") globalThis.browser = chrome;

const DEFAULTS = {
  targetLang: "en",
  showSelectionIcon: true,
  showRomaji: true,
  shortcut: { enabled: true, alt: true, ctrl: false, shift: false, key: "t" },
  engine: "google",
  geminiApiKey: "",
  deepseekApiKey: "",
  geminiFallbackModel: "gemini-3.5-flash-lite"
};

const ENGINES = ["google", "gemini", "deepseek"];

// ---------------------------------------------------------------------------
// UI language
//
// The page is translated by the *target* language picker below: choosing
// "简体中文" makes the whole settings page Chinese. Two things must never
// follow it (see options.html):
//   - the #targetLang <option> texts, which stay in each language's own script;
//   - the "Target language" label, which is intentionally hard-coded English.
// Missing keys fall back to English, missing languages fall back to English.
// ---------------------------------------------------------------------------
const TRANSLATIONS = {
  en: {
    "page.title": "Image Translator (OCR) Settings",
    heading: "Image Translator (OCR)",
    "section.engine": "Translation engine",
    "section.translation": "Translation",
    "section.shortcut": "Shortcut",
    "engine.label": "Engine",
    "engine.google": "Google free endpoint (default)",
    "engine.note":
      "The Google free endpoint needs no API key. Gemini receives the selected image directly; DeepSeek cannot take images, so Lens OCR extracts the text first and only plain text is sent for translation.",
    "geminiKey.label": "Gemini API Key",
    "geminiKey.placeholderActive": "AIza...",
    "geminiKey.placeholderDisabled": "Only for the Gemini engine",
    "geminiKey.note":
      'Get one at <a href="https://aistudio.google.com/app/apikey" target="_blank" rel="noopener">Google AI Studio</a>.',
    "deepseekKey.label": "DeepSeek API Key",
    "deepseekKey.placeholderActive": "sk-...",
    "deepseekKey.placeholderDisabled": "Only for the DeepSeek engine",
    "deepseekKey.note":
      'Get one at <a href="https://platform.deepseek.com/api_keys" target="_blank" rel="noopener">DeepSeek Platform</a>.',
    "geminiFallback.label": "Gemini fallback model",
    "geminiFallback.placeholderActive": "gemini-3.5-flash-lite",
    "geminiFallback.placeholderDisabled": "Only for the Gemini engine",
    "geminiFallback.note":
      "Used automatically when the primary gemini-3.8-flash model still returns 429/503 after retries. Multiple models are allowed, separated by commas (e.g. gemini-3.5-flash-lite, gemini-3.6-flash).",
    "targetLang.note":
      "Target language for image OCR, region translation and text selection translation. The source language is detected automatically for every request.",
    "showIcon.label": "Show a translate icon next to selected text",
    "showIcon.note":
      'After you select text on a page, a small icon appears at the end of the selection — click it to translate. The context-menu "Translate" entry is always available.',
    "showRomaji.label": "Show Japanese romaji (only when Japanese is detected)",
    "showRomaji.note":
      "Romaji is provided by the AI engines (Gemini / DeepSeek) and appears in light grey below the original text. The Google free endpoint does not return romaji; this switch has no effect with the Google engine.",
    "shortcutEnabled.label": "Enable the region-translate shortcut",
    "shortcut.label": "Shortcut",
    "shortcut.placeholder": "Click here, then press the combination you want, e.g. Alt+T",
    "shortcut.note":
      "Click the field, then press the combination to record it. The shortcut does not fire while typing in an <input>, <textarea> or editable area.",
    "status.saved": "Saved",
    "status.cancelled": "Recording cancelled",
    "status.saveFailed": "Save failed: ",
    "status.readFailed": "Failed to read settings: "
  },

  "zh-CN": {
    "page.title": "Image Translator (OCR) 设置",
    heading: "Image Translator (OCR)",
    "section.engine": "翻译引擎",
    "section.translation": "翻译",
    "section.shortcut": "快捷键",
    "engine.label": "引擎",
    "engine.google": "Google 免费接口（默认）",
    "engine.note":
      "Google 免费接口不需要 API Key。Gemini 会把框选到的图片直接交给模型；DeepSeek 不支持图片输入，会先用 Lens OCR 提取文字，再把纯文本发给 DeepSeek 翻译。",
    "geminiKey.label": "Gemini API Key",
    "geminiKey.placeholderActive": "AIza...",
    "geminiKey.placeholderDisabled": "仅在 Gemini 引擎下填写",
    "geminiKey.note":
      '在 <a href="https://aistudio.google.com/app/apikey" target="_blank" rel="noopener">Google AI Studio</a> 申请。',
    "deepseekKey.label": "DeepSeek API Key",
    "deepseekKey.placeholderActive": "sk-...",
    "deepseekKey.placeholderDisabled": "仅在 DeepSeek 引擎下填写",
    "deepseekKey.note":
      '在 <a href="https://platform.deepseek.com/api_keys" target="_blank" rel="noopener">DeepSeek 开放平台</a> 申请。',
    "geminiFallback.label": "Gemini 备用模型",
    "geminiFallback.placeholderActive": "gemini-3.5-flash-lite",
    "geminiFallback.placeholderDisabled": "仅在 Gemini 引擎下填写",
    "geminiFallback.note":
      "主模型 gemini-3.8-flash 重试后仍返回 429/503 时自动切换。可以填多个，用英文逗号分隔（例如 gemini-3.5-flash-lite, gemini-3.6-flash）。",
    "targetLang.note":
      "用于图片 OCR、框选翻译和划词翻译的目标语言；源语言由每次请求自动识别。",
    "showIcon.label": "在选中文字旁显示翻译图标",
    "showIcon.note":
      "在网页上选中文字后，选区末尾会出现一个小图标，点它即可翻译；右键菜单里的「翻译」始终可用。",
    "showRomaji.label": "显示日语罗马音（仅在识别到日语时生效）",
    "showRomaji.note":
      "罗马音由 AI 引擎（Gemini / DeepSeek）提供，会以浅灰色小字显示在原文下方。Google 免费接口不返回罗马音，选择 Google 引擎时该开关不生效。",
    "shortcutEnabled.label": "启用框选翻译快捷键",
    "shortcut.label": "快捷键",
    "shortcut.placeholder": "点这里，然后按下想要的组合键，例如 Alt+T",
    "shortcut.note":
      "点击输入框后按下想用的组合键即可记录。在 <input>、<textarea> 或可编辑区域内输入时，快捷键不会触发。",
    "status.saved": "已保存",
    "status.cancelled": "已取消录制",
    "status.saveFailed": "保存失败：",
    "status.readFailed": "读取设置失败："
  },

  ja: {
    "page.title": "Image Translator (OCR) 設定",
    heading: "Image Translator (OCR)",
    "section.engine": "翻訳エンジン",
    "section.translation": "翻訳",
    "section.shortcut": "ショートカット",
    "engine.label": "エンジン",
    "engine.google": "Google 無料 API（デフォルト）",
    "engine.note":
      "Google 無料 API は API キー不要です。Gemini は選択した画像をそのままモデルに渡します。DeepSeek は画像入力に対応していないため、先に Lens OCR で文字を抽出し、テキストのみを送信して翻訳します。",
    "geminiKey.label": "Gemini API Key",
    "geminiKey.placeholderActive": "AIza...",
    "geminiKey.placeholderDisabled": "Gemini エンジン時のみ入力",
    "geminiKey.note":
      '<a href="https://aistudio.google.com/app/apikey" target="_blank" rel="noopener">Google AI Studio</a> で取得してください。',
    "deepseekKey.label": "DeepSeek API Key",
    "deepseekKey.placeholderActive": "sk-...",
    "deepseekKey.placeholderDisabled": "DeepSeek エンジン時のみ入力",
    "deepseekKey.note":
      '<a href="https://platform.deepseek.com/api_keys" target="_blank" rel="noopener">DeepSeek Platform</a> で取得してください。',
    "geminiFallback.label": "Gemini フォールバックモデル",
    "geminiFallback.placeholderActive": "gemini-3.5-flash-lite",
    "geminiFallback.placeholderDisabled": "Gemini エンジン時のみ入力",
    "geminiFallback.note":
      "メインの gemini-3.8-flash がリトライ後も 429/503 を返した場合に自動で切り替えます。カンマ区切りで複数指定できます（例: gemini-3.5-flash-lite, gemini-3.6-flash）。",
    "targetLang.note":
      "画像 OCR・範囲翻訳・選択テキスト翻訳の対象言語です。原文の言語はリクエストごとに自動判定されます。",
    "showIcon.label": "選択テキストの横に翻訳アイコンを表示",
    "showIcon.note":
      "ページ上でテキストを選択すると、選択範囲の末尾に小さいアイコンが表示されます。クリックで翻訳できます。右クリックメニューの「翻訳」は常に利用できます。",
    "showRomaji.label": "日本語のローマ字を表示（日本語を検出した場合のみ）",
    "showRomaji.note":
      "ローマ字は AI エンジン（Gemini / DeepSeek）が返し、原文の下に薄いグレーで表示されます。Google 無料 API はローマ字を返さないため、Google エンジンではこのスイッチは無効です。",
    "shortcutEnabled.label": "範囲翻訳ショートカットを有効にする",
    "shortcut.label": "ショートカット",
    "shortcut.placeholder": "ここをクリックして、使いたいキーの組み合わせを押してください（例: Alt+T）",
    "shortcut.note":
      "入力欄をクリックしてからキーの組み合わせを押すと記録されます。<input>・<textarea>・編集可能領域の入力中はショートカットは動作しません。",
    "status.saved": "保存しました",
    "status.cancelled": "録音をキャンセルしました",
    "status.saveFailed": "保存に失敗しました：",
    "status.readFailed": "設定の読み込みに失敗しました："
  }
};

let currentLang = "en";

function t(key) {
  const table = TRANSLATIONS[currentLang] || TRANSLATIONS.en;
  return table[key] || TRANSLATIONS.en[key] || "";
}

function applyLanguage(lang) {
  currentLang = TRANSLATIONS[lang] ? lang : "en";
  const table = TRANSLATIONS[currentLang];
  const get = (key) => table[key] || TRANSLATIONS.en[key] || "";
  document.documentElement.lang = currentLang;
  document.querySelectorAll("[data-i18n]").forEach((el) => {
    const text = get(el.dataset.i18n);
    if (text) el.textContent = text;
  });
  // Long notes contain links, so they are replaced as HTML fragments.
  document.querySelectorAll("[data-i18n-html]").forEach((el) => {
    const html = get(el.dataset.i18nHtml);
    if (html) el.innerHTML = html;
  });
  document.querySelectorAll("[data-i18n-placeholder]").forEach((el) => {
    const text = get(el.dataset.i18nPlaceholder);
    if (text) el.placeholder = text;
  });
  // Engine-dependent placeholders ("Only for the Gemini engine") are rendered
  // by renderEngineKeys() in the current language.
  renderEngineKeys();
}

const targetLangEl = document.getElementById("targetLang");
const showIconEl = document.getElementById("showSelectionIcon");
const showRomajiEl = document.getElementById("showRomaji");
const shortcutEnabledEl = document.getElementById("shortcutEnabled");
const shortcutKeyEl = document.getElementById("shortcutKey");
const engineEl = document.getElementById("engine");
const geminiKeyEl = document.getElementById("geminiApiKey");
const deepseekKeyEl = document.getElementById("deepseekApiKey");
const geminiFallbackEl = document.getElementById("geminiFallbackModel");
const statusEl = document.getElementById("status");

let shortcut = normalizeShortcut(DEFAULTS.shortcut);

// P2-28: snapshot of the API-key fields as last persisted, so the change+blur
// pair for one edit produces a single storage write.
let lastApiKeys = {
  geminiApiKey: "",
  deepseekApiKey: "",
  geminiFallbackModel: DEFAULTS.geminiFallbackModel
};

// P2-29: last persisted shortcut, restored when recording is cancelled by Esc.
let savedShortcut = normalizeShortcut(DEFAULTS.shortcut);

// NOTE (P2-30): hand-synced copy of the normalizer in content.js and
// background.js. A shared module would need manifest/HTML changes, so the rules
// below must stay identical in all three copies.
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

function normalizeEngine(raw) {
  return ENGINES.includes(raw) ? raw : "google";
}

function isModifierOnly(key) {
  return ["Alt", "Control", "Shift", "Meta", "OS"].includes(key);
}

function formatShortcut(s) {
  const parts = [];
  if (s.ctrl) parts.push("Ctrl");
  if (s.alt) parts.push("Alt");
  if (s.shift) parts.push("Shift");
  let key = s.key || "";
  if (key.length === 1) key = key.toUpperCase();
  parts.push(key);
  return parts.join(" + ");
}

function renderShortcut() {
  shortcutKeyEl.value = formatShortcut(shortcut);
  shortcutEnabledEl.checked = shortcut.enabled;
  shortcutKeyEl.disabled = !shortcut.enabled;
}

function renderEngineKeys() {
  const engine = normalizeEngine(engineEl.value);
  const isGemini = engine === "gemini";
  const isDeepSeek = engine === "deepseek";

  geminiKeyEl.disabled = !isGemini;
  deepseekKeyEl.disabled = !isDeepSeek;
  geminiFallbackEl.disabled = !isGemini;

  geminiKeyEl.placeholder = isGemini ? t("geminiKey.placeholderActive") : t("geminiKey.placeholderDisabled");
  deepseekKeyEl.placeholder = isDeepSeek
    ? t("deepseekKey.placeholderActive")
    : t("deepseekKey.placeholderDisabled");
  geminiFallbackEl.placeholder = isGemini
    ? t("geminiFallback.placeholderActive")
    : t("geminiFallback.placeholderDisabled");
}

let statusTimer = null;
function setStatus(text) {
  statusEl.textContent = text;
  if (statusTimer) clearTimeout(statusTimer);
  if (text) statusTimer = setTimeout(() => { statusEl.textContent = ""; }, 1200);
}

function readApiKeys() {
  return {
    geminiApiKey: geminiKeyEl.value.trim(),
    deepseekApiKey: deepseekKeyEl.value.trim(),
    geminiFallbackModel: geminiFallbackEl.value.trim() || DEFAULTS.geminiFallbackModel
  };
}

// P2-30: every storage write goes through here so a failure is reported in
// #status instead of surfacing as an unhandled promise rejection.
async function persist(patch) {
  try {
    await browser.storage.local.set(patch);
    setStatus(t("status.saved"));
    return true;
  } catch (e) {
    setStatus(t("status.saveFailed") + (e && e.message ? e.message : e));
    return false;
  }
}

async function load() {
  let stored;
  try {
    stored = await browser.storage.local.get(DEFAULTS);
  } catch (e) {
    // P2-30: a storage failure must be visible instead of silently showing defaults.
    setStatus(t("status.readFailed") + (e && e.message ? e.message : e));
    stored = { ...DEFAULTS };
  }
  targetLangEl.value = stored.targetLang || DEFAULTS.targetLang;
  showIconEl.checked = stored.showSelectionIcon !== false;
  showRomajiEl.checked = stored.showRomaji !== false;
  shortcut = normalizeShortcut(stored.shortcut);
  renderShortcut();

  engineEl.value = normalizeEngine(stored.engine);
  geminiKeyEl.value = typeof stored.geminiApiKey === "string" ? stored.geminiApiKey : "";
  deepseekKeyEl.value = typeof stored.deepseekApiKey === "string" ? stored.deepseekApiKey : "";
  geminiFallbackEl.value = (typeof stored.geminiFallbackModel === "string" && stored.geminiFallbackModel.trim())
    ? stored.geminiFallbackModel
    : DEFAULTS.geminiFallbackModel;
  // The page language follows the saved target language from the very first paint.
  applyLanguage(targetLangEl.value);
  renderEngineKeys();
  savedShortcut = { ...shortcut };
  lastApiKeys = readApiKeys();
}

async function saveShortcut() {
  const ok = await persist({ shortcut });
  if (ok) savedShortcut = { ...shortcut };
}

async function saveBasic() {
  await persist({
    targetLang: targetLangEl.value,
    showSelectionIcon: showIconEl.checked,
    showRomaji: showRomajiEl.checked
  });
}

async function saveEngine() {
  await persist({ engine: normalizeEngine(engineEl.value) });
}

async function saveApiKeys() {
  const patch = readApiKeys();
  // P2-28: change and blur both fire for one edit — write only when the
  // snapshot differs from what was last persisted.
  const unchanged =
    patch.geminiApiKey === lastApiKeys.geminiApiKey &&
    patch.deepseekApiKey === lastApiKeys.deepseekApiKey &&
    patch.geminiFallbackModel === lastApiKeys.geminiFallbackModel;
  if (unchanged) return;
  const ok = await persist(patch);
  if (ok) lastApiKeys = patch;
}

// --- basic settings ---------------------------------------------------------
targetLangEl.addEventListener("change", () => {
  // Switch the whole page immediately, then persist the choice.
  applyLanguage(targetLangEl.value);
  saveBasic();
});
showIconEl.addEventListener("change", saveBasic);
showRomajiEl.addEventListener("change", saveBasic);

// --- engine + API keys ------------------------------------------------------
engineEl.addEventListener("change", () => {
  renderEngineKeys();
  saveEngine();
});
geminiKeyEl.addEventListener("change", saveApiKeys);
deepseekKeyEl.addEventListener("change", saveApiKeys);
geminiFallbackEl.addEventListener("change", saveApiKeys);
// Also persist on blur in case a password manager fills the value without
// firing a change event.
geminiKeyEl.addEventListener("blur", saveApiKeys);
deepseekKeyEl.addEventListener("blur", saveApiKeys);
geminiFallbackEl.addEventListener("blur", saveApiKeys);

// --- shortcut enable/disable ------------------------------------------------
shortcutEnabledEl.addEventListener("change", () => {
  shortcut.enabled = shortcutEnabledEl.checked;
  shortcutKeyEl.disabled = !shortcut.enabled;
  saveShortcut();
});

// --- shortcut capture -------------------------------------------------------
shortcutKeyEl.addEventListener("focus", () => {
  shortcutKeyEl.select();
});

shortcutKeyEl.addEventListener("keydown", (e) => {
  // P2-29: Tab must keep moving focus instead of being recorded.
  if (e.key === "Tab") return;

  // P2-29: Esc cancels recording — restore the persisted combination and clear
  // the pending "Saved" auto-clear timer so it cannot outlive the cancel.
  if (e.key === "Escape") {
    e.preventDefault();
    e.stopPropagation();
    if (statusTimer) { clearTimeout(statusTimer); statusTimer = null; }
    shortcut = { ...savedShortcut };
    renderShortcut();
    setStatus(t("status.cancelled"));
    shortcutKeyEl.blur();
    return;
  }

  // Never let the browser act on the combination while recording it.
  e.preventDefault();
  e.stopPropagation();

  if (isModifierOnly(e.key)) {
    // Live preview of held modifiers; save only when a real key arrives.
    const parts = [];
    if (e.ctrlKey) parts.push("Ctrl");
    if (e.altKey) parts.push("Alt");
    if (e.shiftKey) parts.push("Shift");
    shortcutKeyEl.value = parts.length ? parts.join(" + ") + " + …" : formatShortcut(shortcut);
    return;
  }

  const key = (e.key || "").toLowerCase();
  if (!key || key === "unidentified" || key === "dead") return;

  shortcut = {
    enabled: shortcutEnabledEl.checked,
    alt: e.altKey,
    ctrl: e.ctrlKey,
    shift: e.shiftKey,
    key
  };
  renderShortcut();
  saveShortcut();
});

load();
