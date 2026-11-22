# Euclid's Harness

A one-page reasoning harness. Enter a claim and it is laid out left to right: the axioms and premises it stands on, the steps derived from them, and the conclusion. Remove a column or switch it off, and a second pass says whether the chain **holds**, **weakens**, or **breaks**, and colors what remains. Stress test all removes each axiom in turn and names the load-bearing ones.

Columns can be edited, retargeted onto earlier columns, or added by hand.

## Run

```bash
cd euclids-harness
npm install
npm test
npm run dev
```

Open http://localhost:4173

The model is `gemini-4-neon` with thinking level `HIGH`. Both are constants in `constants.js`.

### A Gemini key

The server reads `GEMINI_API_KEY` from the environment. Copy `.env.example` to `.env` and put the key there, or export it before starting. The key is never written to the page, the logs, or git.

With no server key, paste one into the field at the bottom of the page. It stays in `localStorage` and is sent only to this server, which forwards it to Gemini. A server key wins over a pasted one.

With neither key, decomposition and both stress tests still run on a local stand-in chain so the controls can be tried. The page says so.

### Production build

```bash
npm run build
npm start
```
