/*
 * popup.js — renders the current-chat and history estimates, drives the
 * background scan, and exposes advanced model assumptions.
 */
(function () {
  "use strict";

  // --- Preview fallback --------------------------------------------------
  // When opened as a plain file (no extension context), chrome.storage is
  // absent. Provide a tiny mock with sample data so the page still renders
  // for design review. Inert inside the real extension.
  if (typeof chrome === "undefined" || !chrome.storage) {
    const sampleStats = {
      totalMl: 284600, totalQueries: 18900, days: {},
      lastQuery: { ml: 18.7, tokens: 456, ts: Date.now() }, countedIds: [],
      lastScan: { ts: Date.now(), conversations: 189, failed: 0 }
    };
    const mock = {
      storage: {
        local: {
          get: (keys, cb) => cb({ aquaai_stats: sampleStats, aquaai_config: {} }),
          set: (_o, cb) => cb && cb()
        },
        onChanged: { addListener: () => {} }
      },
      runtime: { onMessage: { addListener: () => {} }, lastError: null },
      tabs: { query: (_q, cb) => cb([{ id: 1, url: "https://chatgpt.com/" }]), sendMessage: () => {} }
    };
    try {
      if (typeof chrome === "undefined") { globalThis.chrome = mock; }
      else { chrome.storage = mock.storage; chrome.runtime = chrome.runtime || mock.runtime; chrome.tabs = mock.tabs; }
    } catch (_) { globalThis.chrome = mock; }
  }

  const Estimator = globalThis.AquaAIEstimator;
  const STORAGE_CONFIG_KEY = "aquaai_config";
  const STORAGE_STATS_KEY = "aquaai_stats";
  const SCALE_USERS = 100000;
  const SCALE_PROMPTS_PER_USER = 10;
  const $ = (id) => document.getElementById(id);

  // --- Theme -------------------------------------------------------------
  function applyTheme(theme) {
    const root = document.documentElement;
    if (theme === "light" || theme === "dark") root.dataset.theme = theme;
    else delete root.dataset.theme; // "auto" → follow OS
  }
  function effectiveIsDark() {
    const t = document.documentElement.dataset.theme;
    if (t === "dark") return true;
    if (t === "light") return false;
    return window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
  }
  function toggleTheme() {
    const next = effectiveIsDark() ? "light" : "dark";
    applyTheme(next);
    const cfg = Object.assign({}, Estimator.DEFAULTS, currentConfig, { theme: next });
    currentConfig = cfg;
    chrome.storage.local.set({ [STORAGE_CONFIG_KEY]: cfg });
  }

  function setStat(prefix, ml) {
    const s = Estimator.splitVolume(ml, volumeUnit());
    $(prefix + "-val").textContent = s.value;
    $(prefix + "-unit").textContent = s.unit;
  }

  function volumeUnit() {
    return currentConfig.VOLUME_UNIT === "gallon" ? "gallon" : "metric";
  }

  function chatAdvice(ml, queries) {
    if (queries < 3) return "";
    if (queries < 8) return "When detail is not needed, ask for a concise answer.";
    if (ml < 100) return "Put context, format, and constraints in one prompt to avoid follow-ups.";
    return "This chat is growing. Put context, format, and constraints in your next prompt.";
  }

  function renderStats(stats) {
    stats = stats || { totalMl: 0, totalQueries: 0, days: {}, lastQuery: null };
    setStat("prompt", stats.lastQuery ? stats.lastQuery.ml : 0);
    setStat("total", stats.totalMl);
    const scan = stats.lastScan;
    if (!scan || !scan.conversations) {
      $("history-meta").textContent = "No history scan yet.";
      $("impact-message").textContent = "Scan history for a broader estimate.";
      $("history-scale").hidden = true;
      if (stats.lastQuery && stats.lastQuery.ml > 0) {
        $("scale-copy").textContent = `If ${SCALE_USERS.toLocaleString()} people sent a prompt like your last one:`;
        $("scale-total").textContent = Estimator.formatVolume(stats.lastQuery.ml * SCALE_USERS, volumeUnit());
        $("scale-scenario").hidden = false;
      } else {
        $("scale-scenario").hidden = true;
      }
      return;
    }
    const included = scan.conversations - (scan.failed || 0);
    const updated = new Date(scan.ts).toLocaleDateString(undefined, { month: "short", day: "numeric" });
    $("history-meta").textContent = `${included} ${included === 1 ? "chat" : "chats"} included · Updated ${updated}`;
    $("impact-message").textContent = Estimator.compactingTip(stats.totalMl, stats.totalQueries);
    $("history-scale").textContent = `For scale: ${Estimator.relatableEquivalent(stats.totalMl)}.`;
    $("history-scale").hidden = false;
    if (stats.totalQueries > 0) {
      const projectedMl = (stats.totalMl / stats.totalQueries) * SCALE_USERS * SCALE_PROMPTS_PER_USER;
      $("scale-copy").textContent = `If ${SCALE_USERS.toLocaleString()} people made ${SCALE_PROMPTS_PER_USER} prompts at your average estimated rate:`;
      $("scale-total").textContent = Estimator.formatVolume(projectedMl, volumeUnit());
      $("scale-scenario").hidden = false;
    } else {
      $("scale-scenario").hidden = true;
    }
  }

  function renderConfig(cfg) {
    cfg = Object.assign({}, Estimator.DEFAULTS, cfg || {});
    $("cfg-base").value = cfg.BASE_ML_PER_QUERY;
    $("cfg-perk").value = cfg.ML_PER_1K_TOKENS;
    $("unit-select").value = cfg.VOLUME_UNIT === "gallon" ? "gallon" : "metric";
  }

  function renderEstimationControl(cfg) {
    const enabled = cfg.ESTIMATION_ENABLED !== false;
    const button = $("estimation-toggle");
    button.classList.toggle("is-paused", !enabled);
    button.setAttribute("aria-pressed", String(!enabled));
    $("estimation-toggle-label").textContent = enabled ? "Pause water estimates" : "Resume water estimates";
    $("estimation-status").textContent = enabled
      ? "New ChatGPT turns are being estimated."
      : "Paused. New turns will not be estimated or added later.";
    $("scan").disabled = !enabled;
  }

  let currentConfig = {};
  function load() {
    chrome.storage.local.get([STORAGE_CONFIG_KEY, STORAGE_STATS_KEY], (res) => {
      currentConfig = res[STORAGE_CONFIG_KEY] || {};
      applyTheme(currentConfig.theme || "auto");
      renderStats(res[STORAGE_STATS_KEY]);
      renderConfig(currentConfig);
      renderEstimationControl(Object.assign({}, Estimator.DEFAULTS, currentConfig));
    });
  }

  // Ask the active ChatGPT tab how much water the open conversation has used.
  function loadCurrentChat() {
    if (!chrome.tabs || !chrome.tabs.query) return;
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs && tabs[0];
      if (!tab || !CHATGPT_RE.test(tab.url || "")) return;
      chrome.tabs.sendMessage(tab.id, { type: "AQUAAI_GET_CHAT" }, (resp) => {
        void chrome.runtime.lastError;
        if (!resp || !resp.convId) return;
        const s = Estimator.splitVolume(resp.ml, volumeUnit());
        $("chat-val").textContent = s.value;
        $("chat-unit").textContent = s.unit;
        $("chat-queries").textContent = `${resp.queries} ${resp.queries === 1 ? "query" : "queries"} this chat`;
        const advice = chatAdvice(resp.ml, resp.queries);
        $("chat-guidance").textContent = advice;
        $("chat-guidance").hidden = !advice;
      });
    });
  }

  function saveConfig() {
    const base = parseFloat($("cfg-base").value);
    const perk = parseFloat($("cfg-perk").value);
    const D = Estimator.DEFAULTS;
    const cfg = Object.assign({}, D, currentConfig, {
      BASE_ML_PER_QUERY: isFinite(base) && base >= 0 ? base : D.BASE_ML_PER_QUERY,
      ML_PER_1K_TOKENS: isFinite(perk) && perk >= 0 ? perk : D.ML_PER_1K_TOKENS
    });
    chrome.storage.local.set({ [STORAGE_CONFIG_KEY]: cfg }, () => {
      currentConfig = cfg;
      const msg = $("saved-msg");
      msg.hidden = false;
      setTimeout(() => (msg.hidden = true), 1500);
      load();
    });
  }

  function resetConfig() {
    const d = Object.assign({}, Estimator.DEFAULTS);
    chrome.storage.local.set({ [STORAGE_CONFIG_KEY]: d }, () => { currentConfig = d; renderConfig(d); load(); });
  }

  function toggleEstimation() {
    const cfg = Object.assign({}, Estimator.DEFAULTS, currentConfig, {
      ESTIMATION_ENABLED: currentConfig.ESTIMATION_ENABLED === false
    });
    chrome.storage.local.set({ [STORAGE_CONFIG_KEY]: cfg }, () => {
      currentConfig = cfg;
      renderEstimationControl(cfg);
    });
  }

  function updateUnit() {
    const cfg = Object.assign({}, Estimator.DEFAULTS, currentConfig, {
      VOLUME_UNIT: $("unit-select").value === "gallon" ? "gallon" : "metric"
    });
    chrome.storage.local.set({ [STORAGE_CONFIG_KEY]: cfg }, () => {
      currentConfig = cfg;
      load();
      loadCurrentChat();
    });
  }

  function resetStats() {
    if (!confirm("Reset all recorded water-consumption data? This cannot be undone.")) return;
    const empty = { totalMl: 0, totalQueries: 0, days: {}, lastQuery: null, countedIds: [] };
    chrome.storage.local.set({ [STORAGE_STATS_KEY]: empty }, () => renderStats(empty));
  }

  // --- Background scan ---------------------------------------------------
  const CHATGPT_RE = /^https:\/\/(chatgpt\.com|chat\.openai\.com)\//;
  function setScanStatus(text) { $("scan-status").textContent = text; }

  function startScan() {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs && tabs[0];
      if (!tab || !CHATGPT_RE.test(tab.url || "")) {
        setScanStatus("Open a ChatGPT tab first, then click Scan.");
        return;
      }
      $("scan").disabled = true;
      setScanStatus("Preparing history estimate…");
      chrome.tabs.sendMessage(tab.id, { type: "AQUAAI_SCAN" }, () => { void chrome.runtime.lastError; });
    });
  }

  function onScanMessage(msg) {
    if (!msg) return;
    if (msg.type === "AQUAAI_SCAN_PROGRESS") {
      if (msg.phase === "auth") setScanStatus("Preparing scan…");
      else if (msg.phase === "list") setScanStatus(`Finding chats… ${msg.done} found`);
      else setScanStatus(`Estimating chats… ${msg.done}/${msg.total}`);
    } else if (msg.type === "AQUAAI_SCAN_DONE") {
      $("scan").disabled = false;
      if (!msg.total) setScanStatus("No conversations found.");
      else if (msg.failed) setScanStatus(`${msg.total - msg.failed}/${msg.total} chats included. Try again later for the rest.`);
      else setScanStatus(`History estimate ready · ${msg.total} chats included.`);
    } else if (msg.type === "AQUAAI_SCAN_ERROR") {
      $("scan").disabled = false;
      setScanStatus(msg.error === "estimation is paused" ? "Resume estimates to scan history." : "History scan stopped. Try again later.");
    }
  }

  document.addEventListener("DOMContentLoaded", () => {
    load();
    loadCurrentChat();
    $("save").addEventListener("click", saveConfig);
    $("reset-cfg").addEventListener("click", resetConfig);
    $("reset-stats").addEventListener("click", resetStats);
    $("estimation-toggle").addEventListener("click", toggleEstimation);
    $("unit-select").addEventListener("change", updateUnit);
    $("scan").addEventListener("click", startScan);
    $("theme-toggle").addEventListener("click", toggleTheme);
    $("settings-toggle").addEventListener("click", () => {
      const s = $("settings");
      s.hidden = !s.hidden;
    });

    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === "local" && changes[STORAGE_STATS_KEY]) {
        renderStats(changes[STORAGE_STATS_KEY].newValue);
        loadCurrentChat();
      }
    });
    chrome.runtime.onMessage.addListener(onScanMessage);
  });
})();
