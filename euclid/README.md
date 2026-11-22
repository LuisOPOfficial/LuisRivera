# Euclid

A minimal, local-first multi-model chat workspace. Pick a model from the top selector, stream replies, switch between chats saved in `localStorage`, and track per-chat context window usage alongside an estimated long-context intelligence degradation indicator.

## Setup & Run

```bash
cd euclid
cp .env.example .env   # add whichever provider keys you want
npm install
npm test
npm start
```

Open `http://127.0.0.1:4180` (configurable via `PORT`).

For development with Vite HMR:

```bash
npm run dev
```

For a prebuilt production bundle:

```bash
npm run build
npm start
```

## Models & API Keys

All models and their context/degradation parameters live in `constants.js`. API keys are read strictly from server environment variables (never exposed to the browser or committed). Any model whose key is missing appears disabled in the selector with a short hint.

| Model | Provider | Env Var | Notes |
| --- | --- | --- | --- |
| `gemini-4-neon` | Google Gemini | `GEMINI_API_KEY` | Thinking level `HIGH`, 1M window |
| `gemini-4-carbon` | Google Gemini | `GEMINI_API_KEY` | Thinking level `MEDIUM`, 1M window |
| `gemini-4-argon` | Google Gemini | `GEMINI_API_KEY` | 1M window |
| `claude-sonnet-5-5` | Anthropic Messages API | `ANTHROPIC_API_KEY` | Streaming, 1M window |
| `baseten-bison-31b` | Baseten System One | `BASETEN_API_KEY` | `decision-models/baseten-bison-latest` (`Bearer` auth), 131k window; sends chat as `state` and one `noul` question |

## Context & Degradation Indicator

The top bar shows tokens used vs. the selected model's context window (using provider usage counts when returned, otherwise an estimate of ~4 chars/token) and a red `−x% intelligence` estimate derived from each model's curve in `constants.js` (staying near 0% up to ~32k–64k tokens and steepening past ~50% of the window, informed by RULER, NoLiMa, and Fiction.LiveBench). Hover or focus the indicator for details.
