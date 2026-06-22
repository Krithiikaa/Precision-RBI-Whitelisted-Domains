'use strict';

const $ = (id) => document.getElementById(id);
let state = null;

function send(msg) { return new Promise((res) => chrome.runtime.sendMessage(msg, res)); }

function fmtElapsed(ms) {
  const s = Math.floor(ms / 1000), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
  return [h, m, ss].map((x) => String(x).padStart(2, '0')).join(':');
}

async function refresh() {
  state = await send({ type: 'GET_STATE' });
  if (!state) return;

  // Toggle
  $('enabledToggle').checked = state.enabled;
  $('enabledSub').textContent = state.enabled ? 'Intercepting sensitive domains' : 'Interception paused';
  $('statusDot').className = 'dot ' + (state.serverUrl ? (state.enabled ? 'dot-green' : 'dot-amber') : 'dot-red');

  // Server hint
  $('serverHint').style.display = state.serverUrl ? 'none' : 'flex';

  // Sessions list
  const list = $('sessionList');
  list.innerHTML = '';
  const seen = new Set();
  const sessions = (state.sessions || []).filter((s) => { if (seen.has(s.sessionId)) return false; seen.add(s.sessionId); return true; });
  $('noSessions').style.display = sessions.length ? 'none' : 'block';
  for (const s of sessions) {
    const li = document.createElement('li');
    li.className = 'session-item';
    const mode = (s.streamMode === 'webrtc') ? 'pill pill-webrtc' : 'pill';
    li.innerHTML = `<div><div class="session-domain">${s.domain || '—'}</div>
      <div class="session-meta"><span class="${mode}">${s.streamMode === 'webrtc' ? 'WebRTC' : 'Canvas'}</span>
      <span>${fmtElapsed(Date.now() - (s.startedAt || Date.now()))}</span></div></div>`;
    const btn = document.createElement('button');
    btn.className = 'close-btn'; btn.textContent = 'Close';
    btn.onclick = async () => { await send({ type: 'CLOSE_SESSION', sessionId: s.sessionId }); refresh(); };
    li.appendChild(btn);
    list.appendChild(li);
  }

  // Current tab whitelist check
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  let host = '';
  try { host = new URL(tab.url).hostname; } catch (_) {}
  $('curDomain').textContent = host || '(no page)';
  const protectedDomain = isWhitelisted(host);
  $('shield').className = 'shield ' + (protectedDomain ? 'shield-green' : 'shield-gray');
  $('curState').textContent = protectedDomain ? 'Protected — will isolate' : 'Normal browsing';

  // Ping + count
  pingServer();
  fetchCount();
}

const WHITELIST = new Set(['precisionit.co.in','www.precisionit.co.in','innait.com','www.innait.com', 'innaitdemo.innait.com',
  'prism.precisionit.co.in','mail.google.com','drive.google.com','www.youtube.com','youtube.com',
  'sheets.google.com','docs.google.com','calendar.google.com','slides.google.com','forms.google.com',
  'meet.google.com','chat.google.com','keep.google.com','sites.google.com','jamboard.google.com',
  'classroom.google.com','contacts.google.com','photos.google.com','voice.google.com','maps.google.com',
  'news.google.com','accounts.google.com','workspace.google.com','admin.google.com']);
function isWhitelisted(h) { return h && (WHITELIST.has(h) || h === 'google.com' || h.endsWith('.google.com')); }

async function pingServer() {
  if (!state || !state.serverUrl) { $('pingBadge').textContent = 'no server'; $('pingBadge').className = 'badge badge-red'; return; }
  const base = state.serverUrl.replace(/\/+$/, '');
  const t0 = performance.now();
  try {
    const r = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(4000) });
    if (!r.ok) throw new Error();
    const ms = Math.round(performance.now() - t0);
    $('pingBadge').textContent = ms + ' ms';
    $('pingBadge').className = 'badge badge-green';
  } catch (_) {
    $('pingBadge').textContent = 'offline';
    $('pingBadge').className = 'badge badge-red';
  }
}

async function fetchCount() {
  if (!state || !state.serverUrl) return;
  const base = state.serverUrl.replace(/\/+$/, '');
  try {
    const r = await fetch(`${base}/api/sessions/count`, { signal: AbortSignal.timeout(4000) });
    const d = await r.json();
    $('sessCount').textContent = `${d.count} / ${d.max}`;
  } catch (_) { $('sessCount').textContent = '— / —'; }
}

$('enabledToggle').addEventListener('change', async (e) => {
  await send({ type: 'TOGGLE_ENABLED', enabled: e.target.checked });
  refresh();
});
$('openRbi').addEventListener('click', async () => { await send({ type: 'OPEN_CURRENT_IN_RBI' }); window.close(); });
$('gear').addEventListener('click', () => chrome.runtime.openOptionsPage());
$('openOptions').addEventListener('click', (e) => { e.preventDefault(); chrome.runtime.openOptionsPage(); });

refresh();
setInterval(() => { pingServer(); fetchCount(); }, 5000);
