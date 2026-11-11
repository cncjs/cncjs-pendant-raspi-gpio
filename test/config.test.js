'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { normalize, Store, ConfigError } = require('../lib/config');

test('empty settings become an empty pin list', () => {
  assert.deepEqual(normalize(undefined), { version: 1, hideBar: false, pins: [] });
  assert.deepEqual(normalize({}), { version: 1, hideBar: false, pins: [] });
});

test('an input pin gets defaults and keeps its actions', () => {
  const { pins: [pin] } = normalize({
    pins: [{ gpio: 17, name: ' Dust bin ', actions: [{ type: 'system', command: 'echo hi' }] }]
  });
  assert.equal(pin.name, 'Dust bin');
  assert.equal(pin.mode, 'input');
  assert.equal(pin.pull, 'down');
  assert.equal(pin.stableMs, 50);
  assert.equal(pin.grid, 12);
  assert.equal(pin.actionsEnabled, true);
  assert.deepEqual(pin.active, { label: 'Active', color: 'red' });
  assert.equal(pin.actions[0].on, 'active');
  assert.equal(pin.actions[0].enabled, true);
  assert.ok(pin.id && pin.actions[0].id);
  assert.equal(pin.outputMode, undefined);
});

test('an output pin gets output defaults and no input fields', () => {
  const { pins: [pin] } = normalize({ pins: [{ gpio: 22, mode: 'output', actions: [{ type: 'notify' }] }] });
  assert.equal(pin.name, 'GPIO22');
  assert.equal(pin.outputMode, 'toggle');
  assert.equal(pin.pulseMs, 500);
  assert.equal(pin.initial, 0);
  assert.deepEqual(pin.active, { label: 'On', color: 'green' });
  assert.equal(pin.actions, undefined);
  assert.equal(pin.pull, undefined);
});

test('normalizing twice changes nothing', () => {
  const once = normalize({ pins: [{ gpio: 17, actions: [{ type: 'cncjs' }] }, { gpio: 22, mode: 'output' }] });
  assert.deepEqual(normalize(once), once);
});

test('bad settings are refused with a readable reason', () => {
  const bad = (pins, pattern) => assert.throws(() => normalize({ pins }), (err) => {
    assert.ok(err instanceof ConfigError);
    assert.match(err.message, pattern);
    return true;
  });
  bad([{}], /choose a GPIO pin/);
  bad([{ gpio: 1 }], /GPIO number/);
  bad([{ gpio: 28 }], /GPIO number/);
  bad([{ gpio: 17.5 }], /GPIO number/);
  bad([{ gpio: 17 }, { gpio: 17 }], /GPIO17 is configured more than once/);
  bad([{ gpio: 17, mode: 'pwm' }], /type/);
  bad([{ gpio: 17, pull: 'sideways' }], /pull resistor/);
  bad([{ gpio: 17, grid: 5 }], /tile width/);
  bad([{ gpio: 17, stableMs: -1 }], /hold time/);
  bad([{ gpio: 17, active: { color: 'pink' } }], /color/);
  bad([{ gpio: 17, name: 'x'.repeat(41) }], /too long/);
  bad([{ gpio: 17, actions: [{ type: 'system', command: '  ' }] }], /system command is empty/);
  bad([{ gpio: 17, actions: [{ type: 'cncjs', command: 'rm -rf' }] }], /CNCjs command/);
  bad([{ gpio: 17, actions: [{ type: 'gcode' }] }], /G-code is empty/);
  bad([{ gpio: 17, actions: [{ type: 'email' }] }], /type/);
  bad([{ gpio: 17, mode: 'output', pulseMs: 5 }], /pulse length/);
  bad('nope', /At most/);
});

test('the hide-status-row setting defaults to off and is kept when on', () => {
  assert.equal(normalize({ pins: [] }).hideBar, false);
  assert.equal(normalize({ hideBar: true, pins: [] }).hideBar, true);
  assert.equal(normalize({ hideBar: 'yes' }).hideBar, true);
});

test('duplicate ids are replaced so every pin and action is unique', () => {
  const { pins } = normalize({ pins: [{ id: 'same', gpio: 17 }, { id: 'same', gpio: 18 }] });
  assert.notEqual(pins[0].id, pins[1].id);
});

test('the store reads state.gpio and the secret from the cncrc file', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gpio-test-')), 'cncrc');
  const store = new Store({ file, baseUrl: 'http://x', getToken: () => 't', log: { warn() {} } });

  assert.deepEqual(store.load(), { version: 1, hideBar: false, pins: [] }); // missing file
  assert.equal(store.readSecret(), '');

  fs.writeFileSync(file, JSON.stringify({ secret: 's3', state: { gpio: { pins: [{ gpio: 17 }] } } }));
  assert.equal(store.readSecret(), 's3');
  assert.equal(store.load().pins[0].gpio, 17);

  fs.writeFileSync(file, JSON.stringify({ secret: 's3', state: { gpio: { pins: [{ gpio: 99 }] } } }));
  assert.deepEqual(store.load(), { version: 1, hideBar: false, pins: [] }); // invalid settings are ignored
});

test('saving posts to the CNCjs state API with a token', async () => {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, init });
    return { ok: true, status: 200 };
  };
  const store = new Store({ file: '/nonexistent', baseUrl: 'http://127.0.0.1:80', getToken: () => 'tok', fetch });
  await store.save({ version: 1, hideBar: false, pins: [] });
  assert.equal(calls[0].url, 'http://127.0.0.1:80/api/state?key=gpio');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer tok');
  assert.deepEqual(JSON.parse(calls[0].init.body), { version: 1, hideBar: false, pins: [] });

  store.fetch = async () => ({ ok: false, status: 403 });
  await assert.rejects(store.save({}), /HTTP 403/);
  store.fetch = async () => { throw new Error('ECONNREFUSED'); };
  await assert.rejects(store.save({}), /not reachable/);
});
