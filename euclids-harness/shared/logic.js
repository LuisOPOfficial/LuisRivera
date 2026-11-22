const KINDS = new Set(["axiom", "step", "conclusion"]);

export function oneLine(value, max) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  if (text.length <= max) return text;
  return text.slice(0, max - 1).trimEnd() + "…";
}

function freshId(seen, n) {
  let id = "n" + n;
  while (seen.has(id)) id = "n" + ++n;
  return id;
}

export function normalizeColumns(input) {
  if (!Array.isArray(input)) return [];
  const seen = new Set();
  const columns = [];
  for (const raw of input) {
    if (!raw || typeof raw !== "object") continue;
    let id = String(raw.id ?? "").trim();
    if (!/^[A-Za-z0-9_-]{1,24}$/.test(id) || seen.has(id)) id = freshId(seen, columns.length + 1);
    const title = oneLine(raw.title, 48);
    const text = oneLine(raw.text, 280);
    if (!title || !text) continue;
    seen.add(id);
    columns.push({
      id,
      kind: KINDS.has(raw.kind) ? raw.kind : "step",
      title,
      text,
      dependsOn: Array.isArray(raw.dependsOn) ? raw.dependsOn.map((d) => String(d)) : [],
    });
  }
  if (columns.length && !columns.some((c) => c.kind === "conclusion")) {
    columns[columns.length - 1].kind = "conclusion";
  }
  const known = new Set();
  for (const col of columns) {
    col.dependsOn = [...new Set(col.dependsOn.filter((id) => known.has(id)))];
    known.add(col.id);
  }
  return columns.slice(0, 16);
}

// Removed columns are placed first so a survivor can still name them in dependsOn.
export function loadChain(columns, removed = []) {
  const wanted = new Set((removed || []).map((c) => c?.id).filter(Boolean));
  const merged = normalizeColumns([...(removed || []), ...(columns || [])]);
  return {
    columns: merged,
    removedIds: merged.filter((c) => wanted.has(c.id)).map((c) => c.id),
  };
}

function names(items) {
  if (items.length === 0) return "";
  if (items.length === 1) return items[0];
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`;
}

// Stand-in used with no API key.
// The first dependency is necessary. Further ones only corroborate:
// lose the first and the column fails; lose a later one and it thins.
function statusesFor(columns, removedIds) {
  const removed = new Set(removedIds);
  const present = columns.filter((c) => !removed.has(c.id));
  const byId = new Map(present.map((c) => [c.id, c]));
  const memo = new Map();
  const visiting = new Set();

  function statusOf(col) {
    if (!col) return "red";
    if (memo.has(col.id)) return memo.get(col.id);
    if (visiting.has(col.id)) return "red";
    visiting.add(col.id);
    const deps = col.dependsOn || [];
    let status = "green";
    if (deps.length) {
      const [spine, ...rest] = deps;
      const spineStatus = !byId.has(spine) ? "red" : statusOf(byId.get(spine));
      if (spineStatus === "red") status = "red";
      else {
        const extras = rest.map((id) => (byId.has(id) ? statusOf(byId.get(id)) : "red"));
        status = spineStatus === "yellow" || extras.some((s) => s !== "green") ? "yellow" : "green";
      }
    }
    visiting.delete(col.id);
    memo.set(col.id, status);
    return status;
  }

  const statuses = present.map((col) => ({ id: col.id, status: statusOf(col) }));
  return { present, statuses, byId: new Map(statuses.map((s) => [s.id, s.status])) };
}

export function judge(columns, removedIds) {
  const removed = new Set(removedIds);
  const name = names(columns.filter((c) => removed.has(c.id)).map((c) => c.title)) || "that";
  const { present, statuses, byId } = statusesFor(columns, removedIds);

  if (!present.length) {
    return { verdict: "BREAKS", explanation: "Nothing is left of the chain.", columns: [] };
  }
  if (!present.some((c) => c.kind === "conclusion")) {
    return {
      verdict: "BREAKS",
      explanation: `Without ${name}, the chain no longer has a conclusion.`,
      columns: statuses.map((s) => ({ ...s, status: "green" })),
    };
  }

  const conclusion = [...present].reverse().find((c) => c.kind === "conclusion");
  const end = byId.get(conclusion.id);
  const verdict = end === "red" ? "BREAKS" : end === "yellow" ? "WEAKENS" : "HOLDS";
  const titled = (status) =>
    present.filter((c) => c.kind !== "conclusion" && byId.get(c.id) === status).map((c) => c.title);

  const agree = (count, one, many) => (count === 1 ? one : many);
  let explanation;
  if (verdict === "HOLDS") {
    explanation = `Without ${name}, the conclusion still follows. Nothing it rests on used what was removed.`;
  } else if (verdict === "BREAKS") {
    const failed = titled("red");
    explanation = failed.length
      ? `Without ${name}, ${names(failed)} ${agree(failed.length, "no longer follows", "no longer follow")}. The conclusion falls with them.`
      : `Without ${name}, the conclusion no longer follows.`;
  } else {
    const thin = titled("yellow");
    explanation = thin.length
      ? `Without ${name}, ${names(thin)} ${agree(thin.length, "is thinner", "are thinner")}. The conclusion is less secure.`
      : `Without ${name}, the conclusion is less secure.`;
  }
  return { verdict, explanation, columns: statuses };
}

export function judgeAll(columns) {
  return columns
    .filter((c) => c.kind === "axiom")
    .map((axiom) => {
      const result = judge(columns, [axiom.id]);
      return { id: axiom.id, title: axiom.title, verdict: result.verdict, note: result.explanation };
    });
}

function column(id, kind, title, text, dependsOn = []) {
  return { id, kind, title, text, dependsOn };
}

// A fixed shape so the page can be tried with no key.
// Identity is included and then left unused, so one result can be HOLDS.
// The domain premise is the spine, so removing it breaks the conclusion.
export function mockDecompose(claim) {
  const sun = /sun|sunrise/i.test(claim);
  const cause = /\bbecause\b|\bcause|\beffect\b/i.test(claim);
  const testimony = /\b(according to|said that|study|studies|expert|reported)\b/i.test(claim);
  const induction = cause
    ? ["Causality", "Where a cause is present and unblocked, the effect follows."]
    : ["Induction", "An unbroken regularity is a reason to expect it again."];
  const perception = testimony
    ? ["Testimony", "A sincere, competent report is a reason to believe what it says."]
    : ["Perception", sun
      ? "Ordinary repeated sightings of sunrise are trustworthy."
      : "Ordinary observation is a reason to trust what was perceived."];
  const domain = sun
    ? "The Earth keeps turning relative to the Sun, and nothing indicated would stop it."
    : "A background fact particular to this claim is being granted.";
  const applied = sun
    ? ["Apply the turning", "Given that turning, another sunrise is what follows."]
    : ["Apply the domain", "The domain fact carries the claim, with the other premises in support."];

  return [
    column("a1", "axiom", "Identity", sun
      ? "The sun named here is the same sun in every step."
      : "The subject of the claim stays the same thing throughout."),
    column("a2", "axiom", "Non-contradiction", "The claim and its negation cannot both hold."),
    column("a3", "axiom", induction[0], induction[1]),
    column("a4", "axiom", perception[0], perception[1]),
    column("a5", "axiom", "Domain premise", domain),
    column("s1", "step", applied[0], applied[1], ["a5", "a3", "a4"]),
    column("s2", "step", "Keep consistency", "That move does not contradict anything still granted.", ["s1", "a2"]),
    column("c1", "conclusion", "Conclusion", oneLine(claim, 180), ["s2"]),
  ];
}
