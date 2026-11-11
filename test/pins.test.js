'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { setTimeout: sleep } = require('node:timers/promises');
const { normalize } = require('../lib/config');
const { MockBackend } = require('../lib/gpio');
const { PinManager } = require('../lib/pins');

const quiet = { info() {}, warn() {}, error() {} };

function setup() {
  const backend = new MockBackend();
  const pins = new PinManager(backend, quiet);
  const changes = [];
  pins.on('change', (pin, active) => changes.push([pin.name, active]));
  return { backend, pins, changes };
}

const byGpio = (pins, gpio) => pins.state().find((p) => p.gpio === gpio);

test('an input reports its starting state without firing a change', async () => {
  const { backend, pins, changes } = setup();
  backend.levels.set(17, 1);
  await pins.apply(normalize({ pins: [{ gpio: 17, name: 'Bin', stableMs: 0 }] }));
  assert.equal(byGpio(pins, 17).active, true);
  assert.deepEqual(changes, []);
  await pins.close();
});

test('a change counts only after it has held for stableMs', async () => {
  const { backend, pins, changes } = setup();
  await pins.apply(normalize({ pins: [{ gpio: 17, name: 'Bin', stableMs: 60 }] }));

  backend.inject(17, 1); // flicker: back low before the hold time
  await sleep(20);
  backend.inject(17, 0);
  await sleep(90);
  assert.deepEqual(changes, []);
  assert.equal(byGpio(pins, 17).active, false);

  backend.inject(17, 1); // stays high
  await sleep(20);
  assert.deepEqual(changes, [], 'not yet');
  await sleep(90);
  assert.deepEqual(changes, [['Bin', true]]);
  assert.equal(byGpio(pins, 17).active, true);

  backend.inject(17, 0);
  await sleep(90);
  assert.deepEqual(changes, [['Bin', true], ['Bin', false]]);
  await pins.close();
});

test('active-low inverts what counts as active', async () => {
  const { backend, pins, changes } = setup();
  await pins.apply(normalize({ pins: [{ gpio: 17, name: 'Door', pull: 'up', activeLow: true, stableMs: 0 }] }));
  assert.equal(byGpio(pins, 17).active, false); // pulled up = high = inactive
  backend.inject(17, 0);
  assert.deepEqual(changes, [['Door', true]]);
  await pins.close();
});

test('outputs start in their initial state and toggle', async () => {
  const { backend, pins } = setup();
  const config = normalize({ pins: [{ gpio: 22, mode: 'output', name: 'Relay', initial: 1 }] });
  await pins.apply(config);
  assert.equal(backend.outputs.get(22), 1);
  await pins.setOutput(config.pins[0].id, 'toggle');
  assert.equal(backend.outputs.get(22), 0);
  assert.equal(byGpio(pins, 22).active, false);
  await pins.setOutput(config.pins[0].id, 'on');
  assert.equal(backend.outputs.get(22), 1);
  await assert.rejects(pins.setOutput(config.pins[0].id, 'sideways'), /on, off, toggle or pulse/);
  await assert.rejects(pins.setOutput('missing', 'on'), /No such output/);
  await pins.close();
});

test('an active-low output drives the pin low when on', async () => {
  const { backend, pins } = setup();
  const config = normalize({ pins: [{ gpio: 22, mode: 'output', activeLow: true }] });
  await pins.apply(config);
  assert.equal(backend.outputs.get(22), 1); // off = high
  await pins.setOutput(config.pins[0].id, 'on');
  assert.equal(backend.outputs.get(22), 0);
  await pins.close();
});

test('a pulse turns the output on, then off again', async () => {
  const { backend, pins } = setup();
  const config = normalize({ pins: [{ gpio: 22, mode: 'output', outputMode: 'momentary', pulseMs: 100 }] });
  await pins.apply(config);
  await pins.setOutput(config.pins[0].id, 'pulse');
  assert.equal(backend.outputs.get(22), 1);
  await sleep(160);
  assert.equal(backend.outputs.get(22), 0);
  assert.equal(byGpio(pins, 22).active, false);
  await pins.close();
});

test('saving settings leaves unchanged pins running and frees removed ones', async () => {
  const { backend, pins } = setup();
  const first = normalize({ pins: [{ gpio: 22, mode: 'output', name: 'Relay' }, { gpio: 17, name: 'Bin' }] });
  await pins.apply(first);
  await pins.setOutput(first.pins[0].id, 'on');

  // Rename the relay and drop the input: the relay must stay on.
  const second = normalize({ pins: [{ ...first.pins[0], name: 'Vacuum' }] });
  await pins.apply(second);
  assert.equal(backend.outputs.get(22), 1);
  assert.equal(byGpio(pins, 22).active, true);
  assert.equal(backend.watching.has(17), false);
  assert.equal(pins.state().length, 1);

  // Disabling it releases the pin.
  await pins.apply(normalize({ pins: [{ ...second.pins[0], enabled: false }] }));
  assert.equal(backend.outputs.has(22), false);
  assert.equal(byGpio(pins, 22).active, null);
  await pins.close();
});

test('a pin that cannot be claimed shows an error instead of failing the rest', async () => {
  const { pins } = setup();
  await pins.apply(normalize({ pins: [{ gpio: 4, name: 'Busy' }, { gpio: 17, name: 'Fine' }] }));
  assert.match(byGpio(pins, 4).error, /in use/);
  assert.equal(byGpio(pins, 4).active, null);
  assert.equal(byGpio(pins, 17).error, null);
  await pins.close();
});
