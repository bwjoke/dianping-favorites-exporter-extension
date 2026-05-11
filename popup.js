const statusNode = document.getElementById("statusText");

function setStatus(text) {
  statusNode.textContent = text;
}

function numberOption(id, min, fallback) {
  const value = document.getElementById(id).value.trim();
  if (!value) {
    return fallback;
  }
  const numeric = Math.trunc(Number(value));
  if (!Number.isFinite(numeric)) {
    return fallback;
  }
  return Math.max(min, numeric);
}

function collectOptions() {
  return {
    delayMs: numberOption("delayMs", 500, 1200),
    maxScrolls: numberOption("maxScrolls", 0, 20),
    maxItems: numberOption("maxItems", 1, null),
    maxLinkedPages: numberOption("maxLinkedPages", 1, 100),
    crawlLinkedPages: document.getElementById("crawlLinkedPages").checked,
    includeDetails: document.getElementById("includeDetails").checked
  };
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function isDianpingUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && (
      parsed.hostname === "dianping.com" ||
      parsed.hostname.endsWith(".dianping.com")
    );
  } catch (_error) {
    return false;
  }
}

async function sendToActiveTab(message) {
  const tab = await activeTab();
  if (!tab || !tab.id) {
    throw new Error("没有找到当前标签页。");
  }
  if (!isDianpingUrl(tab.url || "")) {
    throw new Error("请先打开大众点评收藏列表页或大众点评商户列表页，再点击扩展。");
  }
  try {
    return await chrome.tabs.sendMessage(tab.id, message);
  } catch (error) {
    const messageText = error instanceof Error ? error.message : String(error);
    const noReceiver = /Receiving end does not exist|Could not establish connection/i.test(messageText);
    if (!noReceiver) {
      throw error;
    }

    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["content.js"]
    });
    return chrome.tabs.sendMessage(tab.id, message);
  }
}

document.getElementById("start").addEventListener("click", async () => {
  try {
    setStatus("已发送导出任务，进度会显示在当前大众点评页面右下角。");
    await sendToActiveTab({
      type: "DP_EXPORT_START",
      options: collectOptions()
    });
  } catch (error) {
    setStatus(error instanceof Error ? error.message : String(error));
  }
});

document.getElementById("stop").addEventListener("click", async () => {
  try {
    await sendToActiveTab({ type: "DP_EXPORT_STOP" });
    setStatus("已请求停止。");
  } catch (error) {
    setStatus(error instanceof Error ? error.message : String(error));
  }
});
