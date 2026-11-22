const KEY = "euclids-harness-key";
const ROMAN = ["I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X", "XI", "XII", "XIII", "XIV", "XV", "XVI"];
const RANK = { BREAKS: 0, WEAKENS: 1, HOLDS: 2 };
const MARK = { green: "sound", yellow: "thin", red: "fails" };
const KINDS = ["axiom", "step", "conclusion"];

const claimEl = document.querySelector("#claim");
const statusEl = document.querySelector("#status");
const columnsEl = document.querySelector("#columns");
const verdictEl = document.querySelector("#verdict");
const summaryEl = document.querySelector("#summary");
const decomposeBtn = document.querySelector("#decompose");
const stressAllBtn = document.querySelector("#stress-all");
const addBtn = document.querySelector("#add");
const keyEl = document.querySelector("#key");
const forgetBtn = document.querySelector("#forget");
const footEl = document.querySelector("#foot");

let columns = [];
let verdict = null;
let summary = null;
let busy = false;

function roman(n) {
  return ROMAN[n - 1] || String(n);
}

function claimText() {
  return claimEl.value.trim();
}

function setStatus(text, bad = false) {
  statusEl.textContent = text || "";
  statusEl.classList.toggle("bad", Boolean(bad && text));
}

function noteSource(source) {
  setStatus(source === "mock" ? "Local stand-in — no Gemini key." : "");
}

function slim(col) {
  return {
    id: col.id,
    kind: col.kind,
    title: col.title.trim() || "Untitled",
    text: col.text.trim() || "…",
    dependsOn: col.dependsOn,
  };
}

function clearStress() {
  verdict = null;
  summary = null;
  for (const col of columns) delete col.status;
}

async function post(url, body) {
  const headers = { "content-type": "application/json" };
  const key = localStorage.getItem(KEY)?.trim();
  if (key) headers["x-gemini-key"] = key;
  const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "The request failed.");
  return data;
}

function sync() {
  const axioms = columns.some((col) => col.kind === "axiom" && col.enabled !== false);
  decomposeBtn.disabled = busy;
  addBtn.disabled = busy;
  stressAllBtn.disabled = busy || !axioms;
  document.querySelector("#app").setAttribute("aria-busy", String(busy));
}

async function withBusy(label, fn) {
  if (busy) return;
  busy = true;
  setStatus(label);
  sync();
  try {
    await fn();
  } catch (err) {
    setStatus(err.message || "Something went wrong.", true);
  } finally {
    busy = false;
    sync();
  }
}

function paintChrome() {
  verdictEl.replaceChildren();
  if (!verdict) {
    verdictEl.hidden = true;
  } else {
    verdictEl.hidden = false;
    const word = document.createElement("b");
    word.className = "v-" + verdict.verdict;
    word.textContent = verdict.verdict;
    const text = document.createElement("p");
    text.textContent = verdict.explanation;
    verdictEl.append(word, text);
  }

  summaryEl.replaceChildren();
  if (!summary) {
    summaryEl.hidden = true;
    return;
  }
  summaryEl.hidden = false;
  const heading = document.createElement("h2");
  heading.textContent = "Each axiom removed in turn";
  const bearing = summary.results.filter((row) => row.verdict !== "HOLDS");
  const lead = document.createElement("p");
  lead.className = "bearing";
  lead.textContent = bearing.length
    ? "Load-bearing: " + bearing.map((row) => row.title).join(", ")
    : "No axiom here is load-bearing.";
  const list = document.createElement("ul");
  for (const row of summary.results) {
    const item = document.createElement("li");
    const name = document.createElement("span");
    name.textContent = row.title;
    const word = document.createElement("span");
    word.className = "v-" + row.verdict;
    word.textContent = row.verdict;
    const note = document.createElement("span");
    note.textContent = row.note;
    item.append(name, word, note);
    list.append(item);
  }
  summaryEl.append(heading, lead, list);
  if (summary.source === "mock") {
    const via = document.createElement("p");
    via.className = "via";
    via.textContent = "Local stand-in — no Gemini key.";
    summaryEl.append(via);
  }
}

function button(text, act, label) {
  const el = document.createElement("button");
  el.type = "button";
  el.dataset.act = act;
  el.className = act;
  el.textContent = text;
  el.setAttribute("aria-label", label);
  if (act === "toggle") el.setAttribute("aria-pressed", String(text === "on"));
  return el;
}

function build() {
  paintChrome();
  sync();
  const frag = document.createDocumentFragment();
  columns.forEach((col, index) => {
    const article = document.createElement("article");
    article.className = ["column", col.enabled === false ? "off" : "", col.status || ""].filter(Boolean).join(" ");
    article.dataset.id = col.id;

    const head = document.createElement("div");
    head.className = "head";
    const num = document.createElement("span");
    num.className = "num";
    num.textContent = roman(index + 1);
    const kind = button(col.kind, "kind", "Change kind");
    const controls = document.createElement("span");
    controls.className = "controls";
    const on = col.enabled !== false;
    controls.append(
      button(on ? "on" : "off", "toggle", on ? "Switch off" : "Switch on"),
      button("×", "remove", `Remove ${col.title}`),
    );
    head.append(num, kind, controls);

    const title = document.createElement("input");
    title.dataset.field = "title";
    title.className = "title";
    title.value = col.title;
    title.setAttribute("aria-label", "Title");

    const text = document.createElement("textarea");
    text.dataset.field = "text";
    text.className = "text";
    text.rows = 4;
    text.value = col.text;
    text.setAttribute("aria-label", "Text");

    const earlier = columns.slice(0, index);
    const from = document.createElement("p");
    from.className = "from";
    const label = document.createElement("span");
    label.textContent = "from";
    const selected = earlier.filter((prev) => col.dependsOn.includes(prev.id));
    const names = document.createElement("span");
    names.className = selected.length ? "deps" : "deps empty";
    names.textContent = selected.length ? selected.map((prev) => prev.title).join(", ") : "nothing";
    from.append(label, names);

    const picks = document.createElement("p");
    picks.className = "picks";
    earlier.forEach((prev, pick) => {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.dataset.act = "dep";
      chip.dataset.dep = prev.id;
      chip.className = col.dependsOn.includes(prev.id) ? "chip on" : "chip";
      chip.textContent = roman(pick + 1);
      chip.title = prev.title;
      chip.setAttribute("aria-label", `Depends on ${prev.title}`);
      chip.setAttribute("aria-pressed", String(col.dependsOn.includes(prev.id)));
      picks.append(chip);
    });

    article.append(head, title, text, from);
    if (earlier.length) article.append(picks);
    if (col.status && col.enabled !== false) {
      const mark = document.createElement("p");
      mark.className = "mark";
      mark.textContent = MARK[col.status] || "";
      article.append(mark);
    }
    frag.append(article);
  });
  columnsEl.replaceChildren(frag);
}

function markEdited() {
  if (!verdict && !summary && columns.every((col) => !col.status)) return;
  clearStress();
  paintChrome();
  for (const el of columnsEl.querySelectorAll(".column")) {
    el.classList.remove("green", "yellow", "red");
    el.querySelector(".mark")?.remove();
  }
}

function requireClaim() {
  const claim = claimText();
  if (claim) return claim;
  setStatus("Enter a claim.", true);
  claimEl.focus();
  return "";
}

async function decompose() {
  const claim = requireClaim();
  if (!claim) return;
  await withBusy("Reading the claim…", async () => {
    const data = await post("/api/decompose", { claim });
    columns = data.columns.map((col) => ({ ...col, dependsOn: [...col.dependsOn], enabled: true }));
    clearStress();
    noteSource(data.source);
  });
  build();
}

function applyStress(data) {
  summary = null;
  const status = new Map((data.columns || []).map((col) => [col.id, col.status]));
  for (const col of columns) {
    if (col.enabled === false) delete col.status;
    else col.status = status.get(col.id) || "green";
  }
  verdict = { verdict: data.verdict, explanation: data.explanation, source: data.source };
  noteSource(data.source);
}

async function stress(removed, label) {
  const claim = requireClaim();
  if (!claim) return false;
  const removedIds = new Set(removed.map((col) => col.id));
  const kept = columns.filter((col) => !removedIds.has(col.id));
  if (!kept.length) {
    clearStress();
    setStatus("Nothing left to test.");
    return false;
  }
  let ok = false;
  await withBusy(label, async () => {
    const data = await post("/api/stress", {
      claim,
      columns: kept.map(slim),
      removed: removed.map(slim),
    });
    applyStress(data);
    ok = true;
  });
  return ok;
}

async function removeColumn(id) {
  const target = columns.find((col) => col.id === id);
  if (!target || busy) return;
  const removed = columns.filter((col) => col.id === id || col.enabled === false);
  const kept = columns.filter((col) => !removed.some((item) => item.id === col.id));
  if (!kept.length) {
    columns = columns.filter((col) => col.id !== id);
    for (const col of columns) col.dependsOn = col.dependsOn.filter((dep) => dep !== id);
    clearStress();
    build();
    setStatus("Nothing left to test.");
    return;
  }
  const ok = await stress(removed, `Stress-testing without ${target.title}…`);
  if (!ok) return;
  columns = columns.filter((col) => col.id !== id);
  for (const col of columns) col.dependsOn = col.dependsOn.filter((dep) => dep !== id);
  build();
  verdictEl.scrollIntoView({ block: "nearest" });
}

async function toggleColumn(id) {
  const col = columns.find((item) => item.id === id);
  if (!col || busy) return;
  col.enabled = col.enabled === false;
  clearStress();
  const removed = columns.filter((item) => item.enabled === false);
  const kept = columns.filter((item) => item.enabled !== false);
  build();
  if (!kept.length) {
    setStatus("Nothing left to test.");
    return;
  }
  if (!removed.length) return;
  const ok = await stress(removed, `Stress-testing without ${removed.map((item) => item.title).join(", ")}…`);
  if (!ok) col.enabled = col.enabled === false;
  build();
  if (ok) verdictEl.scrollIntoView({ block: "nearest" });
}

function cycleKind(id) {
  const col = columns.find((item) => item.id === id);
  if (!col || busy) return;
  col.kind = KINDS[(KINDS.indexOf(col.kind) + 1) % KINDS.length];
  clearStress();
  build();
}

function toggleDep(id, dep) {
  const index = columns.findIndex((col) => col.id === id);
  const col = columns[index];
  if (!col || busy || index < 0) return;
  const earlier = columns.slice(0, index).map((item) => item.id);
  const next = new Set(col.dependsOn);
  if (next.has(dep)) next.delete(dep);
  else next.add(dep);
  col.dependsOn = earlier.filter((item) => next.has(item));
  clearStress();
  build();
}

function addColumn() {
  if (busy) return;
  const id = "u" + Math.random().toString(36).slice(2, 7);
  const kind = columns.length ? "step" : "axiom";
  const col = {
    id,
    kind,
    title: kind === "axiom" ? "Added premise" : "Added step",
    text: "A premise you supply.",
    dependsOn: [],
    enabled: true,
  };
  const at = columns.findIndex((item) => item.kind === "conclusion");
  if (at === -1) columns.push(col);
  else columns.splice(at, 0, col);
  clearStress();
  build();
  columnsEl.querySelector(`[data-id="${id}"] [data-field="title"]`)?.focus();
}

async function stressAll() {
  const claim = requireClaim();
  if (!claim || busy) return;
  const kept = columns.filter((col) => col.enabled !== false);
  const order = new Map(kept.map((col, index) => [col.id, index]));
  await withBusy("Removing each axiom in turn…", async () => {
    const data = await post("/api/stress-all", { claim, columns: kept.map(slim) });
    clearStress();
    summary = {
      source: data.source,
      results: [...data.results].sort(
        (a, b) => RANK[a.verdict] - RANK[b.verdict] || order.get(a.id) - order.get(b.id),
      ),
    };
    noteSource(data.source);
  });
  build();
  if (summary) summaryEl.scrollIntoView({ block: "nearest" });
}

document.querySelector("#composer").addEventListener("submit", (event) => {
  event.preventDefault();
  decompose();
});

claimEl.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
    event.preventDefault();
    document.querySelector("#composer").requestSubmit();
  }
});

stressAllBtn.addEventListener("click", stressAll);
addBtn.addEventListener("click", addColumn);

columnsEl.addEventListener("input", (event) => {
  const article = event.target.closest(".column");
  const col = columns.find((item) => item.id === article?.dataset.id);
  const field = event.target.dataset.field;
  if (!col || !field) return;
  col[field] = event.target.value;
  markEdited();
});

columnsEl.addEventListener("click", (event) => {
  const control = event.target.closest("button");
  const article = event.target.closest(".column");
  if (!control || !article) return;
  const id = article.dataset.id;
  const act = control.dataset.act;
  if (act === "remove") removeColumn(id);
  else if (act === "toggle") toggleColumn(id);
  else if (act === "kind") cycleKind(id);
  else if (act === "dep") toggleDep(id, control.dataset.dep);
});

keyEl.value = localStorage.getItem(KEY) || "";
forgetBtn.hidden = !keyEl.value;
keyEl.addEventListener("input", () => {
  const value = keyEl.value.trim();
  if (value) localStorage.setItem(KEY, value);
  else localStorage.removeItem(KEY);
  forgetBtn.hidden = !value;
});
forgetBtn.addEventListener("click", () => {
  localStorage.removeItem(KEY);
  keyEl.value = "";
  forgetBtn.hidden = true;
});

fetch("/api/health")
  .then((res) => res.json())
  .then((data) => {
    const level = String(data.thinking || "").toLowerCase();
    footEl.textContent = data.configured
      ? `${data.model} · thinking ${level} · server key in use`
      : `${data.model} · thinking ${level} · no server key`;
  })
  .catch(() => {});

sync();
