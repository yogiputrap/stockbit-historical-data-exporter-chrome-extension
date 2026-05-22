# Stockbit Historical Data Exporter

> Chrome extension for bulk-exporting Stockbit historical price data into a single Excel file.
> <img width="1629" height="1080" alt="Image" src="https://github.com/user-attachments/assets/83b59784-59e9-4593-a7b6-d9fe307c541e" />

Built for Indonesian retail investors who need to pull historical OHLC + foreign flow data across multiple stocks for analysis. Skip the manual click-through — paste your watchlist, set a date range, get one `.xlsx` with multi-sheet output.

## Features

- **Bulk export up to 30 stocks** in one click
- **Auto-pagination** — fetches every row regardless of date range size
- **Multi-sheet Excel output** — one sheet per stock plus a summary sheet
- **Clean number formatting** — `#,##0` thousand separators, no scientific notation
- **Floating panel UI** with Material Design icons
- **Background service worker** bypasses CORS for reliable cross-origin API access
- **API endpoint auto-discovery** — interceptor detects historical endpoints by response shape

## Installation

1. Clone or download this repository
2. Open Chrome and navigate to `chrome://extensions/`
3. Enable **Developer mode** (toggle, top right)
4. Click **Load unpacked** and select the `stockbit-exporter/` folder
5. The extension is now active on `stockbit.com`

## Usage

### 1. Capture API endpoint (one-time per session)

The extension needs to learn how Stockbit calls its historical API. Do this once after installing:

1. Open any stock page on Stockbit (e.g. [stockbit.com/symbol/BRPT](https://stockbit.com/symbol/BRPT))
2. Open the **Historical Data** modal
3. Watch the floating panel — status changes from yellow (warning) to green (API ready)

### 2. Verify connection

Click **Test Connection** in the panel. A successful response (`OK: true`, `Status: 200`) confirms the background worker can reach the API. The captured URL should look like:

```
https://exodus.stockbit.com/company-price-feed/historical/summary/BRPT?...
```

### 3. Bulk export

1. Paste stock symbols in the textarea, one per line:
   ```
   BRPT
   BBCA
   TLKM
   ASII
   GOTO
   ```
2. Set the date range (defaults to last 1 year)
3. Click **Bulk Export to Excel**
4. The exporter loops through symbols, paginates each, and saves a single `.xlsx`

### Single export

Click **Export Current Modal** to save just the data currently loaded in the open Stockbit historical modal.

## Output

The exported `.xlsx` contains:

- One sheet per stock (sheet name = symbol code)
- A `_Summary` sheet listing each symbol with its row count and status
- Standard columns: `Date`, `Close`, `Change`, `Value`, `Volume`, `Freq`, `F Buy`, `F Sell`, `N Foreign`, `Open`, `High`, `Low`, `Avg`
- Rows sorted ascending by date (oldest first)

## Limits

- Maximum 30 symbols per batch (warning shown if exceeded)
- 300ms delay between requests to avoid rate limiting
- Approximate runtime: ~10 to 30 seconds for a full batch

## Architecture

```
Stockbit page (stockbit.com)
├── interceptor.js (MAIN world)    Captures API URL & data via fetch/XHR hooks
└── content.js (ISOLATED world)    Floating panel UI + bulk export orchestration
                │
                │  chrome.runtime.sendMessage
                ↓
       background.js (Service Worker)
                │  host_permissions bypass CORS
                ↓
       exodus.stockbit.com API
```

The background service worker is the secret sauce. With `host_permissions: ["https://*.stockbit.com/*"]` it can fetch any Stockbit API endpoint with cookies attached, free from CORS preflight rejections that would block content-script fetches.

The interceptor watches the page's own fetch/XHR calls to learn the URL pattern (including query params, auth headers, pagination format), then the content script reuses that template to replay requests for any symbol.

## Files

| File                | Purpose                                                 |
|---------------------|---------------------------------------------------------|
| `manifest.json`     | Chrome extension manifest (MV3)                         |
| `interceptor.js`    | Captures API URL templates and historical data          |
| `content.js`        | Floating panel UI and bulk export logic                 |
| `background.js`     | Service worker handling cross-origin fetches            |
| `xlsx.full.min.js`  | [SheetJS](https://sheetjs.com) library for `.xlsx` I/O  |
| `styles.css`        | Panel styling (Material Design inspired)                |

## Troubleshooting

| Issue | Solution |
|-------|----------|
| Status stays yellow | Open the Historical Data modal at least once for any stock |
| Test Connection returns "Failed to fetch" | Reload extension, close and reopen the Stockbit tab |
| Bulk export shows "No data" for some symbols | Stock may be delisted or suspended in the date range — check `_Summary` sheet |
| Wrong URL captured | Click **Reset captured API** then reopen the modal |
| `Extension context invalidated` errors | Always close and reopen tabs after reloading the extension |

## Development

```bash
# Clone the repo
git clone git@github.com:yogiputrap/stockbit-historical-data-exporter-chrome-extension.git
cd stockbit-historical-data-exporter-chrome-extension/stockbit-exporter

# Make changes, then reload at chrome://extensions/
# Always close and reopen the Stockbit tab after reloading
```

No build step required — pure JavaScript, no bundler. Edit source files and reload.

## Tech

- [Manifest V3](https://developer.chrome.com/docs/extensions/develop/migrate) Chrome Extensions
- [SheetJS Community Edition](https://sheetjs.com) for Excel generation
- Inline SVG Material icons (no external font dependency)
- Service workers for CORS-free cross-origin fetching

## Disclaimer

This extension is not affiliated with Stockbit. It uses Stockbit's public web APIs that are also called by the official Stockbit web interface. Use responsibly and respect Stockbit's terms of service.

## Support

If this extension saves you time, consider [buying the developer a coffee](https://trakteer.id/vutra). Thanks!

## License

MIT
