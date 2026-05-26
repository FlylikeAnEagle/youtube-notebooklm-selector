/* popup.js — Main popup logic */

const MAX_SELECTION = 250;
const YT_URL_REGEX = /^https:\/\/www\.youtube\.com\/(@[\w.-]+|channel\/(UC[\w-]{22}))/;

let allVideos = [];
let selectedIds = new Set();
let currentSort = 'latest';
let currentChannelId = null;
let channelIdentifier = null;
let hideShorts = false;

// DOM refs
const channelNameEl = document.getElementById('channelName');
const toolbar = document.getElementById('toolbar');
const loadingState = document.getElementById('loadingState');
const loadingText = document.getElementById('loadingText');
const stateMsg = document.getElementById('stateMsg');
const stateIcon = document.getElementById('stateIcon');
const stateText = document.getElementById('stateText');
const videoList = document.getElementById('videoList');
const selectionInfo = document.getElementById('selectionInfo');
const pushBtn = document.getElementById('pushBtn');
const footerInfo = document.getElementById('footerInfo');
const sortLatest = document.getElementById('sortLatest');
const sortPopular = document.getElementById('sortPopular');
const selectAllBtn = document.getElementById('selectAll');
const deselectAllBtn = document.getElementById('deselectAll');
const hideShortsBtn = document.getElementById('hideShorts');
const refreshBtn = document.getElementById('refreshBtn');
const optionsBtn = document.getElementById('optionsBtn');

// ---- helpers ----

function $(sel) { return document.querySelector(sel); }
function $$(sel) { return document.querySelectorAll(sel); }

function show(el) { el.classList.remove('hidden'); }
function hide(el) { el.classList.add('hidden'); }

function showError(icon, text) {
  hide(loadingState);
  hide(videoList);
  hide(toolbar);
  stateIcon.textContent = icon;
  stateText.innerHTML = text;
  show(stateMsg);
}

function formatViews(n) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M views';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K views';
  return n + ' views';
}

function formatDate(iso) {
  const d = new Date(iso);
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}

function truncate(str, len) {
  return str.length > len ? str.slice(0, len - 1) + '…' : str;
}

function updateSelectionUI() {
  const count = selectedIds.size;
  selectionInfo.textContent = `Selected: ${count} / ${MAX_SELECTION}`;
  pushBtn.disabled = count === 0;
  const shortsCount = allVideos.filter(v => v.duration > 0 && v.duration < 60).length;
  footerInfo.textContent = shortsCount > 0
    ? `${allVideos.length} videos (${shortsCount} Shorts)`
    : `${allVideos.length} videos`;

  // Disable unchecked checkboxes when at limit
  const checkboxes = videoList.querySelectorAll('input[type="checkbox"]');
  for (const cb of checkboxes) {
    if (!cb.checked) {
      cb.disabled = count >= MAX_SELECTION;
    }
  }
}

// ---- render ----

function getSortedVideos() {
  let sorted = [...allVideos];
  if (hideShorts) {
    sorted = sorted.filter(v => !v.duration || v.duration >= 60);
  }
  if (currentSort === 'latest') {
    sorted.sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt));
  } else {
    sorted.sort((a, b) => b.viewCount - a.viewCount);
  }
  return sorted;
}

function renderVideos() {
  const sorted = getSortedVideos();
  videoList.innerHTML = '';

  for (const video of sorted) {
    const row = document.createElement('div');
    row.className = 'video-row' + (selectedIds.has(video.videoId) ? ' selected' : '');
    row.dataset.videoId = video.videoId;

    const thumb = video.thumbnails?.default || video.thumbnails?.medium || video.thumbnails?.high;
    const thumbUrl = thumb?.url || '';
    const atLimit = selectedIds.size >= MAX_SELECTION;
    const checked = selectedIds.has(video.videoId);
    const disabled = !checked && atLimit;

    row.innerHTML = `
      <input type="checkbox" ${checked ? 'checked' : ''} ${disabled ? 'disabled' : ''}>
      <img class="video-thumb" src="${thumbUrl}" alt="" loading="lazy">
      <div class="video-info">
        <div class="video-title">${escapeHtml(video.title)}</div>
        <div class="video-meta">
          <span>${formatDate(video.publishedAt)}</span>
          <span>${formatViews(video.viewCount)}</span>
        </div>
      </div>
    `;

    const checkbox = row.querySelector('input');
    checkbox.addEventListener('change', () => {
      toggleSelection(video.videoId, checkbox.checked);
    });
    row.addEventListener('click', (e) => {
      if (e.target !== checkbox) {
        checkbox.checked = !checkbox.checked;
        toggleSelection(video.videoId, checkbox.checked);
      }
    });

    videoList.appendChild(row);
  }

  updateSelectionUI();
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function toggleSelection(videoId, isChecked) {
  if (isChecked) {
    if (selectedIds.size >= MAX_SELECTION) return;
    selectedIds.add(videoId);
  } else {
    selectedIds.delete(videoId);
  }
  renderVideos();
}

// ---- sort ----

sortLatest.addEventListener('click', () => {
  currentSort = 'latest';
  sortLatest.classList.add('active');
  sortPopular.classList.remove('active');
  renderVideos();
});

sortPopular.addEventListener('click', () => {
  currentSort = 'popular';
  sortPopular.classList.add('active');
  sortLatest.classList.remove('active');
  renderVideos();
});

// ---- select all / deselect ----

selectAllBtn.addEventListener('click', () => {
  const sorted = getSortedVideos();
  for (const v of sorted) {
    if (selectedIds.size >= MAX_SELECTION) break;
    selectedIds.add(v.videoId);
  }
  renderVideos();
});

deselectAllBtn.addEventListener('click', () => {
  selectedIds.clear();
  renderVideos();
});

hideShortsBtn.addEventListener('click', () => {
  hideShorts = !hideShorts;
  hideShortsBtn.classList.toggle('active', hideShorts);
  // Deselect any shorts that will be hidden
  if (hideShorts) {
    for (const v of allVideos) {
      if (v.duration > 0 && v.duration < 60) {
        selectedIds.delete(v.videoId);
      }
    }
  }
  renderVideos();
});

// ---- push to NotebookLM ----

pushBtn.addEventListener('click', async () => {
  const urls = [...selectedIds].map(id => `https://www.youtube.com/watch?v=${id}`);
  console.log('[YT→NLM Popup] Push clicked, sending', urls.length, 'URLs');

  // Warn about NotebookLM source limits
  if (urls.length > 300) {
    showError('⚠', `NotebookLM allows max 300 sources per notebook.<br>You selected ${urls.length} videos. Please select 300 or fewer.`);
    return;
  }
  if (urls.length > 200) {
    // Soft warning but allow proceed
    if (!confirm(`You selected ${urls.length} videos. NotebookLM's source limit is 300 per notebook. Proceed?`)) return;
  }

  pushBtn.disabled = true;
  pushBtn.textContent = 'Opening NotebookLM...';

  try {
    const response = await sendMessage({ type: 'PUSH_NOTEBOOKLM', urls });
    console.log('[YT→NLM Popup] Background response:', response);
    if (response?.ok) {
      pushBtn.textContent = 'Opened in new tab';
      setTimeout(() => {
        pushBtn.textContent = 'Add to NotebookLM';
        pushBtn.disabled = selectedIds.size === 0;
      }, 2000);
    } else {
      throw new Error(response?.error || 'Failed');
    }
  } catch {
    // Fallback: copy to clipboard
    await copyToClipboard(urls);
  }
});

async function copyToClipboard(urls) {
  try {
    await navigator.clipboard.writeText(urls.join('\n'));
    pushBtn.textContent = 'URLs copied to clipboard!';
    setTimeout(() => {
      pushBtn.textContent = 'Add to NotebookLM';
      pushBtn.disabled = selectedIds.size === 0;
    }, 3000);
  } catch {
    pushBtn.textContent = 'Copy failed — try again';
    pushBtn.disabled = selectedIds.size === 0;
  }
}

// Listen for fallback message from background
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'NOTEBOOKLM_FALLBACK') {
    copyToClipboard(msg.urls);
  }
});

// ---- navigation ----

optionsBtn.addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
});

refreshBtn.addEventListener('click', () => {
  if (channelIdentifier) {
    // Clear cache and re-fetch
    if (currentChannelId) {
      chrome.storage.session.remove(`cache_${currentChannelId}`);
    }
    selectedIds.clear();
    allVideos = [];
    fetchVideos(channelIdentifier, true);
  }
});

// ---- messaging ----

function sendMessage(msg) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(msg, (response) => {
      resolve(response);
    });
  });
}

// ---- main flow ----

async function init() {
  // Get current tab — handle both browser-action popup and standalone window
  let [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  // If opened from inline YouTube button as a separate window, the active tab
  // won't be YouTube — find the YouTube channel tab in any window instead
  if (!tab?.url || !YT_URL_REGEX.test(tab.url)) {
    const ytTabs = await chrome.tabs.query({ url: 'https://www.youtube.com/*' });
    tab = ytTabs.find(t => YT_URL_REGEX.test(t.url)) || tab;
  }

  if (!tab?.url) {
    showError('⚠', 'Cannot detect current tab.');
    return;
  }

  const match = tab.url.match(YT_URL_REGEX);
  if (!match) {
    showError('📺', 'Navigate to a YouTube channel page to use this extension.<br><br>Supported URLs:<br><code>youtube.com/@handle</code><br><code>youtube.com/channel/UC...</code>');
    return;
  }

  channelIdentifier = match[2] || match[1]; // UC... id or @handle
  channelNameEl.textContent = channelIdentifier;

  // Check for API key first
  try {
    await sendMessage({ type: 'GET_API_KEY' });
  } catch {
    showError('🔑', 'YouTube API key not set. <a href="#" id="openOptions">Open settings</a> to add your key.');
    document.getElementById('openOptions')?.addEventListener('click', (e) => {
      e.preventDefault();
      chrome.runtime.openOptionsPage();
    });
    return;
  }

  await fetchVideos(channelIdentifier);
}

async function fetchVideos(identifier, forceRefresh = false) {
  show(loadingState);
  hide(stateMsg);
  hide(videoList);
  hide(toolbar);

  loadingText.textContent = 'Resolving channel...';

  try {
    // Resolve channel ID
    let channelId;
    if (identifier.startsWith('UC') && identifier.length === 24) {
      channelId = identifier;
    } else {
      const resolveRes = await sendMessage({ type: 'RESOLVE_CHANNEL', channel: identifier });
      if (!resolveRes?.ok) throw new Error(resolveRes?.error || 'Failed to resolve channel');
      channelId = resolveRes.channelId;
    }
    currentChannelId = channelId;

    // Check session cache
    if (!forceRefresh) {
      const cached = await new Promise(resolve => {
        chrome.storage.session.get(`cache_${channelId}`, resolve);
      });
      const cacheData = cached[`cache_${channelId}`];
      if (cacheData?.videos?.length) {
        allVideos = cacheData.videos;
        channelNameEl.textContent = `${allVideos.length} videos loaded (cached)`;
        hide(loadingState);
        show(toolbar);
        show(videoList);
        renderVideos();
        return;
      }
    }

    loadingText.textContent = 'Fetching videos...';

    // Fetch all videos
    const fetchRes = await sendMessage({ type: 'FETCH_VIDEOS', channelId });
    if (!fetchRes?.ok) throw new Error(fetchRes?.error || 'Failed to fetch videos');

    allVideos = fetchRes.videos;

    if (allVideos.length === 0) {
      showError('📭', 'No videos found on this channel.');
      return;
    }

    channelNameEl.textContent = `${channelIdentifier} — ${allVideos.length} videos`;
    hide(loadingState);
    show(toolbar);
    show(videoList);
    renderVideos();
  } catch (err) {
    const msg = err.message || '';
    if (msg.includes('NO_API_KEY')) {
      showError('🔑', 'YouTube API key not set. <a href="#" id="openOptions">Open settings</a> to add your key.');
      document.getElementById('openOptions')?.addEventListener('click', (e) => {
        e.preventDefault();
        chrome.runtime.openOptionsPage();
      });
    } else if (msg.includes('CHANNEL_NOT_FOUND')) {
      showError('🔍', 'Channel not found. Check the URL and try again.');
    } else if (msg.includes('quotaExceeded')) {
      const now = new Date();
      const pacificNow = new Date(now.toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }));
      const resetHour = pacificNow.getHours() < 12 ? 'today' : 'tomorrow';
      showError('🚫', `YouTube API quota exceeded. Quota resets at midnight Pacific Time (${resetHour}).<br>Use a different API key in the meantime.`);
    } else {
      showError('❌', `Error: ${escapeHtml(msg)}`);
    }
  }
}

// Listen for progress updates
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'FETCH_PROGRESS') {
    loadingText.textContent = `Fetching videos... ${msg.count} loaded (page ${msg.page})`;
  }
  if (msg.type === 'NLM_PROGRESS') {
    if (msg.phase === 'waiting_login') {
      pushBtn.textContent = 'Waiting for sign-in...';
    } else if (msg.phase === 'login_required') {
      pushBtn.textContent = 'Sign in to NotebookLM first!';
      pushBtn.disabled = false;
      setTimeout(() => {
        pushBtn.textContent = 'Add to NotebookLM';
        pushBtn.disabled = selectedIds.size === 0;
      }, 5000);
    } else if (msg.phase === 'complete') {
      pushBtn.textContent = `Done! ${msg.added} added`;
      pushBtn.disabled = false;
      setTimeout(() => {
        pushBtn.textContent = 'Add to NotebookLM';
        pushBtn.disabled = selectedIds.size === 0;
      }, 3000);
    } else if (msg.phase === 'importing') {
      pushBtn.textContent = `Adding... ${msg.added} / ${msg.total}`;
    }
  }
});

// Boot
init();
