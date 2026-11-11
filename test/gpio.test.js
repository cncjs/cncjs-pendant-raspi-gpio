'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseLines, parseChip, MockBackend } = require('../lib/gpio');

const GPIOINFO = `gpiochip0 - 58 lines:
\tline   0:\t"ID_SDA"        \tinput
\tline   2:\t"GPIO2"         \tinput
\tline   3:\t"GPIO3"         \tinput bias=pull-up edges=falling consumer="lg"
\tline   4:\t"GPIO4"         \toutput bias=disabled consumer="lg"
\tline  17:\t"GPIO17"        \tinput bias=pull-down edges=both consumer="cncjs-gpio"
\tline  27:\t"GPIO27"        \tinput
\tline  30:\t"CTS0"          \tinput consumer="kernel"
`;

test('gpioinfo output is parsed, header pins only', () => {
  const lines = parseLines(GPIOINFO);
  assert.deepEqual(lines.map((l) => l.gpio), [2, 3, 4, 17, 27]);
  assert.deepEqual(lines[0], { gpio: 2, name: 'GPIO2', used: false, consumer: '', own: false });
  assert.deepEqual(lines[1], { gpio: 3, name: 'GPIO3', used: true, consumer: 'lg', own: false });
  assert.equal(lines[3].own, true);
});

test('the header chip is found by label on Pi 4 and Pi 5', () => {
  assert.equal(parseChip('gpiochip0 [pinctrl-bcm2711] (58 lines)\ngpiochip1 [raspberrypi-exp-gpio] (8 lines)\n'), 'gpiochip0');
  assert.equal(parseChip('gpiochip0 [gpio-brcmstb@107d508500] (32 lines)\ngpiochip4 [pinctrl-rp1] (54 lines)\n'), 'gpiochip4');
  assert.equal(parseChip('gpiochip0 [something-else] (8 lines)\n'), 'gpiochip0');
  assert.equal(parseChip(''), undefined);
});

test('the mock backend reports edges only for watched pins', async () => {
  const backend = new MockBackend();
  const edges = [];
  backend.on('edge', (gpio, level) => edges.push([gpio, level]));
  backend.inject(17, 1); // not watched yet
  assert.equal(await backend.watch(17, { pull: 'down' }), 1);
  assert.equal(await backend.watch(27, { pull: 'up' }), 1);
  backend.inject(17, 0);
  backend.inject(17, 0); // no change
  backend.inject(17, 1);
  assert.deepEqual(edges, [[17, 0], [17, 1]]);
  await assert.rejects(backend.watch(4, { pull: 'down' }), /in use/);
});
