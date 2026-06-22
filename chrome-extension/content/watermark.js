/* ============================================================================
 * Precision RBI — watermark + DLP enforcement module.
 * Loaded directly by the viewer page (viewer.html) and exposed as
 * window.PrecisionRBI so both the viewer and the content script can call it.
 * ==========================================================================*/
(function () {
  'use strict';
  if (window.PrecisionRBI) return;

  const NS = {};

  // ── Watermark overlay ─────────────────────────────────────────────────────
  NS.injectWatermark = function (username) {
    if (document.getElementById('prbi-watermark')) return;
    const wm = document.createElement('div');
    wm.id = 'prbi-watermark';
    Object.assign(wm.style, {
      position: 'fixed', inset: '0', pointerEvents: 'none', zIndex: '2147483646',
      display: 'flex', flexWrap: 'wrap', alignContent: 'flex-start',
      opacity: '0.10', overflow: 'hidden', userSelect: 'none',
    });
    const label = `PRECISION RBI — CONFIDENTIAL · ${username || 'user'} · `;
    for (let i = 0; i < 60; i++) {
      const t = document.createElement('div');
      t.textContent = label + new Date().toLocaleString();
      Object.assign(t.style, {
        transform: 'rotate(-30deg)', whiteSpace: 'nowrap',
        margin: '40px', fontSize: '14px', fontFamily: 'monospace', color: '#7AC943',
      });
      wm.appendChild(t);
    }
    document.documentElement.appendChild(wm);
    // Refresh timestamp every 30s.
    setInterval(() => {
      [...wm.children].forEach((c) => { c.textContent = label + new Date().toLocaleString(); });
    }, 30000);
  };

  // ── Clipboard block ───────────────────────────────────────────────────────
  NS.installClipboardBlock = function (report) {
    const block = (e) => {
      e.preventDefault();
      e.stopPropagation();
      report('CLIPBOARD_ATTEMPT', { event: e.type });
      return false;
    };
    ['copy', 'cut', 'paste'].forEach((ev) => document.addEventListener(ev, block, true));
  };

  // ── Screenshot prevention (poison getImageData on captured canvases) ──────
  NS.installScreenshotBlock = function (report, exemptCanvas) {
    const proto = HTMLCanvasElement.prototype;
    const origGetCtx = proto.getContext;
    const origToDataURL = proto.toDataURL;
    const origToBlob = proto.toBlob;

    // Poison readback on any canvas EXCEPT the live stream canvas.
    const orig2dGetImageData = CanvasRenderingContext2D.prototype.getImageData;
    CanvasRenderingContext2D.prototype.getImageData = function (...args) {
      if (this.canvas === exemptCanvas) return orig2dGetImageData.apply(this, args);
      report('SCREENSHOT_ATTEMPT', { method: 'getImageData' });
      const data = orig2dGetImageData.apply(this, args);
      for (let i = 0; i < data.data.length; i++) data.data[i] = (Math.random() * 256) | 0;
      return data;
    };
    proto.toDataURL = function (...args) {
      if (this === exemptCanvas) return origToDataURL.apply(this, args);
      report('SCREENSHOT_ATTEMPT', { method: 'toDataURL' });
      return 'data:image/png;base64,'; // empty
    };
    proto.toBlob = function (cb, ...args) {
      if (this === exemptCanvas) return origToBlob.apply(this, [cb, ...args]);
      report('SCREENSHOT_ATTEMPT', { method: 'toBlob' });
      return cb && cb(new Blob());
    };
    void origGetCtx; // referenced for clarity
  };

  // ── Keystroke-hook detection on window.__proto__ ──────────────────────────
  NS.installKeystrokeHookDetection = function (report) {
    try {
      const proto = Object.getPrototypeOf(window);
      const origAdd = proto.addEventListener;
      if (typeof origAdd === 'function') {
        proto.addEventListener = function (type, listener, opts) {
          if ((type === 'keydown' || type === 'keypress' || type === 'keyup') &&
              this === window && listener && !listener.__prbiTrusted) {
            report('KEYSTROKE_HOOK', { type });
          }
          return origAdd.call(this, type, listener, opts);
        };
      }
    } catch (_) { /* sealed */ }
  };

  // ── Malicious-extension DOM fingerprint scan ──────────────────────────────
  NS.startExtensionScan = function (report) {
    const suspiciousSelectors = [
      'iframe[src^="chrome-extension://"]',
      'div[id*="keylogger"]', 'div[class*="grabber"]',
      'script[src*="inject"][data-ext]',
    ];
    const scan = () => {
      for (const sel of suspiciousSelectors) {
        if (document.querySelector(sel)) {
          report('MALICIOUS_EXTENSION', { selector: sel });
          break;
        }
      }
    };
    scan();
    setInterval(scan, 30000);
  };

  window.PrecisionRBI = NS;
})();
