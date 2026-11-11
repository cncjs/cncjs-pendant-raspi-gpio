'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { setTimeout: sleep } = require('node:timers/promises');
const jwt = require('../lib/jwt');
const { normalize } = require('../lib/config');
const { MockBackend } = require('../lib/gpio');
const { App } = require('../lib/app');
const { createServer } = require('../lib/server');

const SECRET = 'test-secret';
const quiet = { info() {}, warn() {}, error() {} };

async function setup(t, stored = {}) {
  const saved = [];
  const store = {
    load: () => normalize(stored),
    save: async (config) => { saved.push(config); }
  };
  const cncjs = Object.assign(new EventEmitter(), {
    connected: true,
    close() {},
    command: async () => '/dev/ttyUSB0'
  });
  const backend = new MockBackend();
  const app = new App({ secret: SECRET, store, backend, cncjs, mock: true, log: quiet });
  await app.start();
  const server = createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await server.shutdown();
    await app.stop();
  });

  const base = `http://127.0.0.1:${server.address().port}`;
  const token = jwt.sign({ id: '', name: '' }, SECRET, '1h');
  const call = async (method, path, body, auth = token) => {
    const res = await fetch(base + path, {
      method,
      headers: Object.assign(auth ? { Authorization: `Bearer ${auth}` } : {}, body ? { 'Content-Type': 'application/json' } : {}),
      body: body ? JSON.stringify(body) : undefined
    });
    return { status: res.status, type: res.headers.get('content-type'), body: await res.text() };
  };
  const json = async (...args) => {
    const res = await call(...args);
    return Object.assign(res, { data: JSON.parse(res.body) });
  };
  return { app, backend, saved, base, token, call, json };
}

test('the widget files are served without a token, and nothing else is', async (t) => {
  const { call } = await setup(t);
  for (const [path, type] of [['/', 'text/html'], ['/widget.js', 'text/javascript'], ['/pinout.js', 'text/javascript'], ['/widget.css', 'text/css']]) {
    const res = await call('GET', path, null, null);
    assert.equal(res.status, 200, path);
    assert.ok(res.type.startsWith(type), path);
    assert.ok(res.body.length > 100, path);
  }
  assert.equal((await call('GET', '/../package.json', null, null)).status, 404);
  assert.equal((await call('GET', '/lib/server.js', null, null)).status, 404);
  assert.equal((await call('POST', '/', null, null)).status, 404);
});

test('every API call needs a valid CNCjs token', async (t) => {
  const { json, call, base, token } = await setup(t);
  assert.equal((await json('GET', '/api/status', null, null)).status, 401);
  assert.equal((await json('GET', '/api/status', null, jwt.sign({}, 'wrong-secret'))).status, 401);
  assert.equal((await json('PUT', '/api/config', { pins: [] }, null)).status, 401);
  assert.equal((await json('POST', '/api/actions/test', {}, 'garbage')).status, 401);
  assert.equal((await json('GET', '/api/status')).status, 200);
  // EventSource cannot set headers, so the token may also come in the query string.
  assert.equal((await fetch(`${base}/api/status?token=${token}`)).status, 200);
  assert.equal((await call('GET', '/api/nothing')).status, 404);
});

test('saving settings validates, stores through CNCjs and starts the pins', async (t) => {
  const { json, saved, backend } = await setup(t);

  const bad = await json('PUT', '/api/config', { pins: [{ gpio: 99 }] });
  assert.equal(bad.status, 400);
  assert.match(bad.data.error, /GPIO number/);
  assert.equal(saved.length, 0);

  const ok = await json('PUT', '/api/config', { pins: [{ gpio: 17, name: 'Bin', stableMs: 0 }] });
  assert.equal(ok.status, 200);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].pins[0].name, 'Bin');
  assert.equal(ok.data.config.pins[0].name, 'Bin');
  assert.equal(ok.data.pins[0].active, false);
  assert.equal(backend.watching.has(17), true);

  const lines = await json('GET', '/api/lines');
  assert.equal(lines.data.lines.find((l) => l.gpio === 17).own, true);
  assert.equal(lines.data.lines.find((l) => l.gpio === 4).used, true);
});

test('settings are not applied when CNCjs cannot store them', async (t) => {
  const { app, json, backend } = await setup(t);
  app.store.save = async () => { throw new Error('CNCjs is not reachable'); };
  const res = await json('PUT', '/api/config', { pins: [{ gpio: 17 }] });
  assert.equal(res.status, 500);
  assert.match(res.data.error, /not reachable/);
  assert.equal(backend.watching.has(17), false);
  assert.equal(app.config.pins.length, 0);
});

test('an output can be switched from the API', async (t) => {
  const { json, backend } = await setup(t, { pins: [{ id: 'relay', gpio: 22, mode: 'output' }] });
  const on = await json('POST', '/api/pins/relay/output', { value: 'toggle' });
  assert.equal(on.status, 200);
  assert.equal(on.data.pins[0].active, true);
  assert.equal(backend.outputs.get(22), 1);
  assert.equal((await json('POST', '/api/pins/nope/output', { value: 'on' })).status, 400);
});

test('the event stream sends status, then changes and alerts as they happen', async (t) => {
  const { base, token, json } = await setup(t, {
    pins: [{ id: 'bin', gpio: 17, name: 'Bin', stableMs: 0, active: { label: 'FULL' }, actions: [{ type: 'notify' }] }]
  });
  const res = await fetch(`${base}/api/events?token=${token}`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/event-stream/);
  assert.match(res.headers.get('cache-control'), /no-transform/);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  const until = async (pattern) => {
    while (!pattern.test(text)) {
      const { value, done } = await reader.read();
      assert.equal(done, false, 'stream ended early');
      text += decoder.decode(value);
    }
  };

  await until(/event: status\ndata: .*"active":false/);
  await json('POST', '/api/mock/17', { level: 1 });
  await until(/event: notify\ndata: .*"label":"FULL"/);
  await until(/event: status\ndata: .*"active":true/);
  await reader.cancel();
});

test('an action can be tried from the form before it is saved', async (t) => {
  const { json } = await setup(t);
  const ok = await json('POST', '/api/actions/test', {
    pin: { gpio: 17, name: 'Bin', active: { label: 'FULL' } },
    action: { type: 'system', command: 'echo "$GPIO_LABEL"' }
  });
  assert.deepEqual(ok.data, { ok: true, detail: 'FULL' });

  const failed = await json('POST', '/api/actions/test', {
    pin: { gpio: 17 },
    action: { type: 'system', command: 'exit 2' }
  });
  assert.equal(failed.data.ok, false);

  const invalid = await json('POST', '/api/actions/test', { pin: { gpio: 17 }, action: { type: 'system', command: '' } });
  assert.equal(invalid.status, 400);
});

test('an oversized or malformed request body is refused', async (t) => {
  const { base, token } = await setup(t);
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const garbled = await fetch(`${base}/api/config`, { method: 'PUT', headers, body: '{not json' });
  assert.equal(garbled.status, 400);
  const huge = await fetch(`${base}/api/config`, { method: 'PUT', headers, body: JSON.stringify({ x: 'y'.repeat(300000) }) })
    .then((res) => res.status, () => 'dropped');
  assert.ok(huge === 413 || huge === 'dropped');
});
