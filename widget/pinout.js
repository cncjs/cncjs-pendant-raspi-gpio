'use strict';

// The Raspberry Pi 40-pin header, in physical pin order. The same table feeds
// the pin dropdown and the diagram, so the two can never disagree.
//
// "GPIO17" is the number the software uses (the BCM number). "Pin 11" is where
// that signal sits on the header. They are different numbers for the same pin.

/* exported HEADER_PINS, gpioPins, pinNote, renderPinout */

const HEADER_PINS = [
  { pin: 1, label: '3V3', kind: 'v3' }, { pin: 2, label: '5V', kind: 'v5' },
  { pin: 3, gpio: 2, alt: 'SDA' }, { pin: 4, label: '5V', kind: 'v5' },
  { pin: 5, gpio: 3, alt: 'SCL' }, { pin: 6, label: 'GND', kind: 'gnd' },
  { pin: 7, gpio: 4 }, { pin: 8, gpio: 14, alt: 'TXD' },
  { pin: 9, label: 'GND', kind: 'gnd' }, { pin: 10, gpio: 15, alt: 'RXD' },
  { pin: 11, gpio: 17 }, { pin: 12, gpio: 18 },
  { pin: 13, gpio: 27 }, { pin: 14, label: 'GND', kind: 'gnd' },
  { pin: 15, gpio: 22 }, { pin: 16, gpio: 23 },
  { pin: 17, label: '3V3', kind: 'v3' }, { pin: 18, gpio: 24 },
  { pin: 19, gpio: 10, alt: 'MOSI' }, { pin: 20, label: 'GND', kind: 'gnd' },
  { pin: 21, gpio: 9, alt: 'MISO' }, { pin: 22, gpio: 25 },
  { pin: 23, gpio: 11, alt: 'SCLK' }, { pin: 24, gpio: 8, alt: 'CE0' },
  { pin: 25, label: 'GND', kind: 'gnd' }, { pin: 26, gpio: 7, alt: 'CE1' },
  { pin: 27, label: 'ID_SD', kind: 'id' }, { pin: 28, label: 'ID_SC', kind: 'id' },
  { pin: 29, gpio: 5 }, { pin: 30, label: 'GND', kind: 'gnd' },
  { pin: 31, gpio: 6 }, { pin: 32, gpio: 12 },
  { pin: 33, gpio: 13 }, { pin: 34, label: 'GND', kind: 'gnd' },
  { pin: 35, gpio: 19 }, { pin: 36, gpio: 16 },
  { pin: 37, gpio: 26 }, { pin: 38, gpio: 20 },
  { pin: 39, label: 'GND', kind: 'gnd' }, { pin: 40, gpio: 21 }
];

// Usable GPIO pins in GPIO-number order: [{ pin, gpio, alt }]
function gpioPins() {
  return HEADER_PINS.filter((p) => p.gpio !== undefined).sort((a, b) => a.gpio - b.gpio);
}

// Things worth knowing before wiring to a particular pin.
function pinNote(gpio) {
  if (gpio === 2 || gpio === 3) {
    return 'I2C pin with a fixed pull-up resistor on the board; it reads HIGH when nothing is connected.';
  }
  if (gpio === 14 || gpio === 15) {
    return 'Serial port (UART) pin. Do not use it if a GRBL hat or serial console uses the Pi\'s serial port.';
  }
  return '';
}

// Draws the header. options: { selected: gpio, taken: Map(gpio -> reason), onPick(gpio) }
function renderPinout(options) {
  const SVG = 'http://www.w3.org/2000/svg';
  const ROW = 15;
  const WIDTH = 250;
  const LEFT_X = 113;
  const RIGHT_X = 137;
  const el = (name, attrs, text) => {
    const node = document.createElementNS(SVG, name);
    Object.keys(attrs || {}).forEach((key) => node.setAttribute(key, attrs[key]));
    if (text !== undefined) {
      node.textContent = text;
    }
    return node;
  };

  const svg = el('svg', {
    class: 'pinout',
    viewBox: `0 0 ${WIDTH} ${ROW * 20 + 8}`,
    width: WIDTH,
    role: 'img',
    'aria-label': 'Raspberry Pi 40-pin header'
  });
  svg.appendChild(el('rect', { x: LEFT_X - 12, y: 2, width: RIGHT_X - LEFT_X + 24, height: ROW * 20 + 4, rx: 3, class: 'pinout-body' }));

  HEADER_PINS.forEach((p) => {
    const odd = p.pin % 2 === 1;
    const x = odd ? LEFT_X : RIGHT_X;
    const y = 4 + Math.floor((p.pin - 1) / 2) * ROW + ROW / 2;
    const isGpio = p.gpio !== undefined;
    const reason = isGpio ? options.taken.get(p.gpio) : '';
    const selected = isGpio && p.gpio === options.selected;
    const pickable = isGpio && !reason && !selected;
    const name = isGpio ? `GPIO${p.gpio}` : p.label;

    const group = el('g', {
      class: ['pinout-pin', `kind-${isGpio ? 'io' : p.kind}`, selected ? 'is-selected' : '',
        reason ? 'is-taken' : '', pickable ? 'is-pickable' : ''].join(' ').trim()
    });
    group.appendChild(el('title', {}, `${name}${p.alt ? ` (${p.alt})` : ''}, header pin ${p.pin}${reason ? ` - ${reason}` : ''}`));
    group.appendChild(el('circle', { cx: x, cy: y, r: 6 }));
    group.appendChild(el('text', { x, y: y + 2.6, class: 'pinout-num', 'text-anchor': 'middle' }, String(p.pin)));
    group.appendChild(el('text', {
      x: odd ? x - 11 : x + 11,
      y: y + 3,
      class: 'pinout-name',
      'text-anchor': odd ? 'end' : 'start'
    }, p.alt ? (odd ? `${p.alt} ${name}` : `${name} ${p.alt}`) : name));
    if (pickable) {
      group.addEventListener('click', () => options.onPick(p.gpio));
    }
    svg.appendChild(group);
  });
  return svg;
}
