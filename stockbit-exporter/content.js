// Stockbit Historical Data Exporter - Content Script (ISOLATED world)
// Provides UI panel for bulk export, talks to interceptor.js (MAIN world)
(function () {
  "use strict";

  let panel = null;
  let capturedData = [];
  let requestTemplate = null; // captured URL template + headers

  // ===== EVENT LISTENERS FROM INTERCEPTOR =====

  window.addEventListener("__sb_data__", (e) => {
    try {
      const data = JSON.parse(e.detail);
      if (Array.isArray(data) && data.length > 0) {
        capturedData = data;
        updateStatus();
      }
    } catch (err) {}
  });

  window.addEventListener("__sb_template__", (e) => {
    try {
      requestTemplate = JSON.parse(e.detail);
      console.log("[Stockbit Exporter] Got template:", requestTemplate.url);
      console.log("[Stockbit Exporter] Captured headers:", Object.keys(requestTemplate.headers || {}));
      updateStatus();
    } catch (err) {}
  });

  // Make a fetch request via the background service worker (bypasses CORS via host_permissions)
  function pageFetch(url, options = {}) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(
          { type: "fetch", url, headers: options.headers || {} },
          (response) => {
            if (chrome.runtime.lastError) {
              resolve({ ok: false, error: chrome.runtime.lastError.message });
              return;
            }
            resolve(response || { ok: false, error: "No response from background" });
          }
        );
      } catch (err) {
        resolve({ ok: false, error: err.message });
      }
    });
  }

  // ===== URL TEMPLATING =====

  // Replace symbol in captured URL with target symbol
  function buildUrlForSymbol(template, currentSymbol, targetSymbol) {
    let url = template.url;
    const sym = currentSymbol.toUpperCase();
    const target = targetSymbol.toUpperCase();

    // Stockbit specific: /historical/summary/{SYMBOL}?
    if (/\/historical\/summary\/[A-Z]{3,5}/i.test(url)) {
      return url.replace(
        /(\/historical\/summary\/)[A-Z]{3,5}/i,
        `$1${target}`
      );
    }

    // General path replacement
    if (new RegExp(`/${sym}(/|\\?|$|#)`, "i").test(url)) {
      return url.replace(new RegExp(`/${sym}(/|\\?|$|#)`, "i"), `/${target}$1`);
    }

    // Query param replacement
    const paramRe = new RegExp(`([?&](?:symbol|ticker|code|q|stock)(?:%5B\\d+%5D|\\[\\d+\\])?=)${sym}`, "i");
    if (paramRe.test(url)) {
      return url.replace(paramRe, `$1${target}`);
    }

    // Fallback
    return url.replace(new RegExp(`\\b${sym}\\b`), target);
  }

  // Detect pagination params in URL
  function detectPagination(url) {
    const u = new URL(url, window.location.origin);
    const params = u.searchParams;
    const info = { type: null, current: 0, limit: 50, paramName: null };

    if (params.has("page")) {
      info.type = "page";
      info.current = parseInt(params.get("page"), 10) || 1;
      info.paramName = "page";
    } else if (params.has("offset")) {
      info.type = "offset";
      info.current = parseInt(params.get("offset"), 10) || 0;
      info.paramName = "offset";
      info.limit = parseInt(params.get("limit") || "50", 10);
    } else if (params.has("from") && params.has("to")) {
      info.type = "daterange";
    }

    return info;
  }

  function setPaginationParam(url, type, value, limit) {
    const u = new URL(url, window.location.origin);
    if (type === "page") {
      u.searchParams.set("page", value);
    } else if (type === "offset") {
      u.searchParams.set("offset", value);
      u.searchParams.set("limit", limit);
    }
    return u.toString();
  }

  // Modify URL to use new date range
  function setDateRange(url, fromDate, toDate) {
    const u = new URL(url, window.location.origin);
    const params = u.searchParams;

    // Common date param names
    const fromKeys = ["from", "start", "startDate", "start_date", "date_from", "fromDate"];
    const toKeys = ["to", "end", "endDate", "end_date", "date_to", "toDate"];

    let fromKey = null;
    let toKey = null;
    for (const k of fromKeys) if (params.has(k)) fromKey = k;
    for (const k of toKeys) if (params.has(k)) toKey = k;

    if (fromKey) params.set(fromKey, fromDate);
    if (toKey) params.set(toKey, toDate);

    // Also try common Stockbit format yyyy-mm-dd
    return u.toString();
  }

  // Find symbol in current URL (the one that's already in the captured template)
  function findSymbolInUrl(url) {
    if (!url) return null;
    let decoded = url;
    try { decoded = decodeURIComponent(url); } catch (e) {}

    // Stockbit specific: /historical/summary/{SYMBOL}
    const stockbitMatch = decoded.match(/\/historical\/summary\/([A-Z]{3,5})/i);
    if (stockbitMatch) return stockbitMatch[1].toUpperCase();

    // Look for 3-5 letter all-caps tokens in path (last segment before query)
    const pathMatch = decoded.match(/\/([A-Z]{3,5})(\/|\?|$|#)/);
    if (pathMatch) return pathMatch[1];

    // Look in query params
    try {
      const u = new URL(decoded, window.location.origin);
      for (const [key, value] of u.searchParams.entries()) {
        const k = key.toLowerCase().replace(/\[\d+\]/g, "");
        if (["symbol", "ticker", "code", "q", "stock", "symbols"].includes(k)) {
          if (value && /^[A-Z]{3,5}$/i.test(value)) return value.toUpperCase();
        }
      }
    } catch (e) {}

    return null;
  }

  // ===== BULK FETCH =====

  async function fetchAllForSymbol(symbol, fromDate, toDate, onProgress) {
    if (!requestTemplate) {
      throw new Error("No request template captured. Buka modal Historical Data dulu untuk satu saham.");
    }

    const currentSymbol = findSymbolInUrl(requestTemplate.url);
    if (!currentSymbol) {
      throw new Error("Tidak bisa deteksi symbol di URL template. URL: " + requestTemplate.url);
    }

    let baseUrl = buildUrlForSymbol(requestTemplate, currentSymbol, symbol);

    // Apply date range if provided
    if (fromDate && toDate) {
      baseUrl = setDateRange(baseUrl, fromDate, toDate);
    }

    console.log(`[Stockbit Exporter] Fetching for ${symbol}, baseUrl:`, baseUrl);

    const collected = new Map();
    const pagination = detectPagination(baseUrl);

    const addItems = (items) => {
      items.forEach((item) => {
        const key = (() => {
          for (const k of Object.keys(item)) {
            const l = k.toLowerCase();
            if (l.includes("date") || l === "d" || l === "t" || l.includes("time")) {
              return String(item[k]);
            }
          }
          return JSON.stringify(Object.values(item).slice(0, 3));
        })();
        if (!collected.has(key)) collected.set(key, item);
      });
    };

    const findArr = (obj, depth = 0) => {
      if (depth > 8) return null;
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
              k.includes("open") || k === "o" || k.includes("price")
          );
          if (hasDate && hasPrice) return obj;
        }
      }
      if (obj && typeof obj === "object" && !Array.isArray(obj)) {
        for (const k of Object.keys(obj)) {
          const r = findArr(obj[k], depth + 1);
          if (r) return r;
        }
      }
      return null;
    };

    // Background service worker bypasses CORS - we can forward Authorization safely
    const fetchHeaders = {};
    if (requestTemplate.headers) {
      for (const k of Object.keys(requestTemplate.headers)) {
        const lk = k.toLowerCase();
        // Forward auth-related headers, skip browser-controlled ones
        if (lk === "authorization" || lk.startsWith("x-") || lk === "accept") {
          fetchHeaders[k] = requestTemplate.headers[k];
        }
      }
    }
    console.log("[Stockbit Exporter] Forwarding headers:", Object.keys(fetchHeaders));

    let firstResponseLogged = false;

    // Strategy 1: Use page/offset pagination
    if (pagination.type === "page" || pagination.type === "offset") {
      let page = pagination.type === "page" ? 1 : 0;
      const step = pagination.type === "page" ? 1 : pagination.limit;
      let emptyCount = 0;
      let iter = 0;

      while (iter++ < 200) {
        const url = setPaginationParam(baseUrl, pagination.type, page, pagination.limit);
        if (onProgress) onProgress(symbol, collected.size, page);

        const result = await pageFetch(url, { headers: fetchHeaders });

        if (!firstResponseLogged) {
          firstResponseLogged = true;
          console.log(`[Stockbit Exporter] First response for ${symbol}:`, {
            ok: result.ok,
            status: result.status,
            hasJson: !!result.json,
            error: result.error,
            sample: result.json ? JSON.stringify(result.json).substring(0, 500) : result.text?.substring(0, 500),
          });
        }

        if (!result.ok) {
          throw new Error(`HTTP ${result.status || "?"}: ${result.error || "request failed"}`);
        }
        if (!result.json) {
          throw new Error("Response bukan JSON: " + (result.text || "").substring(0, 100));
        }

        const items = findArr(result.json) || (Array.isArray(result.json) ? result.json : []);
        if (items.length === 0) {
          emptyCount++;
          if (emptyCount >= 2) break;
        } else {
          const before = collected.size;
          addItems(items);
          if (collected.size === before) break; // no new dedup'd data
          if (items.length < pagination.limit) break;
        }
        page += step;
        await new Promise((r) => setTimeout(r, 200));
      }
    } else {
      const result = await pageFetch(baseUrl, { headers: fetchHeaders });
      console.log(`[Stockbit Exporter] Single fetch for ${symbol}:`, {
        ok: result.ok,
        status: result.status,
        sample: result.json ? JSON.stringify(result.json).substring(0, 500) : result.text?.substring(0, 500),
      });
      if (!result.ok) throw new Error(`HTTP ${result.status}: ${result.error || "request failed"}`);
      if (!result.json) throw new Error("Response bukan JSON");
      const items = findArr(result.json) || (Array.isArray(result.json) ? result.json : []);
      addItems(items);
    }

    if (collected.size === 0) {
      throw new Error("Response sukses tapi tidak ada data array yang terdeteksi");
    }

    return Array.from(collected.values());
  }

  // ===== EXCEL EXPORT =====

  function normalizeApiData(data) {
    if (data.length === 0) return { headers: [], rows: [] };

    const fieldMap = {
      date: "Date", d: "Date", t: "Date", time: "Date", timestamp: "Date",
      close: "Close", c: "Close", last: "Close",
      change: "Change", chg: "Change",
      changepercent: "Change%", pct: "Change%", percent: "Change%", changepct: "Change%",
      value: "Value", val: "Value",
      volume: "Volume", vol: "Volume",
      frequency: "Freq", freq: "Freq",
      foreignbuy: "F Buy", fbuy: "F Buy", fb: "F Buy",
      foreignsell: "F Sell", fsell: "F Sell", fs: "F Sell",
      foreignnet: "N Foreign", netforeign: "N Foreign", nforeign: "N Foreign", nf: "N Foreign",
      open: "Open", o: "Open",
      high: "High", h: "High",
      low: "Low", l: "Low",
      avg: "Avg", average: "Avg",
    };

    const keys = Object.keys(data[0]);
    const headers = keys.map((k) => {
      const l = k.toLowerCase().replace(/[_\s-]/g, "");
      return fieldMap[l] || k;
    });

    const rows = data.map((item) =>
      keys.map((k) => {
        let val = item[k];
        if (
          (k.toLowerCase().includes("date") || k.toLowerCase() === "d" || k.toLowerCase() === "t" || k.toLowerCase().includes("time")) &&
          typeof val === "number" && val > 1000000000
        ) {
          const d = new Date(val * (val > 9999999999 ? 1 : 1000));
          val = d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "2-digit" });
        }
        return val ?? "";
      })
    );

    return { headers, rows, dateIdx: keys.findIndex((k) => k.toLowerCase().includes("date") || k.toLowerCase() === "d" || k.toLowerCase() === "t") };
  }

  function parseNumber(val) {
    if (val === null || val === undefined || val === "" || val === "-") return val;
    if (typeof val === "number") return val;
    const cleaned = String(val).replace(/,/g, "").trim();
    const num = Number(cleaned);
    return isNaN(num) ? val : num;
  }

  function sortByDate(rows, dateIdx) {
    const monthMap = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
    const parse = (str) => {
      if (typeof str === "number") return str;
      const s = String(str);
      const m = s.match(/(\d{1,2})\s+([A-Za-z]{3})\s+(\d{2,4})/);
      if (m) {
        let y = parseInt(m[3], 10);
        if (y < 100) y += 2000;
        return new Date(y, monthMap[m[2]] ?? 0, parseInt(m[1], 10)).getTime();
      }
      const iso = s.match(/(\d{4})-(\d{2})-(\d{2})/);
      if (iso) return new Date(+iso[1], +iso[2] - 1, +iso[3]).getTime();
      return Date.parse(s) || 0;
    };
    return rows.slice().sort((a, b) => parse(a[dateIdx]) - parse(b[dateIdx]));
  }

  function buildSheet(data) {
    const { headers, rows, dateIdx } = normalizeApiData(data);
    const sorted = dateIdx >= 0 ? sortByDate(rows, dateIdx) : rows;

    const wsData = [headers];
    sorted.forEach((row) => {
      const processed = row.map((cell, idx) => (idx === dateIdx ? cell : parseNumber(cell)));
      wsData.push(processed);
    });

    const ws = XLSX.utils.aoa_to_sheet(wsData);
    ws["!cols"] = headers.map((h) => ({ wch: Math.max(String(h).length + 2, 14) }));

    const range = XLSX.utils.decode_range(ws["!ref"]);
    for (let R = range.s.r + 1; R <= range.e.r; R++) {
      for (let C = range.s.c; C <= range.e.c; C++) {
        if (C === dateIdx) continue;
        const addr = XLSX.utils.encode_cell({ r: R, c: C });
        const cell = ws[addr];
        if (cell && cell.t === "n") {
          cell.z = Number.isInteger(cell.v) ? "#,##0" : "#,##0.00";
        }
      }
    }
    return { ws, rowCount: sorted.length };
  }

  // ===== MATERIAL ICONS (inline SVG) =====
  const ICONS = {
    chart: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M5,9.2H8V19H5V9.2M10.6,5H13.4V19H10.6V5M16.2,13H19V19H16.2V13Z"/></svg>',
    download: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M5,20H19V18H5V20M19,9H15V3H9V9H5L12,16L19,9Z"/></svg>',
    file: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M14,2H6A2,2 0 0,0 4,4V20A2,2 0 0,0 6,22H18A2,2 0 0,0 20,20V8L14,2M18,20H6V4H13V9H18V20Z"/></svg>',
    warn: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M13,14H11V10H13M13,18H11V16H13M1,21H23L12,2L1,21Z"/></svg>',
    check: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12,2C6.48,2 2,6.48 2,12C2,17.52 6.48,22 12,22C17.52,22 22,17.52 22,12C22,6.48 17.52,2 12,2M10,17L5,12L6.41,10.59L10,14.17L17.59,6.58L19,8L10,17Z"/></svg>',
    science: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M19.8,18.4L14,10.67V6.5L15.35,4.81C15.61,4.48 15.38,4 14.96,4H9.04C8.62,4 8.39,4.48 8.65,4.81L10,6.5V10.67L4.2,18.4C3.71,19.06 4.18,20 5,20H19C19.82,20 20.29,19.06 19.8,18.4Z"/></svg>',
    link: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M3.9,12C3.9,10.29 5.29,8.9 7,8.9H11V7H7A5,5 0 0,0 2,12A5,5 0 0,0 7,17H11V15.1H7C5.29,15.1 3.9,13.71 3.9,12M8,13H16V11H8V13M17,7H13V8.9H17C18.71,8.9 20.1,10.29 20.1,12C20.1,13.71 18.71,15.1 17,15.1H13V17H17A5,5 0 0,0 22,12A5,5 0 0,0 17,7Z"/></svg>',
    minus: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M19,13H5V11H19V13Z"/></svg>',
    plus: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M19,13H13V19H11V13H5V11H11V5H13V11H19V13Z"/></svg>',
    refresh: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M17.65,6.35C16.2,4.9 14.21,4 12,4A8,8 0 0,0 4,12A8,8 0 0,0 12,20C15.73,20 18.84,17.45 19.73,14H17.65C16.83,16.33 14.61,18 12,18A6,6 0 0,1 6,12A6,6 0 0,1 12,6C13.66,6 15.14,6.69 16.22,7.78L13,11H20V4L17.65,6.35Z"/></svg>',
    progress: '<svg viewBox="0 0 24 24" fill="currentColor" class="sb-spin"><path d="M12,4V2A10,10 0 0,0 2,12H4A8,8 0 0,1 12,4Z"/></svg>',
    coffee: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M2,21V19H20V21H2M20,8H18V5H20V8M20,3H4V13A4,4 0 0,0 8,17H14A4,4 0 0,0 18,13V10H20A2,2 0 0,0 22,8V5C22,3.89 21.1,3 20,3Z"/></svg>',
  };

  function icon(name, size = 16) {
    return `<span class="sb-icon" style="width:${size}px;height:${size}px">${ICONS[name] || ""}</span>`;
  }

  // ===== UI PANEL =====

  function createPanel() {
    if (document.getElementById("sb-export-panel")) return;

    panel = document.createElement("div");
    panel.id = "sb-export-panel";
    panel.innerHTML = `
      <div class="sb-panel-header">
        <span class="sb-panel-title">${icon("chart", 18)}<span>Stockbit Exporter</span></span>
        <button class="sb-panel-toggle" title="Minimize">${icon("minus", 16)}</button>
      </div>
      <div class="sb-panel-body">
        <div class="sb-status sb-status-warn" id="sb-status">
          <span class="sb-status-icon">${icon("warn", 14)}</span>
          <span class="sb-status-text">Open Historical Data modal to capture API</span>
        </div>
        <div class="sb-url" id="sb-url" style="display:none"></div>

        <label class="sb-label">Stock Symbols (one per line, max 30)</label>
        <textarea id="sb-symbols" class="sb-textarea" rows="6" placeholder="BRPT&#10;BBCA&#10;TLKM&#10;ASII"></textarea>

        <div class="sb-row">
          <div class="sb-col">
            <label class="sb-label">From Date</label>
            <input type="date" id="sb-from" class="sb-input" />
          </div>
          <div class="sb-col">
            <label class="sb-label">To Date</label>
            <input type="date" id="sb-to" class="sb-input" />
          </div>
        </div>

        <button id="sb-bulk-btn" class="sb-btn sb-btn-primary">
          ${icon("download", 16)}<span>Bulk Export to Excel</span>
        </button>
        <button id="sb-current-btn" class="sb-btn sb-btn-secondary">
          ${icon("file", 16)}<span>Export Current Modal</span>
        </button>
        <button id="sb-test-btn" class="sb-btn sb-btn-ghost">
          ${icon("science", 14)}<span>Test Connection</span>
        </button>
        <button id="sb-reset-btn" class="sb-btn sb-btn-link">Reset captured API</button>

        <div class="sb-progress" id="sb-progress" style="display:none"></div>
      </div>
      <div class="sb-panel-footer">
        <a href="https://trakteer.id/vutra" target="_blank" rel="noopener noreferrer" class="sb-trakteer">
          ${icon("coffee", 14)}<span>Traktir kopi developer</span>
        </a>
      </div>
    `;
    document.body.appendChild(panel);

    // Default dates: last 1 year
    const today = new Date();
    const lastYear = new Date();
    lastYear.setFullYear(today.getFullYear() - 1);
    document.getElementById("sb-from").value = lastYear.toISOString().split("T")[0];
    document.getElementById("sb-to").value = today.toISOString().split("T")[0];

    // Event handlers
    panel.querySelector(".sb-panel-toggle").addEventListener("click", togglePanel);
    panel.querySelector(".sb-panel-header").addEventListener("dblclick", togglePanel);
    document.getElementById("sb-bulk-btn").addEventListener("click", handleBulkExport);
    document.getElementById("sb-current-btn").addEventListener("click", handleCurrentExport);
    document.getElementById("sb-test-btn").addEventListener("click", handleTestFetch);
    document.getElementById("sb-reset-btn").addEventListener("click", resetTemplate);

    updateStatus();
  }

  function resetTemplate() {
    requestTemplate = null;
    capturedData = [];
    window.dispatchEvent(new CustomEvent("__sb_reset__"));
    updateStatus();
    setProgress("Template reset. Open Historical Data modal again.");
    setTimeout(() => setProgress(""), 4000);
  }

  function togglePanel() {
    const body = panel.querySelector(".sb-panel-body");
    const toggle = panel.querySelector(".sb-panel-toggle");
    if (body.style.display === "none") {
      body.style.display = "block";
      toggle.innerHTML = ICONS.minus;
    } else {
      body.style.display = "none";
      toggle.innerHTML = ICONS.plus;
    }
  }

  function updateStatus() {
    const status = document.getElementById("sb-status");
    const urlEl = document.getElementById("sb-url");
    if (!status) return;
    const bulkBtn = document.getElementById("sb-bulk-btn");

    if (requestTemplate) {
      const sym = findSymbolInUrl(requestTemplate.url) || "?";
      const text = capturedData.length > 0
        ? `API ready · ${sym} · ${capturedData.length} rows captured`
        : `API ready (template from ${sym})`;
      status.innerHTML = `<span class="sb-status-icon">${icon("check", 14)}</span><span class="sb-status-text">${text}</span>`;
      status.className = "sb-status sb-status-ok";
      if (urlEl) {
        const shortUrl = requestTemplate.url.length > 80
          ? requestTemplate.url.substring(0, 80) + "..."
          : requestTemplate.url;
        urlEl.innerHTML = `${icon("link", 12)}<span>${shortUrl}</span>`;
        urlEl.title = requestTemplate.url;
        urlEl.style.display = "flex";
      }
      if (bulkBtn) bulkBtn.disabled = false;
    } else {
      status.innerHTML = `<span class="sb-status-icon">${icon("warn", 14)}</span><span class="sb-status-text">Open Historical Data modal to capture API</span>`;
      status.className = "sb-status sb-status-warn";
      if (urlEl) urlEl.style.display = "none";
      if (bulkBtn) bulkBtn.disabled = true;
    }
  }

  function setProgress(text) {
    const p = document.getElementById("sb-progress");
    if (p) {
      p.style.display = text ? "block" : "none";
      p.textContent = text || "";
    }
  }

  function setBtnLoading(btn, label) {
    btn.disabled = true;
    btn.innerHTML = `${icon("progress", 14)}<span>${label}</span>`;
  }

  function setBtnIdle(btn, iconName, label) {
    btn.disabled = false;
    btn.innerHTML = `${icon(iconName, 16)}<span>${label}</span>`;
  }

  // ===== EXPORT HANDLERS =====

  async function handleBulkExport() {
    if (!window.XLSX) {
      alert("SheetJS not loaded. Refresh the page.");
      return;
    }
    if (!requestTemplate) {
      alert("Open Historical Data modal first to capture the API endpoint.");
      return;
    }

    const symbolsText = document.getElementById("sb-symbols").value.trim();
    if (!symbolsText) {
      alert("Enter at least 1 stock symbol");
      return;
    }

    const symbols = symbolsText
      .split(/[\n,;\s]+/)
      .map((s) => s.trim().toUpperCase())
      .filter((s) => /^[A-Z]{3,5}$/.test(s));

    if (symbols.length === 0) {
      alert("Invalid stock symbols (must be 3-5 letters)");
      return;
    }

    if (symbols.length > 30) {
      if (!confirm(`You entered ${symbols.length} symbols. Stockbit may rate-limit. Continue?`)) return;
    }

    const fromDate = document.getElementById("sb-from").value;
    const toDate = document.getElementById("sb-to").value;

    const btn = document.getElementById("sb-bulk-btn");
    setBtnLoading(btn, "Processing...");

    const wb = XLSX.utils.book_new();
    const summary = [];
    let successCount = 0;

    try {
      for (let i = 0; i < symbols.length; i++) {
        const sym = symbols[i];
        setProgress(`[${i + 1}/${symbols.length}] Fetching ${sym}...`);

        try {
          const data = await fetchAllForSymbol(sym, fromDate, toDate, (s, count, page) => {
            setProgress(`[${i + 1}/${symbols.length}] ${s}: ${count} rows (page ${page})`);
          });

          if (data.length === 0) {
            summary.push({ symbol: sym, rows: 0, status: "No data" });
            continue;
          }

          const { ws, rowCount } = buildSheet(data);
          XLSX.utils.book_append_sheet(wb, ws, sym.substring(0, 31));
          summary.push({ symbol: sym, rows: rowCount, status: "OK" });
          successCount++;
        } catch (err) {
          console.error(`[Stockbit Exporter] Error fetching ${sym}:`, err);
          summary.push({ symbol: sym, rows: 0, status: "Error: " + err.message });
        }

        if (i < symbols.length - 1) {
          await new Promise((r) => setTimeout(r, 300));
        }
      }

      if (successCount === 0) {
        const errors = summary
          .filter((s) => s.status !== "OK")
          .map((s) => `• ${s.symbol}: ${s.status}`)
          .join("\n");
        alert(
          "No data was successfully fetched.\n\n" +
          "Error details:\n" + errors +
          "\n\nCheck the captured URL in the panel — make sure it's the historical API for ONE symbol."
        );
        return;
      }

      const sumWs = XLSX.utils.aoa_to_sheet([
        ["Symbol", "Rows", "Status"],
        ...summary.map((s) => [s.symbol, s.rows, s.status]),
      ]);
      sumWs["!cols"] = [{ wch: 12 }, { wch: 10 }, { wch: 30 }];
      XLSX.utils.book_append_sheet(wb, sumWs, "_Summary");

      const today = new Date().toISOString().split("T")[0];
      const filename = `stockbit_bulk_${today}.xlsx`;
      XLSX.writeFile(wb, filename);

      setProgress(`Done — ${successCount}/${symbols.length} symbols exported`);
    } catch (err) {
      console.error("[Stockbit Exporter] Bulk error:", err);
      alert("Error: " + err.message);
    } finally {
      setBtnIdle(btn, "download", "Bulk Export to Excel");
      setTimeout(() => setProgress(""), 5000);
    }
  }

  async function handleTestFetch() {
    if (!requestTemplate) {
      alert("No template captured. Open Historical Data modal first.");
      return;
    }
    const btn = document.getElementById("sb-test-btn");
    setBtnLoading(btn, "Testing...");
    setProgress("Testing fetch with captured URL...");

    try {
      console.log("[Stockbit Exporter] TEST FETCH URL:", requestTemplate.url);
      const fetchHeaders = {};
      if (requestTemplate.headers) {
        for (const k of Object.keys(requestTemplate.headers)) {
          const lk = k.toLowerCase();
          if (lk === "authorization" || lk.startsWith("x-") || lk === "accept") {
            fetchHeaders[k] = requestTemplate.headers[k];
          }
        }
      }
      const result = await pageFetch(requestTemplate.url, { headers: fetchHeaders });
      console.log("[Stockbit Exporter] TEST FETCH RESULT:", result);

      const sample = result.json
        ? JSON.stringify(result.json).substring(0, 300)
        : (result.text || "").substring(0, 300);

      alert(
        `Test Result\n\n` +
        `OK: ${result.ok}\n` +
        `Status: ${result.status || "?"}\n` +
        `Error: ${result.error || "none"}\n` +
        `Headers: ${Object.keys(fetchHeaders).join(", ") || "(none)"}\n\n` +
        `Sample:\n${sample || "(empty)"}\n\n` +
        `Open DevTools console for full details.`
      );
    } catch (err) {
      alert("Test error: " + err.message);
    } finally {
      btn.disabled = false;
      btn.innerHTML = `${icon("science", 14)}<span>Test Connection</span>`;
      setTimeout(() => setProgress(""), 3000);
    }
  }

  async function handleCurrentExport() {
    if (!window.XLSX) {
      alert("SheetJS not loaded. Refresh the page.");
      return;
    }
    if (capturedData.length === 0) {
      alert("No data yet. Open Historical Data modal and wait for data to load.");
      return;
    }

    const btn = document.getElementById("sb-current-btn");
    setBtnLoading(btn, "Exporting...");

    try {
      const sym = findSymbolInUrl(requestTemplate?.url || "") || "STOCK";
      const { ws } = buildSheet(capturedData);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, "Historical Data");
      const today = new Date().toISOString().split("T")[0];
      XLSX.writeFile(wb, `${sym}_historical_${today}.xlsx`);
      setProgress(`Exported ${capturedData.length} rows`);
    } catch (err) {
      alert("Error: " + err.message);
    } finally {
      setBtnIdle(btn, "file", "Export Current Modal");
      setTimeout(() => setProgress(""), 3000);
    }
  }

  // ===== INIT =====

  function init() {
    createPanel();
  }

  if (document.readyState === "complete" || document.readyState === "interactive") {
    setTimeout(init, 500);
  } else {
    document.addEventListener("DOMContentLoaded", init);
  }

  console.log("[Stockbit Exporter] Content script v2 loaded");
})();
