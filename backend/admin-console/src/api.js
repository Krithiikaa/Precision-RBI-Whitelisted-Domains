'use strict';
/* ============================================================================
 * Precision RBI — admin API router
 * Aggregates data from session-broker, bdr-service, render-gateway and Docker.
 * ==========================================================================*/

const express = require('express');
const axios   = require('axios');
const Docker  = require('dockerode');
const Redis   = require('ioredis');
const PDFDocument = require('pdfkit');

const router = express.Router();

const SESSION_BROKER_URL = process.env.SESSION_BROKER_URL || 'http://session-broker:3001';
const BDR_SERVICE_URL    = process.env.BDR_SERVICE_URL    || 'http://bdr-service:3002';
const RENDER_GATEWAY_URL = process.env.RENDER_GATEWAY_URL || 'http://render-gateway:3003';
const REDIS_URL          = process.env.REDIS_URL          || 'redis://redis:6379';
const MAX_SESSIONS       = parseInt(process.env.MAX_SESSIONS || '7', 10);
const RAM_TOTAL_MB       = parseInt(process.env.RAM_TOTAL_MB || '7383', 10); // ~7.21 GiB
const CONTAINER_MB       = Math.round(parseInt(process.env.CONTAINER_MEMORY || String(512 * 1024 * 1024), 10) / 1024 / 1024);

const docker = new Docker({ socketPath: '/var/run/docker.sock' });
const redis  = new Redis(REDIS_URL);

async function safeGet(url) { try { return (await axios.get(url, { timeout: 3000 })).data; } catch { return null; } }

// GET /api/admin/stats
router.get('/stats', async (_req, res) => {
  const [sessions, flagged, gateway] = await Promise.all([
    safeGet(`${SESSION_BROKER_URL}/api/sessions`),
    safeGet(`${BDR_SERVICE_URL}/api/bdr-flagged`),
    safeGet(`${RENDER_GATEWAY_URL}/internal/health`),
  ]);
  const active = sessions ? sessions.sessions.length : 0;
  const events = await safeGet(`${BDR_SERVICE_URL}/api/bdr-events?limit=1000`);
  const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
  const bdrEventsToday = events ? events.events.filter((e) => e.timestamp >= todayStart.getTime()).length : 0;

  res.json({
    activeSessions: active,
    maxSessions: MAX_SESSIONS,
    ramUsedMB: active * CONTAINER_MB,
    ramTotalMB: RAM_TOTAL_MB,
    flaggedUsers: flagged ? flagged.flagged.length : 0,
    bdrEventsToday,
    activeRelays: gateway ? gateway.activeRelays : 0,
    capacityWarn: active >= Math.max(1, MAX_SESSIONS - 2),
  });
});

// GET /api/admin/sessions
router.get('/sessions', async (_req, res) => {
  const data = await safeGet(`${SESSION_BROKER_URL}/api/sessions`);
  res.json(data || { sessions: [] });
});

// DELETE /api/admin/sessions/:id
router.delete('/sessions/:id', async (req, res) => {
  try {
    const r = await axios.post(`${SESSION_BROKER_URL}/api/end-session`, { sessionId: req.params.id }, { timeout: 5000 });
    res.json(r.data);
  } catch (e) {
    res.status(502).json({ error: 'broker_unreachable', detail: e.message });
  }
});

// POST /api/admin/sessions/kill-all
router.post('/sessions/kill-all', async (_req, res) => {
  const data = await safeGet(`${SESSION_BROKER_URL}/api/sessions`);
  const ids = data ? data.sessions.map((s) => s.sessionId) : [];
  for (const id of ids) {
    try { await axios.post(`${SESSION_BROKER_URL}/api/end-session`, { sessionId: id }, { timeout: 5000 }); } catch (_) {}
  }
  res.json({ killed: ids.length });
});

// GET /api/admin/bdr
router.get('/bdr', async (req, res) => {
  const qs = new URLSearchParams(req.query).toString();
  const data = await safeGet(`${BDR_SERVICE_URL}/api/bdr-events?${qs}`);
  res.json(data || { events: [], total: 0 });
});

// GET /api/admin/system
router.get('/system', async (_req, res) => {
  let containers = [];
  try {
    const list = await docker.listContainers({ all: false });
    containers = list
      .filter((c) => (c.Names[0] || '').includes('rbi-') || (c.Image || '').includes('precision-rbi'))
      .map((c) => ({ id: c.Id.slice(0, 12), name: c.Names[0], image: c.Image, state: c.State, status: c.Status }));
  } catch (e) { containers = [{ error: e.message }]; }

  const broker  = await safeGet(`${SESSION_BROKER_URL}/api/health`);
  const gateway = await safeGet(`${RENDER_GATEWAY_URL}/internal/health`);

  // Port pool inferred from active sessions.
  const sessions = await safeGet(`${SESSION_BROKER_URL}/api/sessions`);
  const portsInUse = sessions ? sessions.sessions.length : 0;

  res.json({
    containers,
    broker: broker || { status: 'unreachable' },
    gateway: gateway || { status: 'unreachable' },
    portPool: { total: 101, inUse: portsInUse, available: 101 - portsInUse },
  });
});

// GET /api/admin/gateway
router.get('/gateway', async (_req, res) => {
  const data = await safeGet(`${RENDER_GATEWAY_URL}/internal/health`);
  res.json(data || { status: 'unreachable' });
});

// ── Session logs (persistent, from bdr-service) ─────────────────────────────
// GET /api/admin/logs?page&limit&q
router.get('/logs', async (req, res) => {
  const qs = new URLSearchParams(req.query).toString();
  const data = await safeGet(`${BDR_SERVICE_URL}/api/session-logs?${qs}`);
  res.json(data || { logs: [], total: 0, totalPages: 1 });
});

const LOG_COLUMNS = [
  ['date', 'Date'], ['time', 'Time'], ['deviceIp', 'Device IP'],
  ['urlVisited', 'URL Visited'], ['browsedTime', 'Browsed Time'],
  ['threatsCaptured', 'Threats'], ['ramMB', 'RAM (MB)'], ['cpuPct', 'CPU (%)'],
  ['containerName', 'Container'], ['userId', 'User'], ['sessionId', 'Session ID'],
];

async function fetchAllLogs() {
  const d = await safeGet(`${BDR_SERVICE_URL}/api/session-logs?limit=100000&page=1`);
  return (d && d.logs) || [];
}
const cell = (r, k) => (r[k] == null ? '' : String(r[k]));

// GET /api/admin/logs/export.csv
router.get('/logs/export.csv', async (_req, res) => {
  const rows = await fetchAllLogs();
  const esc = (v) => `"${String(v).replace(/"/g, '""')}"`;
  const header = LOG_COLUMNS.map(([, label]) => esc(label)).join(',');
  const body = rows.map((r) => LOG_COLUMNS.map(([k]) => esc(cell(r, k))).join(',')).join('\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="precision-rbi-logs.csv"');
  res.send('﻿' + header + '\n' + body);
});

// GET /api/admin/logs/export.xls  (SpreadsheetML 2003 — opens natively in Excel)
router.get('/logs/export.xls', async (_req, res) => {
  const rows = await fetchAllLogs();
  const x = (v) => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const headCells = LOG_COLUMNS.map(([, l]) => `<Cell><Data ss:Type="String">${x(l)}</Data></Cell>`).join('');
  const dataRows = rows.map((r) => '<Row>' + LOG_COLUMNS.map(([k]) => {
    const v = cell(r, k);
    const num = ['threatsCaptured', 'ramMB', 'cpuPct'].includes(k) && v !== '';
    return `<Cell><Data ss:Type="${num ? 'Number' : 'String'}">${x(v)}</Data></Cell>`;
  }).join('') + '</Row>').join('');
  const xml = `<?xml version="1.0"?>
<?mso-application progid="Excel.Sheet"?>
<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">
 <Worksheet ss:Name="RBI Logs"><Table>
  <Row>${headCells}</Row>
  ${dataRows}
 </Table></Worksheet>
</Workbook>`;
  res.setHeader('Content-Type', 'application/vnd.ms-excel');
  res.setHeader('Content-Disposition', 'attachment; filename="precision-rbi-logs.xls"');
  res.send(xml);
});

// GET /api/admin/logs/export.pdf
router.get('/logs/export.pdf', async (_req, res) => {
  const rows = await fetchAllLogs();
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', 'attachment; filename="precision-rbi-logs.pdf"');
  const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 28 });
  doc.pipe(res);
  doc.fillColor('#2f6b00').fontSize(18).text('Precision RBI — Session Logs', { continued: false });
  doc.fillColor('#414939').fontSize(9).text(`Generated ${new Date().toISOString()} · ${rows.length} record(s)`);
  doc.moveDown(0.6);

  // Compact columns for PDF width.
  const cols = [
    ['date', 'Date', 55], ['time', 'Time', 48], ['deviceIp', 'Device IP', 75],
    ['urlVisited', 'URL', 150], ['browsedTime', 'Browsed', 52], ['threatsCaptured', 'Thr', 26],
    ['ramMB', 'RAM', 38], ['cpuPct', 'CPU%', 36], ['containerName', 'Container', 120], ['userId', 'User', 80],
  ];
  let x0 = doc.page.margins.left;
  const drawRow = (vals, opts = {}) => {
    const y = doc.y;
    let x = x0;
    doc.fontSize(8).fillColor(opts.head ? '#ffffff' : '#1a1c1c');
    if (opts.head) doc.rect(x0, y - 2, cols.reduce((a, c) => a + c[2], 0), 14).fill('#2f6b00');
    cols.forEach(([, , w], i) => {
      doc.fillColor(opts.head ? '#ffffff' : '#1a1c1c').fontSize(8)
        .text(String(vals[i] ?? ''), x + 2, y, { width: w - 4, height: 12, ellipsis: true, lineBreak: false });
      x += w;
    });
    doc.y = y + 14;
  };
  drawRow(cols.map((c) => c[1]), { head: true });
  rows.forEach((r) => {
    if (doc.y > doc.page.height - 40) { doc.addPage(); drawRow(cols.map((c) => c[1]), { head: true }); }
    drawRow(cols.map(([k]) => cell(r, k)));
  });
  if (!rows.length) doc.moveDown().fillColor('#717a67').text('No session logs recorded yet.');
  doc.end();
});

// ── Whitelist management (persistent, in bdr-service) ───────────────────────
router.get('/whitelist', async (_req, res) => {
  const data = await safeGet(`${BDR_SERVICE_URL}/api/whitelist`);
  res.json(data || { domains: [], defaults: [], custom: [] });
});
router.post('/whitelist', async (req, res) => {
  try {
    const r = await axios.post(`${BDR_SERVICE_URL}/api/whitelist`, req.body, { timeout: 3000 });
    res.json(r.data);
  } catch (e) {
    res.status(e.response?.status || 502).json(e.response?.data || { error: 'bdr_unreachable' });
  }
});
router.delete('/whitelist', async (req, res) => {
  try {
    const r = await axios.delete(`${BDR_SERVICE_URL}/api/whitelist`, { data: req.body, timeout: 3000 });
    res.json(r.data);
  } catch (e) {
    res.status(e.response?.status || 502).json(e.response?.data || { error: 'bdr_unreachable' });
  }
});

module.exports = router;
