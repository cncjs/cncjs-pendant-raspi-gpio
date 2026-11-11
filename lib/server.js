'use strict';

// Small HTTP server for the widget: static files, a JSON API and a
// Server-Sent Events stream. It is meant to sit behind a CNCjs mount point
// (cncjs --mount /gpio:http://127.0.0.1:8010/), which is why it listens on
// localhost only and why every API call must carry a CNCjs access token.

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const jwt = require('./jwt');
const { ConfigError, normalize, normalizeAction } = require('./config');

const WIDGET_DIR = path.join(__dirname, '..', 'widget');
const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/widget.js': ['widget.js', 'text/javascript; charset=utf-8'],
  '/pinout.js': ['pinout.js', 'text/javascript; charset=utf-8'],
  '/widget.css': ['widget.css', 'text/css; charset=utf-8']
};
const BODY_LIMIT = 256 * 1024;
const HEARTBEAT_MS = 25000;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > BODY_LIMIT) {
        reject(new HttpError(413, 'Request is too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('error', reject);
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(new HttpError(400, 'Request body is not valid JSON'));
      }
    });
  });
}

function createServer(app) {
  const clients = new Set();

  const broadcast = (event, data) => {
    const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of clients) {
      res.write(frame);
    }
  };
  app.on('status', () => broadcast('status', app.status()));
  app.on('notify', (notice) => broadcast('notify', notice));

  // A real event (not a comment) so the widget can tell a stalled stream from a quiet one.
  const heartbeat = setInterval(() => broadcast('ping', {}), HEARTBEAT_MS);
  heartbeat.unref();

  const authorize = (req, url) => {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : url.searchParams.get('token');
    try {
      jwt.verify(token, app.secret);
    } catch (err) {
      throw new HttpError(401, 'Not signed in to CNCjs (reload the CNCjs page)');
    }
  };

  const json = (res, status, data) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(data));
  };

  const events = (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      // no-transform and X-Accel-Buffering keep proxies from buffering the stream
      'Cache-Control': 'no-cache, no-transform',
      'X-Accel-Buffering': 'no',
      Connection: 'keep-alive'
    });
    res.write(`retry: 3000\nevent: status\ndata: ${JSON.stringify(app.status())}\n\n`);
    clients.add(res);
    req.on('close', () => clients.delete(res));
  };

  const api = async (req, res, url) => {
    const route = `${req.method} ${url.pathname}`;
    let match;

    if (route === 'GET /api/events') {
      events(req, res);
    } else if (route === 'GET /api/status') {
      json(res, 200, app.status());
    } else if (route === 'GET /api/lines') {
      json(res, 200, { lines: await app.lines() });
    } else if (route === 'PUT /api/config') {
      json(res, 200, await app.saveConfig(await readBody(req)));
    } else if (route === 'POST /api/actions/test') {
      // Runs an action as drafted in the settings form, before it is saved.
      const body = await readBody(req);
      const pin = normalize({ pins: [{ ...body.pin, actions: [] }] }).pins[0];
      const action = normalizeAction(body.action);
      const active = action.on === 'inactive' ? false : body.active !== false;
      try {
        json(res, 200, { ok: true, detail: await app.actions.run(pin, action, active, { test: true }) });
      } catch (err) {
        json(res, 200, { ok: false, detail: err.message });
      }
    } else if (req.method === 'POST' && (match = /^\/api\/pins\/([\w-]+)\/output$/.exec(url.pathname))) {
      const body = await readBody(req);
      try {
        await app.pins.setOutput(match[1], body.value);
      } catch (err) {
        throw new HttpError(400, err.message);
      }
      json(res, 200, app.status());
    } else if (app.mock && req.method === 'POST' && (match = /^\/api\/mock\/(\d+)$/.exec(url.pathname))) {
      const body = await readBody(req);
      app.backend.inject(Number(match[1]), body.level);
      json(res, 200, { ok: true });
    } else {
      throw new HttpError(404, 'Not found');
    }
  };

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname.startsWith('/api/')) {
        authorize(req, url);
        await api(req, res, url);
        return;
      }
      const file = req.method === 'GET' && STATIC[url.pathname];
      if (!file) {
        throw new HttpError(404, 'Not found');
      }
      res.writeHead(200, { 'Content-Type': file[1], 'Cache-Control': 'no-cache' });
      fs.createReadStream(path.join(WIDGET_DIR, file[0])).pipe(res);
    } catch (err) {
      const status = err.status || (err instanceof ConfigError ? 400 : 500);
      if (status === 500) {
        app.log.warn(`${req.method} ${req.url.split('?')[0]}: ${err.message}`);
      }
      if (!res.headersSent) {
        json(res, status, { error: err.message });
      } else {
        res.end();
      }
    }
  });

  server.on('close', () => clearInterval(heartbeat));

  // Stops accepting requests and drops open event streams.
  server.shutdown = () => new Promise((resolve) => {
    server.close(resolve);
    server.closeAllConnections();
  });
  return server;
}

module.exports = { createServer };
