/*
 * injected.js — runs in the PAGE's main world (not the isolated content-script
 * world), so it can observe the site's own network calls.
 *
 * Purpose: give an early, reliable "a query was just sent" signal by hooking
 * ChatGPT's conversation endpoint. The DOM observer in content.js remains the
 * single source of truth for COUNTING and MEASURING responses; this file only
 * emits an in-flight signal so the UI can show a "calculating…" state and so
 * the design demonstrates how to hook the real API.
 *
 * It communicates with content.js via window.postMessage (the only channel
 * available across the main/isolated world boundary).
 */
(function () {
  "use strict";

  // [CHATGPT_API_ENDPOINT] — the backend path ChatGPT hits to send a message.
  // Kept as a matchable fragment so a UI/domain change is a one-line edit.
  const CONVERSATION_ENDPOINT_FRAGMENT = "/backend-api/conversation";

  const CHANNEL = "AQUAAI_MAIN_WORLD";

  function post(payload) {
    window.postMessage(
      Object.assign({ __aquaai: true, channel: CHANNEL }, payload),
      window.location.origin
    );
  }

  function urlOf(input) {
    try {
      if (typeof input === "string") return input;
      if (input && typeof input.url === "string") return input.url; // Request
    } catch (_) {}
    return "";
  }

  // --- Hook fetch ----------------------------------------------------------
  const originalFetch = window.fetch;
  if (typeof originalFetch === "function") {
    window.fetch = function (input, init) {
      const url = urlOf(input);
      const isQuery =
        url.indexOf(CONVERSATION_ENDPOINT_FRAGMENT) !== -1 &&
        (!init || (init.method || "GET").toUpperCase() === "POST");

      if (isQuery) {
        post({ type: "QUERY_SENT", via: "fetch", ts: Date.now() });
      }
      return originalFetch.apply(this, arguments);
    };
  }

  // --- Hook XHR (fallback for any non-fetch calls) -------------------------
  const OrigXHR = window.XMLHttpRequest;
  if (OrigXHR && OrigXHR.prototype) {
    const origOpen = OrigXHR.prototype.open;
    const origSend = OrigXHR.prototype.send;
    OrigXHR.prototype.open = function (method, url) {
      this.__aquaai_isQuery =
        typeof url === "string" &&
        url.indexOf(CONVERSATION_ENDPOINT_FRAGMENT) !== -1 &&
        String(method).toUpperCase() === "POST";
      return origOpen.apply(this, arguments);
    };
    OrigXHR.prototype.send = function () {
      if (this.__aquaai_isQuery) {
        post({ type: "QUERY_SENT", via: "xhr", ts: Date.now() });
      }
      return origSend.apply(this, arguments);
    };
  }
})();
