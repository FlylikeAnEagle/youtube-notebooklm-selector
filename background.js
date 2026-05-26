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
    const code = res.status;
    throw new Error(`YT_API_ERROR:${reason}:${code}`);
  }
  return res.json();
}

// ----- channel resolution -----

async function resolveChannelId(raw) {
  if (raw.startsWith('UC') && raw.length === 24) return raw;

  if (raw.startsWith('@')) {
    const data = await ytFetch('channels', { part: 'id', forHandle: raw.slice(1) });
    if (data.items?.[0]) return data.items[0].id;
  }

  try {
    const data = await ytFetch('channels', { part: 'id', id: raw });
    if (data.items?.[0]) return data.items[0].id;
  } catch { /* fallthrough */ }

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
      if (!snip?.resourceId?.videoId) continue;
      // Skip private/deleted videos (YouTube sets generic titles)
      const title = (snip.title || '').trim().toLowerCase();
      if (title === 'deleted video' || title === 'private video') continue;
      // Only include actual videos (not playlists etc.)
      if (snip.resourceId.kind && snip.resourceId.kind !== 'youtube#video') continue;
      videos.push({
        videoId: snip.resourceId.videoId,
        title: snip.title,
        publishedAt: snip.publishedAt,
        thumbnails: snip.thumbnails,
      });
    }
    pageToken = data.nextPageToken;
    page++;
    if (onProgress) onProgress(videos.length, page);
  } while (pageToken);

  return videos;
}

async function fetchVideoStats(videoIds) {
  const stats = new Map();
  for (let i = 0; i < videoIds.length; i += 50) {
    const batch = videoIds.slice(i, i + 50);
    const data = await ytFetch('videos', {
      part: 'statistics,contentDetails',
      id: batch.join(','),
    });
    for (const item of data.items || []) {
      stats.set(item.id, {
        viewCount: parseInt(item.statistics?.viewCount || '0', 10),
        duration: parseIsoDuration(item.contentDetails?.duration || ''),
      });
    }
  }
  return stats;
}

// Parse ISO 8601 duration (PT#H#M#S) to seconds
function parseIsoDuration(iso) {
  if (!iso) return 0;
  const m = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!m) return 0;
  return (parseInt(m[1] || '0', 10) * 3600) + (parseInt(m[2] || '0', 10) * 60) + parseInt(m[3] || '0', 10);
}

// ----- NotebookLM injection (dual-strategy) -----

const NLM_LOG = '[YT→NLM BG]';
const NLM_CHECKPOINT_KEY = 'nlm_import_state';

// --- Checkpoint helpers ---

function nlmGetCheckpoint() {
  return new Promise(resolve => {
    chrome.storage.session.get(NLM_CHECKPOINT_KEY, data => resolve(data[NLM_CHECKPOINT_KEY] || null));
  });
}

function nlmSetCheckpoint(state) {
  return new Promise(resolve => {
    chrome.storage.session.set({ [NLM_CHECKPOINT_KEY]: state }, resolve);
  });
}

function nlmClearCheckpoint() {
  return new Promise(resolve => {
    chrome.storage.session.remove(NLM_CHECKPOINT_KEY, resolve);
  });
}

// --- Tab creation & lifecycle ---

async function pushToNotebookLM(videoUrls) {
  console.log(NLM_LOG, 'pushToNotebookLM called with', videoUrls.length, 'URLs');

  // Always clear any previous checkpoint — each push creates a fresh notebook
  await nlmClearCheckpoint();

  const tab = await chrome.tabs.create({ url: 'https://notebooklm.google.com' });
  console.log(NLM_LOG, 'Tab created:', tab.id);

  await nlmSetCheckpoint({
    tabId: tab.id,
    urls: videoUrls,
    added: 0,
    failed: [],
    phase: 'init',
    notebookUrl: null,
    startedAt: Date.now(),
    apiAvailable: true,
  });

  return waitForTabAndInject(tab.id, videoUrls, 0, true);
}

function waitForTabAndInject(tabId, urls, startIndex, apiAvailable) {
  return new Promise((resolve) => {
    let injected = false;

    const listener = (tid, info, updatedTab) => {
      if (tid !== tabId) return;
      const url = info.url || updatedTab?.url || '';
      console.log(NLM_LOG, 'Tab update:', info.status, url.slice(0, 80));

      if (info.status !== 'complete') return;

      // Detect sign-in page — user not logged into Google/NotebookLM
      if (url.includes('accounts.google.com')) {
        console.log(NLM_LOG, 'Sign-in page detected — waiting for login...');
        chrome.runtime.sendMessage({
          type: 'NLM_PROGRESS',
          added: 0,
          total: urls.length,
          failed: 0,
          phase: 'waiting_login',
        }).catch(() => {});
        return;
      }

      if (!url.includes('notebooklm.google.com')) {
        console.log(NLM_LOG, 'Not on NotebookLM yet, waiting...');
        return;
      }
      if (injected) return;
      injected = true;
      chrome.tabs.onUpdated.removeListener(listener);

      console.log(NLM_LOG, 'NotebookLM page ready. Waiting 3s for Angular...');
      setTimeout(() => {
        injectFullStack(tabId, urls, startIndex, apiAvailable)
          .catch(err => console.error(NLM_LOG, 'Full-stack injection error:', err));
      }, 3000);
    };

    chrome.tabs.onUpdated.addListener(listener);

    // 45s safety timeout — if stuck on sign-in or loading
    setTimeout(() => {
      if (!injected) {
        console.warn(NLM_LOG, '45s timeout — checking tab URL');
        chrome.tabs.onUpdated.removeListener(listener);
        injected = true;
        chrome.tabs.get(tabId).then(tab => {
          if (tab.url?.includes('accounts.google.com')) {
            chrome.runtime.sendMessage({
              type: 'NLM_PROGRESS',
              added: 0,
              total: urls.length,
              failed: urls.length,
              phase: 'login_required',
            }).catch(() => {});
          }
        }).catch(() => {});
        injectFullStack(tabId, urls, startIndex, apiAvailable)
          .catch(err => console.error(NLM_LOG, 'Timeout injection error:', err));
      }
    }, 30000);

    resolve(tabId);
  });
}

async function injectFullStack(tabId, urls, startIndex, apiAvailable) {
  console.log(NLM_LOG, 'injectFullStack tab:', tabId, 'urls:', urls.length, 'start:', startIndex, 'api:', apiAvailable);

  // MAIN world interceptor is now a persistent content script (notebooklm-interceptor.js)
  // injected at document_start via manifest.json — no need to inject via executeScript.

  // Inject orchestrator into ISOLATED world
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: _isolatedOrchestrator,
      args: [urls, startIndex, apiAvailable],
    });
    console.log(NLM_LOG, 'ISOLATED orchestrator injected');
  } catch (err) {
    console.error(NLM_LOG, 'Orchestrator injection failed:', err.message);
    // Last resort: clipboard fallback
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        func: _clipboardFallback,
        args: [urls],
      });
    } catch (e2) {
      console.error(NLM_LOG, 'Clipboard fallback also failed:', e2.message);
      chrome.runtime.sendMessage({ type: 'NOTEBOOKLM_FALLBACK', urls })
        .catch(() => {});
    }
  }
}

// MAIN world interceptor is now notebooklm-interceptor.js (persistent content script)
// Injected at document_start via manifest.json — no executeScript needed.

// --- ISOLATED world orchestrator (has chrome.* APIs) ---

function _isolatedOrchestrator(urls, startIndex, apiAvailable) {
  var MAX_WAIT = 15000;
  var P = '[YT→NLM]';
  var S = 'yt-nlm-ext';

  function log() {
    var args = [P, new Date().toISOString().slice(11, 23)];
    for (var i = 0; i < arguments.length; i++) args.push(arguments[i]);
    console.log.apply(console, args);
  }
  function warn() {
    var args = [P, new Date().toISOString().slice(11, 23)];
    for (var i = 0; i < arguments.length; i++) args.push(arguments[i]);
    console.warn.apply(console, args);
  }

  log('=== ORCHESTRATOR START ===');
  log('URLs:', urls.length, '| Start:', startIndex, '| API available:', apiAvailable);
  log('Page URL:', location.href);

  // ---- State ----
  var state = {
    added: 0,
    failed: [],
    phase: 'bootstrap'
  };

  // ---- DOM Utilities ----

  function sleep(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }

  function waitForElement(selector, timeout) {
    timeout = timeout || MAX_WAIT;
    return new Promise(function(resolve, reject) {
      var el = document.querySelector(selector);
      if (el) { log('Immediate hit:', selector); return resolve(el); }
      var t0 = Date.now();
      var obs = new MutationObserver(function() {
        var el = document.querySelector(selector);
        if (el) { obs.disconnect(); resolve(el); }
      });
      obs.observe(document.body, { childList: true, subtree: true });
      setTimeout(function() { obs.disconnect(); reject(new Error('Timeout: ' + selector)); }, timeout);
    });
  }

  // Multi-strategy button finder: checks textContent AND aria-label
  function findButton(pattern, timeout) {
    timeout = timeout || MAX_WAIT;
    return new Promise(function(resolve, reject) {
      function find() {
        return Array.from(document.querySelectorAll('button, [role="button"]')).find(function(b) {
          return pattern.test(b.textContent || '') || pattern.test(b.getAttribute('aria-label') || '');
        });
      }
      var btn = find();
      if (btn) return resolve(btn);
      var obs = new MutationObserver(function() {
        var btn = find();
        if (btn) { obs.disconnect(); resolve(btn); }
      });
      obs.observe(document.body, { childList: true, subtree: true });
      setTimeout(function() { obs.disconnect(); reject(new Error('Timeout button: ' + pattern)); }, timeout);
    });
  }

  function setAngularValue(el, value) {
    el.focus();
    el.click();
    var desc = Object.getOwnPropertyDescriptor(
      el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype, 'value'
    );
    if (desc && desc.set) { desc.set.call(el, value); }
    else { el.value = value; }
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  // ---- Progress UI ----

  function showToast(message, color) {
    var existing = document.getElementById('yt-nlm-toast');
    if (existing) existing.remove();
    var toast = document.createElement('div');
    toast.id = 'yt-nlm-toast';
    toast.style.cssText =
      'position:fixed;bottom:24px;right:24px;z-index:2147483647;' +
      'background:' + (color || '#1a73e8') + ';color:white;padding:16px 20px;border-radius:8px;' +
      'font-family:Arial,Helvetica,sans-serif;font-size:14px;' +
      'box-shadow:0 4px 12px rgba(0,0,0,0.3);max-width:440px;line-height:1.5;' +
      'display:flex;align-items:center;gap:12px;';
    var text = document.createElement('span');
    text.style.flex = '1';
    text.textContent = message;
    toast.appendChild(text);
    var dismiss = document.createElement('button');
    dismiss.textContent = '\u2715';
    dismiss.style.cssText =
      'background:rgba(255,255,255,0.2);border:none;color:white;' +
      'width:28px;height:28px;border-radius:50%;cursor:pointer;font-size:14px;' +
      'display:flex;align-items:center;justify-content:center;flex-shrink:0;';
    dismiss.onclick = function() { toast.remove(); };
    toast.appendChild(dismiss);
    document.body.appendChild(toast);
  }

  // ---- Clipboard ----

  async function copyUrls(list) {
    try {
      await navigator.clipboard.writeText(list.join('\n'));
      return true;
    } catch (e) {
      try {
        var ta = document.createElement('textarea');
        ta.value = list.join('\n');
        ta.style.cssText = 'position:fixed;left:-9999px';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        ta.remove();
        return true;
      } catch (e2) { return false; }
    }
  }

  // ---- Progress reporting (sends to service worker for storage) ----

  function reportProgress() {
    try {
      chrome.runtime.sendMessage({
        type: 'NLM_IMPORT_PROGRESS',
        urls: urls,
        added: state.added,
        failed: state.failed,
        phase: state.phase,
        notebookUrl: location.href,
        apiAvailable: apiAvailable
      }).catch(function() {});
    } catch (e) {}
  }

  // ---- MAIN world communication ----

  var apiReady = false;
  var captureResolve = null;

  function waitForCapture(timeout) {
    return new Promise(function(resolve) {
      if (apiReady) { resolve(true); return; }
      captureResolve = resolve;
      setTimeout(function() {
        if (captureResolve) { captureResolve = null; resolve(null); }
      }, timeout);
    });
  }

  window.addEventListener('message', function(event) {
    if (!event.data || event.data.source !== S) return;

    if (event.data.type === 'NLM_API_CAPTURED' && event.data.payload && event.data.payload.ready) {
      log('API params captured — ready for replay');
      apiReady = true;
      if (captureResolve) {
        var r = captureResolve;
        captureResolve = null;
        r(true);
      }
    }
  });

  // ---- Dialog detection & management ----

  function isDialogOpen() {
    // The "Websites" button only appears inside the Add Sources dialog
    var btns = document.querySelectorAll('button, [role="button"]');
    for (var i = 0; i < btns.length; i++) {
      var t = (btns[i].textContent || '').trim();
      if (/websites/i.test(t)) return true;
    }
    return false;
  }

  // Check for error messages in the dialog (source limit, invalid URL, etc.)
  function getDialogError() {
    // Look for error/snackbar elements that appear after failed inserts
    var errorEls = document.querySelectorAll('[role="alert"], .error, .snackbar, [class*="error"], [class*="toast"]');
    for (var i = 0; i < errorEls.length; i++) {
      var t = (errorEls[i].textContent || '').trim().toLowerCase();
      if (t.includes('limit') || t.includes('maximum') || t.includes('too many') || t.includes('source')) {
        return t;
      }
    }
    return null;
  }

  async function openAddSourceDialog() {
    if (isDialogOpen()) return;
    log('Opening Add Sources dialog...');
    var addBtn = await findButton(/add.{0,5}source/i, 10000);
    addBtn.click();
    await sleep(2000);
    if (!isDialogOpen()) {
      throw new Error('Add Sources dialog did not open');
    }
    log('Dialog opened');
  }

  // Add multiple URLs in ONE bulk operation (Websites → paste all → Insert)
  async function addBulkUrlsViaDialog(urlList) {
    log('Bulk-adding', urlList.length, 'URLs via dialog');

    // Click "Websites" (or "Website")
    var webBtn = await findButton(/websites/i, 5000);
    log('Clicking "Websites"');
    webBtn.click();
    await sleep(1500);

    // Find URL input — could be textarea or input, with or without placeholder
    var input = document.querySelector('textarea[placeholder*="Paste"]')
      || document.querySelector('textarea')
      || document.querySelector('input[type="url"]')
      || document.querySelector('input[type="text"]');
    if (!input) {
      input = await waitForElement('textarea, input[type="url"], input[type="text"]', 5000);
    }
    log('Found input element:', input.tagName, 'placeholder:', input.placeholder);

    // Enter ALL URLs joined by newlines
    var bulkText = urlList.join('\n');
    setAngularValue(input, bulkText);
    await sleep(1500);

    // Click "Insert"
    var insertBtn = await findButton(/insert/i, 5000);
    log('Clicking "Insert"');
    insertBtn.click();
    await sleep(20000); // Longer processing time for bulk

    log('Bulk insert submitted:', urlList.length, 'URLs');
  }

  // Add a single URL to the already-open dialog (used for retry fallback)
  async function addUrlViaDialog(url) {
    log('Adding single URL via dialog:', url);

    // Click "Websites" (or "Website")
    var webBtn = await findButton(/websites/i, 5000);
    log('Clicking "Websites"');
    webBtn.click();
    await sleep(1500);

    // Find URL input
    var input = document.querySelector('textarea[placeholder*="Paste"]')
      || document.querySelector('textarea')
      || document.querySelector('input[type="url"]')
      || document.querySelector('input[type="text"]');
    if (!input) {
      input = await waitForElement('textarea, input[type="url"], input[type="text"]', 5000);
    }
    log('Found input element:', input.tagName, 'placeholder:', input.placeholder);

    setAngularValue(input, url);
    await sleep(1000);

    var insertBtn = await findButton(/insert/i, 5000);
    log('Clicking "Insert"');
    insertBtn.click();
    await sleep(15000);

    log('URL submitted:', url);
  }

  // ---- API replay for a single URL (via MAIN world fetch) ----

  function replayViaAPI(url, index) {
    return new Promise(function(resolve) {
      if (!apiReady) { resolve(false); return; }

      var responded = false;
      var handler = function(event) {
        if (!event.data || event.data.source !== S || event.data.type !== 'NLM_API_RESPONSE') return;
        if (!event.data.payload || !event.data.payload.__replay) return;
        if (event.data.payload.__index !== index) return;
        if (responded) return;
        responded = true;
        window.removeEventListener('message', handler);
        resolve(event.data.payload.ok);
      };
      window.addEventListener('message', handler);

      // Send replay request to MAIN world with URL and index for correlation
      window.postMessage({ source: S, type: 'NLM_REPLAY_REQUEST', payload: { url: url, index: index } }, '*');

      // 15s timeout
      setTimeout(function() {
        if (!responded) {
          responded = true;
          window.removeEventListener('message', handler);
          resolve(false);
        }
      }, 15000);
    });
  }

  // ---- Dismiss any open dialog ----

  function dismissDialog() {
    try { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); } catch (e) {}
    try {
      var closeBtns = document.querySelectorAll('button[aria-label="Close"], button[aria-label="Cancel"]');
      for (var i = 0; i < closeBtns.length; i++) closeBtns[i].click();
    } catch (e) {}
  }

  // ---- Main flow ----

  async function run() {
    try {
      // ==== Phase 1: Bootstrap ====
      state.phase = 'bootstrap';
      log('Phase 1: Bootstrap — waiting for Angular app...');

      try {
        await waitForElement('button', MAX_WAIT);
        log('App bootstrapped');
      } catch (e) {
        throw new Error('App did not bootstrap (no buttons after ' + MAX_WAIT + 'ms)');
      }

      await sleep(2000);

      // Log DOM diagnostics
      var allBtns = Array.from(document.querySelectorAll('button'));
      log('DOM snapshot —', allBtns.length, 'buttons:',
        allBtns.slice(0, 25).map(function(b) { return '"' + (b.textContent || '').trim().slice(0, 50) + '"'; }));

      // Navigate to notebook if needed
      var onNotebook = /\/notebook\//.test(location.href);
      log('On notebook page?', onNotebook);

      if (!onNotebook) {
        log('Clicking "New notebook"...');
        var newBtn = await findButton(/new notebook/i, 10000);
        newBtn.click();
        var notebookFound = false;
        var t0 = Date.now();
        while (Date.now() - t0 < 15000) {
          if (/\/notebook\//.test(location.href)) { notebookFound = true; break; }
          await sleep(500);
        }
        if (!notebookFound) throw new Error('Notebook page did not load');
        log('Notebook page loaded:', location.href);
        await sleep(3000);
      }

      reportProgress();

      // ==== Phase 2: Import URLs — API-first, DOM fallback ====
      state.phase = 'importing';
      var remaining = urls.slice(startIndex);

      // Check if Add Sources dialog already open (auto-opens on new notebooks)
      var dialogAutoOpened = isDialogOpen();
      log('Add Sources dialog auto-opened?', dialogAutoOpened);

      if (!dialogAutoOpened) {
        await openAddSourceDialog();
      }

      // Strategy: Prime the interceptor by doing ONE URL via DOM,
      // then replay remaining via API. If capture never fires, bulk-paste all.

      log('=== Phase 2A: Priming interceptor with first URL via DOM ===');
      var primed = false;
      var primedUrl = remaining[0];

      if (apiAvailable) {
        // Start listening for API capture while doing DOM automation
        var capturePromise = waitForCapture(15000);

        try {
          await addUrlViaDialog(primedUrl);
          state.added++;
          log('DOM priming OK. Total:', state.added);

          // Wait for API capture (interceptor should have caught the batchexecute call)
          var captured = await capturePromise;
          if (captured) {
            primed = true;
            log('API capture successful — switching to replay mode');
          } else {
            warn('API capture timed out after DOM priming');
          }
        } catch (domErr) {
          warn('DOM priming failed:', domErr.message);
          // Even if DOM failed, check if we got a capture
          var captured = await Promise.race([
            capturePromise,
            new Promise(function(r) { setTimeout(function() { r(null); }, 2000); })
          ]);
          if (captured) { primed = true; state.added++; }
        }
      }

      if (primed) {
        // ==== Phase 2B: API replay for remaining URLs ====
        log('=== Phase 2B: API replay for', remaining.length - 1, 'remaining URLs ===');
        showToast('API mode: adding ' + (remaining.length - 1) + ' sources...', '#4caf50');

        for (var i = 1; i < remaining.length; i++) {
          var idx = i; // for correlation
          log('API replay', i + 1, '/' + remaining.length, remaining[i].slice(0, 60));
          var ok = await replayViaAPI(remaining[i], idx);

          if (ok) {
            state.added++;
            log('API replay OK. Total:', state.added);
          } else {
            warn('API replay FAILED for URL', i + 1);
            state.failed.push(remaining[i]);
          }

          if (i % 5 === 0 || i === remaining.length - 1) {
            showToast('Added ' + state.added + ' of ' + remaining.length + ' sources...', '#1a73e8');
            reportProgress();
          }

          // 2s gap between API calls to avoid rate limiting
          await sleep(2000);
        }

        // Retry failed URLs once via API
        if (state.failed.length > 0 && state.failed.length < remaining.length) {
          log('Retrying', state.failed.length, 'failed URLs via API...');
          var retryList = state.failed.slice();
          state.failed = [];

          for (var r = 0; r < retryList.length; r++) {
            log('Retry API', r + 1, '/', retryList.length, retryList[r].slice(0, 60));
            var ok = await replayViaAPI(retryList[r], 10000 + r);
            if (ok) {
              state.added++;
              log('Retry API OK. Total:', state.added);
            } else {
              warn('Retry API failed:', retryList[r].slice(0, 60));
              state.failed.push(retryList[r]);
            }
            await sleep(500);
          }
          reportProgress();
        }

      } else {
        // ==== Phase 2C: DOM fallback — bulk paste all ====
        log('=== Phase 2C: DOM fallback (bulk paste) for', remaining.length, 'URLs ===');

        if (state.added > 0) {
          // First URL was already attempted via DOM — paste remaining
          remaining = remaining.slice(1);
        }

        if (remaining.length === 0) {
          // Only had 1 URL and it failed via DOM
          state.failed.push(primedUrl);
        } else {
          try {
            // Ensure dialog is open for bulk paste
            if (!isDialogOpen()) await openAddSourceDialog();
            await addBulkUrlsViaDialog(remaining);
            state.added += remaining.length;
            log('Bulk paste complete. Total:', state.added);
          } catch (bulkErr) {
            warn('Bulk paste FAILED:', bulkErr.message, '— one-at-a-time fallback');
            dismissDialog();
            await sleep(2000);

            for (var i = 0; i < remaining.length; i++) {
              try {
                if (!isDialogOpen()) await openAddSourceDialog();
                await addUrlViaDialog(remaining[i]);
                state.added++;
              } catch (err) {
                warn('Single DOM failed:', err.message);
                state.failed.push(remaining[i]);
                dismissDialog();
                await sleep(1000);
              }
              showToast('Added ' + state.added + ' of ' + urls.length + ' sources...', '#1a73e8');
              reportProgress();
              await sleep(1000);
            }
          }
        }
      }

      // ==== Phase 4: Completion ====
      state.phase = 'complete';
      log('=== COMPLETE: Added', state.added, 'of', urls.length, '| Failed:', state.failed.length, '===');
      reportProgress();

      if (state.failed.length === 0) {
        showToast('Successfully added ' + state.added + ' YouTube source(s)!', '#1a73e8');
      } else {
        var copied = await copyUrls(state.failed);
        showToast(
          'Added ' + state.added + ' of ' + urls.length + ' sources. ' +
          state.failed.length + ' failed URL(s) ' + (copied ? 'copied to clipboard.' : '(clipboard copy failed).'),
          '#e8710a'
        );
      }

      // Notify service worker
      try {
        chrome.runtime.sendMessage({
          type: 'NLM_IMPORT_COMPLETE',
          added: state.added,
          failed: state.failed.length,
          total: urls.length
        }).catch(function() {});
      } catch (e) {}

    } catch (err) {
      warn('=== ORCHESTRATOR FAILED ===', err.message);
      warn('Stack:', err.stack);

      // Log DOM diagnostics
      var btns = Array.from(document.querySelectorAll('button'));
      warn('DOM buttons (' + btns.length + '):',
        btns.slice(0, 20).map(function(b) { return '"' + (b.textContent || '').trim().slice(0, 40) + '"'; }));
      warn('Page URL:', location.href);

      // Clipboard fallback
      var copied = await copyUrls(urls);
      if (copied) {
        showToast('Auto-import failed. ' + urls.length + ' URL(s) copied to clipboard.', '#d93025');
      } else {
        showToast('Auto-import failed. Check DevTools console for details.', '#d93025');
      }
    }
  }

  run();
}

// --- Last-resort clipboard fallback ---

function _clipboardFallback(urls) {
  var text = urls.join('\n');
  navigator.clipboard.writeText(text).then(function() {
    console.log('[YT→NLM Fallback]', 'Copied', urls.length, 'URLs');
    var toast = document.createElement('div');
    toast.style.cssText =
      'position:fixed;bottom:24px;right:24px;z-index:2147483647;' +
      'background:#d93025;color:white;padding:16px 20px;border-radius:8px;' +
      'font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;' +
      'box-shadow:0 4px 12px rgba(0,0,0,0.3);max-width:440px;';
    toast.textContent = urls.length + ' YouTube URL(s) copied to clipboard.';
    document.body.appendChild(toast);
    setTimeout(function() { toast.remove(); }, 60000);
  }).catch(function(e) {
    console.error('[YT→NLM Fallback]', 'Clipboard failed:', e);
  });
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
          chrome.runtime.sendMessage({
            type: 'FETCH_PROGRESS',
            count,
            page,
          }).catch(() => {});
        });

        const ids = videos.map(v => v.videoId);
        const stats = await fetchVideoStats(ids);

        const result = videos.map(v => ({
          ...v,
          viewCount: stats.get(v.videoId)?.viewCount || 0,
          duration: stats.get(v.videoId)?.duration || 0,
        }));

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
    console.log(NLM_LOG, 'Received PUSH_NOTEBOOKLM:', msg.urls?.length, 'URLs');
    pushToNotebookLM(msg.urls)
      .then(tabId => {
        console.log(NLM_LOG, 'Tab opened:', tabId);
        sendResponse({ ok: true, tabId });
      })
      .catch(err => {
        console.error(NLM_LOG, 'pushToNotebookLM error:', err);
        sendResponse({ ok: false, error: err.message });
      });
    return true;
  }

  // Open popup window when inline YouTube button is clicked
  if (msg.type === 'OPEN_NLM_POPUP') {
    console.log(NLM_LOG, 'Opening popup window from inline button');
    chrome.windows.create({
      url: chrome.runtime.getURL('popup.html') + '?fromButton=true',
      type: 'popup',
      width: 420,
      height: 650,
    });
    return;
  }

  if (msg.type === 'NLM_IMPORT_PROGRESS') {
    // Store checkpoint on behalf of injected script (chrome.storage not available there)
    const tabId = sender.tab ? sender.tab.id : 0;
    nlmSetCheckpoint({
      tabId: tabId,
      urls: msg.urls,
      added: msg.added,
      failed: msg.failed,
      phase: msg.phase,
      notebookUrl: msg.notebookUrl,
      startedAt: Date.now(),
      apiAvailable: msg.apiAvailable,
    });
    console.log(NLM_LOG, 'Progress:', msg.added, 'added, phase:', msg.phase);
    // Forward to popup
    chrome.runtime.sendMessage({ type: 'NLM_PROGRESS', added: msg.added, total: msg.urls.length, failed: msg.failed.length })
      .catch(() => {});
  }

  if (msg.type === 'NLM_IMPORT_COMPLETE') {
    console.log(NLM_LOG, 'Import complete:', msg.added, 'added,', msg.failed, 'failed, of', msg.total);
    // Forward to popup
    chrome.runtime.sendMessage({ type: 'NLM_PROGRESS', ...msg }).catch(() => {});
    // Clear checkpoint after delay
    setTimeout(() => nlmClearCheckpoint(), 300000);
  }

  if (msg.type === 'NOTEBOOKLM_FALLBACK') {
    console.log(NLM_LOG, 'Forwarding NOTEBOOKLM_FALLBACK to popup');
    chrome.runtime.sendMessage(msg).catch(() => {});
  }

  // Service worker fetch proxy — ISOLATED world sends fetch requests through
  // the background to avoid CORS/credential issues in page-context fetch
  if (msg.type === 'NLM_FETCH_PROXY') {
    const { url, method, headers, body } = msg;
    console.log(NLM_LOG, 'Fetch proxy:', method, url?.substring(0, 100));
    fetch(url, {
      method,
      headers: headers || {},
      body,
      credentials: 'include',
    })
    .then(async (res) => {
      const text = await res.text();
      sendResponse({ ok: res.ok, status: res.status, body: text });
    })
    .catch((err) => {
      sendResponse({ ok: false, error: err.message });
    });
    return true;
  }
});
