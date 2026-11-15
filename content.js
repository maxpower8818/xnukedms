/* Relays the popup to the page-world inbox runner and remembers the latest status. */
(function () {
  const SOURCE = "xnukedms";
  let seq = 0;
  let pendingAck = 0;
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

  function badgeCount() {
    if (status.phase === "delete" || status.phase === "done") return status.deleted || 0;
    return 0;
  }

  function publishBadge() {
    chrome.runtime.sendMessage({ type: "badge", count: badgeCount() }, () => {
      void chrome.runtime.lastError;
    });
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window || event.data?.source !== SOURCE || event.data.to !== "content") return;
    const data = event.data;
    if (data.type === "ack") {
      if (data.requestId === pendingAck) pendingAck = 0;
      return;
    }
    if (data.type !== "status") return;
    status = {
      phase: data.phase || "idle",
      deleted: data.deleted || 0,
      failed: data.failed || 0,
      total: data.total || 0,
      found: data.found || 0,
      message: data.message || "",
      warnings: Array.isArray(data.warnings) ? data.warnings : [],
      log: Array.isArray(data.log) ? data.log : status.log,
      conversations: Array.isArray(data.conversations) ? data.conversations : status.conversations
    };
    publishBadge();
  });

  function ask(message, reportFailure) {
    const requestId = ++seq;
    if (reportFailure) pendingAck = requestId;
    window.postMessage({ source: SOURCE, to: "page", requestId, ...message }, "*");
    if (!reportFailure) return;
    window.setTimeout(() => {
      if (pendingAck !== requestId) return;
      pendingAck = 0;
      status.phase = "error";
      status.message = "Reload this x.com tab, then try again.";
    }, 1200);
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || typeof message.type !== "string") return;
    if (message.type === "get-status") {
      sendResponse(status);
      return;
    }
    if (message.type === "scan" || message.type === "stop" || message.type === "delete" || message.type === "clear-log") {
      ask(message, true);
      sendResponse({ ok: true });
    }
  });

  window.setTimeout(() => ask({ type: "refresh" }, false), 0);
  window.setTimeout(() => ask({ type: "refresh" }, false), 800);
})();
