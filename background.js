/* background.js — Service Worker */

const API_KEY_STORAGE_KEY = 'yt_api_key';
const YT_API_BASE = 'https://www.googleapis.com/youtube/v3';

// ----- helpers -----

async function getApiKey() {
  return new Promise((resolve, reject) => {
    chrome.storage.sync.get(API_KEY_STORAGE_KEY, (data) => {
      const key = data[API_KEY_STORAGE_KEY];
      if (!key) reject(new Error('NO_API_KEY'));
      else resolve(key);
    });
  });
}

async function ytFetch(endpoint, params) {
  const key = await getApiKey();
  const url = new URL(`${YT_API_BASE}/${endpoint}`);
  url.searchParams.set('key', key);
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, v);
  }
  const res = await fetch(url.toString());
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const reason = body?.error?.errors?.[0]?.reason || res.statusText;
    throw new Error(`YT_API_ERROR:${reason}`);
  }
  return res.json();
}

// ----- channel resolution -----

async function resolveChannelId(raw) {
  // raw could be @handle, UC... id, or a channel name
  if (raw.startsWith('UC') && raw.length === 24) return raw;

  // Try @handle
  if (raw.startsWith('@')) {
    const data = await ytFetch('channels', { part: 'id', forHandle: raw.slice(1) });
    if (data.items?.[0]) return data.items[0].id;
  }

  // Try as channel ID anyway
  try {
    const data = await ytFetch('channels', { part: 'id', id: raw });
    if (data.items?.[0]) return data.items[0].id;
  } catch { /* fallthrough */ }

  // Try as legacy username
  const data = await ytFetch('channels', { part: 'id', forUsername: raw });
  if (data.items?.[0]) return data.items[0].id;

  throw new Error('CHANNEL_NOT_FOUND');
}

// ----- video fetching -----

async function getUploadsPlaylistId(channelId) {
  const data = await ytFetch('channels', {
    part: 'contentDetails',
    id: channelId,
  });
  return data.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
}

async function fetchAllPlaylistItems(playlistId, onProgress) {
  const videos = [];
  let pageToken = null;
  let page = 0;

  do {
    const params = {
      part: 'snippet',
      playlistId,
      maxResults: '50',
    };
    if (pageToken) params.pageToken = pageToken;

    const data = await ytFetch('playlistItems', params);
    for (const item of data.items || []) {
      const snip = item.snippet;
      if (snip.resourceId?.videoId) {
        videos.push({
          videoId: snip.resourceId.videoId,
          title: snip.title,
          publishedAt: snip.publishedAt,
          thumbnails: snip.thumbnails,
        });
      }
    }
    pageToken = data.nextPageToken;
    page++;
    if (onProgress) onProgress(videos.length, page);
  } while (pageToken);

  return videos;
}

async function fetchVideoStats(videoIds) {
  const stats = new Map();
  // Batch in chunks of 50
  for (let i = 0; i < videoIds.length; i += 50) {
    const batch = videoIds.slice(i, i + 50);
    const data = await ytFetch('videos', {
      part: 'statistics',
      id: batch.join(','),
    });
    for (const item of data.items || []) {
      stats.set(item.id, {
        viewCount: parseInt(item.statistics?.viewCount || '0', 10),
      });
    }
  }
  return stats;
}

// ----- NotebookLM injection -----

async function pushToNotebookLM(videoUrls) {
  const tab = await chrome.tabs.create({
    url: 'https://notebooklm.google.com',
  });

  // Wait for tab to finish loading, then inject
  chrome.tabs.onUpdated.addListener(function listener(tabId, info) {
    if (tabId !== tab.id || info.status !== 'complete') return;
    chrome.tabs.onUpdated.removeListener(listener);

    setTimeout(() => {
      injectNotebookLM(tab.id, videoUrls);
    }, 1500);
  });

  return tab.id;
}

async function injectNotebookLM(tabId, videoUrls) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: _notebookLMInjector,
      args: [videoUrls],
    });
  } catch {
    // Fallback: copy to clipboard from background via offscreen or notify
    // We'll signal the popup to fall back to clipboard
    chrome.runtime.sendMessage({
      type: 'NOTEBOOKLM_FALLBACK',
      urls: videoUrls,
    });
  }
}

// This function runs inside the NotebookLM page
function _notebookLMInjector(urls) {
  const WAIT_MS = 2000;
  const MAX_WAIT = 15000;

  function findAndClick() {
    // Look for "Add source" or "+" button
    const buttons = Array.from(document.querySelectorAll('button, [role="button"]'));
    const addBtn = buttons.find(b =>
      /add source|add sources|\+ source/i.test(b.textContent) ||
      b.querySelector('[data-testid="add-source"]')
    );
    return addBtn;
  }

  function findUrlInput() {
    // Look for URL input field in the add-source dialog
    const inputs = Array.from(document.querySelectorAll('input, textarea'));
    return inputs.find(inp =>
      /url|link|paste/i.test(inp.placeholder || inp.getAttribute('aria-label') || '')
    );
  }

  async function run() {
    const start = Date.now();
    let addBtn = null;

    // Wait for Add Source button
    while (Date.now() - start < MAX_WAIT) {
      addBtn = findAndClick();
      if (addBtn) break;
      await new Promise(r => setTimeout(r, 500));
    }
    if (!addBtn) {
      chrome.runtime.sendMessage({ type: 'NOTEBOOKLM_FALLBACK', urls });
      return;
    }

    addBtn.click();
    await new Promise(r => setTimeout(r, WAIT_MS));

    // Find URL input
    const urlInput = findUrlInput();
    if (!urlInput) {
      chrome.runtime.sendMessage({ type: 'NOTEBOOKLM_FALLBACK', urls });
      return;
    }

    // Try to find the "YouTube" source type button and click it
    const ytBtn = Array.from(document.querySelectorAll('button, [role="button"]'))
      .find(b => /youtube/i.test(b.textContent));
    if (ytBtn) {
      ytBtn.click();
      await new Promise(r => setTimeout(r, 1000));
    }

    // Re-find input after potential UI change
    const input = findUrlInput() || urlInput;

    // Set value and dispatch events
    const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype, 'value'
    )?.set || Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype, 'value'
    )?.set;

    for (const url of urls) {
      if (nativeInputValueSetter) {
        nativeInputValueSetter.call(input, url);
      } else {
        input.value = url;
      }
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise(r => setTimeout(r, 300));
    }

    // Try to find and click submit button
    await new Promise(r => setTimeout(r, 500));
    const submitBtn = Array.from(document.querySelectorAll('button'))
      .find(b => /insert|add|submit|confirm/i.test(b.textContent));
    if (submitBtn) submitBtn.click();
  }

  run();
}

// ----- message handler -----

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'GET_API_KEY') {
    getApiKey()
      .then(key => sendResponse({ ok: true, key }))
      .catch(err => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (msg.type === 'RESOLVE_CHANNEL') {
    resolveChannelId(msg.channel)
      .then(id => sendResponse({ ok: true, channelId: id }))
      .catch(err => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (msg.type === 'FETCH_VIDEOS') {
    (async () => {
      try {
        const channelId = msg.channelId;
        const playlistId = await getUploadsPlaylistId(channelId);

        const videos = await fetchAllPlaylistItems(playlistId, (count, page) => {
          // Send progress updates
          try {
            chrome.runtime.sendMessage({
              type: 'FETCH_PROGRESS',
              count,
              page,
            });
          } catch { /* popup might be closed */ }
        });

        // Fetch stats
        const ids = videos.map(v => v.videoId);
        const stats = await fetchVideoStats(ids);

        const result = videos.map(v => ({
          ...v,
          viewCount: stats.get(v.videoId)?.viewCount || 0,
        }));

        // Cache in session storage
        chrome.storage.session.set({
          [`cache_${channelId}`]: { videos: result, ts: Date.now() },
        });

        sendResponse({ ok: true, videos: result });
      } catch (err) {
        sendResponse({ ok: false, error: err.message });
      }
    })();
    return true;
  }

  if (msg.type === 'PUSH_NOTEBOOKLM') {
    pushToNotebookLM(msg.urls)
      .then(tabId => sendResponse({ ok: true, tabId }))
      .catch(err => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (msg.type === 'NOTEBOOKLM_FALLBACK') {
    // Copy URLs to clipboard — we'll handle this in popup
    // Just forward it
    chrome.runtime.sendMessage(msg);
  }
});
