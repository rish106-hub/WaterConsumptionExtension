/*
 * popup.js — renders the dashboard (This Prompt / Today + donut / Weekly Trend
 * line chart / Lifetime), drives the background history scan, and exposes the
 * model settings. estimator.js loads first (see popup.html).
 */
(function () {
  "use strict";

  // --- Preview fallback --------------------------------------------------
  // When opened as a plain file (no extension context), chrome.storage is
  // absent. Provide a tiny mock with sample data so the page still renders
  // for design review. Inert inside the real extension.
  if (typeof chrome === "undefined" || !chrome.storage) {
    const sampleDays = {};
    const demo = [1200, 1900, 900, 2400, 1500, 2100, 2430];
    const base = new Date();
    demo.forEach((ml, i) => {
      const d = new Date(base);
      d.setDate(base.getDate() - (demo.length - 1 - i));
      const k = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      sampleDays[k] = { ml: ml, queries: Math.round(ml / 15) };
    });
    const sampleStats = {
      totalMl: 284600, totalQueries: 18900, days: sampleDays,
      lastQuery: { ml: 18.7, tokens: 456, ts: Date.now() }, countedIds: []
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
  const DONUT_CIRC = 2 * Math.PI * 27; // r=27 in the SVG

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

  function dayKey(d) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }
  function todayKey() { return dayKey(new Date()); }

  function setStat(prefix, ml) {
    const s = Estimator.splitVolume(ml);
    $(prefix + "-val").textContent = s.value;
    $(prefix + "-unit").textContent = s.unit;
  }

  // Last 7 days (oldest → newest) of { label, ml }.
  function last7(stats) {
    const out = [];
    const now = new Date();
    const wd = ["S", "M", "T", "W", "T", "F", "S"];
    for (let i = 6; i >= 0; i--) {
      const d = new Date(now);
      d.setDate(now.getDate() - i);
      const day = stats.days[dayKey(d)];
      out.push({ label: wd[d.getDay()], ml: day ? day.ml : 0 });
    }
    return out;
  }

  function renderTrend(stats) {
    const data = last7(stats);
    const W = 300, H = 96, pad = 8;
    const max = Math.max(1, ...data.map((d) => d.ml));
    const stepX = (W - pad * 2) / (data.length - 1);
    const pts = data.map((d, i) => {
      const x = pad + i * stepX;
      const y = H - pad - (d.ml / max) * (H - pad * 2);
      return [x, y];
    });
    const line = pts.map((p, i) => (i ? "L" : "M") + p[0].toFixed(1) + " " + p[1].toFixed(1)).join(" ");
    const area = `${line} L ${pts[pts.length - 1][0].toFixed(1)} ${H} L ${pts[0][0].toFixed(1)} ${H} Z`;
    $("trend-line").setAttribute("d", line);
    $("trend-area").setAttribute("d", area);
    $("trend-labels").innerHTML = data.map((d) => `<span>${d.label}</span>`).join("");

    // Delta: today vs yesterday, framed so "down" is good (green).
    const today = data[6].ml, prev = data[5].ml;
    const el = $("trend-delta");
    if (prev === 0 && today === 0) { el.textContent = ""; el.className = "trend-delta"; return; }
    if (prev === 0) { el.textContent = "▲ new"; el.className = "trend-delta up"; return; }
    const pct = Math.round(((today - prev) / prev) * 100);
    if (pct === 0) { el.textContent = "— flat"; el.className = "trend-delta"; }
    else if (pct > 0) { el.textContent = `▲ ${pct}% vs yesterday`; el.className = "trend-delta up"; }
    else { el.textContent = `▼ ${Math.abs(pct)}% vs yesterday`; el.className = "trend-delta down"; }
  }

  function renderStats(stats, cfg) {
    stats = stats || { totalMl: 0, totalQueries: 0, days: {}, lastQuery: null };
    cfg = Object.assign({}, Estimator.DEFAULTS, cfg || {});
    const day = stats.days[todayKey()] || { ml: 0, queries: 0 };

    setStat("prompt", stats.lastQuery ? stats.lastQuery.ml : 0);
    setStat("today", day.ml);
    setStat("total", stats.totalMl);

    $("today-queries").textContent = `${day.queries} ${day.queries === 1 ? "query" : "queries"} today`;
    $("total-queries").textContent = `${stats.totalQueries} ${stats.totalQueries === 1 ? "query" : "queries"} all time`;

    // Donut = today vs daily goal.
    const goal = cfg.DAILY_GOAL_ML || Estimator.DEFAULTS.DAILY_GOAL_ML;
    const pct = Math.max(0, Math.min(100, Math.round((day.ml / goal) * 100)));
    $("donut-arc").setAttribute("stroke-dasharray", `${(pct / 100) * DONUT_CIRC} ${DONUT_CIRC}`);
    $("donut-pct").textContent = pct + "%";

    renderTrend(stats);
  }

  function renderConfig(cfg) {
    cfg = Object.assign({}, Estimator.DEFAULTS, cfg || {});
    $("cfg-base").value = cfg.BASE_ML_PER_QUERY;
    $("cfg-perk").value = cfg.ML_PER_1K_TOKENS;
    $("cfg-goal").value = cfg.DAILY_GOAL_ML;
  }

  let currentConfig = {};
  function load() {
    chrome.storage.local.get([STORAGE_CONFIG_KEY, STORAGE_STATS_KEY], (res) => {
      currentConfig = res[STORAGE_CONFIG_KEY] || {};
      applyTheme(currentConfig.theme || "auto");
      renderStats(res[STORAGE_STATS_KEY], currentConfig);
      renderConfig(currentConfig);
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
        if (!resp || !resp.convId || !resp.ml) return;
        const s = Estimator.splitVolume(resp.ml);
        $("chat-val").textContent = s.value;
        $("chat-unit").textContent = s.unit;
        $("chat-queries").textContent = `${resp.queries} ${resp.queries === 1 ? "query" : "queries"} this chat`;
        $("chat-card").hidden = false;
      });
    });
  }

  function saveConfig() {
    const base = parseFloat($("cfg-base").value);
    const perk = parseFloat($("cfg-perk").value);
    const goal = parseFloat($("cfg-goal").value);
    const D = Estimator.DEFAULTS;
    const cfg = Object.assign({}, D, {
      BASE_ML_PER_QUERY: isFinite(base) && base >= 0 ? base : D.BASE_ML_PER_QUERY,
      ML_PER_1K_TOKENS: isFinite(perk) && perk >= 0 ? perk : D.ML_PER_1K_TOKENS,
      DAILY_GOAL_ML: isFinite(goal) && goal >= 100 ? goal : D.DAILY_GOAL_ML
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

  function resetStats() {
    if (!confirm("Reset all recorded water-consumption data? This cannot be undone.")) return;
    const empty = { totalMl: 0, totalQueries: 0, days: {}, lastQuery: null, countedIds: [] };
    chrome.storage.local.set({ [STORAGE_STATS_KEY]: empty }, () => renderStats(empty, currentConfig));
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
      setScanStatus("Starting… this runs in the background; you can keep working.");
      chrome.tabs.sendMessage(tab.id, { type: "AQUAAI_SCAN" }, () => { void chrome.runtime.lastError; });
    });
  }

  function onScanMessage(msg) {
    if (!msg) return;
    if (msg.type === "AQUAAI_SCAN_PROGRESS") {
      if (msg.phase === "auth") setScanStatus("Authorizing with your ChatGPT session…");
      else if (msg.phase === "list") setScanStatus(`Finding conversations… ${msg.done} so far`);
      else setScanStatus(`Reading chats… ${msg.done}/${msg.total}`);
    } else if (msg.type === "AQUAAI_SCAN_DONE") {
      $("scan").disabled = false;
      setScanStatus(msg.total ? `Done — scanned ${msg.total} conversations.` : "No conversations found.");
    } else if (msg.type === "AQUAAI_SCAN_ERROR") {
      $("scan").disabled = false;
      setScanStatus("Scan failed: " + msg.error + ". Make sure you're signed in to ChatGPT.");
    }
  }

  document.addEventListener("DOMContentLoaded", () => {
    load();
    loadCurrentChat();
    $("save").addEventListener("click", saveConfig);
    $("reset-cfg").addEventListener("click", resetConfig);
    $("reset-stats").addEventListener("click", resetStats);
    $("scan").addEventListener("click", startScan);
    $("theme-toggle").addEventListener("click", toggleTheme);
    $("settings-toggle").addEventListener("click", () => {
      const s = $("settings");
      s.hidden = !s.hidden;
    });

    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === "local" && changes[STORAGE_STATS_KEY]) {
        renderStats(changes[STORAGE_STATS_KEY].newValue, currentConfig);
      }
    });
    chrome.runtime.onMessage.addListener(onScanMessage);
  });
})();
