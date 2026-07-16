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
  let writeChain = Promise.resolve();  // serialises storage read-modify-writes

  // --- Live vs. history classification -----------------------------------
  // A response counts toward "Today" ONLY if we actually observed the user
  // send that prompt (network hook or a keypress/click on the composer).
  // Everything else — history rendered on load, or a conversation you open
  // later — counts toward all-time only. This is what stops a chat with 30
  // old messages from dumping all 30 into "today" when you send one prompt.
  const ARM_TTL_MS = 120000;           // an armed send expires if no reply lands
  let armedAt = 0;

  function armLive() { armedAt = Date.now(); }
  function consumeLive() {
    if (armedAt && Date.now() - armedAt < ARM_TTL_MS) {
      armedAt = 0;
      return true;
    }
    return false;
  }

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
      if (!config.ESTIMATION_ENABLED) return;
      armLive();
      UI.setCalculating(true);
    }
  });

  // Fallback signal in case the main-world network hook is blocked: detect the
  // user submitting a prompt from the composer directly in the isolated world.
  function looksLikeComposer(node) {
    if (!node || !node.closest) return false;
    return !!node.closest('#prompt-textarea, form[data-type="unified-composer"], main form');
  }
  document.addEventListener(
    "keydown",
    (e) => {
      if (e.key === "Enter" && !e.shiftKey && looksLikeComposer(e.target)) {
        if (!config.ESTIMATION_ENABLED) return;
        armLive();
        UI.setCalculating(true);
      }
    },
    true
  );
  document.addEventListener(
    "click",
    (e) => {
      const btn = e.target && e.target.closest
        ? e.target.closest('button[data-testid="send-button"], button[aria-label*="Send" i]')
        : null;
      if (btn) {
        if (!config.ESTIMATION_ENABLED) return;
        armLive();
        UI.setCalculating(true);
      }
    },
    true
  );

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
    return { totalMl: 0, totalQueries: 0, days: {}, lastQuery: null, countedIds: [], ignoredIds: [], dismissedTips: {}, conversations: {} };
  }

  // The current conversation id from the URL (/c/<id>), or "" if none yet.
  function currentConversationId() {
    const m = location.pathname.match(/\/c\/([0-9a-f-]+)/i);
    return m ? m[1] : "";
  }

  // ChatGPT assigns the /c/<id> route asynchronously for a brand-new chat.
  // Wait briefly before recording a live turn so the session tally is linked
  // to the chat that just produced it instead of being stored as an orphan.
  async function conversationIdForLiveTurn() {
    const immediate = currentConversationId();
    if (immediate) return immediate;
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline) {
      await wait(200);
      const id = currentConversationId();
      if (id) return id;
    }
    return "";
  }

  /**
   * Persist one or more query events. Serialised via writeChain so concurrent
   * finalisations can't clobber each other's read-modify-write.
   * @param {Array<{id:string, result:{ml:number, tokens:number}}>} events
   * @param {boolean} live  true = a query made right now (counts toward "today"
   *                        and becomes "last"); false = backfilled history
   *                        (counts toward all-time totals only).
   * @param {string} [convId] conversation these events belong to (per-chat tally)
   */
  function recordEvents(events, live, convId) {
    if (!events || !events.length) return Promise.resolve();
    writeChain = writeChain.then(
      () =>
        new Promise((resolve) => {
          chrome.storage.local.get([STORAGE_STATS_KEY], (res) => {
            const stats = Object.assign(blankStats(), res[STORAGE_STATS_KEY] || {});
            if (!Array.isArray(stats.countedIds)) stats.countedIds = [];
            if (!stats.conversations) stats.conversations = {};
            const persisted = new Set(stats.countedIds);
            const key = todayKey();
            const day = stats.days[key] || { ml: 0, queries: 0 };
            const conv = convId
              ? stats.conversations[convId] || { ml: 0, queries: 0 }
              : null;
            let added = 0;
            let latestResult = null;

            for (const ev of events) {
              if (persisted.has(ev.id)) continue; // already counted on a prior load
              persisted.add(ev.id);
              stats.countedIds.push(ev.id);
              stats.totalMl = Math.round((stats.totalMl + ev.result.ml) * 100) / 100;
              stats.totalQueries += 1;
              added++;
              latestResult = ev.result;
              if (conv) {
                conv.ml = Math.round((conv.ml + ev.result.ml) * 100) / 100;
                conv.queries += 1;
              }
              if (live) {
                day.ml = Math.round((day.ml + ev.result.ml) * 100) / 100;
                day.queries += 1;
                stats.lastQuery = { ml: ev.result.ml, tokens: ev.result.tokens, ts: Date.now() };
              }
            }

            if (!added) return resolve();
            if (live) stats.days[key] = day;
            if (conv) stats.conversations[convId] = conv;

            chrome.storage.local.set({ [STORAGE_STATS_KEY]: stats }, () => {
              UI.render(stats);
              if (live && latestResult) UI.showImpact(latestResult.ml);
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
    return writeChain;
  }

  // A paused interval should stay paused after a reload. Store only message
  // ids, never prompt or response text, so those turns are not backfilled if
  // the user resumes tracking later.
  function ignoreEvents(ids) {
    if (!ids || !ids.length) return Promise.resolve();
    ids.forEach((id) => counted.add(id));
    writeChain = writeChain.then(() => new Promise((resolve) => {
      chrome.storage.local.get([STORAGE_STATS_KEY], (res) => {
        const stats = Object.assign(blankStats(), res[STORAGE_STATS_KEY] || {});
        const ignored = new Set(stats.ignoredIds || []);
        ids.forEach((id) => ignored.add(id));
        stats.ignoredIds = Array.from(ignored);
        chrome.storage.local.set({ [STORAGE_STATS_KEY]: stats }, resolve);
      });
    }));
    return writeChain;
  }

  // ---------------------------------------------------------------------
  // Detection: finalize an assistant message once it stops streaming
  // ---------------------------------------------------------------------
  function messageId(node) {
    return node.getAttribute("data-message-id") || null;
  }

  // ChatGPT does not expose token usage in the page DOM. Pairing an answer
  // with the preceding user message is the best local input proxy. It does
  // not claim to know hidden system prompts or the full context window.
  function promptTextForAssistant(node) {
    const messages = Array.from(document.querySelectorAll('[data-message-author-role]'));
    const index = messages.indexOf(node);
    for (let i = index - 1; i >= 0; i--) {
      if (messages[i].getAttribute('data-message-author-role') === 'user') {
        return (messages[i].innerText || '').trim();
      }
    }
    return '';
  }

  function scheduleFinalize(node) {
    const id = messageId(node);
    if (!id || counted.has(id)) return;

    if (finalizeTimers.has(id)) clearTimeout(finalizeTimers.get(id));
    const timer = setTimeout(async () => {
      finalizeTimers.delete(id);
      if (counted.has(id)) return;
      if (!config.ESTIMATION_ENABLED) {
        ignoreEvents([id]);
        UI.setCalculating(false);
        return;
      }
      counted.add(id);

      const text = (node.innerText || "").trim();
      const result = Estimator.estimateWater({
        promptText: promptTextForAssistant(node), responseText: text, config: config
      });
      UI.setCalculating(false);
      // Live only if we saw the user send this prompt; otherwise it's history.
      const live = consumeLive();
      const convId = live ? await conversationIdForLiveTurn() : currentConversationId();
      recordEvents([{ id: id, result: result }], live, convId);
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
    if (!config.ESTIMATION_ENABLED) {
      const ids = Array.from(document.querySelectorAll(SELECTORS.assistantMessage))
        .map(messageId)
        .filter((id) => id && !counted.has(id));
      return ignoreEvents(ids);
    }
    const events = [];
    document.querySelectorAll(SELECTORS.assistantMessage).forEach((node) => {
      const id = messageId(node);
      if (!id || counted.has(id)) return;
      counted.add(id);
      const text = (node.innerText || "").trim();
      events.push({ id: id, result: Estimator.estimateWater({
        promptText: promptTextForAssistant(node), responseText: text, config: config
      }) });
    });
    recordEvents(events, false, currentConversationId()); // history → all-time totals only
  }

  // ---------------------------------------------------------------------
  // "Scan my chats" — runs entirely in the background via ChatGPT's own
  // backend API using YOUR logged-in session. No tab-hopping, no UI hijack,
  // and it paginates through EVERY conversation (not just the visible list).
  //
  // Fragility note: these are ChatGPT's private/unofficial endpoints, so a
  // backend change could break the scan. They're grouped here for easy fixing.
  // Nothing leaves your browser — data is read only to compute local totals.
  // ---------------------------------------------------------------------
  const API = {
    session: "/api/auth/session",
    list: (offset, limit) =>
      `/backend-api/conversations?offset=${offset}&limit=${limit}&order=updated`,
    detail: (id) => `/backend-api/conversation/${id}`
  };
  const LIST_PAGE = 28;
  let scanning = false;

  function wait(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  function broadcast(msg) {
    try { chrome.runtime.sendMessage(msg); } catch (_) {}
  }

  async function getAccessToken() {
    const r = await fetch(API.session, { credentials: "include" });
    if (!r.ok) throw new Error("auth session HTTP " + r.status);
    const j = await r.json();
    if (!j || !j.accessToken) throw new Error("not signed in to ChatGPT");
    return j.accessToken;
  }

  async function listAllConversationIds(token, onProgress) {
    const ids = [];
    let offset = 0;
    let total = Infinity;
    while (offset < total) {
      const r = await fetch(API.list(offset, LIST_PAGE), {
        headers: { Authorization: "Bearer " + token },
        credentials: "include"
      });
      if (!r.ok) throw new Error("list HTTP " + r.status);
      const j = await r.json();
      const items = j.items || [];
      total = typeof j.total === "number" ? j.total : offset + items.length;
      items.forEach((it) => it && it.id && ids.push(it.id));
      offset += LIST_PAGE;
      onProgress && onProgress(ids.length, total);
      if (!items.length) break;
      await wait(120); // be gentle on the API
    }
    return ids;
  }

  function textParts(message) {
    const content = message && message.content;
    if (!content || (content.content_type && content.content_type !== "text")) return "";
    return (content.parts || []).filter((p) => typeof p === "string").join("\n").trim();
  }

  function activePath(mapping, currentNode) {
    if (!currentNode || !mapping[currentNode]) return null;
    const ids = new Set();
    let id = currentNode;
    while (id && mapping[id] && !ids.has(id)) {
      ids.add(id);
      id = mapping[id].parent;
    }
    return ids;
  }

  async function assistantMessagesOf(token, id) {
    const r = await fetch(API.detail(id), {
      headers: { Authorization: "Bearer " + token },
      credentials: "include"
    });
    if (!r.ok) throw new Error("conversation HTTP " + r.status);
    const j = await r.json();
    const mapping = (j && j.mapping) || {};
    const selected = activePath(mapping, j && j.current_node);
    // Without a current node we cannot distinguish the active conversation
    // from discarded regeneration branches. Skip rather than inflate totals.
    if (!selected) throw new Error("conversation has no active branch");
    const out = [];
    for (const key of selected) {
      const m = mapping[key] && mapping[key].message;
      if (!m || !m.author || m.author.role !== "assistant") continue;
      const text = textParts(m);
      if (!text || !m.id) continue;
      let promptText = "";
      let parent = mapping[key].parent;
      while (parent && mapping[parent]) {
        const parentMessage = mapping[parent].message;
        if (parentMessage && parentMessage.author && parentMessage.author.role === "user") {
          promptText = textParts(parentMessage);
          break;
        }
        parent = mapping[parent].parent;
      }
      out.push({ id: m.id, text: text, promptText: promptText });
    }
    return out;
  }

  async function runScan() {
    if (scanning) return;
    if (!config.ESTIMATION_ENABLED) {
      broadcast({ type: "AQUAAI_SCAN_ERROR", error: "estimation is paused" });
      return;
    }
    scanning = true;
    try {
      broadcast({ type: "AQUAAI_SCAN_PROGRESS", phase: "auth", done: 0, total: 0 });
      const token = await getAccessToken();

      const ids = await listAllConversationIds(token, (n, t) =>
        broadcast({ type: "AQUAAI_SCAN_PROGRESS", phase: "list", done: n, total: t })
      );

      let done = 0;
      let failed = 0;
      const total = ids.length;
      broadcast({ type: "AQUAAI_SCAN_PROGRESS", phase: "read", done: done, total: total });

      for (const id of ids) {
        try {
          const msgs = await assistantMessagesOf(token, id);
          const events = [];
          for (const m of msgs) {
            if (counted.has(m.id)) continue;
            counted.add(m.id);
            events.push({
              id: m.id,
              result: Estimator.estimateWater({
                promptText: m.promptText, responseText: m.text, config: config
              })
            });
          }
          await recordEvents(events, false, id); // scanned history → all-time only
        } catch (_) {
          failed++;
        }
        done++;
        broadcast({ type: "AQUAAI_SCAN_PROGRESS", phase: "read", done: done, total: total });
        await wait(100);
      }
      chrome.storage.local.get([STORAGE_STATS_KEY], (res) => {
        const stats = Object.assign(blankStats(), res[STORAGE_STATS_KEY] || {});
        stats.lastScan = { ts: Date.now(), conversations: total, failed: failed };
        chrome.storage.local.set({ [STORAGE_STATS_KEY]: stats });
      });
      broadcast({ type: "AQUAAI_SCAN_DONE", total: total, failed: failed });
    } catch (e) {
      broadcast({ type: "AQUAAI_SCAN_ERROR", error: String((e && e.message) || e) });
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
      const drop = `<svg class="aquaai-ico" viewBox="0 0 24 24" fill="none"
        stroke="currentColor" stroke-width="2" stroke-linecap="round"
        stroke-linejoin="round" aria-hidden="true"><path d="M12 2.69l5.66 5.66a8 8 0 1 1-11.31 0z"/></svg>`;
      root.innerHTML = `
        <div id="aquaai-panel" role="dialog" aria-label="Water footprint details">
          <div class="aquaai-panel-head">
            <span class="aquaai-head-title">${drop} This chat</span>
            <button id="aquaai-close" aria-label="Close">×</button>
          </div>
          <div class="aquaai-row"><span>This chat</span><b id="aquaai-chat">–</b></div>
          <div class="aquaai-tip" id="aquaai-tip" hidden>
            <span>Try one clear brief and request a concise answer.</span>
            <button id="aquaai-dismiss-tip" aria-label="Dismiss suggestion">×</button>
          </div>
        </div>
        <div id="aquaai-toast" role="status" aria-live="polite" hidden>
          <strong id="aquaai-toast-prompt"></strong>
          <span id="aquaai-toast-scale"></span>
        </div>
        <button id="aquaai-bar" title="This chat's estimated water use" aria-expanded="false" aria-controls="aquaai-panel">
          <span class="aquaai-drop">${drop}</span>
          <span id="aquaai-bar-summary"></span>
        </button>`;

      function setOpen(open) {
        root.classList.toggle("aquaai-open", open);
        root.querySelector("#aquaai-bar").setAttribute("aria-expanded", String(open));
      }
      root.querySelector("#aquaai-bar").addEventListener("click", () => {
        setOpen(!root.classList.contains("aquaai-open"));
      });
      root.querySelector("#aquaai-close").addEventListener("click", (e) => {
        e.stopPropagation();
        setOpen(false);
      });
      root.querySelector("#aquaai-dismiss-tip").addEventListener("click", () => {
        const convId = currentConversationId();
        if (!convId) return;
        writeChain = writeChain.then(() => new Promise((resolve) => {
          chrome.storage.local.get([STORAGE_STATS_KEY], (res) => {
            const stats = Object.assign(blankStats(), res[STORAGE_STATS_KEY] || {});
            stats.dismissedTips = Object.assign({}, stats.dismissedTips || {}, { [convId]: true });
            chrome.storage.local.set({ [STORAGE_STATS_KEY]: stats }, resolve);
          });
        }));
      });
      document.addEventListener("keydown", (event) => {
        if (event.key === "Escape" && root.classList.contains("aquaai-open")) setOpen(false);
      });
      document.addEventListener("click", (event) => {
        if (root.classList.contains("aquaai-open") && !root.contains(event.target)) setOpen(false);
      });
      if (lastStats) render(lastStats);
    }

    // Keep the bar docked directly above the composer. If ChatGPT re-renders
    // the composer (SPA navigation), re-attach. Fall back to floating bottom.
    function ensureMounted() {
      if (!root) build();
      const composer = findComposer();
      if (composer && composer.parentElement) {
        root.classList.remove("aquaai-floating");
        // ChatGPT often replaces the composer node during navigation. Reattach
        // whenever the indicator is not immediately before the current one.
        if (root.parentElement !== composer.parentElement || root.nextElementSibling !== composer) {
          composer.parentElement.insertBefore(root, composer);
        }
      } else {
        // Composer not found yet — float at the bottom until it appears.
        root.classList.add("aquaai-floating");
        if (root.parentElement !== document.body) document.body.appendChild(root);
      }
    }

    function setCalculating(on) {
      if (!root) return;
      // Just pulse the drop icon — no wordy label.
      root.classList.toggle("aquaai-busy", !!on);
    }

    let impactTimer;
    function showImpact(ml) {
      if (!root || !config.ESTIMATION_ENABLED) return;
      const toast = root.querySelector("#aquaai-toast");
      root.querySelector("#aquaai-toast-prompt").textContent =
        `This prompt: ${Estimator.formatVolume(ml, config.VOLUME_UNIT)} estimated.`;
      root.querySelector("#aquaai-toast-scale").textContent =
        `At 100,000 similar prompts: ${Estimator.formatVolume(ml * 100000, config.VOLUME_UNIT)}.`;
      toast.hidden = false;
      clearTimeout(impactTimer);
      impactTimer = setTimeout(() => { toast.hidden = true; }, 8000);
    }

    function render(stats) {
      lastStats = stats;
      if (!root) return;
      const convId = currentConversationId();
      const conv = convId && stats.conversations ? stats.conversations[convId] : null;
      const sessionMl = conv ? conv.ml : 0;

      // The composer control is deliberately session-only. Global totals stay
      // in the extension popup and never appear beside the ChatGPT input.
      const summary = root.querySelector("#aquaai-bar-summary");
      if (config.ESTIMATION_ENABLED) {
        summary.textContent = sessionMl > 0 ? Estimator.formatVolume(sessionMl, config.VOLUME_UNIT) : "";
        summary.style.display = sessionMl > 0 ? "" : "none";
      } else {
        summary.textContent = "";
        summary.style.display = "none";
      }
      root.classList.toggle("aquaai-paused", !config.ESTIMATION_ENABLED);
      root.querySelector("#aquaai-chat").textContent =
        conv ? Estimator.formatVolume(conv.ml, config.VOLUME_UNIT) : Estimator.formatVolume(0, config.VOLUME_UNIT);
      const showTip = config.ESTIMATION_ENABLED && conv && conv.queries >= 8 &&
        !(stats.dismissedTips && stats.dismissedTips[convId]);
      root.querySelector("#aquaai-tip").hidden = !showTip;

      root.classList.remove("aquaai-pulse");
      void root.offsetWidth; // reflow to restart animation
      root.classList.add("aquaai-pulse");
    }

    // Apply the user's theme choice to the on-page panel. "auto" (or unset)
    // lets overlay.css follow the OS via prefers-color-scheme.
    function applyTheme(theme) {
      if (!root) return;
      if (theme === "light" || theme === "dark") root.setAttribute("data-theme", theme);
      else root.removeAttribute("data-theme");
    }

    return { build, ensureMounted, render, setCalculating, showImpact, applyTheme };
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
      armedAt = 0; // a conversation switch is not a live prompt you just sent
      backfillExisting();
      setTimeout(backfillExisting, 1500);
      chrome.storage.local.get([STORAGE_STATS_KEY], (res) => UI.render(res[STORAGE_STATS_KEY] || blankStats()));
    }, 800);

    // Load config + stats first so `counted` is seeded and we don't re-tally
    // history that was already counted on a previous visit.
    chrome.storage.local.get([STORAGE_CONFIG_KEY, STORAGE_STATS_KEY], (res) => {
      config = Object.assign({}, Estimator.DEFAULTS, res[STORAGE_CONFIG_KEY] || {});
      UI.applyTheme(config.theme);
      const stats = res[STORAGE_STATS_KEY];
      if (stats) {
        (stats.countedIds || []).forEach((id) => counted.add(id));
        (stats.ignoredIds || []).forEach((id) => counted.add(id));
        UI.render(stats);
      }
      startObserver();
      // Tally the currently-open conversation's history into the all-time total.
      backfillExisting();
      // Re-scan shortly after, in case messages render lazily after load.
      setTimeout(backfillExisting, 1500);
      setTimeout(backfillExisting, 3500);
    });

    // Messages from the popup: start a scan, or report this chat's usage.
    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      if (!msg) return false;
      if (msg.type === "AQUAAI_SCAN") {
        runScan();
        sendResponse({ started: true, alreadyRunning: scanning });
        return false;
      }
      if (msg.type === "AQUAAI_GET_CHAT") {
        const convId = currentConversationId();
        chrome.storage.local.get([STORAGE_STATS_KEY], (res) => {
          const s = res[STORAGE_STATS_KEY] || {};
          const conv = convId && s.conversations ? s.conversations[convId] : null;
          sendResponse(conv ? { convId: convId, ml: conv.ml, queries: conv.queries } : { convId: convId });
        });
        return true; // async response
      }
      return false;
    });

    // Live-update the overlay if the popup edits config (incl. theme) or stats.
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local") return;
      if (changes[STORAGE_CONFIG_KEY]) {
        config = Object.assign({}, Estimator.DEFAULTS, changes[STORAGE_CONFIG_KEY].newValue || {});
        UI.applyTheme(config.theme);
        if (!config.ESTIMATION_ENABLED) {
          armedAt = 0;
          UI.setCalculating(false);
          backfillExisting();
        }
        chrome.storage.local.get([STORAGE_STATS_KEY], (res) => UI.render(res[STORAGE_STATS_KEY] || blankStats()));
      }
      if (changes[STORAGE_STATS_KEY] && changes[STORAGE_STATS_KEY].newValue) {
        UI.render(changes[STORAGE_STATS_KEY].newValue);
      }
    });
  }

  init();
})();
