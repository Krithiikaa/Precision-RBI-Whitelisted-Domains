'use strict';
// Manifest V3 forbids inline <script>; this is loaded via <script src>.
const params = new URLSearchParams(location.search);
const domain = params.get('domain') || 'this site';
const error  = params.get('error');

document.getElementById('domainLabel').textContent = domain;

const loadingView = document.getElementById('loadingView');
const errorView   = document.getElementById('errorView');
const errIcon     = document.getElementById('errIcon');
const errTitle    = document.getElementById('errTitle');
const errSub      = document.getElementById('errSub');

function showError(kind) {
  loadingView.classList.add('hidden');
  errorView.classList.remove('hidden');
  if (kind === 'capacity') {
    errIcon.classList.add('icon-warn');
    errIcon.textContent = '⏳';
    errTitle.textContent = 'Server is at capacity';
    errSub.textContent = 'All isolated browser slots are in use. Please try again in a moment.';
  } else if (kind === 'server') {
    errTitle.textContent = 'Security server error';
    errSub.textContent = 'The server could not start an isolated session. Contact your IT administrator if this persists.';
  } else {
    errTitle.textContent = 'Cannot reach security server';
    errSub.textContent = 'Check that the server is running and the Server URL is set correctly in the extension options.';
  }
}

document.getElementById('retryBtn').addEventListener('click', () => {
  // Re-navigate to the original domain; the background worker re-intercepts.
  location.href = 'https://' + domain;
});

if (error) {
  showError(error);
} else {
  // Poll the background worker; it redirects this tab to viewer.html once the
  // session is ready. Polling is a safety net in case that redirect is missed.
  let attempts = 0;
  const poll = setInterval(() => {
    attempts += 1;
    try {
      chrome.runtime.sendMessage({ type: 'SESSION_READY_POLL', domain }, (resp) => {
        if (chrome.runtime.lastError) return;
        if (resp && resp.session && resp.session.renderWsUrl) {
          clearInterval(poll);
          const s = resp.session;
          const viewer = chrome.runtime.getURL('rbi-viewer/viewer.html') +
            `?renderWsUrl=${encodeURIComponent(s.renderWsUrl)}` +
            `&sessionId=${encodeURIComponent(s.sessionId)}` +
            `&url=${encodeURIComponent('https://' + domain)}` +
            `&streamMode=${encodeURIComponent(s.streamMode || 'canvas')}`;
          location.href = viewer;
        }
      });
    } catch (_) {}
    // ~55s — must exceed the broker's 45s readiness timeout so a slow-but-OK
    // start under load isn't shown as an error while the broker is still working.
    if (attempts > 110) { clearInterval(poll); showError('server'); }
  }, 500);
}
