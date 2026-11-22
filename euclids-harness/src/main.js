const KEY = "euclids-harness-key";
const RANK = { BREAKS: 0, WEAKENS: 1, HOLDS: 2 };
const COLORS = ["red", "blue", "yellow", "green"];
const KINDS = ["axiom", "step", "conclusion"];
const CRACKS = `<svg class="cracks" viewBox="0 0 160 100" aria-hidden="true">
  <path d="M48 0 L62 28 L50 46 L70 100" fill="none" stroke="rgba(0,0,0,0.38)" stroke-width="3" stroke-linecap="round"/>
  <path d="M108 0 L96 36 L112 58 L100 100" fill="none" stroke="rgba(0,0,0,0.28)" stroke-width="2.4" stroke-linecap="round"/>
</svg>`;

const claimEl = document.querySelector("#claim");
const statusEl = document.querySelector("#status");
const towerEl = document.querySelector("#tower");
const trayEl = document.querySelector("#tray");
const trayBlocksEl = document.querySelector("#tray-blocks");
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
  for (const col of columns) {
    delete col.status;
    col.loadBearing = false;
  }
}

function shortModel(id) {
  const match = String(id || "").match(/gemini-4-(\w+)/i);
  return match ? match[1].toLowerCase() : String(id || "").toLowerCase();
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
  heading.textContent = "Each block pulled in turn";
  const bearing = summary.results.filter((row) => row.verdict !== "HOLDS");
  const lead = document.createElement("p");
  lead.className = "bearing";
  lead.textContent = bearing.length
    ? "Load-bearing: " + bearing.map((row) => row.title).join(", ")
    : "No block here is load-bearing.";
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

function colorFor(col, index) {
  if (col.kind === "conclusion") return "orange conclusion";
  return COLORS[index % COLORS.length];
}

function makeBlock(col, index, inTray) {
  const article = document.createElement("article");
  article.className = ["block", colorFor(col, index), col.loadBearing ? "load-bearing" : ""].filter(Boolean).join(" ");
  article.dataset.id = col.id;
  article.dataset.kind = col.kind;

  const kind = document.createElement("p");
  kind.className = "kind";
  kind.textContent = col.kind;

  const title = document.createElement("p");
  title.className = "title";
  title.textContent = col.title;

  const text = document.createElement("p");
  text.className = "text";
  text.textContent = col.text;

  article.insertAdjacentHTML("beforeend", CRACKS);
  article.append(kind, title, text);

  if (inTray) {
    const back = document.createElement("button");
    back.type = "button";
    back.className = "put-back";
    back.dataset.act = "put-back";
    back.textContent = "Put it back";
    article.append(back);
  } else if (col.kind !== "conclusion") {
    article.setAttribute("aria-label", `Pull out ${col.title}`);
  }
  return article;
}

function layer(name, items, offset) {
  const row = document.createElement("div");
  row.className = "layer layer-" + name;
  items.forEach((col, i) => row.append(makeBlock(col, offset + i, false)));
  return row;
}

function build() {
  paintChrome();
  sync();
  const standing = columns.filter((col) => col.enabled !== false);
  const pulled = columns.filter((col) => col.enabled === false);
  const axioms = standing.filter((col) => col.kind === "axiom");
  const steps = standing.filter((col) => col.kind === "step");
  const conclusions = standing.filter((col) => col.kind === "conclusion");
  const frag = document.createDocumentFragment();
  if (conclusions.length) frag.append(layer("conclusion", conclusions, 20));
  if (steps.length) frag.append(layer("steps", steps, 8));
  if (axioms.length) frag.append(layer("axioms", axioms, 0));
  towerEl.replaceChildren(frag);

  trayBlocksEl.replaceChildren();
  trayEl.hidden = pulled.length === 0;
  pulled.forEach((col, i) => trayBlocksEl.append(makeBlock(col, i, true)));

  if (verdict) applyMotion(verdict.verdict);
  towerEl.querySelectorAll(".block").forEach((el) => bindPull(el));
}

function applyMotion(result) {
  const standing = [...towerEl.querySelectorAll(".block")];
  if (result === "HOLDS") {
    towerEl.classList.add("steady");
    return;
  }
  standing.forEach((el, i) => {
    const col = columns.find((item) => item.id === el.dataset.id);
    const status = col?.status;
    if (result === "WEAKENS" && (status === "yellow" || status === "red" || col?.kind === "conclusion")) {
      el.classList.add("wobble", "cracked");
      el.style.animationDelay = `${i * 40}ms`;
    }
    if (result === "BREAKS" && (status === "red" || col?.kind === "conclusion")) {
      const dir = i % 2 === 0 ? 1 : -1;
      el.style.setProperty("--dx", `${dir * (70 + (i % 3) * 24)}px`);
      el.style.setProperty("--rot", `${dir * (22 + (i % 4) * 8)}deg`);
      el.style.animationDelay = `${80 + i * 70}ms`;
      el.classList.add("tumble");
    }
  });
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
  await withBusy("Building the tower…", async () => {
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
    col.loadBearing = false;
  }
  verdict = { verdict: data.verdict, explanation: data.explanation, source: data.source };
  noteSource(data.source);
}

async function stress(removed, label) {
  const claim = requireClaim();
  if (!claim) return false;
  const removedIds = new Set(removed.map((col) => col.id));
  const kept = columns.filter((col) => !removedIds.has(col.id) && col.enabled !== false);
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

async function pullBlock(id) {
  const col = columns.find((item) => item.id === id);
  if (!col || busy || col.enabled === false || col.kind === "conclusion") return;
  col.enabled = false;
  clearStress();
  build();
  const removed = columns.filter((item) => item.enabled === false);
  const kept = columns.filter((item) => item.enabled !== false);
  if (!kept.length) {
    setStatus("Nothing left to test.");
    return;
  }
  const ok = await stress(removed, `Pulling out ${col.title}…`);
  if (!ok) col.enabled = true;
  build();
  if (ok) verdictEl.scrollIntoView({ block: "nearest" });
}

async function putBack(id) {
  const col = columns.find((item) => item.id === id);
  if (!col || busy || col.enabled !== false) return;
  col.enabled = true;
  const removed = columns.filter((item) => item.enabled === false);
  const kept = columns.filter((item) => item.enabled !== false);
  if (!removed.length) {
    clearStress();
    build();
    return;
  }
  if (!kept.length) {
    clearStress();
    build();
    setStatus("Nothing left to test.");
    return;
  }
  const ok = await stress(removed, `Putting ${col.title} back…`);
  if (!ok) col.enabled = false;
  build();
}

function addColumn() {
  if (busy) return;
  const id = "u" + Math.random().toString(36).slice(2, 7);
  const kind = columns.some((col) => col.kind === "axiom") ? "step" : "axiom";
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
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function playStressAll(results) {
  for (const row of results) {
    const el = towerEl.querySelector(`.block[data-id="${row.id}"]`);
    if (!el) continue;
    el.classList.add("pulling", "flash-" + row.verdict);
    if (row.verdict === "WEAKENS") el.classList.add("wobble", "cracked");
    if (row.verdict === "BREAKS") {
      el.style.setProperty("--dx", "86px");
      el.style.setProperty("--rot", "16deg");
    }
    await sleep(row.verdict === "HOLDS" ? 520 : 780);
    el.classList.remove("pulling", "wobble", "cracked", "flash-HOLDS", "flash-WEAKENS", "flash-BREAKS");
    el.style.removeProperty("--dx");
    el.style.removeProperty("--rot");
    await sleep(160);
  }
  for (const row of results) {
    const col = columns.find((item) => item.id === row.id);
    if (col) col.loadBearing = row.verdict !== "HOLDS";
  }
}

async function stressAll() {
  const claim = requireClaim();
  if (!claim || busy) return;
  const kept = columns.filter((col) => col.enabled !== false);
  const order = new Map(kept.map((col, index) => [col.id, index]));
  await withBusy("Pulling each block in turn…", async () => {
    const data = await post("/api/stress-all", { claim, columns: kept.map(slim) });
    clearStress();
    summary = {
      source: data.source,
      results: [...data.results].sort(
        (a, b) => RANK[a.verdict] - RANK[b.verdict] || order.get(a.id) - order.get(b.id),
      ),
    };
    noteSource(data.source);
    build();
    await playStressAll(summary.results);
    build();
  });
  if (summary) summaryEl.scrollIntoView({ block: "nearest" });
}

function bindPull(el) {
  const id = el.dataset.id;
  if (!id || el.dataset.kind === "conclusion") return;
  let startX = 0;
  let startY = 0;
  let dragged = false;
  let holding = false;

  el.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || busy || event.target.closest("button")) return;
    holding = true;
    dragged = false;
    startX = event.clientX;
    startY = event.clientY;
    el.setPointerCapture(event.pointerId);
  });

  el.addEventListener("pointermove", (event) => {
    if (!holding) return;
    const dx = event.clientX - startX;
    const dy = event.clientY - startY;
    if (Math.hypot(dx, dy) > 8) dragged = true;
    if (dragged) el.style.transform = `translate(${dx}px, ${dy}px) rotate(${dx / 18}deg)`;
  });

  const finish = (event) => {
    if (!holding) return;
    holding = false;
    try { el.releasePointerCapture(event.pointerId); } catch {}
    const dx = event.clientX - startX;
    const dy = event.clientY - startY;
    el.style.transform = "";
    if (Math.abs(dx) > 56 || Math.hypot(dx, dy) > 80) pullBlock(id);
    else if (!dragged) pullBlock(id);
  };

  el.addEventListener("pointerup", finish);
  el.addEventListener("pointercancel", () => {
    holding = false;
    el.style.transform = "";
  });
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

trayEl.addEventListener("click", (event) => {
  const btn = event.target.closest("[data-act='put-back']");
  const block = event.target.closest(".block");
  if (!btn || !block) return;
  putBack(block.dataset.id);
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
    const main = `${shortModel(data.model)} · ${String(data.thinking || "").toLowerCase()}`;
    const stress = `${shortModel(data.stressModel)} · ${String(data.stressThinking || "").toLowerCase()}`;
    const mode = data.configured ? "server key in use" : "no server key";
    footEl.textContent = `main: ${main}  |  stress: ${stress}  ·  ${mode}`;
  })
  .catch(() => {});

sync();
