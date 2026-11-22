import { GoogleGenAI, Type } from "@google/genai";
import { GEMINI_MODEL, THINKING_LEVEL } from "./constants.js";

const columnSchema = {
  type: Type.OBJECT,
  properties: {
    id: { type: Type.STRING },
    kind: { type: Type.STRING, enum: ["axiom", "step", "conclusion"] },
    title: { type: Type.STRING },
    text: { type: Type.STRING },
    dependsOn: { type: Type.ARRAY, items: { type: Type.STRING } },
  },
  required: ["id", "kind", "title", "text", "dependsOn"],
};

export const schemas = {
  decompose: {
    type: Type.OBJECT,
    properties: { columns: { type: Type.ARRAY, items: columnSchema } },
    required: ["columns"],
  },
  stress: {
    type: Type.OBJECT,
    properties: {
      verdict: { type: Type.STRING, enum: ["HOLDS", "WEAKENS", "BREAKS"] },
      explanation: { type: Type.STRING },
      columns: {
        type: Type.ARRAY,
        items: {
          type: Type.OBJECT,
          properties: {
            id: { type: Type.STRING },
            status: { type: Type.STRING, enum: ["green", "yellow", "red"] },
          },
          required: ["id", "status"],
        },
      },
    },
    required: ["verdict", "explanation", "columns"],
  },
  stressAll: {
    type: Type.OBJECT,
    properties: {
      results: {
        type: Type.ARRAY,
        items: {
          type: Type.OBJECT,
          properties: {
            id: { type: Type.STRING },
            verdict: { type: Type.STRING, enum: ["HOLDS", "WEAKENS", "BREAKS"] },
            note: { type: Type.STRING },
          },
          required: ["id", "verdict", "note"],
        },
      },
    },
    required: ["results"],
  },
};

function parseJson(text) {
  const trimmed = String(text ?? "").trim().replace(/^```(?:json)?\s*|\s*```$/g, "");
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(trimmed.slice(start, end + 1));
    throw new Error("The model did not return JSON.");
  }
}

export async function generateJson({ apiKey, prompt, schema }) {
  const ai = new GoogleGenAI({ apiKey });
  const response = await ai.models.generateContent({
    model: GEMINI_MODEL,
    contents: prompt,
    config: {
      abortSignal: AbortSignal.timeout(90_000),
      thinkingConfig: { thinkingLevel: THINKING_LEVEL, includeThoughts: false },
      responseMimeType: "application/json",
      responseSchema: schema,
    },
  });
  if (!response.text) throw new Error("The model returned nothing.");
  return parseJson(response.text);
}
