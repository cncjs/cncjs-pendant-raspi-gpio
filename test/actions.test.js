'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { setTimeout: sleep } = require('node:timers/promises');
const { normalize } = require('../lib/config');
const { Actions } = require('../lib/actions');

const quiet = { info() {}, warn() {}, error() {} };

function setup(pinInput) {
  const sent = [];
  const cncjs = {
    command: async (...args) => {
      sent.push(args);
      return '/dev/ttyUSB0';
    }
  };
  const actions = new Actions({ cncjs, log: quiet });
  const notices = [];
  actions.on('notify', (n) => notices.push(n));
  const pin = normalize({ pins: [pinInput] }).pins[0];
  return { actions, sent, notices, pin };
}

test('only enabled actions that match the new state run', async () => {
  const { actions, notices, sent, pin } = setup({
    gpio: 17,
    name: 'Bin',
    active: { label: 'FULL' },
    inactive: { label: 'OK' },
    actions: [
      { type: 'notify', on: 'active' },
      { type: 'cncjs', command: 'gcode:pause', on: 'active' },
      { type: 'gcode', gcode: 'M5', on: 'inactive' },
      { type: 'cncjs', command: 'unlock', on: 'both' },
      { type: 'cncjs', command: 'homing', on: 'active', enabled: false }
    ]
  });

  actions.handle(pin, true);
  await sleep(20);
  assert.equal(notices.length, 1);
  assert.equal(notices[0].label, 'FULL');
  assert.equal(notices[0].name, 'Bin');
  assert.deepEqual(sent, [['gcode:pause'], ['unlock']]);

  sent.length = 0;
  actions.handle(pin, false);
  await sleep(20);
  assert.equal(notices.length, 1);
  assert.deepEqual(sent, [['gcode', 'M5'], ['unlock']]);
});

test('nothing runs while the pin\'s actions are switched off', async () => {
  const { actions, notices, pin } = setup({ gpio: 17, actionsEnabled: false, actions: [{ type: 'notify' }] });
  actions.handle(pin, true);
  await sleep(20);
  assert.equal(notices.length, 0);
});

test('a system command runs in a shell with the pin details in its environment', async () => {
  const { actions, pin } = setup({
    gpio: 17,
    name: 'Dust bin',
    active: { label: 'Bin is FULL' },
    actions: [{ type: 'system', command: 'echo "$GPIO_NAME|$GPIO_PIN|$GPIO_STATE|$GPIO_LABEL" && true' }]
  });
  const out = await actions.run(pin, pin.actions[0], true);
  assert.equal(out, 'Dust bin|17|active|Bin is FULL');
  const last = actions.results()[pin.actions[0].id];
  assert.equal(last.ok, true);
  assert.equal(last.detail, out);
});

test('a failing system command is reported, not thrown away', async () => {
  const { actions, pin } = setup({
    gpio: 17,
    actions: [{ type: 'system', command: 'echo oops >&2; exit 3' }]
  });
  await assert.rejects(actions.run(pin, pin.actions[0], true), /exit 3 oops/);
  assert.equal(actions.results()[pin.actions[0].id].ok, false);
});

test('a machine command fails cleanly when CNCjs has no machine', async () => {
  const { actions, pin } = setup({ gpio: 17, actions: [{ type: 'cncjs', command: 'feedhold' }] });
  actions.cncjs.command = async () => { throw new Error('CNCjs has no machine connected'); };
  await assert.rejects(actions.run(pin, pin.actions[0], true), /no machine connected/);
  actions.handle(pin, true); // must not raise an unhandled rejection
  await sleep(20);
});
