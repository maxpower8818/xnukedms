const DEFAULTS = {
  buckets: ["primary", "requests", "hidden", "groups"],
  olderThanDays: "",
  delayMs: 1200
};

const LIST_CAP = 300;
const X_TAB = /^https:\/\/(x|twitter)\.com\//;

let settings = { ...DEFAULTS, buckets: DEFAULTS.buckets.slice() };
let status = {
  phase: "idle",
  deleted: 0,
  failed: 0,
  total: 0,
  found: 0,
  message: "",
  warnings: [],
  log: [],
  conversations: []
};
let selected = new Set();
let listKey = "";
let tabId = 0;
let pollTimer = 0;

const scanButton = document.querySelector("#scan");
const stopButton = document.querySelector("#stop");
const deleteButton = document.querySelector("#delete");
const toggleButton = document.querySelector("#toggle");
const bucketBox = document.querySelector("#buckets");
const daysInput = document.querySelector("#days");
const searchInput = document.querySelector("#search");
const confirmInput = document.querySelector("#confirm");
const delayInput = document.querySelector("#delay");
const countNode = document.querySelector("#count");
const listNode = document.querySelector("#list");
const truncatedNode = document.querySelector("#truncated");
const statusNode = document.querySelector("#status");
const logNode = document.querySelector("#log");
const clearLogButton = document.querySelector("#clear-log");
let logKey = null;

function running() {
  return status.phase === "scan" || status.phase === "delete";
}

function filtered() {
  const days = daysInput.value.trim();
  return (status.conversations || []).filter((conv) => XNukeInbox.matchesFilter(conv, {
    buckets: settings.buckets,
    olderThanDays: days,
    query: searchInput.value
  }, Date.now()));
}

function persist() {
  chrome.storage.local.set({ settings });
}

function send(message) {
  if (!tabId) return;
  chrome.tabs.sendMessage(tabId, message, () => {
    if (chrome.runtime.lastError) {
      statusNode.textContent = "Reload this x.com tab, then try again.";
    }
  });
}

function renderBuckets() {
  bucketBox.replaceChildren();
  for (const bucket of XNukeInbox.BUCKETS) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "chip";
    button.textContent = bucket.name;
    const pressed = settings.buckets.includes(bucket.id);
    button.setAttribute("aria-pressed", pressed ? "true" : "false");
    button.addEventListener("click", () => {
      settings.buckets = pressed
        ? settings.buckets.filter((id) => id !== bucket.id)
        : settings.buckets.concat(bucket.id);
      persist();
      renderBuckets();
      renderList(true);
      renderActions();
    });
    bucketBox.appendChild(button);
  }
}

function renderList(force) {
  const rows = filtered();
  const key = rows.map((row) => row.id).join("\n");
  if (status.phase === "scan") {
    countNode.textContent = status.found ? `Scanning… ${status.found}` : "Scanning…";
  } else {
    countNode.textContent = rows.length === 1 ? "1 match" : `${rows.length} matches`;
  }
  const allSelected = rows.length > 0 && rows.every((row) => selected.has(row.id));
  toggleButton.textContent = allSelected ? "Clear" : "Select all";
  toggleButton.disabled = !rows.length || running();
  if (!force && key === listKey) return;
  listKey = key;
  listNode.replaceChildren();
  if (!rows.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = running()
      ? "Scanning…"
      : (status.conversations.length ? "Nothing matches these filters." : "Scan to load conversations.");
    listNode.appendChild(empty);
    truncatedNode.hidden = true;
    return;
  }
  const visible = rows.slice(0, LIST_CAP);
  for (const row of visible) {
    const label = document.createElement("label");
    label.className = "row";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = selected.has(row.id);
    input.disabled = running();
    input.addEventListener("change", () => {
      if (input.checked) selected.add(row.id);
      else selected.delete(row.id);
      renderActions();
      const matches = filtered();
      const all = matches.length > 0 && matches.every((item) => selected.has(item.id));
      toggleButton.textContent = all ? "Clear" : "Select all";
    });
    const text = document.createElement("span");
    text.textContent = row.label;
    const meta = document.createElement("span");
    meta.className = "meta";
    meta.textContent = `${row.bucketName} · ${row.when}`;
    text.appendChild(meta);
    label.append(input, text);
    listNode.appendChild(label);
  }
  if (rows.length > visible.length) {
    truncatedNode.hidden = false;
    truncatedNode.textContent = `Showing ${visible.length} of ${rows.length}. Select all includes every match.`;
  } else {
    truncatedNode.hidden = true;
  }
}

function renderActions() {
  const busy = running();
  scanButton.disabled = busy;
  stopButton.disabled = !busy;
  const matches = new Set(filtered().map((row) => row.id));
  let chosen = 0;
  for (const id of selected) {
    if (matches.has(id)) chosen += 1;
  }
  const confirmed = confirmInput.value === "DELETE";
  deleteButton.disabled = busy || !confirmed || chosen === 0;
  deleteButton.textContent = chosen === 1 ? "Delete 1 conversation" : `Delete ${chosen} conversations`;
}

function renderStatus() {
  const parts = [];
  if (status.message) parts.push(status.message);
  if (status.warnings && status.warnings.length) parts.push(status.warnings[0]);
  statusNode.textContent = parts.join(" ") || "Open x.com while signed in.";
}

function renderLog() {
  const entries = status.log || [];
  const key = entries.map((entry) => `${entry.level}:${entry.text}`).join("\n");
  if (key === logKey) return;
  const follow = logNode.scrollHeight - logNode.scrollTop - logNode.clientHeight < 24;
  logKey = key;
  logNode.replaceChildren();
  if (!entries.length) {
    const empty = document.createElement("div");
    empty.className = "info";
    empty.textContent = "No requests yet.";
    logNode.appendChild(empty);
    return;
  }
  for (const entry of entries) {
    const line = document.createElement("div");
    line.className = entry.level === "fail" ? "fail" : (entry.level || "info");
    line.textContent = entry.text;
    logNode.appendChild(line);
  }
  if (follow) logNode.scrollTop = logNode.scrollHeight;
}

function render() {
  renderList(false);
  renderActions();
  renderStatus();
  renderLog();
}

function applyStatus(next) {
  const previousPhase = status.phase;
  status = {
    phase: next.phase || "idle",
    deleted: next.deleted || 0,
    failed: next.failed || 0,
    total: next.total || 0,
    found: next.found || 0,
    message: next.message || "",
    warnings: next.warnings || [],
    log: Array.isArray(next.log) ? next.log : [],
    conversations: Array.isArray(next.conversations) ? next.conversations : []
  };
  if (status.phase === "scan" && previousPhase !== "scan") selected = new Set();
  if (previousPhase === "delete" && status.phase === "delete") {
    renderActions();
    renderStatus();
    renderLog();
    return;
  }
  const live = new Set(status.conversations.map((row) => row.id));
  for (const id of [...selected]) {
    if (!live.has(id)) selected.delete(id);
  }
  render();
}

function refresh() {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tab = tabs[0];
    if (!tab?.id || !X_TAB.test(tab.url || "")) {
      tabId = 0;
      statusNode.textContent = "Open x.com while signed in.";
      scanButton.disabled = true;
      stopButton.disabled = true;
      deleteButton.disabled = true;
      return;
    }
    tabId = tab.id;
    chrome.tabs.sendMessage(tab.id, { type: "get-status" }, (response) => {
      if (chrome.runtime.lastError || !response) {
        statusNode.textContent = "Reload this x.com tab, then try again.";
        return;
      }
      applyStatus(response);
    });
  });
}

scanButton.addEventListener("click", () => {
  selected = new Set();
  listKey = "";
  send({ type: "scan" });
  status.phase = "scan";
  status.message = "Scanning inbox…";
  render();
});

stopButton.addEventListener("click", () => send({ type: "stop" }));

deleteButton.addEventListener("click", () => {
  if (confirmInput.value !== "DELETE") return;
  const matches = new Set(filtered().map((row) => row.id));
  const ids = [...selected].filter((id) => matches.has(id));
  send({ type: "delete", ids, delayMs: XNukeInbox.clampDelay(delayInput.value) });
  status.phase = "delete";
  status.total = ids.length;
  status.deleted = 0;
  status.message = `Deleting 0 of ${ids.length}…`;
  confirmInput.value = "";
  render();
});

toggleButton.addEventListener("click", () => {
  const rows = filtered();
  const allSelected = rows.length > 0 && rows.every((row) => selected.has(row.id));
  if (allSelected) {
    for (const row of rows) selected.delete(row.id);
  } else {
    for (const row of rows) selected.add(row.id);
  }
  renderList(true);
  renderActions();
});

daysInput.addEventListener("input", () => {
  settings.olderThanDays = daysInput.value.trim();
  persist();
  renderList(true);
  renderActions();
});

searchInput.addEventListener("input", () => {
  renderList(true);
  renderActions();
});

confirmInput.addEventListener("input", renderActions);

clearLogButton.addEventListener("click", () => {
  status.log = [];
  logKey = null;
  renderLog();
  send({ type: "clear-log" });
});

delayInput.addEventListener("change", () => {
  delayInput.value = String(XNukeInbox.clampDelay(delayInput.value));
  settings.delayMs = Number(delayInput.value);
  persist();
});

chrome.storage.local.get("settings", (data) => {
  const saved = data.settings || {};
  settings = {
    ...DEFAULTS,
    ...saved,
    buckets: Array.isArray(saved.buckets) ? saved.buckets.filter((id) => XNukeInbox.BUCKET_NAME[id]) : DEFAULTS.buckets.slice()
  };
  if (!settings.buckets.length) settings.buckets = DEFAULTS.buckets.slice();
  daysInput.value = settings.olderThanDays || "";
  delayInput.value = String(XNukeInbox.clampDelay(settings.delayMs));
  renderBuckets();
  refresh();
  pollTimer = window.setInterval(refresh, 700);
});

window.addEventListener("unload", () => window.clearInterval(pollTimer));
