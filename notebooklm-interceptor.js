/* notebooklm-interceptor.js
 * Persistent MAIN world content script — injected at document_start
 * before NotebookLM's Angular app loads. No chrome.* APIs available.
 *
 * Patches window.fetch and XMLHttpRequest to capture batchexecute
 * calls (rpcids=izAoDd) and replay them with URL substitution.
 */

if (!window.__nlmInterceptorInstalled) {
  window.__nlmInterceptorInstalled = true;

  var S = 'yt-nlm-ext';

  // ---- Captured state ----

  window.__nlmApiState = {
    at: null,
    bl: null,
    fsid: null,
    sourcePath: null,
    notebookId: null,
    reqid: 100000 + Math.floor(Math.random() * 100000),
    captured: false
  };

  // Guard: prevent interceptors from capturing replay requests
  window.__nlmReplayInProgress = false;

  // The EXACT captured request — headers, body, URL — for verbatim replay
  window.__nlmCaptured = {
    url: null,           // full URL from XHR open()
    headers: {},         // all headers from setRequestHeader()
    body: null,          // raw body string from send()
    origUrl: null         // the YouTube URL found in the body
  };

  console.log('[' + S + ']', 'Interceptor installed at document_start');

  // ---- Helpers ----

  function extractParams(url) {
    try {
      var fullUrl = url;
      if (url.charAt(0) === '/') fullUrl = 'https://notebooklm.google.com' + url;
      var u = new URL(fullUrl);
      var p = u.searchParams;
      var st = window.__nlmApiState;

      if (u.pathname.indexOf('batchexecute') === -1 && !p.get('rpcids')) return;

      if (p.get('bl')) st.bl = p.get('bl');
      if (p.get('f.sid')) st.fsid = p.get('f.sid');

      var sp = p.get('source-path');
      if (sp) {
        st.sourcePath = sp;
        var m = sp.match(/\/notebook\/([a-f0-9-]+)/);
        if (m) st.notebookId = m[1];
      }

      if (!st.notebookId) {
        var nm = u.href.match(/\/notebook\/([a-f0-9-]+)/);
        if (nm) st.notebookId = nm[1];
      }
      if (!st.notebookId) {
        try {
          var lm = location.pathname.match(/\/notebook\/([a-f0-9-]+)/);
          if (lm) st.notebookId = lm[1];
        } catch (e) {}
      }

      if (st.bl && st.fsid && st.sourcePath) {
        st.captured = true;
        console.log('[' + S + ']', 'Params — bl:', st.bl, 'fsid:', st.fsid.length, 'chars', 'sourcePath:', st.sourcePath);
      }
    } catch (e) {}
  }

  function extractAtFromResponse(text) {
    if (!text) return;
    var m = text.match(/"SNlM0e","([^"]+)"/);
    if (m) { window.__nlmApiState.at = m[1]; return; }
    m = text.match(/\]"([^"]{20,})"/);
    if (m) window.__nlmApiState.at = m[1];
  }

  function extractAtFromBody(bodyStr) {
    if (!bodyStr) return;
    var m = bodyStr.match(/at=([^&]+)/);
    if (m) window.__nlmApiState.at = m[1];
  }

  function notifyCapture() {
    var st = window.__nlmApiState;
    if (st.captured && st.at) {
      window.postMessage({ source: S, type: 'NLM_API_CAPTURED', payload: { ready: true } }, '*');
    }
  }

  // ---- XHR header capture ----

  var origOpen = XMLHttpRequest.prototype.open;
  var origSetHeader = XMLHttpRequest.prototype.setRequestHeader;
  var origSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function(method, url) {
    this.__nlmMethod = method;
    this.__nlmUrl = url;
    this.__nlmHeaders = {};  // fresh headers dict per XHR

    if (typeof method === 'string' && method.toUpperCase() === 'POST' && typeof url === 'string') {
      if (url.indexOf('rpcids=izAoDd') !== -1) {
        console.log('[' + S + '] XHR open izAoDd:', url.substring(0, 120));
        extractParams(url);
      }
    }
    return origOpen.apply(this, arguments);
  };

  XMLHttpRequest.prototype.setRequestHeader = function(name, value) {
    // Capture ALL headers for izAoDd requests
    if (this.__nlmHeaders && this.__nlmUrl && this.__nlmUrl.indexOf('rpcids=izAoDd') !== -1) {
      this.__nlmHeaders[name] = value;
    }
    return origSetHeader.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function(body) {
    var xhr = this;
    var method = (xhr.__nlmMethod || 'GET').toUpperCase();
    var url = xhr.__nlmUrl || '';

    if (method === 'POST' && url.indexOf('rpcids=izAoDd') !== -1 && body) {
      // Skip capture during replay — don't overwrite the original
      if (window.__nlmReplayInProgress) {
        return origSend.apply(this, arguments);
      }
      var bodyStr = typeof body === 'string' ? body : '';

      // Extract at from body
      extractAtFromBody(bodyStr);

      // Extract video ID from body — try URL-encoded form first, then plain
      // Body contains: ...watch%3Fv%3DVIDEO_ID... or ...watch?v=VIDEO_ID...
      var vidMatch = bodyStr.match(/watch%3Fv%3D([a-zA-Z0-9_-]{11})/);
      var origVideoId = vidMatch ? vidMatch[1] : null;
      if (!origVideoId) {
        vidMatch = bodyStr.match(/watch\?v=([a-zA-Z0-9_-]{11})/);
        origVideoId = vidMatch ? vidMatch[1] : null;
      }

      // Store EVERYTHING verbatim
      window.__nlmCaptured = {
        url: url,
        headers: xhr.__nlmHeaders || {},
        body: bodyStr,
        origVideoId: origVideoId,
        origUrl: origVideoId ? ('https://www.youtube.com/watch?v=' + origVideoId) : null
      };

      console.log('[' + S + '] *** izAoDd CAPTURED ***');
      console.log('[' + S + ']   URL:', url.substring(0, 150));
      console.log('[' + S + ']   Headers:', JSON.stringify(xhr.__nlmHeaders));
      console.log('[' + S + ']   Body length:', bodyStr.length, 'bytes');
      console.log('[' + S + ']   origVideoId:', origVideoId);
      console.log('[' + S + ']   origUrl:', window.__nlmCaptured.origUrl);

      notifyCapture();

      xhr.addEventListener('load', function() {
        extractAtFromResponse(xhr.responseText);
        notifyCapture();
      });
    }

    return origSend.apply(this, arguments);
  };

  // ---- Monkey-patch fetch (for non-izAoDd NLM requests + param capture) ----

  var originalFetch = window.fetch;

  window.fetch = function() {
    var args = Array.prototype.slice.call(arguments);
    var input = args[0];
    var init = args[1] || {};
    var url = typeof input === 'string' ? input : (input && input.url ? input.url : '');
    var method = (init.method || 'GET').toUpperCase();

    if (method === 'POST' && url.indexOf('notebooklm') !== -1) {
      console.log('[' + S + '] Fetch POST:', url.substring(0, 120));
    }

    // Also capture izAoDd if it comes via fetch (not just XHR)
    if (method === 'POST' && url.indexOf('rpcids=izAoDd') !== -1) {
      // Skip capture during replay
      if (window.__nlmReplayInProgress) {
        return originalFetch.apply(this, args);
      }
      console.log('[' + S + '] *** izAoDd via FETCH intercepted! ***');
      extractParams(url);
      var bodyStr = typeof init.body === 'string' ? init.body : '';
      extractAtFromBody(bodyStr);
      var vidMatch = bodyStr.match(/watch%3Fv%3D([a-zA-Z0-9_-]{11})/);
      var origVideoId = vidMatch ? vidMatch[1] : null;
      if (!origVideoId) {
        vidMatch = bodyStr.match(/watch\?v=([a-zA-Z0-9_-]{11})/);
        origVideoId = vidMatch ? vidMatch[1] : null;
      }
      window.__nlmCaptured = {
        url: url,
        headers: {},
        body: bodyStr,
        origVideoId: origVideoId,
        origUrl: origVideoId ? ('https://www.youtube.com/watch?v=' + origVideoId) : null
      };
      console.log('[' + S + '] Captured via fetch — origVideoId:', origVideoId, 'body length:', bodyStr.length);
      notifyCapture();
    }

    return originalFetch.apply(this, args).then(function(response) {
      if (method === 'POST' && url.indexOf('notebooklm') !== -1) {
        try {
          var clone = response.clone();
          clone.text().then(function(text) {
            extractAtFromResponse(text);
            if (url.indexOf('rpcids=izAoDd') !== -1) notifyCapture();
          }).catch(function() {});
        } catch (e) {}
      }
      return response;
    });
  };

  // ---- Build replay URL ----

  function buildReplayUrl() {
    var st = window.__nlmApiState;
    var hl = 'en';
    try { hl = (navigator.language || 'en').split('-')[0]; } catch (e) {}
    st.reqid += 300;
    return 'https://notebooklm.google.com' +
      '/_/LabsTailwindUi/data/batchexecute' +
      '?rpcids=izAoDd' +
      '&source-path=' + encodeURIComponent(st.sourcePath || '') +
      '&f.sid=' + st.fsid +
      '&bl=' + st.bl +
      '&hl=' + hl +
      '&rt=c' +
      '&_reqid=' + st.reqid;
  }

  // ---- Listen for replay requests from ISOLATED world ----

  window.addEventListener('message', function(event) {
    if (!event.data || event.data.source !== S || event.data.type !== 'NLM_REPLAY_REQUEST') return;

    var ytUrl = event.data.payload.url;
    var reqIndex = event.data.payload.index || 0;
    var st = window.__nlmApiState;
    var cap = window.__nlmCaptured;

    console.log('[' + S + '] ======== REPLAY #' + reqIndex + ' ========');
    console.log('[' + S + '] Target URL:', ytUrl);

    if (!cap || !cap.body) {
      console.warn('[' + S + '] No captured body — cannot replay');
      window.postMessage({ source: S, type: 'NLM_API_RESPONSE', payload: { ok: false, error: 'No captured body', __replay: true, __index: reqIndex } }, '*');
      return;
    }

    if (!st.fsid || !st.sourcePath) {
      console.warn('[' + S + '] Missing params — fsid:', !!st.fsid, 'sourcePath:', !!st.sourcePath);
      window.postMessage({ source: S, type: 'NLM_API_RESPONSE', payload: { ok: false, error: 'Missing params', __replay: true, __index: reqIndex } }, '*');
      return;
    }

    // === STEP 1: Build replay URL ===
    var replayUrl = buildReplayUrl();

    // === STEP 2: Build replay body — substitute video ID ===
    // The body is URL-encoded form data. The VIDEO_ID is alphanumeric
    // and identical at every encoding level — safe to replace directly.
    var replayBody = cap.body;
    var origVidId = cap.origVideoId;
    var newVidMatch = ytUrl.match(/v=([a-zA-Z0-9_-]{11})/);
    var newVidId = newVidMatch ? newVidMatch[1] : null;

    if (origVidId && newVidId && origVidId !== newVidId) {
      var parts = replayBody.split(origVidId);
      replayBody = parts.join(newVidId);
      console.log('[' + S + '] Substituted video ID:', origVidId, '->', newVidId, '(' + (parts.length - 1) + ' occurrences)');
    } else if (!origVidId) {
      console.warn('[' + S + '] No origVideoId in captured body — sending as-is (will repeat priming URL!)');
    } else if (origVidId === newVidId) {
      console.log('[' + S + '] Same video ID as priming — skipping substitution');
    } else {
      console.warn('[' + S + '] Cannot extract new video ID from:', ytUrl);
    }

    // Replace the at= token with fresh value (raw, no re-encoding)
    if (st.at) {
      replayBody = replayBody.replace(/at=([^&]+)/, 'at=' + st.at);
    }

    // === STEP 3: Diagnostic logging — FULL request ===
    console.log('[' + S + '] --- REPLAY REQUEST ---');
    console.log('[' + S + '] URL:', replayUrl);
    console.log('[' + S + '] Headers:', JSON.stringify(cap.headers));
    console.log('[' + S + '] Body length:', replayBody.length, 'bytes');
    // Decode f.req for comparison
    var freqMatch = replayBody.match(/f\.req=([^&]+)/);
    if (freqMatch) {
      console.log('[' + S + '] f.req decoded:', decodeURIComponent(freqMatch[1]).substring(0, 400));
    }
    console.log('[' + S + '] at token:', (replayBody.match(/at=([^&]+)/) || [])[1]);

    // Side-by-side comparison
    console.log('[' + S + '] ORIGINAL body (first 200):', cap.body.substring(0, 200));
    console.log('[' + S + '] REPLAY   body (first 200):', replayBody.substring(0, 200));

    // === STEP 4: Replay via XMLHttpRequest (same as original) ===
    var xhr = new XMLHttpRequest();
    xhr.open('POST', replayUrl);

    // Set ALL captured headers exactly
    var headerKeys = Object.keys(cap.headers);
    for (var h = 0; h < headerKeys.length; h++) {
      try {
        xhr.setRequestHeader(headerKeys[h], cap.headers[headerKeys[h]]);
      } catch (e) {
        console.warn('[' + S + '] Could not set header:', headerKeys[h], e.message);
      }
    }

    // Set guard before sending — prevents interceptors from overwriting __nlmCaptured
    window.__nlmReplayInProgress = true;

    xhr.onload = function() {
      window.__nlmReplayInProgress = false;
      var ok = xhr.status >= 200 && xhr.status < 300;
      var text = xhr.responseText || '';

      console.log('[' + S + '] Replay XHR response:', xhr.status, ok ? 'OK' : 'FAIL');
      console.log('[' + S + '] Response (first 300):', text.substring(0, 300));

      extractAtFromResponse(text);

      // Trust the HTTP status — 200 = success, non-200 = failure
      window.postMessage({
        source: S,
        type: 'NLM_API_RESPONSE',
        payload: { ok: ok, status: xhr.status, confirmed: ok, body: text.slice(0, 2000), __replay: true, __index: reqIndex }
      }, '*');
    };

    xhr.onerror = function() {
      window.__nlmReplayInProgress = false;
      console.warn('[' + S + '] Replay XHR error');
      window.postMessage({ source: S, type: 'NLM_API_RESPONSE', payload: { ok: false, error: 'XHR error', __replay: true, __index: reqIndex } }, '*');
    };

    xhr.send(replayBody);
  });

  // ---- Extract from page globals after DOM is ready ----
  function extractFromPageGlobals() {
    var st = window.__nlmApiState;
    try {
      if (!st.fsid && window.WIZ_global_data) {
        st.fsid = window.WIZ_global_data.FdrFJe || window.WIZ_global_data.fSid || null;
      }
      if (!st.at && window.WIZ_global_data) {
        st.at = window.WIZ_global_data.SNlM0e || null;
      }
    } catch (e) {}
    if (!st.notebookId) {
      try {
        var m = location.pathname.match(/\/notebook\/([a-f0-9-]+)/);
        if (m) { st.notebookId = m[1]; st.sourcePath = '/notebook/' + m[1]; }
      } catch (e) {}
    }
    if (!st.bl) {
      try {
        var scripts = document.querySelectorAll('script');
        for (var i = 0; i < scripts.length; i++) {
          var t = scripts[i].textContent || '';
          var m = t.match(/boq_labs-tailwind-frontend_[\w.]+/);
          if (m) { st.bl = m[0]; break; }
        }
      } catch (e) {}
    }
    if (st.bl && st.fsid && st.sourcePath && !st.captured) {
      st.captured = true;
      console.log('[' + S + '] Params from page globals — bl:', st.bl, 'fsid:', st.fsid?.length, 'chars');
    }
    if (st.captured && st.at) notifyCapture();
  }

  extractFromPageGlobals();
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function() {
      setTimeout(extractFromPageGlobals, 500);
      setTimeout(extractFromPageGlobals, 3000);
    });
  } else {
    setTimeout(extractFromPageGlobals, 500);
    setTimeout(extractFromPageGlobals, 3000);
  }
}
