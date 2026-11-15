chrome.runtime.onMessage.addListener((message, sender) => {
  if (message?.type !== "badge" || sender.tab?.id == null) return;
  const count = Number(message.count) || 0;
  const text = count > 0 ? String(Math.min(count, 999)) : "";
  chrome.action.setBadgeText({ text, tabId: sender.tab.id });
  chrome.action.setBadgeBackgroundColor({ color: "#f4212e", tabId: sender.tab.id });
});
