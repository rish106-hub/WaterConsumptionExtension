/*
 * content.js — runs in the isolated world on ChatGPT pages.
 *
 * Responsibilities:
 *   1. Inject injected.js into the page's main world (for the API in-flight
 *      signal).
 *   2. Watch the conversation DOM and detect each COMPLETED assistant
 *      response (this is the single source of truth for counting/measuring).
 *   3. Estimate water via AquaAIEstimator using the user's saved config.
 *   4. Persist per-query events + cumulative totals to chrome.storage.local.
 *   5. Render a small, non-intrusive floating overlay with live feedback.
 *
 * estimator.js is guaranteed to have loaded first (see manifest content_scripts
 * order), so globalThis.AquaAIEstimator is available.
 */
(function () {
  "use strict";

  const Estimator = globalThis.AquaAIEstimator;
  const STORAGE_CONFIG_KEY = "aquaai_config";
  const STORAGE_STATS_KEY = "aquaai_stats";

  // Selectors kept together so a ChatGPT UI change is a one-place edit.
  const SELECTORS = {
    assistantMessage: '[data-message-author-role="assistant"]'
  };

  let config = Object.assign({}, Estimator.DEFAULTS);
  const counted = new Set();           // message ids already counted (persisted)
  const finalizeTimers = new Map();    // message id -> debounce timer
  const STREAM_IDLE_MS = 1200;         // "response finished" heuristic
  const BOOT_WINDOW_MS = 4000;         // messages seen this soon after load are
                                       // treated as EXISTING history, not new
                                       // queries (so they hit all-time, not today)
  let bootAt = Date.now();             // reset on each conversation switch
  let writeChain = Promise.resolve();  // serialises storage read-modify-writes
  let inFlight = false;

  // ---------------------------------------------------------------------
  // Main-world injection + signal bridge
  // ---------------------------------------------------------------------
  function injectMainWorldScript() {
    try {
      const s = document.createElement("script");
      s.src = chrome.runtime.getURL("src/injected.js");
      s.onload = () => s.remove();
      (document.head || document.documentElement).appendChild(s);
    } catch (e) {
      // Non-fatal: DOM detection still works without the API hook.
      console.debug("[AquaAI] main-world inject skipped:", e);
    }
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.__aquaai !== true) return;
    if (data.type === "QUERY_SENT") {
      inFlight = true;
      UI.setCalculating(true);
    }
  });

  // ---------------------------------------------------------------------
  // Storage helpers
  // ---------------------------------------------------------------------
  function todayKey() {
    // Local date, YYYY-MM-DD
    const d = new Date();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${d.getFullYear()}-${m}-${day}`;
  }

  function blankStats() {
    return { totalMl: 0, totalQueries: 0, days: {}, lastQuery: null, countedIds: [] };
  }

  /**
   * Persist one or more query events. Serialised via writeChain so concurrent
   * finalisations can't clobber each other's read-modify-write.
   * @param {Array<{id:string, result:{ml:number, tokens:number}}>} events
   * @param {boolean} live  true = a query made right now (counts toward "today"
   *                        and becomes "last"); false = backfilled history
   *                        (counts toward all-time totals only).
   */
  function recordEvents(events, live) {
    if (!events || !events.length) return;
    writeChain = writeChain.then(
      () =>
        new Promise((resolve) => {
          chrome.storage.local.get([STORAGE_STATS_KEY], (res) => {
            const stats = Object.assign(blankStats(), res[STORAGE_STATS_KEY] || {});
            if (!Array.isArray(stats.countedIds)) stats.countedIds = [];
            const persisted = new Set(stats.countedIds);
            const key = todayKey();
            const day = stats.days[key] || { ml: 0, queries: 0 };
            let added = 0;

            for (const ev of events) {
              if (persisted.has(ev.id)) continue; // already counted on a prior load
              persisted.add(ev.id);
              stats.countedIds.push(ev.id);
              stats.totalMl = Math.round((stats.totalMl + ev.result.ml) * 100) / 100;
              stats.totalQueries += 1;
              added++;
              if (live) {
                day.ml = Math.round((day.ml + ev.result.ml) * 100) / 100;
                day.queries += 1;
                stats.lastQuery = { ml: ev.result.ml, tokens: ev.result.tokens, ts: Date.now() };
              }
            }

            if (!added) return resolve();
            if (live) stats.days[key] = day;

            chrome.storage.local.set({ [STORAGE_STATS_KEY]: stats }, () => {
              UI.render(stats);
              const todayMl = stats.days[key] ? stats.days[key].ml : 0;
              try {
                chrome.runtime.sendMessage({
                  type: "AQUAAI_STATS_UPDATED",
                  totalMl: stats.totalMl,
                  todayMl: todayMl
                });
              } catch (_) {}
              resolve();
            });
          });
        })
    );
  }

  // ---------------------------------------------------------------------
  // Detection: finalize an assistant message once it stops streaming
  // ---------------------------------------------------------------------
  function messageId(node) {
    return node.getAttribute("data-message-id") || null;
  }

  function scheduleFinalize(node) {
    const id = messageId(node);
    if (!id || counted.has(id)) return;

    if (finalizeTimers.has(id)) clearTimeout(finalizeTimers.get(id));
    const timer = setTimeout(() => {
      finalizeTimers.delete(id);
      if (counted.has(id)) return;
      counted.add(id);

      const text = (node.innerText || "").trim();
      const result = Estimator.estimateWater({ responseText: text, config: config });
      inFlight = false;
      UI.setCalculating(false);
      // Messages that surface within the boot window are pre-existing history
      // still rendering — count them toward all-time, not toward "today".
      const live = Date.now() - bootAt > BOOT_WINDOW_MS;
      recordEvents([{ id: id, result: result }], live);
    }, STREAM_IDLE_MS);
    finalizeTimers.set(id, timer);
  }

  function scanForAssistantMessages(root) {
    const nodes = (root || document).querySelectorAll
      ? (root || document).querySelectorAll(SELECTORS.assistantMessage)
      : [];
    nodes.forEach(scheduleFinalize);
  }

  /**
   * On load, immediately tally every assistant message already in the open
   * conversation (de-duplicated against what was counted on prior visits), so
   * the all-time total reflects your existing ChatGPT history. Each new
   * conversation you open adds itself the first time you see it.
   */
  function backfillExisting() {
    const events = [];
    document.querySelectorAll(SELECTORS.assistantMessage).forEach((node) => {
      const id = messageId(node);
      if (!id || counted.has(id)) return;
      counted.add(id);
      const text = (node.innerText || "").trim();
      events.push({ id: id, result: Estimator.estimateWater({ responseText: text, config: config }) });
    });
    recordEvents(events, false); // history → all-time totals only
  }

  // ---------------------------------------------------------------------
  // "Scan recent chats" — drive ChatGPT's own sidebar to backfill many
  // conversations at once. Triggered by a message from the popup.
  //
  // This is inherently a bit fragile: it clicks ChatGPT's UI, so a redesign
  // of the sidebar could break it. Selectors are kept here for easy fixing.
  // ---------------------------------------------------------------------
  const SCAN = {
    sidebarLink: 'nav a[href^="/c/"], a[href^="/c/"]',
    sidebarScroll: "nav"
  };
  let scanning = false;

  function wait(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  function broadcast(msg) {
    try { chrome.runtime.sendMessage(msg); } catch (_) {}
  }

  function collectChatHrefs() {
    const seen = new Set();
    const hrefs = [];
    document.querySelectorAll(SCAN.sidebarLink).forEach((a) => {
      const href = a.getAttribute("href");
      if (href && href.indexOf("/c/") === 0 && !seen.has(href)) {
        seen.add(href);
        hrefs.push(href);
      }
    });
    return hrefs;
  }

  async function waitForConversation(href, timeoutMs) {
    const deadline = Date.now() + (timeoutMs || 6000);
    while (Date.now() < deadline) {
      const arrived = location.pathname.indexOf(href) !== -1;
      const hasMsg = document.querySelector(SELECTORS.assistantMessage);
      if (arrived && hasMsg) return true;
      await wait(200);
    }
    return false;
  }

  async function runScan() {
    if (scanning) return;
    scanning = true;
    try {
      // Load more of the list by scrolling the sidebar a few times.
      const nav = document.querySelector(SCAN.sidebarScroll);
      for (let i = 0; i < 6 && nav; i++) {
        nav.scrollTop = nav.scrollHeight;
        await wait(400);
      }

      const hrefs = collectChatHrefs();
      let done = 0;
      broadcast({ type: "AQUAAI_SCAN_PROGRESS", done: done, total: hrefs.length });

      for (const href of hrefs) {
        let link;
        try { link = document.querySelector('a[href="' + CSS.escape(href) + '"]'); }
        catch (_) { link = null; }
        if (link) {
          link.click();                         // SPA navigation
          await waitForConversation(href);
          bootAt = Date.now();                  // count as history, not "today"
          backfillExisting();
          await wait(700);                       // let long threads finish rendering
          backfillExisting();                    // catch late rows
        }
        done++;
        broadcast({ type: "AQUAAI_SCAN_PROGRESS", done: done, total: hrefs.length });
      }
      broadcast({ type: "AQUAAI_SCAN_DONE", total: hrefs.length });
    } finally {
      scanning = false;
    }
  }

  function startObserver() {
    const observer = new MutationObserver((mutations) => {
      for (const mut of mutations) {
        // A growing/finished assistant message triggers either childList or
        // characterData changes; re-arm its finalize timer.
        if (mut.target && mut.target.nodeType === 1) {
          const el = /** @type {Element} */ (mut.target);
          const msg = el.closest
            ? el.closest(SELECTORS.assistantMessage)
            : null;
          if (msg) scheduleFinalize(msg);
        }
        mut.addedNodes &&
          mut.addedNodes.forEach((n) => {
            if (n.nodeType === 1) scanForAssistantMessages(n);
          });
      }
    });
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true
    });
  }

  // ---------------------------------------------------------------------
  // Floating overlay UI (non-intrusive, collapsible)
  // ---------------------------------------------------------------------
  const UI = (function () {
    let root;            // #aquaai-wrap — the bar + popover, docked at the composer
    let lastStats = null;

    // Where to attach: the ChatGPT prompt bar. We try a few selectors so a UI
    // tweak on ChatGPT's side is a one-line fix, and fall back to floating.
    const COMPOSER_SELECTORS = [
      'form[data-type="unified-composer"]',
      "#prompt-textarea",
      'form:has(#prompt-textarea)',
      "main form"
    ];

    function findComposer() {
      for (const sel of COMPOSER_SELECTORS) {
        let el;
        try { el = document.querySelector(sel); } catch (_) { continue; }
        if (!el) continue;
        // Normalise to the enclosing <form> so we can dock just above it.
        return el.closest("form") || el;
      }
      return null;
    }

    function build() {
      root = document.createElement("div");
      root.id = "aquaai-wrap";
      root.innerHTML = `
        <div id="aquaai-panel" role="dialog" aria-label="Water footprint details">
          <div class="aquaai-panel-head">
            <span>💧 Water Footprint</span>
            <button id="aquaai-close" aria-label="Close">×</button>
          </div>
          <div class="aquaai-row"><span>Last query</span><b id="aquaai-last">–</b></div>
          <div class="aquaai-row"><span>Today</span><b id="aquaai-today">–</b></div>
          <div class="aquaai-row"><span>All time</span><b id="aquaai-total">–</b></div>
          <div class="aquaai-note" id="aquaai-equiv">Send a prompt to see its water cost.</div>
          <div class="aquaai-disclaimer">Estimate only — based on public research
            (Li et&nbsp;al., 2023). Actual usage varies by model, data center &amp; grid.</div>
        </div>
        <button id="aquaai-bar" title="AquaAI water footprint — click for details">
          <span class="aquaai-drop">💧</span>
          <span id="aquaai-bar-summary"></span>
        </button>`;

      root.querySelector("#aquaai-bar").addEventListener("click", () => {
        root.classList.toggle("aquaai-open");
      });
      root.querySelector("#aquaai-close").addEventListener("click", (e) => {
        e.stopPropagation();
        root.classList.remove("aquaai-open");
      });
      if (lastStats) render(lastStats);
    }

    // Keep the bar docked directly above the composer. If ChatGPT re-renders
    // the composer (SPA navigation), re-attach. Fall back to floating bottom.
    function ensureMounted() {
      if (!root) build();
      if (root.isConnected && !root.classList.contains("aquaai-floating")) return;

      const composer = findComposer();
      if (composer && composer.parentElement) {
        root.classList.remove("aquaai-floating");
        // Insert just before the prompt bar so it sits on top of it.
        if (root.previousElementSibling !== null || root.parentElement !== composer.parentElement) {
          composer.parentElement.insertBefore(root, composer);
        }
      } else if (!root.isConnected) {
        // Composer not found yet — float at the bottom until it appears.
        root.classList.add("aquaai-floating");
        document.body.appendChild(root);
      }
    }

    function setCalculating(on) {
      if (!root) return;
      // Just pulse the drop icon — no wordy label.
      root.classList.toggle("aquaai-busy", !!on);
    }

    function render(stats) {
      lastStats = stats;
      if (!root) return;
      const last = stats.lastQuery ? stats.lastQuery.ml : 0;
      const today = stats.days[todayKey()] ? stats.days[todayKey()].ml : 0;
      const total = stats.totalMl || 0;

      // Compact bar: just the drop icon + the running all-time total (hidden
      // until there's something to show, so it stays a small icon at first).
      const summary = root.querySelector("#aquaai-bar-summary");
      if (total > 0) {
        summary.textContent = Estimator.formatVolume(total);
        summary.style.display = "";
      } else {
        summary.textContent = "";
        summary.style.display = "none";
      }
      root.querySelector("#aquaai-last").textContent = Estimator.formatVolume(last);
      root.querySelector("#aquaai-today").textContent = Estimator.formatVolume(today);
      root.querySelector("#aquaai-total").textContent = Estimator.formatVolume(total);
      root.querySelector("#aquaai-equiv").textContent =
        "Today ≈ " + Estimator.relatableEquivalent(today);

      root.classList.remove("aquaai-pulse");
      void root.offsetWidth; // reflow to restart animation
      root.classList.add("aquaai-pulse");
    }

    return { build, ensureMounted, render, setCalculating };
  })();

  // ---------------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------------
  function init() {
    if (!document.body) {
      window.addEventListener("DOMContentLoaded", init, { once: true });
      return;
    }
    injectMainWorldScript();
    UI.build();
    UI.ensureMounted();
    // Re-dock the bar if ChatGPT re-renders the composer (SPA navigation).
    setInterval(UI.ensureMounted, 1500);

    // ChatGPT switches conversations without a full page reload. When the URL
    // changes, treat it like a fresh load: reset the boot window (so the newly
    // opened conversation's messages count as history → All-time, not Today)
    // and backfill it. This is how All-time grows across all your chats.
    let currentUrl = location.href;
    setInterval(() => {
      if (location.href === currentUrl) return;
      currentUrl = location.href;
      bootAt = Date.now();
      backfillExisting();
      setTimeout(backfillExisting, 1500);
    }, 800);

    // Load config + stats first so `counted` is seeded and we don't re-tally
    // history that was already counted on a previous visit.
    chrome.storage.local.get([STORAGE_CONFIG_KEY, STORAGE_STATS_KEY], (res) => {
      config = Object.assign({}, Estimator.DEFAULTS, res[STORAGE_CONFIG_KEY] || {});
      const stats = res[STORAGE_STATS_KEY];
      if (stats) {
        (stats.countedIds || []).forEach((id) => counted.add(id));
        UI.render(stats);
      }
      startObserver();
      // Tally the currently-open conversation's history into the all-time total.
      backfillExisting();
      // Re-scan shortly after, in case messages render lazily after load.
      setTimeout(backfillExisting, 1500);
      setTimeout(backfillExisting, 3500);
    });

    // The popup asks us to scan the sidebar; kick it off on this page.
    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      if (msg && msg.type === "AQUAAI_SCAN") {
        runScan();
        sendResponse({ started: true, alreadyRunning: scanning });
      }
      return false;
    });

    // Live-update the overlay if the popup edits config or resets stats.
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local") return;
      if (changes[STORAGE_CONFIG_KEY]) {
        config = Object.assign({}, Estimator.DEFAULTS, changes[STORAGE_CONFIG_KEY].newValue || {});
      }
      if (changes[STORAGE_STATS_KEY] && changes[STORAGE_STATS_KEY].newValue) {
        UI.render(changes[STORAGE_STATS_KEY].newValue);
      }
    });
  }

  init();
})();
