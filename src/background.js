/*
 * background.js — MV3 service worker.
 *
 * Lightweight: keeps the toolbar badge in sync with cumulative water use and
 * initialises default config on install. All heavy logic lives in the content
 * script; the worker is event-driven and may be torn down at any time.
 */
"use strict";

const STORAGE_CONFIG_KEY = "aquaai_config";
const STORAGE_STATS_KEY = "aquaai_stats";

// Mirror of estimator.js DEFAULTS (service worker can't share the content
// script global). Keep in sync if the model constants change.
const DEFAULT_CONFIG = {
  BASE_ML_PER_QUERY: 5,
  ML_PER_1K_TOKENS: 30,
  CHARS_PER_TOKEN: 4,
  ASSUMED_TOKENS_WHEN_UNKNOWN: 300
};

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.get([STORAGE_CONFIG_KEY, STORAGE_STATS_KEY], (res) => {
    const patch = {};
    if (!res[STORAGE_CONFIG_KEY]) patch[STORAGE_CONFIG_KEY] = DEFAULT_CONFIG;
    if (!res[STORAGE_STATS_KEY]) {
      patch[STORAGE_STATS_KEY] = {
        totalMl: 0,
        totalQueries: 0,
        days: {},
        lastQuery: null
      };
    }
    if (Object.keys(patch).length) chrome.storage.local.set(patch);
  });
});

function formatBadge(ml) {
  if (!ml || ml <= 0) return "";
  if (ml < 1000) return `${Math.round(ml)}`;      // e.g. "420"
  return `${(ml / 1000).toFixed(1)}L`;            // e.g. "1.3L"
}

function refreshBadge(todayMl) {
  const text = formatBadge(todayMl);
  chrome.action.setBadgeText({ text });
  chrome.action.setBadgeBackgroundColor({ color: "#1e88e5" });
}

// Update badge when the content script records a query…
chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === "AQUAAI_STATS_UPDATED") {
    refreshBadge(msg.todayMl);
  }
});

// …and also whenever storage changes (e.g. reset from popup, or day rollover).
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes[STORAGE_STATS_KEY]) return;
  const stats = changes[STORAGE_STATS_KEY].newValue;
  if (!stats) {
    refreshBadge(0);
    return;
  }
  const d = new Date();
  const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const today = stats.days && stats.days[key] ? stats.days[key].ml : 0;
  refreshBadge(today);
});
