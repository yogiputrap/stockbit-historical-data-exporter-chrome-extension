// Background service worker - handles cross-origin fetches without CORS restriction
// Extensions with host_permissions can fetch any URL and cookies are auto-included

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "fetch") {
    handleFetch(message.url, message.headers || {})
      .then((result) => sendResponse(result))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true; // keep message channel open for async response
  }
});

async function handleFetch(url, headers) {
  try {
    console.log("[Stockbit Exporter BG] Fetching:", url.substring(0, 120));
    const res = await fetch(url, {
      method: "GET",
      headers: headers,
      credentials: "include",
    });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch (e) {}
    console.log("[Stockbit Exporter BG] Response:", res.status, "len:", text.length);
    return {
      ok: res.ok,
      status: res.status,
      json,
      text: json ? null : text.substring(0, 500),
    };
  } catch (err) {
    console.error("[Stockbit Exporter BG] Fetch error:", err);
    return { ok: false, error: err.message };
  }
}

console.log("[Stockbit Exporter BG] Service worker loaded");
