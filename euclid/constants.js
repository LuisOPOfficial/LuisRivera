// Single registry for models, provider defaults, and long-context degradation curves.
// Gemini thinking levels accepted by the API: MINIMAL, LOW, MEDIUM, HIGH, XHIGH.
export const THINKING_LEVELS = ["MINIMAL", "LOW", "MEDIUM", "HIGH", "XHIGH"];

export const DEFAULT_HOST = "127.0.0.1";
export const DEFAULT_PORT = 4180;

export const PROVIDERS = {
  gemini: {
    name: "Google Gemini",
    envKey: "GEMINI_API_KEY",
  },
  anthropic: {
    name: "Anthropic",
    envKey: "ANTHROPIC_API_KEY",
    endpoint: "https://api.anthropic.com/v1/messages",
    apiVersion: "2023-06-01",
    maxTokens: 4096,
  },
  baseten: {
    name: "Baseten",
    envKey: "BASETEN_API_KEY",
    endpoint: "https://inference.baseten.co/v1/systemone",
    serviceTier: "default",
  },
};

// Long-context degradation curve parameters per model.
// Sources: published long-context reasoning & retrieval benchmarks —
//   - RULER (Hsieh et al., 2024): effective context length typically falls well below
//     advertised window sizes, with multi-hop/aggregation tasks decaying from ~32k-64k tokens.
//   - NoLiMa (Modarressi et al., 2025): non-literal retrieval degrades sharply past ~32k tokens.
//   - Fiction.LiveBench (2025): deep comprehension on long narratives decays steadily
//     after ~32k-64k tokens and steepens substantially beyond ~50% of the context window.
// Curve shape (see shared/context.js):
//   - 0% loss up to `decayStart`
//   - gradual rise from `decayStart` to `steepStart` (~50% of window)
//   - steeper rise from `steepStart` to `contextWindow`, reaching `maxLossPct` at 100% fill.
//
// Edit model IDs, thinking levels, or curve parameters here.
// Other current Claude IDs: "claude-opus-5-5", "claude-haiku-5-5".
export const MODELS = [
  {
    id: "gemini-4-neon",
    label: "Gemini 4 Neon",
    provider: "gemini",
    apiModel: "gemini-4-neon",
    thinkingLevel: "HIGH",
    streaming: true,
    note: "Thinking: HIGH",
    contextWindow: 1_000_000,
    degradation: {
      decayStart: 64_000,
      steepStart: 500_000,
      maxLossPct: 40,
    },
  },
  {
    id: "gemini-4-carbon",
    label: "Gemini 4 Carbon",
    provider: "gemini",
    apiModel: "gemini-4-carbon",
    thinkingLevel: "MEDIUM",
    streaming: true,
    note: "Thinking: MEDIUM",
    contextWindow: 1_000_000,
    degradation: {
      decayStart: 48_000,
      steepStart: 500_000,
      maxLossPct: 45,
    },
  },
  {
    id: "gemini-4-argon",
    label: "Gemini 4 Argon",
    provider: "gemini",
    apiModel: "gemini-4-argon",
    streaming: true,
    contextWindow: 1_000_000,
    degradation: {
      decayStart: 32_000,
      steepStart: 500_000,
      maxLossPct: 50,
    },
  },
  {
    id: "claude-sonnet-5-5",
    label: "Claude Sonnet 5.5",
    provider: "anthropic",
    apiModel: "claude-sonnet-5-5",
    streaming: true,
    contextWindow: 1_000_000,
    degradation: {
      decayStart: 64_000,
      steepStart: 500_000,
      maxLossPct: 42,
    },
  },
  {
    id: "baseten-bison-31b",
    label: "Baseten Bison 31B",
    provider: "baseten",
    apiModel: "decision-models/baseten-bison-latest",
    streaming: false,
    note: "Decision model (yes/no)",
    contextWindow: 131_072,
    degradation: {
      decayStart: 32_000,
      steepStart: 65_536,
      maxLossPct: 55,
    },
  },
];

export function getModel(id) {
  return MODELS.find((model) => model.id === id) || null;
}

export function providerKeyFor(providerId, env = process.env) {
  const provider = PROVIDERS[providerId];
  return provider ? String(env?.[provider.envKey] ?? "").trim() : "";
}

export function listModels(env = process.env) {
  return MODELS.map((model) => {
    const provider = PROVIDERS[model.provider];
    const available = Boolean(providerKeyFor(model.provider, env));
    return {
      id: model.id,
      label: model.label,
      provider: model.provider,
      providerName: provider.name,
      apiModel: model.apiModel,
      thinkingLevel: model.thinkingLevel || null,
      streaming: model.streaming,
      note: model.note || null,
      contextWindow: model.contextWindow,
      degradation: model.degradation,
      available,
      hint: available ? null : `Set ${provider.envKey}`,
    };
  });
}
