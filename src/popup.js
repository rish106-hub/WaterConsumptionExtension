/*
 * popup.js — toolbar popup: shows totals, a relatable equivalent, and lets the
 * user tune the model factors or reset data. estimator.js is loaded first
 * (see popup.html) so globalThis.AquaAIEstimator is available.
 */
(function () {
  "use strict";

  const Estimator = globalThis.AquaAIEstimator;
  const STORAGE_CONFIG_KEY = "aquaai_config";
  const STORAGE_STATS_KEY = "aquaai_stats";

  const $ = (id) => document.getElementById(id);

  function todayKey() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }

  function renderStats(stats) {
    stats = stats || { totalMl: 0, totalQueries: 0, days: {}, lastQuery: null };
    const day = stats.days[todayKey()] || { ml: 0, queries: 0 };

    $("today").textContent = Estimator.formatVolume(day.ml);
    $("today-queries").textContent = `${day.queries} ${day.queries === 1 ? "query" : "queries"}`;
    $("total").textContent = Estimator.formatVolume(stats.totalMl);
    $("total-queries").textContent = `${stats.totalQueries} ${stats.totalQueries === 1 ? "query" : "queries"}`;
    $("last").textContent = stats.lastQuery ? Estimator.formatVolume(stats.lastQuery.ml) : "–";
    $("equiv").textContent = "Today ≈ " + Estimator.relatableEquivalent(day.ml);
  }

  function renderConfig(cfg) {
    cfg = Object.assign({}, Estimator.DEFAULTS, cfg || {});
    $("cfg-base").value = cfg.BASE_ML_PER_QUERY;
    $("cfg-perk").value = cfg.ML_PER_1K_TOKENS;
  }

  function load() {
    chrome.storage.local.get([STORAGE_CONFIG_KEY, STORAGE_STATS_KEY], (res) => {
      renderStats(res[STORAGE_STATS_KEY]);
      renderConfig(res[STORAGE_CONFIG_KEY]);
    });
  }

  function saveConfig() {
    const base = parseFloat($("cfg-base").value);
    const perk = parseFloat($("cfg-perk").value);
    const cfg = Object.assign({}, Estimator.DEFAULTS, {
      BASE_ML_PER_QUERY: isFinite(base) && base >= 0 ? base : Estimator.DEFAULTS.BASE_ML_PER_QUERY,
      ML_PER_1K_TOKENS: isFinite(perk) && perk >= 0 ? perk : Estimator.DEFAULTS.ML_PER_1K_TOKENS
    });
    chrome.storage.local.set({ [STORAGE_CONFIG_KEY]: cfg }, () => {
      const msg = $("saved-msg");
      msg.hidden = false;
      setTimeout(() => (msg.hidden = true), 1500);
    });
  }

  function resetConfig() {
    chrome.storage.local.set({ [STORAGE_CONFIG_KEY]: Object.assign({}, Estimator.DEFAULTS) }, () => {
      renderConfig(Estimator.DEFAULTS);
    });
  }

  function setScanStatus(text) {
    $("scan-status").textContent = text;
  }

  const CHATGPT_RE = /^https:\/\/(chatgpt\.com|chat\.openai\.com)\//;

  function startScan() {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs && tabs[0];
      const url = (tab && tab.url) || "";
      if (!CHATGPT_RE.test(url)) {
        setScanStatus("Open a ChatGPT tab first, then click Scan.");
        return;
      }
      $("scan").disabled = true;
      setScanStatus("Scanning… keep this ChatGPT tab open and in focus.");
      chrome.tabs.sendMessage(tab.id, { type: "AQUAAI_SCAN" }, () => {
        // Ignore lastError: the content script may still be waking up.
        void chrome.runtime.lastError;
      });
    });
  }

  function resetStats() {
    if (!confirm("Reset all recorded water-consumption data? This cannot be undone.")) return;
    const empty = { totalMl: 0, totalQueries: 0, days: {}, lastQuery: null };
    chrome.storage.local.set({ [STORAGE_STATS_KEY]: empty }, () => renderStats(empty));
  }

  document.addEventListener("DOMContentLoaded", () => {
    load();
    $("save").addEventListener("click", saveConfig);
    $("reset-cfg").addEventListener("click", resetConfig);
    $("reset-stats").addEventListener("click", resetStats);
    $("scan").addEventListener("click", startScan);

    // Live refresh if a query lands while the popup is open.
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === "local" && changes[STORAGE_STATS_KEY]) {
        renderStats(changes[STORAGE_STATS_KEY].newValue);
      }
    });

    // Progress updates from the content script's sidebar scan.
    chrome.runtime.onMessage.addListener((msg) => {
      if (!msg) return;
      if (msg.type === "AQUAAI_SCAN_PROGRESS") {
        setScanStatus(`Scanning… ${msg.done}/${msg.total} chats`);
      } else if (msg.type === "AQUAAI_SCAN_DONE") {
        $("scan").disabled = false;
        setScanStatus(
          msg.total
            ? `Done — scanned ${msg.total} chat${msg.total === 1 ? "" : "s"}. Totals updated.`
            : "No conversations found in the sidebar to scan."
        );
      }
    });
  });
})();
