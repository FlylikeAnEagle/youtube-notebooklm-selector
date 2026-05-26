/* content.js — Injects inline "NotebookLM" button on YouTube channel pages */

const YT_CHANNEL_REGEX = /^https:\/\/www\.youtube\.com\/(@[\w.-]+|channel\/UC[\w-]{22})/;
const BTN_ID = 'yt-nlm-ext-btn';

function isChannelPage() {
  var p = location.pathname;
  // Channel home, videos, shorts, streams, playlists, community, about
  return /^\/(@[\w.-]+|channel\/UC[\w-]{22})(\/(videos|shorts|streams|playlists|community|featured|about))?\/?$/.test(p);
}

function injectButton() {
  if (document.getElementById(BTN_ID)) return;
  if (!isChannelPage()) return;

  // Find injection point: the row containing Subscribe button
  var subscribeBtn = document.querySelector('#subscribe-button');
  var headerActions = document.querySelector('#header-actions')
    || document.querySelector('ytd-c4-tabbed-header-renderer #actions')
    || document.querySelector('ytd-tabbed-page-header #actions');

  // Try to find any container with the subscribe button as a sibling
  var container = null;
  if (subscribeBtn) {
    container = subscribeBtn.parentElement;
  } else if (headerActions) {
    container = headerActions;
  }

  if (!container) {
    // Fallback: look for the owner row that has subscribe + action buttons
    var ownerRow = document.querySelector('#channel-header #inner-header-container #buttons')
      || document.querySelector('ytd-c4-tabbed-header-renderer #buttons')
      || document.querySelector('#inner-header-container #buttons');
    if (ownerRow) container = ownerRow;
  }

  if (!container) return;

  // Create pill button matching YouTube's style
  var btn = document.createElement('button');
  btn.id = BTN_ID;
  btn.innerHTML = '<span style="margin-right:6px">\uD83D\uDCD3</span>NotebookLM';
  btn.style.cssText =
    'background:rgba(255,255,255,0.1);color:#f1f1f1;border:none;' +
    'border-radius:18px;padding:0 16px;height:36px;font-size:14px;' +
    'font-family:Roboto,Arial,sans-serif;cursor:pointer;margin-left:8px;' +
    'display:inline-flex;align-items:center;white-space:nowrap;' +
    'transition:background 0.2s;';
  btn.onmouseenter = function() { btn.style.background = 'rgba(255,255,255,0.2)'; };
  btn.onmouseleave = function() { btn.style.background = 'rgba(255,255,255,0.1)'; };
  btn.onclick = function() {
    chrome.runtime.sendMessage({ type: 'OPEN_NLM_POPUP' });
  };

  // Insert after subscribe button or at end of container
  if (subscribeBtn && subscribeBtn.nextSibling) {
    container.insertBefore(btn, subscribeBtn.nextSibling);
  } else {
    container.appendChild(btn);
  }
}

function removeButton() {
  var btn = document.getElementById(BTN_ID);
  if (btn) btn.remove();
}

// SPA navigation handling
var lastUrl = location.href;

function onNavigate() {
  if (location.href === lastUrl) return;
  lastUrl = location.href;
  removeButton();
  // Wait for YouTube's SPA to render the new page
  setTimeout(injectButton, 2000);
}

// Use both MutationObserver and popstate for reliability
var navObserver = new MutationObserver(function() {
  // YouTube uses SPA navigation — watch for URL changes via DOM mutations
  if (location.href !== lastUrl) {
    onNavigate();
  }
});

// Initial injection after page load
setTimeout(function() {
  injectButton();
  navObserver.observe(document.body, { childList: true, subtree: true });
}, 2500);
