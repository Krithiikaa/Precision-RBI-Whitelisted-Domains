/* ============================================================================
 * Precision RBI — background service worker (Manifest V3)
 * ----------------------------------------------------------------------------
 * Intercepts navigation to whitelisted domains, starts a server-side isolated
 * session, and swaps the tab to the Canvas viewer. Non-whitelisted navigation
 * is never touched. Keep-alive via chrome.alarms. Teardown via tabs.onRemoved.
 * ==========================================================================*/

// ── [SECTION 3] Hardcoded whitelist ────────────────────────────────────────
const RBI_WHITELIST = [
  'precisionit.co.in', 'www.precisionit.co.in',
  'innait.com', 'www.innait.com', 'prism.precisionit.co.in',
  'mail.google.com', 'drive.google.com', 'www.youtube.com', 'youtube.com',
  'sheets.google.com', 'docs.google.com', 'calendar.google.com',
  'slides.google.com', 'forms.google.com', 'meet.google.com',
  'chat.google.com', 'keep.google.com', 'sites.google.com',
  'jamboard.google.com', 'classroom.google.com', 'contacts.google.com',
  'photos.google.com', 'voice.google.com', 'maps.google.com',
  'news.google.com', 'accounts.google.com', 'workspace.google.com',
  'admin.google.com', 'innaitdemo.innait.com'
];
const WHITELIST_SET = new Set(RBI_WHITELIST);

// Admin-managed domains pulled from the server (merged with the built-ins), so
// whitelist edits made in the admin console reflect on the user side.
let dynamicWhitelist = new Set();

// [MATCHING RULE] exact hostname, endsWith('.google.com'), or admin domain
// (exact or a subdomain of it).
function matchesWhitelist(hostname) {
  if (!hostname) return false;
  if (WHITELIST_SET.has(hostname)) return true;
  if (hostname === 'google.com' || hostname.endsWith('.google.com')) return true;
  for (const d of dynamicWhitelist) {
    if (hostname === d || hostname.endsWith('.' + d)) return true;
  }
  return false;
}

// Pull the admin-managed whitelist from the server; cache it for offline use.
async function refreshWhitelist() {
  const base = apiBase();
  if (!base) return;
  try {
    const r = await fetch(`${base}/api/whitelist`, { cache: 'no-store' });
    if (!r.ok) return;
    const data = await r.json();
    if (Array.isArray(data.domains)) {
      dynamicWhitelist = new Set(data.domains.map((d) => String(d).toLowerCase()));
      await chrome.storage.local.set({ whitelistCache: [...dynamicWhitelist] });
    }
  } catch (_) { /* keep cached/default list */ }
}

// ── In-memory state (rehydrated from chrome.storage.session) ───────────────
// tabId -> { sessionId, renderWsUrl, domain, streamMode, startedAt }
let activeSessions = new Map();
let serverUrl = null;
let enabled = true;
let userId = null;

async function loadState() {
  const sync = await chrome.storage.sync.get(['serverUrl', 'enabled', 'userId', 'streamModePref']);
  serverUrl = sync.serverUrl || null;
  enabled = sync.enabled !== false; // default on
  userId = sync.userId;
  if (!userId) {
    userId = 'u_' + Math.random().toString(36).slice(2, 11);
    await chrome.storage.sync.set({ userId });
  }
  const sess = await chrome.storage.session.get(['activeSessions']);
  if (sess.activeSessions) {
    activeSessions = new Map(Object.entries(sess.activeSessions).map(([k, v]) => [Number(k), v]));
  }
  // Restore cached admin whitelist so it applies before the next server refresh.
  if (!dynamicWhitelist.size) {
    const local = await chrome.storage.local.get(['whitelistCache']);
    if (Array.isArray(local.whitelistCache)) dynamicWhitelist = new Set(local.whitelistCache);
  }
}

async function persistSessions() {
  const obj = {};
  for (const [tabId, s] of activeSessions.entries()) obj[tabId] = s;
  await chrome.storage.session.set({ activeSessions: obj });
}

function apiBase() {
  // serverUrl like http://10.225.244.10 ; API + render go through nginx :443.
  if (!serverUrl) return null;
  return serverUrl.replace(/\/+$/, '');
}

// ── Backoff helper ──────────────────────────────────────────────────────────
async function fetchWithBackoff(url, opts, maxRetries = 5) {
  let delay = 1000;
  for (let i = 0; i <= maxRetries; i++) {
    try {
      const r = await fetch(url, opts);
      return r;
    } catch (e) {
      if (i === maxRetries) throw e;
      await new Promise((res) => setTimeout(res, delay));
      delay = Math.min(delay * 2, 30000);
    }
  }
}

// ── End a session on the server (fire-and-forget) ───────────────────────────
async function endSessionRemote(base, sessionId) {
  if (!base || !sessionId) return;
  try {
    await fetch(`${base}/api/end-session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId }),
      keepalive: true,
    });
  } catch (_) {}
}

// ── Start an isolated session for a tab ─────────────────────────────────────
// Each TAB gets its own isolated session (the broker keys reuse by userId:tabId),
// so RBI works across multiple tabs at once instead of every tab sharing — and
// fighting over — a single container/stream.
async function startIsolation(tabId, targetUrl, domain) {
  const base = apiBase();
  if (!base) return;

  // If this tab already had a session for a DIFFERENT domain, retire it first so
  // each top-level navigation opens the correct isolated page.
  const prev = activeSessions.get(tabId);
  if (prev && prev.sessionId && prev.domain !== domain) {
    endSessionRemote(base, prev.sessionId);
    activeSessions.delete(tabId);
    await persistSessions();
  }

  // [STEP A] Show loading page immediately (preempts the original navigation).
  const loadingUrl = chrome.runtime.getURL('loading/loading.html') +
    `?domain=${encodeURIComponent(domain)}`;
  await chrome.tabs.update(tabId, { url: loadingUrl });

  try {
    const resp = await fetchWithBackoff(`${base}/api/start-session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // clientId scopes the session to THIS tab (see broker reuse logic).
      body: JSON.stringify({ userId, clientId: `${userId}:${tabId}`, userIp: '', targetUrl }),
    });

    if (resp.status === 503) {
      const capUrl = chrome.runtime.getURL('loading/loading.html') +
        `?domain=${encodeURIComponent(domain)}&error=capacity`;
      await chrome.tabs.update(tabId, { url: capUrl });
      return;
    }
    if (!resp.ok) {
      const errUrl = chrome.runtime.getURL('loading/loading.html') +
        `?domain=${encodeURIComponent(domain)}&error=server`;
      await chrome.tabs.update(tabId, { url: errUrl });
      return;
    }

    const data = await resp.json();
    const { sessionId, renderWsUrl, streamMode } = data;

    const session = { sessionId, renderWsUrl, streamMode, domain, userId, startedAt: Date.now(), tabId };
    activeSessions.set(tabId, session);
    await persistSessions();

    const viewer = chrome.runtime.getURL('rbi-viewer/viewer.html') +
      `?renderWsUrl=${encodeURIComponent(renderWsUrl)}` +
      `&sessionId=${encodeURIComponent(sessionId)}` +
      `&url=${encodeURIComponent(targetUrl)}` +
      `&streamMode=${encodeURIComponent(streamMode || 'canvas')}`;
    await chrome.tabs.update(tabId, { url: viewer });
  } catch (e) {
    const errUrl = chrome.runtime.getURL('loading/loading.html') +
      `?domain=${encodeURIComponent(domain)}&error=connect`;
    try { await chrome.tabs.update(tabId, { url: errUrl }); } catch (_) {}
  }
}

// ── Navigation interception ─────────────────────────────────────────────────
chrome.webNavigation.onBeforeNavigate.addListener(async (details) => {
  if (details.frameId !== 0) return;        // main frame only
  await loadState();
  if (!enabled || !serverUrl) return;

  let hostname;
  try { hostname = new URL(details.url).hostname; } catch (_) { return; }
  if (!matchesWhitelist(hostname)) return;  // [EXT-01] no match → do nothing

  // Already inside a viewer/loading page? skip.
  if (details.url.startsWith('chrome-extension://')) return;

  startIsolation(details.tabId, details.url, hostname);
});

// ── Teardown PATH 1: tab removed ────────────────────────────────────────────
chrome.tabs.onRemoved.addListener(async (tabId) => {
  const s = activeSessions.get(tabId);
  if (!s) return;
  activeSessions.delete(tabId);
  await persistSessions();
  const base = apiBase();
  if (!base) return;
  // Only end the session if no other tab uses it (multi-tab reuse).
  const stillUsed = [...activeSessions.values()].some((x) => x.sessionId === s.sessionId);
  if (stillUsed) return;
  try {
    await fetch(`${base}/api/end-session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: s.sessionId }),
    });
  } catch (_) {}
});

// ── Keep-alive PATH 2: heartbeat alarm ──────────────────────────────────────
chrome.alarms.create('heartbeat', { periodInMinutes: 0.4 });
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== 'heartbeat') return;
  await loadState();
  const base = apiBase();
  if (!base) return;
  await refreshWhitelist(); // keep admin whitelist edits in sync
  const sent = new Set();
  for (const s of activeSessions.values()) {
    if (sent.has(s.sessionId)) continue;
    sent.add(s.sessionId);
    try {
      await fetch(`${base}/api/heartbeat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: s.sessionId }),
      });
    } catch (_) {}
  }
});

// ── Messages from popup / viewer ────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    await loadState();
    if (msg.type === 'GET_STATE') {
      sendResponse({
        enabled, serverUrl, userId,
        sessions: [...activeSessions.values()],
      });
    } else if (msg.type === 'TOGGLE_ENABLED') {
      enabled = !!msg.enabled;
      await chrome.storage.sync.set({ enabled });
      sendResponse({ enabled });
    } else if (msg.type === 'OPEN_CURRENT_IN_RBI') {
      // Manual trigger for any URL.
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab && tab.url) {
        let host = '';
        try { host = new URL(tab.url).hostname; } catch (_) {}
        startIsolation(tab.id, tab.url, host || 'page');
      }
      sendResponse({ ok: true });
    } else if (msg.type === 'CLOSE_SESSION') {
      const base = apiBase();
      if (base && msg.sessionId) {
        try {
          await fetch(`${base}/api/end-session`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sessionId: msg.sessionId }),
          });
        } catch (_) {}
      }
      for (const [tabId, s] of activeSessions.entries()) {
        if (s.sessionId === msg.sessionId) { activeSessions.delete(tabId); try { await chrome.tabs.remove(tabId); } catch (_) {} }
      }
      await persistSessions();
      sendResponse({ ok: true });
    } else if (msg.type === 'SESSION_READY_POLL') {
      // loading.html polls here to learn the viewer URL once ready.
      const s = [...activeSessions.values()].find((x) => x.domain === msg.domain);
      sendResponse({ session: s || null });
    }
  })();
  return true; // async
});

// ── onInstalled: prompt for server config if unset ──────────────────────────
chrome.runtime.onInstalled.addListener(async () => {
  await loadState();
  if (!serverUrl) {
    chrome.action.setBadgeText({ text: '!' });
    chrome.action.setBadgeBackgroundColor({ color: '#D85A30' });
  }
});

// Initial load + first whitelist sync.
loadState().then(refreshWhitelist);
