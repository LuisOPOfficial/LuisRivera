import { GoogleGenAI } from "@google/genai";
import { PROVIDERS } from "./constants.js";

const REQUEST_TIMEOUT_MS = 90_000;

export function publicError(err, secrets = []) {
  let text = String(err?.message || "The model call failed.");
  for (const secret of secrets) {
    if (secret) text = text.split(secret).join("[key]");
  }
  text = text
    .replace(/AIza[\w-]+/g, "[key]")
    .replace(/sk-ant-[\w-]+/g, "[key]")
    .replace(/(Bearer|Api-Key)\s+[A-Za-z0-9._-]+/gi, "$1 [key]");
  return text.slice(0, 300);
}

function combinedSignal(signal) {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

async function readErrorMessage(res, fallback) {
  const raw = await res.text().catch(() => "");
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      const msg = parsed?.error?.message || parsed?.error || parsed?.message;
      if (typeof msg === "string" && msg.trim()) return msg.trim();
    } catch {
      return raw.trim();
    }
  }
  return `${fallback} (HTTP ${res.status})`;
}

export function buildGeminiRequest(model, messages, signal) {
  const config = { abortSignal: combinedSignal(signal) };
  if (model.thinkingLevel) {
    config.thinkingConfig = {
      thinkingLevel: model.thinkingLevel,
      includeThoughts: false,
    };
  }
  return {
    model: model.apiModel,
    contents: messages.map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content }],
    })),
    config,
  };
}

export function buildAnthropicRequest(model, messages, apiKey) {
  const cfg = PROVIDERS.anthropic;
  return {
    url: cfg.endpoint,
    init: {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": cfg.apiVersion,
      },
      body: JSON.stringify({
        model: model.apiModel,
        max_tokens: cfg.maxTokens,
        stream: true,
        messages: messages.map((m) => ({ role: m.role, content: m.content })),
      }),
    },
  };
}

export function buildBasetenRequest(model, messages, apiKey) {
  const cfg = PROVIDERS.baseten;
  return {
    url: cfg.endpoint,
    init: {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: model.apiModel,
        service_tier: cfg.serviceTier,
        state: {
          messages: messages.map((m) => ({ role: m.role, content: m.content })),
        },
        questions: {
          reply: {
            type: "noul",
            instructions:
              "Reply to the last user message in the conversation: is the statement true or is the answer yes?",
          },
        },
      }),
    },
  };
}

export function formatBasetenReply(data) {
  const answer = data?.answers?.reply ?? Object.values(data?.answers || {})[0];
  if (!answer || typeof answer !== "object") {
    throw new Error("Baseten returned no answer.");
  }
  if (typeof answer.text === "string" && answer.text.trim()) {
    return answer.text.trim();
  }
  if (typeof answer.noul === "number") {
    const verdict = answer.noul >= 0.5 ? "Yes" : "No";
    const pct = (answer.noul * 100).toFixed(1);
    return `${verdict} (${pct}% · noul = ${answer.noul.toFixed(4)})`;
  }
  if (typeof answer.choice === "string") return answer.choice;
  if (typeof answer.score === "number") return `Score: ${answer.score.toFixed(2)}`;
  throw new Error("Baseten returned an unrecognized answer.");
}

function normalizeUsage(inputTokens, outputTokens, totalTokens) {
  const input = Number(inputTokens) || 0;
  const output = Number(outputTokens) || 0;
  const total = Number(totalTokens) || input + output;
  return total > 0 ? { inputTokens: input, outputTokens: output, totalTokens: total } : null;
}

async function streamGemini({ model, messages, apiKey, onDelta, signal }) {
  const ai = new GoogleGenAI({ apiKey });
  const request = buildGeminiRequest(model, messages, signal);
  const stream = await ai.models.generateContentStream(request);
  let full = "";
  let usage = null;

  for await (const chunk of stream) {
    const text = chunk?.text;
    if (text) {
      full += text;
      onDelta(text);
    }
    const um = chunk?.usageMetadata;
    if (um) {
      const next = normalizeUsage(um.promptTokenCount, um.candidatesTokenCount, um.totalTokenCount);
      if (next) usage = next;
    }
  }
  if (!full) throw new Error("The model returned nothing.");
  return { text: full, usage };
}

function consumeAnthropicFrames(rawFrames, onDelta, usageAcc) {
  let appended = "";
  for (const frame of rawFrames) {
    const dataLines = frame
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim());
    if (!dataLines.length) continue;
    const payload = dataLines.join("\n");
    if (!payload || payload === "[DONE]") continue;
    let evt;
    try {
      evt = JSON.parse(payload);
    } catch {
      continue;
    }
    if (evt.type === "error") {
      throw new Error(evt.error?.message || "Anthropic stream error.");
    }
    if (evt.type === "message_start" && evt.message?.usage) {
      const u = evt.message.usage;
      usageAcc.input =
        (Number(u.input_tokens) || 0) +
        (Number(u.cache_creation_input_tokens) || 0) +
        (Number(u.cache_read_input_tokens) || 0);
      if (typeof u.output_tokens === "number") usageAcc.output = u.output_tokens;
    }
    if (evt.type === "message_delta" && evt.usage) {
      if (typeof evt.usage.input_tokens === "number") usageAcc.input = evt.usage.input_tokens;
      if (typeof evt.usage.output_tokens === "number") usageAcc.output = evt.usage.output_tokens;
    }
    if (evt.type === "content_block_delta" && evt.delta?.type === "text_delta" && evt.delta.text) {
      appended += evt.delta.text;
      onDelta(evt.delta.text);
    }
  }
  return appended;
}

async function streamAnthropic({ model, messages, apiKey, onDelta, signal, fetchImpl }) {
  const { url, init } = buildAnthropicRequest(model, messages, apiKey);
  const res = await fetchImpl(url, { ...init, signal: combinedSignal(signal) });
  if (!res.ok) {
    throw new Error(await readErrorMessage(res, "Anthropic request failed"));
  }

  const contentType = res.headers.get("content-type") || "";
  if (!contentType.includes("text/event-stream") || !res.body) {
    const data = await res.json();
    const text = (data?.content || [])
      .filter((block) => block.type === "text" && block.text)
      .map((block) => block.text)
      .join("");
    if (!text) throw new Error("The model returned nothing.");
    onDelta(text);
    const u = data?.usage;
    const usage = u ? normalizeUsage(u.input_tokens, u.output_tokens) : null;
    return { text, usage };
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const usageAcc = { input: 0, output: 0 };
  let buffer = "";
  let full = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split(/\r?\n\r?\n/);
    buffer = parts.pop() || "";
    full += consumeAnthropicFrames(parts, onDelta, usageAcc);
  }
  buffer += decoder.decode();
  if (buffer.trim()) {
    full += consumeAnthropicFrames([buffer], onDelta, usageAcc);
  }
  if (!full) throw new Error("The model returned nothing.");
  return { text: full, usage: normalizeUsage(usageAcc.input, usageAcc.output) };
}

async function callBaseten({ model, messages, apiKey, onDelta, signal, fetchImpl }) {
  const { url, init } = buildBasetenRequest(model, messages, apiKey);
  const res = await fetchImpl(url, { ...init, signal: combinedSignal(signal) });
  if (!res.ok) {
    throw new Error(await readErrorMessage(res, "Baseten request failed"));
  }
  const data = await res.json();
  const reply = formatBasetenReply(data);
  onDelta(reply);
  const u = data?.usage;
  const usage = u ? normalizeUsage(u.input_tokens, u.output_tokens) : null;
  return { text: reply, usage };
}

export async function streamChat({
  model,
  messages,
  apiKey,
  onDelta,
  signal,
  fetchImpl = globalThis.fetch,
}) {
  if (model.provider === "gemini") {
    return streamGemini({ model, messages, apiKey, onDelta, signal });
  }
  if (model.provider === "anthropic") {
    return streamAnthropic({ model, messages, apiKey, onDelta, signal, fetchImpl });
  }
  if (model.provider === "baseten") {
    return callBaseten({ model, messages, apiKey, onDelta, signal, fetchImpl });
  }
  throw new Error(`Unsupported provider: ${model.provider}`);
}
