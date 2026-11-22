import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import {
  DEFAULT_HOST,
  DEFAULT_PORT,
  MODELS,
  PROVIDERS,
  THINKING_LEVELS,
  getModel,
  listModels,
} from "../constants.js";
import {
  buildAnthropicRequest,
  buildBasetenRequest,
  buildGeminiRequest,
  formatBasetenReply,
  publicError,
} from "../providers.js";
import {
  buildDegradationTooltip,
  computeContextMetrics,
  computeIntelligenceLoss,
  estimateMessagesTokens,
  estimateTokens,
  formatLossLabel,
  formatTokens,
} from "../shared/context.js";
import { createApp } from "../server.js";

function sseResponse(chunks) {
  const encoder = new TextEncoder();
  const body = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream; charset=utf-8" },
  });
}

function parseSseText(text) {
  return text
    .split(/\r?\n\r?\n/)
    .map((frame) =>
      frame
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .join("\n"),
    )
    .filter(Boolean)
    .map((payload) => JSON.parse(payload));
}

async function startServer(options = {}) {
  const server = createApp(options).listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  return { server, baseUrl: `http://127.0.0.1:${port}` };
}

test("model registry exposes all models, defaults, and curve params", () => {
  assert.equal(DEFAULT_HOST, "127.0.0.1");
  assert.equal(DEFAULT_PORT, 4180);
  assert.deepEqual(THINKING_LEVELS, ["MINIMAL", "LOW", "MEDIUM", "HIGH", "XHIGH"]);

  const ids = MODELS.map((m) => m.id);
  assert.deepEqual(ids, [
    "gemini-4-neon",
    "gemini-4-carbon",
    "gemini-4-argon",
    "claude-sonnet-5-5",
    "baseten-bison-31b",
  ]);

  assert.equal(getModel("gemini-4-neon").thinkingLevel, "HIGH");
  assert.equal(getModel("gemini-4-carbon").thinkingLevel, "MEDIUM");
  assert.equal(getModel("gemini-4-argon").thinkingLevel, undefined);
  assert.equal(getModel("baseten-bison-31b").apiModel, "decision-models/baseten-bison-latest");

  for (const model of MODELS) {
    assert.ok(PROVIDERS[model.provider], `provider exists for ${model.id}`);
    assert.ok(model.contextWindow > 0, `contextWindow set for ${model.id}`);
    assert.ok(model.degradation.decayStart > 0);
    assert.ok(model.degradation.steepStart > model.degradation.decayStart);
    assert.ok(model.degradation.steepStart <= model.contextWindow);
    assert.ok(model.degradation.maxLossPct > 0 && model.degradation.maxLossPct <= 100);
  }
});

test("listModels reports availability without leaking keys", () => {
  const env = {
    GEMINI_API_KEY: "AIzaSecretGeminiKey12345",
    ANTHROPIC_API_KEY: "",
  };
  const listed = listModels(env);
  const serialized = JSON.stringify(listed);
  assert.equal(serialized.includes("AIzaSecretGeminiKey12345"), false);

  const neon = listed.find((m) => m.id === "gemini-4-neon");
  const claude = listed.find((m) => m.id === "claude-sonnet-5-5");
  const bison = listed.find((m) => m.id === "baseten-bison-31b");

  assert.equal(neon.available, true);
  assert.equal(neon.hint, null);
  assert.equal(claude.available, false);
  assert.equal(claude.hint, "Set ANTHROPIC_API_KEY");
  assert.equal(bison.available, false);
  assert.equal(bison.hint, "Set BASETEN_API_KEY");
});

test("provider request shaping matches Gemini, Anthropic, and Baseten specs", () => {
  const messages = [
    { role: "user", content: "Hello" },
    { role: "assistant", content: "Hi there" },
    { role: "user", content: "Is 2 + 2 equal to 4?" },
  ];

  const neonReq = buildGeminiRequest(getModel("gemini-4-neon"), messages);
  assert.equal(neonReq.model, "gemini-4-neon");
  assert.deepEqual(neonReq.config.thinkingConfig, { thinkingLevel: "HIGH", includeThoughts: false });
  assert.deepEqual(neonReq.contents, [
    { role: "user", parts: [{ text: "Hello" }] },
    { role: "model", parts: [{ text: "Hi there" }] },
    { role: "user", parts: [{ text: "Is 2 + 2 equal to 4?" }] },
  ]);

  const carbonReq = buildGeminiRequest(getModel("gemini-4-carbon"), messages);
  assert.deepEqual(carbonReq.config.thinkingConfig, { thinkingLevel: "MEDIUM", includeThoughts: false });

  const argonReq = buildGeminiRequest(getModel("gemini-4-argon"), messages);
  assert.equal(argonReq.config.thinkingConfig, undefined);

  const anthReq = buildAnthropicRequest(getModel("claude-sonnet-5-5"), messages, "sk-ant-test");
  assert.equal(anthReq.url, "https://api.anthropic.com/v1/messages");
  assert.equal(anthReq.init.headers["x-api-key"], "sk-ant-test");
  assert.equal(anthReq.init.headers["anthropic-version"], "2023-06-01");
  const anthBody = JSON.parse(anthReq.init.body);
  assert.equal(anthBody.model, "claude-sonnet-5-5");
  assert.equal(anthBody.stream, true);
  assert.deepEqual(anthBody.messages, messages);

  const basetenReq = buildBasetenRequest(getModel("baseten-bison-31b"), messages, "bt_key_123");
  assert.equal(basetenReq.url, "https://inference.baseten.co/v1/systemone");
  assert.equal(basetenReq.init.headers.authorization, "Bearer bt_key_123");
  const basetenBody = JSON.parse(basetenReq.init.body);
  assert.equal(basetenBody.model, "decision-models/baseten-bison-latest");
  assert.equal(basetenBody.service_tier, "default");
  assert.deepEqual(basetenBody.state, { messages });
  assert.equal(basetenBody.questions.reply.type, "noul");
  assert.match(basetenBody.questions.reply.instructions, /last user message/i);

  assert.equal(formatBasetenReply({ answers: { reply: { type: "noul", noul: 0.942 } } }), "Yes (94.2% · noul = 0.9420)");
  assert.equal(formatBasetenReply({ answers: { reply: { type: "noul", noul: 0.12 } } }), "No (12.0% · noul = 0.1200)");
});

test("publicError scrubs explicit secrets and known token prefixes", () => {
  const err = new Error(
    "Upstream failed with AIzaFakeGoogleKey99 and sk-ant-api03-secret and Bearer my-baseten-secret and raw-secret-xyz",
  );
  const scrubbed = publicError(err, ["raw-secret-xyz"]);
  assert.equal(scrubbed.includes("AIzaFakeGoogleKey99"), false);
  assert.equal(scrubbed.includes("sk-ant-api03-secret"), false);
  assert.equal(scrubbed.includes("my-baseten-secret"), false);
  assert.equal(scrubbed.includes("raw-secret-xyz"), false);
  assert.match(scrubbed, /\[key\]/);
});

test("server handles missing keys, validation errors, and error scrubbing cleanly", async () => {
  const { server, baseUrl } = await startServer({ env: {} });
  try {
    const modelsRes = await fetch(`${baseUrl}/api/models`).then((r) => r.json());
    assert.equal(modelsRes.models.length, MODELS.length);
    assert.equal(modelsRes.models.every((m) => m.available === false), true);

    const missingKey = await fetch(`${baseUrl}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        modelId: "claude-sonnet-5-5",
        messages: [{ role: "user", content: "Hi" }],
      }),
    });
    assert.equal(missingKey.status, 503);
    const missingBody = await missingKey.json();
    assert.match(missingBody.error, /ANTHROPIC_API_KEY/);

    const unknown = await fetch(`${baseUrl}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        modelId: "not-a-model",
        messages: [{ role: "user", content: "Hi" }],
      }),
    });
    assert.equal(unknown.status, 400);

    const badJson = await fetch(`${baseUrl}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    });
    assert.equal(badJson.status, 400);
  } finally {
    server.close();
  }
});

test("mocked send works end-to-end through Gemini, Anthropic, and Baseten paths", async () => {
  const env = {
    GEMINI_API_KEY: "AIzaMockGeminiSecret123",
    ANTHROPIC_API_KEY: "sk-ant-mock-secret-456",
    BASETEN_API_KEY: "baseten-mock-secret-789",
  };

  const captured = [];
  const originalFetch = globalThis.fetch;

  const mockFetch = async (input, init = {}) => {
    const url = typeof input === "string" ? input : input.url;
    if (url.startsWith("http://127.0.0.1:")) {
      return originalFetch(input, init);
    }

    const headers = Object.fromEntries(new Headers(init.headers || {}).entries());
    const bodyText = typeof init.body === "string" ? init.body : "";
    captured.push({ url, headers, body: bodyText ? JSON.parse(bodyText) : null });

    if (url.includes("generativelanguage.googleapis.com")) {
      return sseResponse([
        `data: ${JSON.stringify({
          candidates: [{ content: { role: "model", parts: [{ text: "Proof by " }] } }],
          usageMetadata: { promptTokenCount: 120, candidatesTokenCount: 4, totalTokenCount: 124 },
        })}\n\n`,
        `data: ${JSON.stringify({
          candidates: [{ content: { role: "model", parts: [{ text: "contradiction." }] } }],
          usageMetadata: { promptTokenCount: 120, candidatesTokenCount: 10, totalTokenCount: 130 },
        })}\n\n`,
      ]);
    }

    if (url === "https://api.anthropic.com/v1/messages") {
      return sseResponse([
        `event: message_start\ndata: ${JSON.stringify({
          type: "message_start",
          message: { usage: { input_tokens: 42, output_tokens: 1 } },
        })}\n\n`,
        `event: content_block_delta\ndata: ${JSON.stringify({
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "Hello " },
        })}\n\n`,
        `event: content_block_delta\ndata: ${JSON.stringify({
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "from Claude." },
        })}\n\n`,
        `event: message_delta\ndata: ${JSON.stringify({
          type: "message_delta",
          usage: { output_tokens: 8 },
        })}\n\n`,
      ]);
    }

    if (url === "https://inference.baseten.co/v1/systemone") {
      return new Response(
        JSON.stringify({
          model: "decision-models/baseten-bison-latest",
          answers: { reply: { type: "noul", noul: 0.985 } },
          usage: { input_tokens: 64, output_tokens: 1 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }

    throw new Error(`Unexpected URL in mockFetch: ${url}`);
  };

  globalThis.fetch = mockFetch;
  const { server, baseUrl } = await startServer({ env, fetchImpl: mockFetch });

  try {
    // 1. Gemini path
    const gemRes = await originalFetch(`${baseUrl}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        modelId: "gemini-4-neon",
        messages: [{ role: "user", content: "Prove sqrt(2) is irrational." }],
      }),
    });
    assert.equal(gemRes.status, 200);
    const gemEvents = parseSseText(await gemRes.text());
    assert.deepEqual(
      gemEvents.filter((e) => e.type === "delta").map((e) => e.text),
      ["Proof by ", "contradiction."],
    );
    const gemDone = gemEvents.find((e) => e.type === "done");
    assert.equal(gemDone.text, "Proof by contradiction.");
    assert.deepEqual(gemDone.usage, { inputTokens: 120, outputTokens: 10, totalTokens: 130 });

    const gemCall = captured.find((c) => c.url.includes("generativelanguage.googleapis.com"));
    assert.ok(gemCall, "Gemini fetch was invoked");
    assert.match(gemCall.url, /gemini-4-neon:streamGenerateContent/);
    assert.equal(gemCall.body.generationConfig.thinkingConfig.thinkingLevel, "HIGH");

    // 2. Anthropic path
    const claudeRes = await originalFetch(`${baseUrl}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        modelId: "claude-sonnet-5-5",
        messages: [{ role: "user", content: "Say hi." }],
      }),
    });
    assert.equal(claudeRes.status, 200);
    const claudeEvents = parseSseText(await claudeRes.text());
    assert.deepEqual(
      claudeEvents.filter((e) => e.type === "delta").map((e) => e.text),
      ["Hello ", "from Claude."],
    );
    const claudeDone = claudeEvents.find((e) => e.type === "done");
    assert.equal(claudeDone.text, "Hello from Claude.");
    assert.deepEqual(claudeDone.usage, { inputTokens: 42, outputTokens: 8, totalTokens: 50 });

    const claudeCall = captured.find((c) => c.url === "https://api.anthropic.com/v1/messages");
    assert.equal(claudeCall.headers["x-api-key"], "sk-ant-mock-secret-456");
    assert.equal(claudeCall.body.model, "claude-sonnet-5-5");

    // 3. Baseten Bison 31B path
    const bisonRes = await originalFetch(`${baseUrl}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        modelId: "baseten-bison-31b",
        messages: [{ role: "user", content: "Is 2 + 2 equal to 4?" }],
      }),
    });
    assert.equal(bisonRes.status, 200);
    const bisonEvents = parseSseText(await bisonRes.text());
    const bisonDone = bisonEvents.find((e) => e.type === "done");
    assert.equal(bisonDone.text, "Yes (98.5% · noul = 0.9850)");
    assert.deepEqual(bisonDone.usage, { inputTokens: 64, outputTokens: 1, totalTokens: 65 });

    const bisonCall = captured.find((c) => c.url === "https://inference.baseten.co/v1/systemone");
    assert.equal(bisonCall.headers.authorization, "Bearer baseten-mock-secret-789");
    assert.equal(bisonCall.body.model, "decision-models/baseten-bison-latest");
    assert.equal(bisonCall.body.service_tier, "default");
    assert.equal(bisonCall.body.questions.reply.type, "noul");
  } finally {
    globalThis.fetch = originalFetch;
    server.close();
  }
});

test("upstream errors scrub provider keys before reaching the browser", async () => {
  const secret = "baseten-ultra-secret-token";
  const mockFetch = async () =>
    new Response(JSON.stringify({ error: `Invalid credentials: Bearer ${secret}` }), {
      status: 401,
      headers: { "content-type": "application/json" },
    });

  const { server, baseUrl } = await startServer({
    env: { BASETEN_API_KEY: secret },
    fetchImpl: mockFetch,
  });

  try {
    const res = await fetch(`${baseUrl}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        modelId: "baseten-bison-31b",
        messages: [{ role: "user", content: "Hello" }],
      }),
    });
    assert.equal(res.status, 502);
    const body = await res.json();
    assert.equal(body.error.includes(secret), false);
    assert.match(body.error, /\[key\]/);
  } finally {
    server.close();
  }
});

test("context window metrics and long-context degradation curve behave accurately", () => {
  assert.equal(estimateTokens(""), 0);
  assert.equal(estimateTokens("12345678"), 2);
  assert.equal(
    estimateMessagesTokens([
      { role: "user", content: "12345678" },
      { role: "assistant", content: "1234" },
      { role: "assistant", error: "ignored", content: "ignored" },
    ]),
    2 + 4 + 1 + 4,
  );

  for (const model of MODELS) {
    const { decayStart, steepStart, maxLossPct } = model.degradation;
    assert.equal(computeIntelligenceLoss(0, model), 0);
    assert.equal(computeIntelligenceLoss(decayStart, model), 0);

    const midPre = computeIntelligenceLoss(Math.round((decayStart + steepStart) / 2), model);
    const atSteep = computeIntelligenceLoss(steepStart, model);
    const midPost = computeIntelligenceLoss(Math.round((steepStart + model.contextWindow) / 2), model);
    const atMax = computeIntelligenceLoss(model.contextWindow, model);

    assert.ok(midPre > 0 && midPre < atSteep, `rises before steepStart for ${model.id}`);
    assert.ok(atSteep < midPost && midPost < atMax, `rises past steepStart for ${model.id}`);
    assert.equal(atMax, maxLossPct);

    const slopeBefore = (atSteep - 0) / (steepStart - decayStart);
    const slopeAfter = (atMax - atSteep) / (model.contextWindow - steepStart);
    assert.ok(slopeAfter > slopeBefore, `decay steepens past steepStart for ${model.id}`);
  }

  const neon = getModel("gemini-4-neon");
  const messages = [
    { role: "user", content: "Hello" },
    { role: "assistant", content: "World" },
  ];

  // Exact provider usage used when messageCount and modelId match
  const exact = computeContextMetrics({
    messages,
    usage: { inputTokens: 400_000, outputTokens: 100_000, totalTokens: 500_000, messageCount: 2, modelId: "gemini-4-neon" },
    model: neon,
  });
  assert.equal(exact.source, "provider");
  assert.equal(exact.tokensUsed, 500_000);
  assert.equal(exact.usedPct, 50);
  assert.equal(exact.lossPct, 10);

  // Falls back to estimate when new message added or model switched
  const stale = computeContextMetrics({
    messages: [...messages, { role: "user", content: "Another turn" }],
    usage: { totalTokens: 500_000, messageCount: 2, modelId: "gemini-4-neon" },
    model: neon,
  });
  assert.equal(stale.source, "estimated");
  assert.equal(stale.lossPct, 0);

  const switched = computeContextMetrics({
    messages,
    usage: { totalTokens: 500_000, messageCount: 2, modelId: "gemini-4-neon" },
    model: getModel("baseten-bison-31b"),
  });
  assert.equal(switched.source, "estimated");
  assert.equal(switched.maxTokens, 131_072);

  assert.equal(formatTokens(0), "0");
  assert.equal(formatTokens(1_500), "1.5k");
  assert.equal(formatTokens(131_072), "131.1k");
  assert.equal(formatTokens(1_000_000), "1M");
  assert.equal(formatLossLabel(0), "−0% intelligence");
  assert.equal(formatLossLabel(14.4), "−14% intelligence");
  assert.equal(formatLossLabel(3.2), "−3.2% intelligence");

  const tip = buildDegradationTooltip(exact, neon);
  assert.match(tip, /RULER/);
  assert.match(tip, /NoLiMa/);
  assert.match(tip, /Fiction\.LiveBench/);
  assert.match(tip, /exact provider token usage/);
});
