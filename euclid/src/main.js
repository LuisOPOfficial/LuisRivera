import {
  buildDegradationTooltip,
  computeContextMetrics,
  formatLossLabel,
  formatTokens,
} from "../shared/context.js";

const STORAGE_CHATS = "euclid.chats.v1";
const STORAGE_ACTIVE = "euclid.active.v1";
const STORAGE_MODEL = "euclid.model.v1";

const STARTERS = [
  "Explain why √2 is irrational in four crisp steps",
  "Compare HTTP/2 and HTTP/3 briefly",
  "Is the sum of two odd integers always even?",
];

const shellEl = document.querySelector("#app");
const chatListEl = document.querySelector("#chat-list");
const backdropEl = document.querySelector("#backdrop");
const toggleSidebarBtn = document.querySelector("#toggle-sidebar");
const modelSelectEl = document.querySelector("#model-select");
const contextHudEl = document.querySelector("#context-hud");
const ctxBarFillEl = document.querySelector("#ctx-bar-fill");
const ctxUsageEl = document.querySelector("#ctx-usage");
const intelLossEl = document.querySelector("#intel-loss");
const ctxTooltipEl = document.querySelector("#ctx-tooltip");
const newChatBtn = document.querySelector("#new-chat");
const transcriptEl = document.querySelector("#transcript");
const emptyStateEl = document.querySelector("#empty-state");
const startersEl = document.querySelector("#starter-prompts");
const keyNoticeEl = document.querySelector("#key-notice");
const messagesEl = document.querySelector("#messages");
const composerEl = document.querySelector("#composer");
const promptEl = document.querySelector("#prompt");
const sendBtn = document.querySelector("#send-btn");
const statusEl = document.querySelector("#status");

let models = [];
let chats = loadChats();
let activeChatId = localStorage.getItem(STORAGE_ACTIVE) || "";
let activeAbort = null;

function uid() {
  return typeof crypto !== "undefined" && crypto.randomUUID
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function loadChats() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_CHATS) || "[]");
    return Array.isArray(raw) ? raw.filter((c) => c && typeof c.id === "string" && Array.isArray(c.messages)) : [];
  } catch {
    return [];
  }
}

function saveChats() {
  localStorage.setItem(STORAGE_CHATS, JSON.stringify(chats));
  if (activeChatId) localStorage.setItem(STORAGE_ACTIVE, activeChatId);
  else localStorage.removeItem(STORAGE_ACTIVE);
}

function activeChat() {
  return chats.find((c) => c.id === activeChatId) || null;
}

function selectedModel() {
  return models.find((m) => m.id === modelSelectEl.value && m.available) || null;
}

function activeModelMeta() {
  return selectedModel() || models.find((m) => m.id === activeChat()?.modelId) || models[0] || null;
}

function renderContextHud() {
  const model = activeModelMeta();
  const chat = activeChat();
  const metrics = computeContextMetrics({
    messages: chat?.messages || [],
    usage: chat?.usage || null,
    model,
  });

  const prefix = metrics.tokensUsed > 0 && metrics.source === "estimated" ? "~" : "";
  ctxUsageEl.textContent = `${prefix}${formatTokens(metrics.tokensUsed)} / ${formatTokens(metrics.maxTokens)} (${metrics.usedPct}%)`;
  ctxBarFillEl.style.width = `${Math.max(metrics.tokensUsed > 0 ? 2 : 0, metrics.usedPct)}%`;
  intelLossEl.textContent = formatLossLabel(metrics.lossPct);
  contextHudEl.classList.toggle("degrading", metrics.lossPct > 0);

  const tooltip = buildDegradationTooltip(metrics, model);
  ctxTooltipEl.textContent = tooltip;
  contextHudEl.title = tooltip;
}

function setStatus(text, bad = false) {
  statusEl.textContent = text || "";
  statusEl.classList.toggle("bad", Boolean(bad && text));
}

function titleFrom(text) {
  const clean = String(text || "").replace(/\s+/g, " ").trim();
  return clean.length > 42 ? `${clean.slice(0, 42)}…` : clean || "New chat";
}

function escapeHtml(str) {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatInline(text) {
  const parts = text.split(/(`[^`]+`)/g);
  return parts
    .map((part) => {
      if (part.startsWith("`") && part.endsWith("`") && part.length > 2) {
        return `<code>${escapeHtml(part.slice(1, -1))}</code>`;
      }
      return escapeHtml(part)
        .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
        .replace(/\*([^*\n]+)\*/g, "<em>$1</em>");
    })
    .join("");
}

function renderMarkdown(text) {
  const blocks = String(text || "").split(/(```[\s\S]*?```)/g);
  const html = [];

  for (const block of blocks) {
    if (!block) continue;
    if (block.startsWith("```") && block.endsWith("```")) {
      const inner = block.slice(3, -3).replace(/^[a-zA-Z0-9_-]*\n/, "");
      html.push(`<pre><code>${escapeHtml(inner)}</code></pre>`);
      continue;
    }

    const paragraphs = block.trim().split(/\n{2,}/);
    for (const para of paragraphs) {
      const lines = para.split("\n");
      if (lines.every((l) => /^\s*[-*]\s+/.test(l))) {
        const items = lines
          .map((l) => `<li>${formatInline(l.replace(/^\s*[-*]\s+/, ""))}</li>`)
          .join("");
        html.push(`<ul>${items}</ul>`);
      } else if (lines.every((l) => /^\s*\d+\.\s+/.test(l))) {
        const items = lines
          .map((l) => `<li>${formatInline(l.replace(/^\s*\d+\.\s+/, ""))}</li>`)
          .join("");
        html.push(`<ol>${items}</ol>`);
      } else {
        html.push(`<p>${lines.map(formatInline).join("<br />")}</p>`);
      }
    }
  }
  return html.join("");
}

function renderModelSelector() {
  modelSelectEl.replaceChildren();
  const byProvider = new Map();
  for (const m of models) {
    if (!byProvider.has(m.providerName)) byProvider.set(m.providerName, []);
    byProvider.get(m.providerName).push(m);
  }

  const available = models.filter((m) => m.available);
  if (!available.length) {
    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.disabled = true;
    placeholder.selected = true;
    placeholder.textContent = "No API keys configured";
    modelSelectEl.append(placeholder);
  }

  for (const [providerName, groupModels] of byProvider.entries()) {
    const group = document.createElement("optgroup");
    group.label = providerName;
    for (const m of groupModels) {
      const opt = document.createElement("option");
      opt.value = m.id;
      opt.disabled = !m.available;
      if (!m.available) {
        opt.textContent = `${m.label} — ${m.hint}`;
      } else if (m.note) {
        opt.textContent = `${m.label} (${m.note})`;
      } else {
        opt.textContent = m.label;
      }
      group.append(opt);
    }
    modelSelectEl.append(group);
  }

  const saved = localStorage.getItem(STORAGE_MODEL);
  const preferred =
    available.find((m) => m.id === activeChat()?.modelId) ||
    available.find((m) => m.id === saved) ||
    available[0];

  if (preferred) {
    modelSelectEl.value = preferred.id;
    localStorage.setItem(STORAGE_MODEL, preferred.id);
  }

  syncModelChrome();
}

function syncModelChrome() {
  const anyAvailable = models.some((m) => m.available);
  keyNoticeEl.hidden = anyAvailable;

  if (!anyAvailable && models.length) {
    setStatus("No provider keys set on server.");
  } else if (!activeAbort) {
    setStatus("");
  }

  syncComposer();
  renderContextHud();
}

function syncComposer() {
  const streaming = Boolean(activeAbort);
  const canSend = Boolean(selectedModel()) && promptEl.value.trim().length > 0;
  sendBtn.classList.toggle("streaming", streaming);
  sendBtn.disabled = streaming ? false : !canSend;
  sendBtn.setAttribute("aria-label", streaming ? "Stop generating" : "Send message");
}

function renderSidebar() {
  chatListEl.replaceChildren();
  if (!chats.length) {
    const empty = document.createElement("div");
    empty.className = "chat-empty";
    empty.textContent = "No saved chats yet.";
    chatListEl.append(empty);
    return;
  }

  const sorted = [...chats].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  for (const chat of sorted) {
    const row = document.createElement("div");
    row.className = "chat-item" + (chat.id === activeChatId ? " active" : "");

    const openBtn = document.createElement("button");
    openBtn.type = "button";
    openBtn.className = "chat-item-btn";
    openBtn.textContent = chat.title || "Untitled chat";
    openBtn.addEventListener("click", () => selectChat(chat.id));

    const delBtn = document.createElement("button");
    delBtn.type = "button";
    delBtn.className = "chat-del-btn";
    delBtn.setAttribute("aria-label", `Delete ${chat.title || "chat"}`);
    delBtn.textContent = "×";
    delBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      deleteChat(chat.id);
    });

    row.append(openBtn, delBtn);
    chatListEl.append(row);
  }
}

function makeMessageNode(msg) {
  const article = document.createElement("article");
  article.className = `msg msg-${msg.role}${msg.streaming ? " msg-streaming" : ""}`;

  if (msg.role === "assistant" && msg.modelLabel) {
    const meta = document.createElement("div");
    meta.className = "msg-meta";
    meta.textContent = msg.modelLabel;
    article.append(meta);
  }

  if (msg.error) {
    const err = document.createElement("div");
    err.className = "msg-error";
    err.textContent = msg.error;
    article.append(err);
  } else {
    const body = document.createElement("div");
    body.className = "msg-body";
    if (msg.role === "user") {
      body.textContent = msg.content;
    } else {
      body.innerHTML = renderMarkdown(msg.content);
    }
    article.append(body);
  }

  return article;
}

function renderTranscript(scroll = true) {
  const chat = activeChat();
  const hasMessages = Boolean(chat && chat.messages.length);
  emptyStateEl.hidden = hasMessages;
  messagesEl.replaceChildren();

  if (hasMessages) {
    for (const msg of chat.messages) {
      messagesEl.append(makeMessageNode(msg));
    }
    if (scroll) {
      transcriptEl.scrollTop = transcriptEl.scrollHeight;
    }
  }
  renderContextHud();
}

function selectChat(id) {
  if (activeAbort) activeAbort.abort();
  activeChatId = id;
  saveChats();
  const chat = activeChat();
  if (chat?.modelId && models.some((m) => m.id === chat.modelId && m.available)) {
    modelSelectEl.value = chat.modelId;
    localStorage.setItem(STORAGE_MODEL, chat.modelId);
    syncModelChrome();
  }
  closeMobileSidebar();
  renderSidebar();
  renderTranscript();
  promptEl.focus();
}

function startNewChat() {
  if (activeAbort) activeAbort.abort();
  activeChatId = "";
  saveChats();
  closeMobileSidebar();
  renderSidebar();
  renderTranscript();
  setStatus(models.some((m) => m.available) ? "" : "No provider keys set on server.");
  promptEl.focus();
}

function deleteChat(id) {
  if (activeChatId === id && activeAbort) activeAbort.abort();
  chats = chats.filter((c) => c.id !== id);
  if (activeChatId === id) {
    activeChatId = chats[0]?.id || "";
  }
  saveChats();
  renderSidebar();
  renderTranscript();
}

function autoResize() {
  promptEl.style.height = "auto";
  promptEl.style.height = `${Math.min(promptEl.scrollHeight, 180)}px`;
}

function closeMobileSidebar() {
  shellEl.classList.remove("sidebar-open");
  backdropEl.hidden = true;
}

function toggleSidebar() {
  if (window.matchMedia("(max-width: 760px)").matches) {
    const open = shellEl.classList.toggle("sidebar-open");
    backdropEl.hidden = !open;
  } else {
    shellEl.classList.toggle("sidebar-collapsed");
  }
}

async function sendPrompt(text) {
  const model = selectedModel();
  const content = text.trim();
  if (!content) return;
  if (!model) {
    setStatus("Select a model with a configured API key.", true);
    return;
  }

  let chat = activeChat();
  if (!chat) {
    chat = {
      id: uid(),
      title: titleFrom(content),
      modelId: model.id,
      updatedAt: Date.now(),
      messages: [],
    };
    chats.unshift(chat);
    activeChatId = chat.id;
  }

  const historyPayload = chat.messages
    .filter((m) => !m.error && m.content)
    .map((m) => ({ role: m.role, content: m.content }));
  historyPayload.push({ role: "user", content });

  chat.messages.push({ role: "user", content });
  const assistantMsg = {
    role: "assistant",
    content: "",
    modelId: model.id,
    modelLabel: model.label,
    streaming: true,
  };
  chat.messages.push(assistantMsg);
  chat.modelId = model.id;
  chat.updatedAt = Date.now();
  if (chat.messages.length === 2) chat.title = titleFrom(content);

  promptEl.value = "";
  autoResize();
  saveChats();
  renderSidebar();
  renderTranscript();

  const controller = new AbortController();
  activeAbort = controller;
  setStatus(`Waiting for ${model.label}…`);
  syncComposer();

  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "text/event-stream",
      },
      body: JSON.stringify({ modelId: model.id, messages: historyPayload }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || `Request failed (HTTP ${res.status}).`);
    }

    const contentType = res.headers.get("content-type") || "";
    if (!contentType.includes("text/event-stream") || !res.body) {
      const data = await res.json();
      assistantMsg.content = data.text || "";
    } else {
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      const handleFrames = (frames) => {
        for (const frame of frames) {
          const dataLines = frame
            .split(/\r?\n/)
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).trim());
          if (!dataLines.length) continue;
          const evt = JSON.parse(dataLines.join("\n"));
          if (evt.type === "delta" && evt.text) {
            assistantMsg.content += evt.text;
            setStatus(model.streaming ? `Streaming from ${model.label}…` : "");
            renderTranscript();
          } else if (evt.type === "done") {
            if (evt.text && !assistantMsg.content) {
              assistantMsg.content = evt.text;
            }
            if (evt.usage && typeof evt.usage.totalTokens === "number") {
              const validCount = chat.messages.filter((m) => m && !m.error && m.content).length;
              chat.usage = {
                ...evt.usage,
                messageCount: validCount,
                modelId: model.id,
              };
            }
          } else if (evt.type === "error") {
            throw new Error(evt.error || "The model call failed.");
          }
        }
      };

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split(/\r?\n\r?\n/);
        buffer = parts.pop() || "";
        handleFrames(parts);
      }
      buffer += decoder.decode();
      if (buffer.trim()) handleFrames([buffer]);
    }

    if (!assistantMsg.content) {
      throw new Error("The model returned nothing.");
    }
    setStatus("");
  } catch (err) {
    if (err.name === "AbortError") {
      if (!assistantMsg.content) {
        assistantMsg.error = "Generation stopped.";
      }
      setStatus("Stopped.");
    } else {
      assistantMsg.error = err.message || "Something went wrong.";
      setStatus(assistantMsg.error, true);
    }
  } finally {
    delete assistantMsg.streaming;
    activeAbort = null;
    chat.updatedAt = Date.now();
    saveChats();
    renderTranscript();
    syncComposer();
  }
}

function renderStarters() {
  startersEl.replaceChildren();
  for (const text of STARTERS) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "starter-btn";
    btn.textContent = text;
    btn.addEventListener("click", () => {
      if (selectedModel()) {
        sendPrompt(text);
      } else {
        promptEl.value = text;
        autoResize();
        syncComposer();
        promptEl.focus();
      }
    });
    startersEl.append(btn);
  }
}

async function loadModels() {
  try {
    const res = await fetch("/api/models");
    const data = await res.json();
    models = Array.isArray(data.models) ? data.models : [];
    renderModelSelector();
  } catch {
    setStatus("Could not load models from server.", true);
  }
}

toggleSidebarBtn.addEventListener("click", toggleSidebar);
backdropEl.addEventListener("click", closeMobileSidebar);
newChatBtn.addEventListener("click", startNewChat);

modelSelectEl.addEventListener("change", () => {
  if (modelSelectEl.value) {
    localStorage.setItem(STORAGE_MODEL, modelSelectEl.value);
    const chat = activeChat();
    if (chat) {
      chat.modelId = modelSelectEl.value;
      saveChats();
    }
  }
  syncModelChrome();
});

promptEl.addEventListener("input", () => {
  autoResize();
  syncComposer();
});

promptEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    if (!activeAbort) sendPrompt(promptEl.value);
  }
});

composerEl.addEventListener("submit", (e) => {
  e.preventDefault();
  if (activeAbort) {
    activeAbort.abort();
    return;
  }
  sendPrompt(promptEl.value);
});

if (activeChatId && !activeChat()) {
  activeChatId = "";
  saveChats();
}

renderStarters();
renderSidebar();
renderTranscript();
loadModels();
