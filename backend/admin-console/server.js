'use strict';
/* ============================================================================
 * Precision RBI — admin-console server
 * Serves the bundled React dashboard (static) and mounts the admin API router.
 * ==========================================================================*/

const express = require('express');
const path    = require('path');
const apiRouter = require('./src/api.js');

const PORT      = parseInt(process.env.ADMIN_PORT || '3000', 10);
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASSWORD || 'precision2024';

const app = express();
app.use(express.json());

// Basic auth gate for everything (simple, single-tenant operations console).
app.use((req, res, next) => {
  const hdr = req.headers.authorization || '';
  const [scheme, b64] = hdr.split(' ');
  if (scheme === 'Basic' && b64) {
    const [u, p] = Buffer.from(b64, 'base64').toString().split(':');
    if (u === ADMIN_USER && p === ADMIN_PASS) return next();
  }
  res.set('WWW-Authenticate', 'Basic realm="Precision RBI Admin"');
  return res.status(401).send('Authentication required');
});

app.use('/api/admin', apiRouter);
app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => console.log(`[Admin] console listening on :${PORT}`));
