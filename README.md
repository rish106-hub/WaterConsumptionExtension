# AquaAI — ChatGPT Water Footprint (Chrome Extension, MV3)

Visualises the **estimated** water consumption associated with each ChatGPT
query, to raise awareness of AI's environmental impact.

> ⚠️ All figures are **estimates**, not measurements. They do not represent
> exact water usage. See *Water model* below.

## What it does

1. **Detects** interactions on `chatgpt.com` / `chat.openai.com`.
2. **Estimates** water per turn from prompt and response length using a transparent model.
3. **Displays** a small water-drop icon docked on the prompt bar. It shows
   only the estimated water footprint of the current chat.
4. **Tracks** the current chat and optional history estimate in `chrome.storage.local`,
   with a compact popup focused on the active conversation.
5. **Backfills history**: on load it tallies the open conversation, and the
   **Scan** button reads *all* your conversations in the background.
6. **Pauses cleanly**: the popup can stop new estimates. Turns sent while
   paused are not added later if the user resumes tracking.
7. **Suggests practical reductions**: after several turns, the popup offers a
   short prompt-writing suggestion and gives history estimates a simple volume
   comparison.
8. **Uses your units**: switch the popup, chat indicator, and toolbar badge
   between metric volume and US gallons.
9. **Shows scale immediately**: after the first estimate, the popup shows a
   transparent 100,000-person scenario; a history scan upgrades it to a
   multi-prompt scenario based on the user's own average.
10. **Shows the moment on-page**: after a completed live response, a brief
    message above the composer shows the prompt estimate and its 100,000-prompt
    scale scenario.
11. **Stays attached to the live chat**: the composer control reattaches when
    ChatGPT rerenders and waits for a new chat ID before it records a live turn.

### Live vs. history (why "Today" stays honest)

A response counts toward **Today** only if the extension actually observed you
send that prompt — detected via the network hook (`injected.js`) with a
keypress/click fallback. Anything else (history rendered on load, a chat you
open later, a background scan) counts toward **Lifetime** only. This is what
stops a chat with 30 old messages from dumping all 30 into "today" when you
send a single new prompt.

### Background scan

The **Scan my ChatGPT history** button (popup) messages the content script,
which calls ChatGPT's own backend using your logged-in session:
`/api/auth/session` for a token, then paginates `/backend-api/conversations`
and reads each `/backend-api/conversation/<id>`. It runs invisibly (no
tab-hopping) and attempts every listed conversation, not just the visible
sidebar.

> These are ChatGPT's private/unofficial endpoints, so a backend change could
> break the scan. The scanner follows the active branch, so discarded
> regenerations are not counted. Chats that fail to load are reported as
> incomplete instead of being presented as a complete scan. Scanned messages
> are de-duplicated by message id, so scanning repeatedly is safe.

## Architecture

| File | World | Role |
|------|-------|------|
| `manifest.json` | — | MV3 manifest, permissions, content-script wiring |
| `src/estimator.js` | content + popup | Pure water model (`AquaAIEstimator`) |
| `src/injected.js` | page main world | Hooks `[CHATGPT_API_ENDPOINT]` for an in-flight signal |
| `src/content.js` | content isolated world | **Source of truth**: DOM observer, estimation, storage, overlay |
| `src/background.js` | service worker | Defaults on install + toolbar badge |
| `src/popup.{html,css,js}` | popup | Dashboard + tunable model settings + reset |
| `styles/overlay.css` | content | Floating overlay styling (light/dark) |
| `icons/` | — | Placeholder icons (regenerate via `tools/make_icons.py`) |

### Detection strategy

The **DOM `MutationObserver`** is the single source of truth: it watches for
completed assistant messages (`[data-message-author-role="assistant"]`),
de-duplicates by `data-message-id`, and finalises a message after
`STREAM_IDLE_MS` of no changes (a "finished streaming" heuristic). This is
robust to API changes and never double-counts.

`injected.js` additionally hooks the network layer
(`[CHATGPT_API_ENDPOINT]` = `/backend-api/conversation`) purely to show a
"calculating…" state early — it does **not** count, so the two paths can't
conflict.

## Water model  `[WATER_CONSUMPTION_MODEL_DETAILS]`

```
water_mL = BASE_ML_PER_QUERY + ((promptTokens + responseTokens) / 1000) * ML_PER_1K_TOKENS
tokens ≈ characters / CHARS_PER_TOKEN
```

Defaults (`[WATER_CONSUMPTION_FACTOR]`, all user-tunable in the popup):

| Constant | Default | Meaning |
|----------|---------|---------|
| `BASE_ML_PER_QUERY` | `5` mL | fixed cooling/overhead per request |
| `ML_PER_1K_TOKENS` | `30` mL | marginal water per 1,000 generated tokens |
| `CHARS_PER_TOKEN` | `4` | tokenizer approximation |
| `ASSUMED_TOKENS_WHEN_UNKNOWN` | `300` | used when answer length can't be read |
| `ASSUMED_PROMPT_TOKENS_WHEN_UNKNOWN` | `50` | used when prompt length can't be read |

**Basis:** Li, P., Yang, J., Islam, M. A., & Ren, S. (2023), *"Making AI Less
Thirsty"* (arXiv:2304.03271) — a short GPT-3-class session of ~20–50 medium
responses consumes on the order of ~500 mL of freshwater (on-site cooling +
off-site power generation), i.e. roughly ~10–25 mL/response. The defaults land
a 50-token prompt plus ~300-token answer at ~15.5 mL. This is a proxy, not a
measurement: it does not know the selected model, data centre, hidden system
prompt, or full context window. Real usage varies widely by model, data centre
WUE, and grid — hence everything is an editable assumption.

## Install (unpacked)

1. `chrome://extensions` → enable **Developer mode**.
2. **Load unpacked** → select this folder.
3. Open ChatGPT and send a message; the pill updates bottom-right.

Regenerate icons: `python3 tools/make_icons.py`.
```
# WaterConsumptionExtensioon
