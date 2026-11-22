import test from "node:test";
import assert from "node:assert/strict";
import { GEMINI_MODEL, THINKING_LEVEL } from "../constants.js";
import { judge, judgeAll, loadChain, mockDecompose, normalizeColumns } from "../shared/logic.js";

test("model constants stay on gemini-4-neon at high", () => {
  assert.equal(GEMINI_MODEL, "gemini-4-neon");
  assert.equal(THINKING_LEVEL, "HIGH");
});

test("normalize keeps earlier deps and repairs a chain", () => {
  const columns = normalizeColumns([
    { id: "a1", kind: "axiom", title: "One", text: "First." },
    { id: "a1", kind: "nope", title: "Two", text: "Second.", dependsOn: ["a1", "later"] },
    { id: "bad id", kind: "step", title: "Three", text: "Third.", dependsOn: ["missing"] },
    { title: "", text: "nope" },
    { id: "s9", kind: "step", title: "Last", text: "End.", dependsOn: ["a1"] },
  ]);
  assert.deepEqual(columns.map((col) => col.id), ["a1", "n2", "n3", "s9"]);
  assert.equal(columns[1].kind, "step");
  assert.deepEqual(columns[1].dependsOn, ["a1"]);
  assert.deepEqual(columns[2].dependsOn, []);
  assert.equal(columns.at(-1).kind, "conclusion");
});

test("a removed column stays visible to the columns that used it", () => {
  const { columns, removedIds } = loadChain(
    [{ id: "s1", kind: "step", title: "Step", text: "Uses the axiom.", dependsOn: ["a5"] }],
    [{ id: "a5", kind: "axiom", title: "Domain premise", text: "Granted." }],
  );
  assert.deepEqual(removedIds, ["a5"]);
  assert.deepEqual(columns.find((col) => col.id === "s1").dependsOn, ["a5"]);
  const result = judge(columns, removedIds);
  assert.equal(result.verdict, "BREAKS");
  assert.equal(result.columns.find((col) => col.id === "s1").status, "red");
});

test("the sun chain breaks on its spine, thins on support, and holds without identity", () => {
  const columns = mockDecompose("The sun will rise tomorrow.");
  assert.equal(columns.at(-1).text, "The sun will rise tomorrow.");
  assert.deepEqual(columns.find((col) => col.id === "s1").dependsOn, ["a5", "a3", "a4"]);
  assert.ok(columns.every((col) => !col.dependsOn.includes("a1")));

  const broken = judge(columns, ["a5"]);
  assert.equal(broken.verdict, "BREAKS");
  assert.equal(broken.columns.find((col) => col.id === "s1").status, "red");
  assert.equal(broken.columns.find((col) => col.id === "c1").status, "red");
  assert.equal(broken.columns.find((col) => col.id === "a3").status, "green");
  assert.match(broken.explanation, /Apply the turning/);

  const thin = judge(columns, ["a3"]);
  assert.equal(thin.verdict, "WEAKENS");
  assert.equal(thin.columns.find((col) => col.id === "s1").status, "yellow");
  assert.equal(thin.columns.find((col) => col.id === "c1").status, "yellow");

  const held = judge(columns, ["a1"]);
  assert.equal(held.verdict, "HOLDS");
  assert.ok(held.columns.every((col) => col.status === "green"));

  const weakened = judge(columns, ["a2"]);
  assert.equal(weakened.verdict, "WEAKENS");
  assert.match(weakened.explanation, /Keep consistency is thinner/);
  assert.equal(judge(columns, ["c1"]).verdict, "BREAKS");
});

test("stress-test all names the load-bearing axioms", () => {
  const results = judgeAll(mockDecompose("The sun will rise tomorrow."));
  const byId = Object.fromEntries(results.map((row) => [row.id, row.verdict]));
  assert.equal(byId.a1, "HOLDS");
  assert.equal(byId.a2, "WEAKENS");
  assert.equal(byId.a3, "WEAKENS");
  assert.equal(byId.a4, "WEAKENS");
  assert.equal(byId.a5, "BREAKS");
});

test("causal and testimonial claims swap in the matching principle", () => {
  const causal = mockDecompose("The ice melted because the room was warm.");
  assert.equal(causal.find((col) => col.id === "a3").title, "Causality");
  const told = mockDecompose("According to the study, the bridge is safe.");
  assert.equal(told.find((col) => col.id === "a4").title, "Testimony");
});
