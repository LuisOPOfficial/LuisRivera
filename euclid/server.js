import express from "express";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  DEFAULT_HOST,
  DEFAULT_PORT,
  PROVIDERS,
  getModel,
  listModels,
  providerKeyFor,
} from "./constants.js";
import { publicError, streamChat } from "./providers.js";

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

function bad(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function normalizeMessages(raw) {
  if (!Array.isArray(raw) || !raw.length) {
    throw bad("Send at least one message.");
  }
  if (raw.length > 100) {
    throw bad("Conversation is too long (max 100 messages).");
  }
  const messages = raw.map((item) => {
    const role = item?.role;
    if (role !== "user" && role !== "assistant") {
      throw bad("Each message role must be user or assistant.");
    }
    const content = String(item?.content ?? "").trim();
    if (!content) throw bad("Message content cannot be empty.");
    if (content.length > 32_000) throw bad("Message is too long.");
    return { role, content };
  });
  if (messages.at(-1).role !== "user") {
    throw bad("The last message must be from the user.");
  }
  return messages;
}

function configuredSecrets(env) {
  return Object.keys(PROVIDERS)
    .map((id) => providerKeyFor(id, env))
    .filter(Boolean);
}

function writeSse(res, payload) {
  if (!res.headersSent) {
    res.status(200);
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();
  }
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

export function createApp({ env, fetchImpl } = {}) {
  const readEnv = () => env || process.env;
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "512kb" }));
  app.use((err, _req, res, next) => {
    if (err instanceof SyntaxError && err.status === 400) {
      res.status(400).json({ error: "Invalid JSON." });
      return;
    }
    next(err);
  });

  app.get("/api/health", (_req, res) => {
    res.json({ ok: true });
  });

  app.get("/api/models", (_req, res) => {
    res.json({ models: listModels(readEnv()) });
  });

  app.post("/api/chat", async (req, res) => {
    const currentEnv = readEnv();
    const secrets = configuredSecrets(currentEnv);
    try {
      const model = getModel(String(req.body?.modelId ?? "").trim());
      if (!model) throw bad("Unknown model.");

      const messages = normalizeMessages(req.body?.messages);
      const provider = PROVIDERS[model.provider];
      const apiKey = providerKeyFor(model.provider, currentEnv);
      if (!apiKey) {
        throw bad(`Missing ${provider.envKey} on the server.`, 503);
      }

      const controller = new AbortController();
      res.on("close", () => {
        if (!res.writableEnded) controller.abort();
      });

      const result = await streamChat({
        model,
        messages,
        apiKey,
        signal: controller.signal,
        fetchImpl: fetchImpl || globalThis.fetch,
        onDelta: (text) => {
          if (!res.writableEnded) writeSse(res, { type: "delta", text });
        },
      });

      if (!res.writableEnded) {
        writeSse(res, {
          type: "done",
          model: model.id,
          text: result.text,
          usage: result.usage || null,
        });
        res.end();
      }
    } catch (err) {
      if (res.writableEnded) return;
      const status = err.status || 502;
      const error = status < 500 ? err.message : publicError(err, secrets);
      if (!res.headersSent) {
        res.status(status).json({ error });
      } else {
        writeSse(res, { type: "error", error });
        res.end();
      }
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
  const dist = path.join(root, "dist");
  if (process.env.NODE_ENV === "production" && fs.existsSync(path.join(dist, "index.html"))) {
    app.use(express.static(dist));
    app.get("*", (_req, res) => res.sendFile(path.join(dist, "index.html")));
  } else {
    const { createServer } = await import("vite");
    const vite = await createServer({ root, server: { middlewareMode: true }, appType: "spa" });
    app.use(vite.middlewares);
  }
  const port = Number(process.env.PORT) || DEFAULT_PORT;
  const host = process.env.HOST || DEFAULT_HOST;
  app.listen(port, host, () => {
    console.log(`Euclid running at http://${host}:${port}`);
  });
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) main();
