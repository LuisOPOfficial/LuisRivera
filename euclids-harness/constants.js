// Point the harness at other Gemini models or thinking depths here.
// Thinking levels the API accepts: MINIMAL, LOW, MEDIUM, HIGH, XHIGH.
// Decompose (the main run) uses neon at HIGH.
// Single-block and stress-test-all use carbon at MEDIUM.
export const GEMINI_MODEL = "gemini-4-neon";
export const THINKING_LEVEL = "HIGH";
export const STRESS_MODEL = "gemini-4-carbon";
export const STRESS_THINKING_LEVEL = "MEDIUM";
