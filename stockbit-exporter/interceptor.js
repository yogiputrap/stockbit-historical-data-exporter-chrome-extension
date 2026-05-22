// MAIN world script: intercepts fetch/XHR + captures request templates
// New strategy: detect historical data by RESPONSE SHAPE, not URL keywords
(function () {
  "use strict";

  console.log("[Stockbit Exporter] Interceptor loaded in MAIN world");

  const allRows = new Map();
  let lastTemplate = null;

  function sendData() {
    const data = Array.from(allRows.values());
    window.dispatchEvent(new CustomEvent("__sb_data__", { detail: JSON.stringify(data) }));
  }

  function sendTemplate(tpl) {
    window.dispatchEvent(new CustomEvent("__sb_template__", { detail: JSON.stringify(tpl) }));
  }

  function getRowKey(item) {
    for (const k of Object.keys(item)) {
      const l = k.toLowerCase();
      if (l.includes("date") || l === "d" || l === "t" || l.includes("time")) {
        return String(item[k]);
      }
    }
    return JSON.stringify(Object.values(item).slice(0, 3));
  }

  function addRows(data) {
    let added = 0;
    data.forEach((item) => {
      const key = getRowKey(item);
      if (!allRows.has(key)) {
        allRows.set(key, item);
        added++;
      }
    });
    console.log("[Stockbit Exporter] +", added, "rows. Total:", allRows.size);
    sendData();
  }

  window.addEventListener("__sb_reset__", () => {
    allRows.clear();
    lastTemplate = null;
    console.log("[Stockbit Exporter] Reset");
  });

  // Detect historical data by structure: array of objects with date+price fields
  function findDataArray(obj, depth) {
    if (depth > 6) return null;
    if (Array.isArray(obj) && obj.length > 0) {
      const f = obj[0];
      if (f && typeof f === "object" && !Array.isArray(f)) {
        const keys = Object.keys(f).map((k) => k.toLowerCase());
        const hasDate = keys.some(
          (k) => k.includes("date") || k.includes("time") || k === "d" || k === "t"
        );
        const hasPrice = keys.some(
          (k) =>
            k.includes("close") || k === "c" || k.includes("last") ||
            k.includes("open") || k === "o"
        );
        if (hasDate && hasPrice) return obj;
      }
    }
    if (obj && typeof obj === "object" && !Array.isArray(obj)) {
      for (const key of Object.keys(obj)) {
        const r = findDataArray(obj[key], depth + 1);
        if (r) return r;
      }
    }
    return null;
  }

  // Skip URLs that are clearly not what we want
  function isExcludedUrl(url) {
    if (!url) return true;
    const l = url.toLowerCase();
    // Skip multi-symbol watchlist
    if (l.includes("symbol%5b0%5d") || l.includes("symbol[0]")) return true;
    // Skip non-data endpoints
    if (l.includes("/feed") || l.includes("/news") || l.includes("/order")) return true;
    if (l.includes(".png") || l.includes(".jpg") || l.includes(".css") || l.includes(".js")) return true;
    return false;
  }

  // Explicit detection for known Stockbit historical endpoint
  function isKnownHistoricalUrl(url) {
    if (!url) return false;
    return url.includes("/company-price-feed/historical/");
  }

  function captureTemplate(url, method, headers) {
    lastTemplate = { url, method: method || "GET", headers: headers || {}, timestamp: Date.now() };
    sendTemplate(lastTemplate);
    console.log("[Stockbit Exporter] ✅ Captured TEMPLATE:", url);
  }

  // Override fetch
  const originalFetch = window.fetch;
  window.fetch = async function (...args) {
    const response = await originalFetch.apply(this, args);
    const url = typeof args[0] === "string" ? args[0] : args[0]?.url || "";

    // Always try to capture for known Stockbit historical URLs OR by shape detection
    const isKnown = isKnownHistoricalUrl(url);
    if (isKnown || !isExcludedUrl(url)) {
      try {
        const clone = response.clone();
        const ct = response.headers.get("content-type") || "";
        if (ct.includes("json") || ct === "" || isKnown) {
          const text = await clone.text();
          let json = null;
          try { json = JSON.parse(text); } catch (e) { return response; }

          const data = findDataArray(json, 0);
          if (data && data.length > 0) {
            console.log("[Stockbit Exporter] 🎯 Historical data detected in:", url);
            const init = args[1] || (args[0] && typeof args[0] === "object" ? args[0] : {});
            const headers = {};
            try {
              if (init.headers) {
                if (init.headers instanceof Headers) {
                  init.headers.forEach((v, k) => (headers[k] = v));
                } else if (Array.isArray(init.headers)) {
                  init.headers.forEach(([k, v]) => (headers[k] = v));
                } else {
                  Object.assign(headers, init.headers);
                }
              }
            } catch (e) {}
            captureTemplate(url, init.method || "GET", headers);
            addRows(data);
          } else if (isKnown) {
            console.log("[Stockbit Exporter] Historical URL but no data array. Response keys:",
              json && typeof json === "object" ? Object.keys(json) : typeof json);
          }
        }
      } catch (e) {
        if (isKnown) console.log("[Stockbit Exporter] fetch parse error on known URL:", e.message);
      }
    }
    return response;
  };

  // Override XHR
  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;
  const originalSetHeader = XMLHttpRequest.prototype.setRequestHeader;

  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__url = url;
    this.__method = method;
    this.__headers = {};
    return originalOpen.apply(this, [method, url, ...rest]);
  };

  XMLHttpRequest.prototype.setRequestHeader = function (k, v) {
    if (this.__headers) this.__headers[k] = v;
    return originalSetHeader.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function (...args) {
    const xhr = this;
    xhr.addEventListener("load", function () {
      const url = xhr.__url || "";
      const isKnown = isKnownHistoricalUrl(url);
      if (!isKnown && isExcludedUrl(url)) return;
      try {
        const json = JSON.parse(xhr.responseText);
        const data = findDataArray(json, 0);
        if (data && data.length > 0) {
          console.log("[Stockbit Exporter] 🎯 Historical data in XHR:", url);
          captureTemplate(url, xhr.__method || "GET", xhr.__headers || {});
          addRows(data);
        }
      } catch (e) {}
    });
    return originalSend.apply(this, args);
  };
})();
