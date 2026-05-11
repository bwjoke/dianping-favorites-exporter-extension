function isAllowedDianpingUrl(url) {
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

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.type !== "DP_EXPORT_FETCH") {
    return false;
  }

  (async () => {
    try {
      if (!isAllowedDianpingUrl(message.url)) {
        throw new Error("Blocked non-Dianping URL.");
      }

      const response = await fetch(message.url, {
        credentials: "include",
        redirect: "follow"
      });
      const text = await response.text();
      sendResponse({
        ok: response.ok,
        status: response.status,
        finalUrl: response.url,
        text
      });
    } catch (error) {
      sendResponse({
        ok: false,
        status: 0,
        finalUrl: message.url,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  })();

  return true;
});
