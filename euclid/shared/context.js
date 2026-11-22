// Context window accounting and long-context intelligence degradation curve.
// Shared between the browser UI and Node tests.

const DEFAULT_WINDOW = 128_000;
const MID_LOSS_SHARE = 0.25;

export function estimateTokens(text) {
  const str = String(text ?? "");
  if (!str) return 0;
  return Math.ceil(str.length / 4);
}

export function estimateMessagesTokens(messages = []) {
  let total = 0;
  for (const msg of messages) {
    if (!msg || msg.error || !msg.content) continue;
    total += estimateTokens(msg.content) + 4;
  }
  return total;
}

export function computeIntelligenceLoss(tokens, model) {
  const maxTokens = Math.max(1, Number(model?.contextWindow) || DEFAULT_WINDOW);
  const used = Math.max(0, Number(tokens) || 0);
  const curve = model?.degradation || {};
  const decayStart = Math.max(0, Number(curve.decayStart) || Math.round(maxTokens * 0.25));
  const steepStart = Math.max(
    decayStart + 1,
    Math.min(maxTokens, Number(curve.steepStart) || Math.round(maxTokens * 0.5)),
  );
  const maxLossPct = Math.max(0, Number(curve.maxLossPct) || 45);

  if (used <= decayStart || maxLossPct === 0) return 0;

  const midLoss = maxLossPct * MID_LOSS_SHARE;
  if (used <= steepStart) {
    const u = (used - decayStart) / (steepStart - decayStart);
    return Number((midLoss * Math.pow(u, 1.5)).toFixed(1));
  }

  const tailSpan = Math.max(1, maxTokens - steepStart);
  const v = Math.min(1, (used - steepStart) / tailSpan);
  const loss = midLoss + (maxLossPct - midLoss) * (0.65 * v + 0.35 * v * v);
  return Number(Math.min(maxLossPct, loss).toFixed(1));
}

export function computeContextMetrics({ messages = [], usage = null, model = null } = {}) {
  const maxTokens = Math.max(1, Number(model?.contextWindow) || DEFAULT_WINDOW);
  const validMessages = messages.filter((m) => m && !m.error && m.content);
  const hasExactUsage =
    Boolean(usage) &&
    typeof usage.totalTokens === "number" &&
    usage.totalTokens >= 0 &&
    usage.messageCount === validMessages.length &&
    (!model?.id || !usage.modelId || usage.modelId === model.id);

  const tokensUsed = hasExactUsage
    ? Math.round(usage.totalTokens)
    : estimateMessagesTokens(validMessages);
  const source = hasExactUsage ? "provider" : "estimated";
  const usedPct = Number(Math.min(100, (tokensUsed / maxTokens) * 100).toFixed(1));
  const lossPct = computeIntelligenceLoss(tokensUsed, model);

  return {
    tokensUsed,
    maxTokens,
    usedPct,
    source,
    lossPct,
  };
}

export function formatTokens(n) {
  const value = Math.max(0, Math.round(Number(n) || 0));
  if (value >= 1_000_000) {
    const m = value / 1_000_000;
    return `${Number.isInteger(m) ? m : m.toFixed(1)}M`;
  }
  if (value >= 10_000) return `${(value / 1_000).toFixed(1).replace(/\.0$/, "")}k`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(value);
}

export function formatLossLabel(lossPct) {
  const value = Math.max(0, Number(lossPct) || 0);
  const rounded = value >= 10 || value === 0 ? Math.round(value) : Number(value.toFixed(1));
  return `\u2212${rounded}% intelligence`;
}

export function buildDegradationTooltip(metrics, model) {
  const curve = model?.degradation || {};
  const decayStart = formatTokens(curve.decayStart ?? 32_000);
  const steepStart = formatTokens(curve.steepStart ?? Math.round(metrics.maxTokens * 0.5));
  const sourceNote =
    metrics.source === "provider"
      ? "exact provider token usage"
      : "estimated from message length (~4 chars/token)";

  return (
    `Estimated effective intelligence drop from long-context degradation ` +
    `(modeled on RULER, NoLiMa, and Fiction.LiveBench): stays near 0% up to ${decayStart} tokens ` +
    `and steepens past ${steepStart} (~50% of the ${formatTokens(metrics.maxTokens)} window). ` +
    `Current chat: ${metrics.tokensUsed.toLocaleString("en-US")} / ${metrics.maxTokens.toLocaleString("en-US")} tokens ` +
    `(${metrics.usedPct}%, ${sourceNote}).`
  );
}
