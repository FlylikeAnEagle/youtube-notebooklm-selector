# YouTube Channel Selector for NotebookLM

A Chrome extension (Manifest V3) that lets you browse all videos from any YouTube channel, select up to 250, and push them as sources into Google NotebookLM.

## Features

- Fetches **all videos** from a YouTube channel with pagination
- Sort by **Latest** or **Most Popular**
- Select up to **250 videos** with Select All / Clear controls
- **One-click push** to NotebookLM — opens a new tab and injects the selected YouTube URLs
- **Dark mode** UI matching YouTube's aesthetic
- **Session caching** — re-opening the popup on the same channel doesn't re-fetch
- Vanilla JS, no external dependencies

## Installation

### 1. Get a YouTube Data API v3 Key

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a new project (or select an existing one)
3. Navigate to **APIs & Services → Library**
4. Search for **YouTube Data API v3** and enable it
5. Go to **APIs & Services → Credentials**
6. Click **Create Credentials → API Key**
7. (Recommended) Restrict the key to **YouTube Data API v3** only
8. Copy the key

### 2. Load as Unpacked Extension

1. Open Chrome and go to `chrome://extensions/`
2. Enable **Developer mode** (toggle in top-right)
3. Click **Load unpacked**
4. Select this project's folder
5. The extension icon should appear in your toolbar

### 3. Set Your API Key

1. Click the extension icon, then click the **⚙ gear** button
   — or go to `chrome://extensions/`, find this extension, and click **Details → Extension options**
2. Paste your YouTube Data API v3 key
3. Click **Save**

## Usage

1. Navigate to any YouTube channel page (e.g., `youtube.com/@MrBeast` or `youtube.com/channel/UC...`)
2. Click the extension icon
3. Wait for videos to load (progress is shown)
4. Sort by **Latest** or **Most Popular**
5. Select videos individually or use **Select All**
6. Click **Add to NotebookLM**
7. A new NotebookLM tab opens and the extension attempts to inject the selected URLs

## How NotebookLM Injection Works

When you click "Add to NotebookLM":

1. The extension opens `https://notebooklm.google.com` in a new tab
2. It waits for the page to fully load
3. Using `chrome.scripting.executeScript`, it injects a function into the NotebookLM page that:
   - Finds and clicks the **"Add source"** button
   - Looks for a YouTube source option and clicks it
   - Locates the URL input field
   - Pastes each selected YouTube URL using native input value setters and dispatched events
   - Clicks the submit/confirm button

### Fallback

If the DOM injection fails (NotebookLM's UI changes frequently), the extension falls back to:
- Copying all selected URLs to your clipboard
- Showing a notification so you can paste them manually

## Project Structure

```
├── manifest.json        # Extension manifest (Manifest V3)
├── popup.html           # Popup UI markup
├── popup.css            # Dark mode styles (640px wide)
├── popup.js             # Popup logic: fetching, sorting, selection, rendering
├── background.js        # Service worker: API calls, channel resolution, NotebookLM injection
├── content.js           # YouTube page content script (reserved for future use)
├── options.html         # API key settings page
├── options.js           # Options page logic
├── .gitignore
├── .env.example         # Notes about API key setup
└── README.md
```

## Limitations

- YouTube Data API v3 has a daily quota (~10,000 units). Fetching large channels with many pages may consume significant quota.
- NotebookLM has its own source limits. The extension caps at 250 selections.
- The NotebookLM DOM injection may break if Google changes the UI. The clipboard fallback always works.

## License

MIT
