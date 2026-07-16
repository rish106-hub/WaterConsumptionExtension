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
 * We use prompt and response length as a transparent local proxy:
 *   water_mL = BASE_ML_PER_QUERY + ((promptTokens + responseTokens) / 1000)
 *              * ML_PER_1K_TOKENS
 *
 * Tokens are ESTIMATED from character count (~4 chars/token).
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
    ASSUMED_TOKENS_WHEN_UNKNOWN: 300, // used when response length can't be read
    ASSUMED_PROMPT_TOKENS_WHEN_UNKNOWN: 50,
    ESTIMATION_ENABLED: true,
    VOLUME_UNIT: "metric",
    DAILY_GOAL_ML: 5000        // "budget" used for the Today donut (5 L)
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

  function estimatePromptTokens(text, cfg) {
    if (!text || typeof text !== "string" || text.trim().length === 0) {
      return cfg.ASSUMED_PROMPT_TOKENS_WHEN_UNKNOWN;
    }
    return estimateTokens(text, cfg);
  }

  /**
   * Estimate water consumption for a single query/response.
   * @param {object} [opts]
   * @param {string} [opts.promptText] the user's prompt, if available
   * @param {string} [opts.responseText] the model's answer, if available
   * @param {number} [opts.promptTokens] explicit prompt-token count
   * @param {number} [opts.responseTokens] explicit token count (wins over text)
   * @param {object} [opts.config] overrides for the model constants
   * @returns {{ml:number, tokens:number, config:object}}
   */
  function estimateWater(opts) {
    opts = opts || {};
    const cfg = Object.assign({}, DEFAULTS, opts.config || {});
    const responseTokens =
      typeof opts.responseTokens === "number" && opts.responseTokens > 0
        ? opts.responseTokens
        : estimateTokens(opts.responseText, cfg);
    const promptTokens =
      typeof opts.promptTokens === "number" && opts.promptTokens > 0
        ? opts.promptTokens
        : estimatePromptTokens(opts.promptText, cfg);
    const tokens = promptTokens + responseTokens;

    const ml = cfg.BASE_ML_PER_QUERY + (tokens / 1000) * cfg.ML_PER_1K_TOKENS;
    return {
      ml: Math.round(ml * 100) / 100, // 2 decimals
      tokens: tokens,
      promptTokens: promptTokens,
      responseTokens: responseTokens,
      config: cfg
    };
  }

  /**
   * Human-friendly formatting for a volume in millilitres.
   * @param {number} ml
   * @returns {string}
   */
  function formatVolume(ml, unit) {
    if (!isFinite(ml) || ml < 0) ml = 0;
    if (unit === "gallon") {
      if (ml === 0) return "0 gal";
      const gallons = ml / 3785.411784;
      return `${gallons.toFixed(gallons < 1 ? 3 : 2)} gal`;
    }
    if (ml < 1000) return `${ml.toFixed(ml < 10 ? 1 : 0)} mL`;
    return `${(ml / 1000).toFixed(2)} L`;
  }

  /**
   * Split a volume into a number string and its unit, for UIs that style the
   * value and unit differently (e.g. "18.7" + "mL", "2.43" + "Liters").
   * @param {number} ml
   * @returns {{value:string, unit:string}}
   */
  function splitVolume(ml, unit) {
    if (!isFinite(ml) || ml < 0) ml = 0;
    if (unit === "gallon") {
      if (ml === 0) return { value: "0", unit: "gal" };
      const gallons = ml / 3785.411784;
      return { value: gallons.toFixed(gallons < 1 ? 3 : 2), unit: "gal" };
    }
    if (ml < 1000) return { value: ml < 100 ? ml.toFixed(1) : String(Math.round(ml)), unit: "mL" };
    return { value: (ml / 1000).toFixed(2), unit: "Liters" };
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

  function compactingTip(ml, queries) {
    if (!ml || !queries) return "Ask one clear question instead of splitting it across follow-ups.";
    if (queries >= 50) return "You have a long history. Combine context and ask for a concise answer when you can.";
    if (queries >= 10) return "A clear brief and a requested answer length can reduce extra turns.";
    return "One focused prompt can replace several follow-ups.";
  }

  globalThis.AquaAIEstimator = {
    DEFAULTS,
    estimateTokens,
    estimateWater,
    formatVolume,
    splitVolume,
    relatableEquivalent,
    compactingTip
  };
})();
