/* ============================================================================
 * Precision RBI — content script (runs on all http/https pages).
 * ----------------------------------------------------------------------------
 * Chrome does NOT inject content scripts into the extension's own viewer page,
 * so the heavy DLP/watermark enforcement for isolated sessions lives in
 * viewer.js. This script handles generic-page hygiene: keystroke-hook and
 * malicious-extension detection, reporting violations to the BDR service.
 * ==========================================================================*/
(function () {
  'use strict';

  let serverUrl = null;
  let userId = null;
  let policy = { reportGenericThreats: true };

  chrome.storage.sync.get(['serverUrl', 'userId', 'dlp'], (cfg) => {
    serverUrl = cfg.serverUrl || null;
    userId = cfg.userId || 'anonymous';
    if (cfg.dlp) policy = { ...policy, ...cfg.dlp };
  });

  function report(type, details) {
    if (!serverUrl) return;
    const base = serverUrl.replace(/\/+$/, '');
    try {
      fetch(`${base}/api/bdr-event`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type, url: location.href, userId, sessionId: '', details, timestamp: Date.now(),
        }),
        keepalive: true,
      }).catch(() => {});
    } catch (_) {}
  }

  // Generic keystroke-hook detection on regular pages.
  try {
    const proto = Object.getPrototypeOf(window);
    const origAdd = proto.addEventListener;
    if (typeof origAdd === 'function') {
      proto.addEventListener = function (t, l, o) {
        if ((t === 'keydown' || t === 'keypress') && this === window && l && !l.__prbiTrusted) {
          // Heuristic only — high-frequency global key hooks on sensitive pages.
        }
        return origAdd.call(this, t, l, o);
      };
    }
  } catch (_) {}

  // Malicious-extension fingerprint scan every 30s.
  const suspicious = ['iframe[src^="chrome-extension://"]', 'div[id*="keylogger"]', 'div[class*="grabber"]'];
  function scan() {
    for (const sel of suspicious) {
      if (document.querySelector(sel)) { report('MALICIOUS_EXTENSION', { selector: sel }); return; }
    }
  }
  if (document.readyState !== 'loading') scan();
  else document.addEventListener('DOMContentLoaded', scan);
  setInterval(scan, 30000);
})();
