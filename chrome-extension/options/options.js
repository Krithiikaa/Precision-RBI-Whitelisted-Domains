'use strict';

const WHITELIST = ['precisionit.co.in', 'www.precisionit.co.in', 'innait.com', 'www.innait.com',
  'prism.precisionit.co.in', 'mail.google.com', 'innaitdemo.innait.com', 'drive.google.com', 'www.youtube.com', 'youtube.com',
  'sheets.google.com', 'docs.google.com', 'calendar.google.com', 'slides.google.com', 'forms.google.com',
  'meet.google.com', 'chat.google.com', 'keep.google.com', 'sites.google.com', 'jamboard.google.com',
  'classroom.google.com', 'contacts.google.com', 'photos.google.com', 'voice.google.com', 'maps.google.com',
  'news.google.com', 'accounts.google.com', 'workspace.google.com', 'admin.google.com', '*.google.com'];

const $ = (id) => document.getElementById(id);

function paintDomains(list) {
  const grid = $('domainGrid');
  grid.innerHTML = '';
  for (const d of list) { const el = document.createElement('div'); el.textContent = d; grid.appendChild(el); }
}

// Show the live whitelist from the server (admin additions included); fall back
// to the built-in list when the server is unreachable.
function renderDomains() {
  paintDomains(WHITELIST);
  chrome.storage.sync.get(['serverUrl'], async (cfg) => {
    const base = (cfg.serverUrl || '').replace(/\/+$/, '');
    if (!base) return;
    try {
      const r = await fetch(`${base}/api/whitelist`, { cache: 'no-store' });
      if (!r.ok) return;
      const data = await r.json();
      if (Array.isArray(data.domains) && data.domains.length) paintDomains(data.domains);
    } catch (_) { /* keep built-in list */ }
  });
}

function load() {
  chrome.storage.sync.get(['serverUrl', 'enabled', 'streamModePref', 'dlp'], (cfg) => {
    $('serverUrl').value = cfg.serverUrl || '';
    $('enabled').checked = cfg.enabled !== false;
    const mode = cfg.streamModePref || 'auto';
    const radio = document.querySelector(`input[name=streamMode][value=${mode}]`);
    if (radio) radio.checked = true;
    const dlp = cfg.dlp || { clipboard: true, downloads: true, watermark: true, screenshot: true };
    $('dlpClipboard').checked = dlp.clipboard !== false;
    $('dlpDownloads').checked = dlp.downloads !== false;
    $('dlpWatermark').checked = dlp.watermark !== false;
    $('dlpScreenshot').checked = dlp.screenshot !== false;
  });
}

$('saveBtn').addEventListener('click', () => {
  const mode = (document.querySelector('input[name=streamMode]:checked') || {}).value || 'auto';
  const cfg = {
    serverUrl: $('serverUrl').value.trim().replace(/\/+$/, ''),
    enabled: $('enabled').checked,
    streamModePref: mode,
    dlp: {
      clipboard: $('dlpClipboard').checked,
      downloads: $('dlpDownloads').checked,
      watermark: $('dlpWatermark').checked,
      screenshot: $('dlpScreenshot').checked,
    },
  };
  chrome.storage.sync.set(cfg, () => {
    chrome.action.setBadgeText({ text: '' }); // clear setup prompt
    const m = $('savedMsg'); m.style.display = 'inline'; setTimeout(() => (m.style.display = 'none'), 2000);
  });
});

$('testBtn').addEventListener('click', async () => {
  const base = $('serverUrl').value.trim().replace(/\/+$/, '');
  const res = $('testResult');
  if (!base) { res.textContent = 'Enter a server URL first'; res.className = 'test-result err'; return; }
  res.textContent = 'Testing…'; res.className = 'test-result';
  try {
    const r = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(5000) });
    const d = await r.json();
    res.textContent = `Connected · v${d.version} · uptime ${d.uptime}s · ${d.activeContainers}/${d.maxSessions} active`;
    res.className = 'test-result ok';
  } catch (e) {
    res.textContent = 'Cannot connect — check IP and that the server is running';
    res.className = 'test-result err';
  }
});

renderDomains();
load();
