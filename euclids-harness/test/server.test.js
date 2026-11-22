import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createApp } from "../server.js";

async function listen() {
  delete process.env.GEMINI_API_KEY;
  const server = createApp().listen(0, "127.0.0.1");
  await once(server, "listening");
  return server;
}

async function post(server, path, body, headers = {}) {
  const { port } = server.address();
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : {} };
}

test("decompose, stress, and stress-all run without a key", async () => {
  const server = await listen();
  try {
    const { port } = server.address();
    const health = await fetch(`http://127.0.0.1:${port}/api/health`).then((res) => res.json());
    assert.equal(health.model, "gemini-4-neon");
    assert.equal(health.thinking, "HIGH");
    assert.equal(health.stressModel, "gemini-4-carbon");
    assert.equal(health.stressThinking, "MEDIUM");
    assert.equal(health.configured, false);
    assert.equal(JSON.stringify(health).includes("AIza"), false);

    const empty = await post(server, "/api/decompose", { claim: "   " });
    assert.equal(empty.status, 400);

    const decomposed = await post(server, "/api/decompose", { claim: "The sun will rise tomorrow." });
    assert.equal(decomposed.status, 200);
    assert.equal(decomposed.body.source, "mock");
    const columns = decomposed.body.columns;
    assert.equal(columns.at(-1).id, "c1");

    const domain = columns.find((col) => col.id === "a5");
    const kept = columns.filter((col) => col.id !== "a5");
    const stressed = await post(server, "/api/stress", { claim: "The sun will rise tomorrow.", columns: kept, removed: [domain] });
    assert.equal(stressed.status, 200);
    assert.equal(stressed.body.verdict, "BREAKS");
    assert.equal(stressed.body.columns.find((col) => col.id === "c1").status, "red");
    assert.equal(stressed.body.columns.find((col) => col.id === "a1").status, "green");

    const all = await post(server, "/api/stress-all", { claim: "The sun will rise tomorrow.", columns });
    assert.equal(all.status, 200);
    const byId = Object.fromEntries(all.body.results.map((row) => [row.id, row.verdict]));
    assert.equal(byId.a5, "BREAKS");
    assert.equal(byId.a1, "HOLDS");

    const junk = await post(server, "/api/decompose", "{");
    assert.equal(junk.status, 400);
    assert.equal(junk.body.error, "Invalid JSON.");
  } finally {
    server.close();
  }
});
