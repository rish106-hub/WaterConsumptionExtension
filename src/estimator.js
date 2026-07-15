/*
 * estimator.js — Shared water-consumption model.
 *
 * Loaded both as the first content script (in the ChatGPT page's isolated
 * world) and via a <script> tag in popup.html, so it must not assume a DOM or
 * chrome.* APIs. It only exposes a pure model on globalThis.AquaAIEstimator.
 *
 * ---------------------------------------------------------------------------
 * WATER_CONSUMPTION_MODEL_DETAILS
 * ---------------------------------------------------------------------------
 * The model is an ESTIMATE, not a measurement. It is grounded in publicly
 * available research and deliberately exposes every assumption as a tunable
 * constant so it can be corrected as better data appears.
 *
 * Primary source of the order of magnitude:
 *   Li, P., Yang, J., Islam, M. A., & Ren, S. (2023).
 *   "Making AI Less Thirsty: Uncovering and Addressing the Secret Water
 *   Footprint of AI Models." (arXiv:2304.03271)
 *   Headline finding widely cited: a short ChatGPT (GPT-3 class) session of
 *   ~20-50 medium responses consumes on the order of ~500 mL of fresh water
 *   once on-site data-center cooling AND off-site power-generation water are
 *   included. That implies very roughly ~10-25 mL per response.
 *
 * We refine "per response" into two parts so longer answers cost more:
 *   water_mL = BASE_ML_PER_QUERY + (responseTokens / 1000) * ML_PER_1K_TOKENS
 *
 * where responseTokens is ESTIMATED from character count (~4 chars/token).
 *
 * The defaults below land a typical ~300-token answer at ~14 mL, consistent
 * with ~500 mL / ~35 responses. THESE ARE ASSUMPTIONS — tune to taste.
 *
 * NOTE: Real figures depend heavily on the specific model, the data center's
 * Water Usage Effectiveness (WUE), the local electricity grid's water
 * intensity, and time of day. Treat all output as an educational estimate.
 */
(function () {
  "use strict";

  // ---- Tunable model constants -------------------------------------------
  // [WATER_CONSUMPTION_FACTOR] — adjust these to match newer research or a
  // specific deployment. All values are the DEFAULTS; the popup lets a user
  // override them and they are persisted in chrome.storage.
  const DEFAULTS = Object.freeze({
    BASE_ML_PER_QUERY: 5,      // fixed cooling/overhead per request (mL)
    ML_PER_1K_TOKENS: 30,      // marginal water per 1000 generated tokens (mL)
    CHARS_PER_TOKEN: 4,        // rough tokenizer approximation
    ASSUMED_TOKENS_WHEN_UNKNOWN: 300 // used when response length can't be read
  });

  /**
   * Estimate generated tokens from a response string.
   * @param {string|undefined} text
   * @param {object} cfg merged config
   * @returns {number} estimated token count
   */
  function estimateTokens(text, cfg) {
    if (!text || typeof text !== "string" || text.length === 0) {
      return cfg.ASSUMED_TOKENS_WHEN_UNKNOWN;
    }
    return Math.max(1, Math.round(text.length / cfg.CHARS_PER_TOKEN));
  }

  /**
   * Estimate water consumption for a single query/response.
   * @param {object} [opts]
   * @param {string} [opts.responseText] the model's answer, if available
   * @param {number} [opts.responseTokens] explicit token count (wins over text)
   * @param {object} [opts.config] overrides for the model constants
   * @returns {{ml:number, tokens:number, config:object}}
   */
  function estimateWater(opts) {
    opts = opts || {};
    const cfg = Object.assign({}, DEFAULTS, opts.config || {});
    const tokens =
      typeof opts.responseTokens === "number" && opts.responseTokens > 0
        ? opts.responseTokens
        : estimateTokens(opts.responseText, cfg);

    const ml = cfg.BASE_ML_PER_QUERY + (tokens / 1000) * cfg.ML_PER_1K_TOKENS;
    return {
      ml: Math.round(ml * 100) / 100, // 2 decimals
      tokens: tokens,
      config: cfg
    };
  }

  /**
   * Human-friendly formatting for a volume in millilitres.
   * @param {number} ml
   * @returns {string}
   */
  function formatVolume(ml) {
    if (!isFinite(ml) || ml < 0) ml = 0;
    if (ml < 1000) return `${ml.toFixed(ml < 10 ? 1 : 0)} mL`;
    return `${(ml / 1000).toFixed(2)} L`;
  }

  /**
   * A relatable comparison for a cumulative volume.
   * @param {number} ml
   * @returns {string}
   */
  function relatableEquivalent(ml) {
    const glassMl = 250;   // a typical drinking glass
    const bottleMl = 500;  // a standard water bottle
    if (ml < glassMl) return "less than a glass of water";
    if (ml < bottleMl) return `~${(ml / glassMl).toFixed(1)} glasses of water`;
    return `~${(ml / bottleMl).toFixed(1)} water bottles`;
  }

  globalThis.AquaAIEstimator = {
    DEFAULTS,
    estimateTokens,
    estimateWater,
    formatVolume,
    relatableEquivalent
  };
})();
