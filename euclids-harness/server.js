import express from "express";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { GEMINI_MODEL, STRESS_MODEL, STRESS_THINKING_LEVEL, THINKING_LEVEL } from "./constants.js";
import { generateJson, schemas } from "./gemini.js";
import { judge, judgeAll, loadChain, mockDecompose, normalizeColumns, oneLine } from "./shared/logic.js";

const root = path.dirname(fileURLToPath(import.meta.url));

function loadEnv() {
  const file = path.join(root, ".env");
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!match || process.env[match[1]] !== undefined) continue;
    process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, "");
  }
}

function bad(message) {
  const error = new Error(message);
  error.status = 400;
  return error;
}

function claimOf(body) {
  const claim = String(body?.claim ?? "").trim();
  if (!claim) throw bad("Enter a claim.");
  if (claim.length > 2000) throw bad("Keep the claim under 2000 characters.");
  return claim;
}

function keyFrom(req) {
  const env = process.env.GEMINI_API_KEY?.trim();
  if (env) return env;
  const header = req.get("x-gemini-key")?.trim();
  if (header && header.length <= 256) return header;
  return "";
}

function publicError(err, key) {
  let text = String(err?.message || "The model call failed.");
  if (key) text = text.split(key).join("[key]");
  return text.replace(/AIza[\w-]+/g, "[key]").slice(0, 300);
}

function fail(res, err, key) {
  const status = err.status || 502;
  const error = status === 400 ? err.message : publicError(err, key);
  res.status(status).json({ error });
}

const VERDICTS = new Set(["HOLDS", "WEAKENS", "BREAKS"]);
const COLORS = new Set(["green", "yellow", "red"]);

function lineOf(columns) {
  return columns
    .map((c) => `${c.id} [${c.kind}] ${c.title} — ${c.text} (from: ${c.dependsOn.join(", ") || "nothing"})`)
    .join("\n");
}

function decomposePrompt(claim) {
  return `Decompose the claim into the smallest honest left-to-right chain.

Claim:
${claim}

Columns, foundations first:
- kind "axiom" only for principles the claim actually uses, drawn when they apply from identity, non-contradiction, causality, induction, reliability of perception, reliability of testimony, plus the domain premises it needs.
- kind "step" for the derived moves.
- kind "conclusion" exactly once, stating what the claim commits to.
Each column needs id (a1, s1, c1), title of at most four words, text of one sentence, and dependsOn: ids of earlier columns it uses. Axioms usually depend on nothing. Prefer 5 to 8 columns. Do not add an axiom nothing else uses.`;
}

function stressPrompt(claim, columns, removedIds) {
  const removed = new Set(removedIds);
  const gone = columns.filter((c) => removed.has(c.id));
  const kept = columns.filter((c) => !removed.has(c.id));
  return `You are an adversarial examiner. Do not rescue the chain. The columns listed as removed are gone; a dependency on one of them is unsupported.

Claim:
${claim}

Removed:
${lineOf(gone)}

Remaining, in order:
${lineOf(kept)}

verdict is HOLDS if the conclusion still follows, WEAKENS if it is less secure but not unsupported, BREAKS if it no longer follows.
explanation is at most two sentences and names the steps that fail or thin out.
For every remaining column, status is green if it still stands, yellow if it is shakier, red if it fails. A column with no dependency on what was removed is green.`;
}

function stressAllPrompt(claim, columns) {
  const axioms = columns.filter((c) => c.kind === "axiom").map((c) => c.id).join(", ");
  return `You are an adversarial examiner. Consider each axiom on its own. For that axiom, imagine it removed and every other column kept, and judge the chain independently.

Claim:
${claim}

Columns, in order:
${lineOf(columns)}

Return one result for each of these axiom ids: ${axioms}.
verdict is HOLDS, WEAKENS, or BREAKS. note is one sentence on what fails or holds. Do not include steps or the conclusion.`;
}

function normalizeVerdict(raw, remaining) {
  const verdict = String(raw?.verdict || "").toUpperCase();
  if (!VERDICTS.has(verdict)) throw new Error("The model returned no verdict.");
  const given = new Map((raw.columns || []).map((c) => [c.id, c.status]));
  return {
    verdict,
    explanation: oneLine(raw.explanation, 320),
    columns: remaining.map((c) => ({
      id: c.id,
      status: COLORS.has(given.get(c.id)) ? given.get(c.id) : "green",
    })),
  };
}

function normalizeAll(raw, axioms) {
  const byId = new Map((raw?.results || []).map((r) => [r.id, r]));
  return axioms.map((axiom) => {
    const row = byId.get(axiom.id);
    const verdict = String(row?.verdict || "").toUpperCase();
    if (!VERDICTS.has(verdict)) throw new Error("The model skipped an axiom.");
    return { id: axiom.id, title: axiom.title, verdict, note: oneLine(row.note, 220) };
  });
}

export function createApp() {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "64kb" }));
  app.use((err, _req, res, next) => {
    if (err instanceof SyntaxError && err.status === 400) {
      res.status(400).json({ error: "Invalid JSON." });
      return;
    }
    next(err);
  });

  app.get("/api/health", (_req, res) => {
    res.json({
      ok: true,
      model: GEMINI_MODEL,
      thinking: THINKING_LEVEL,
      stressModel: STRESS_MODEL,
      stressThinking: STRESS_THINKING_LEVEL,
      configured: Boolean(process.env.GEMINI_API_KEY?.trim()),
    });
  });

  app.post("/api/decompose", async (req, res) => {
    const key = keyFrom(req);
    try {
      const claim = claimOf(req.body);
      if (!key) {
        res.json({ source: "mock", columns: mockDecompose(claim) });
        return;
      }
      const raw = await generateJson({
        apiKey: key,
        prompt: decomposePrompt(claim),
        schema: schemas.decompose,
        model: GEMINI_MODEL,
        thinkingLevel: THINKING_LEVEL,
      });
      const columns = normalizeColumns(raw.columns);
      if (!columns.length) throw new Error("The model returned no columns.");
      res.json({ source: "gemini", model: GEMINI_MODEL, thinking: THINKING_LEVEL, columns });
    } catch (err) {
      fail(res, err, key);
    }
  });

  app.post("/api/stress", async (req, res) => {
    const key = keyFrom(req);
    try {
      const claim = claimOf(req.body);
      const { columns, removedIds } = loadChain(req.body?.columns, req.body?.removed);
      if (!removedIds.length) throw bad("Say which column to remove.");
      const remaining = columns.filter((c) => !removedIds.includes(c.id));
      if (!remaining.length) throw bad("Nothing left to test.");
      if (!key) {
        res.json({ source: "mock", ...judge(columns, removedIds) });
        return;
      }
      const raw = await generateJson({
        apiKey: key,
        prompt: stressPrompt(claim, columns, removedIds),
        schema: schemas.stress,
        model: STRESS_MODEL,
        thinkingLevel: STRESS_THINKING_LEVEL,
      });
      res.json({
        source: "gemini",
        model: STRESS_MODEL,
        thinking: STRESS_THINKING_LEVEL,
        ...normalizeVerdict(raw, remaining),
      });
    } catch (err) {
      fail(res, err, key);
    }
  });

  app.post("/api/stress-all", async (req, res) => {
    const key = keyFrom(req);
    try {
      const claim = claimOf(req.body);
      const { columns } = loadChain(req.body?.columns, []);
      const axioms = columns.filter((c) => c.kind === "axiom");
      if (!axioms.length) throw bad("There are no axioms to remove.");
      if (!key) {
        res.json({ source: "mock", results: judgeAll(columns) });
        return;
      }
      const raw = await generateJson({
        apiKey: key,
        prompt: stressAllPrompt(claim, columns),
        schema: schemas.stressAll,
        model: STRESS_MODEL,
        thinkingLevel: STRESS_THINKING_LEVEL,
      });
      res.json({
        source: "gemini",
        model: STRESS_MODEL,
        thinking: STRESS_THINKING_LEVEL,
        results: normalizeAll(raw, axioms),
      });
    } catch (err) {
      fail(res, err, key);
    }
  });

  app.use("/api", (_req, res) => {
    res.status(404).json({ error: "Not found." });
  });

  return app;
}

async function main() {
  loadEnv();
  const app = createApp();
  if (process.env.NODE_ENV === "production") {
    const dist = path.join(root, "dist");
    app.use(express.static(dist));
    app.get("*", (_req, res) => res.sendFile(path.join(dist, "index.html")));
  } else {
    const { createServer } = await import("vite");
    const vite = await createServer({ server: { middlewareMode: true }, appType: "spa" });
    app.use(vite.middlewares);
  }
  const port = Number(process.env.PORT) || 4173;
  const host = process.env.HOST || "127.0.0.1";
  app.listen(port, host, () => {
    console.log(`Euclid's Harness at http://${host}:${port}`);
  });
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) main();
