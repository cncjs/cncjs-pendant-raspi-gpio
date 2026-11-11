'use strict';

// Settings live in the CNCjs config file (cncrc) under `state.gpio`, next to
// CNCjs's own events, commands and macros. They are read straight from the
// file and written through CNCjs's REST API, so CNCjs stays the only writer.

const fs = require('node:fs');
const crypto = require('node:crypto');

const STATE_KEY = 'gpio';
const VERSION = 1;

// GPIO numbers (BCM) that are broken out on the 40-pin header and free for use.
// GPIO0/1 are reserved for the HAT ID EEPROM.
const GPIO_MIN = 2;
const GPIO_MAX = 27;

const MODES = ['input', 'output'];
const PULLS = ['up', 'down', 'none'];
const COLORS = ['green', 'red', 'amber', 'blue', 'grey'];
const GRIDS = [3, 4, 6, 12];
const OUTPUT_MODES = ['toggle', 'momentary'];
const ACTION_WHEN = ['active', 'inactive', 'both'];
const ACTION_TYPES = ['notify', 'system', 'cncjs', 'gcode'];
// Commands from the CNCjs Controller API that make sense as a pin action.
const CNCJS_COMMANDS = [
  'gcode:pause', 'gcode:resume', 'gcode:stop',
  'feedhold', 'cyclestart', 'unlock', 'homing', 'reset'
];

const MAX_PINS = GPIO_MAX - GPIO_MIN + 1;
const MAX_ACTIONS = 10;

class ConfigError extends Error {}

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function text(value, fallback, max, what) {
  if (value === undefined || value === null) {
    return fallback;
  }
  if (typeof value !== 'string') {
    throw new ConfigError(`${what} must be text`);
  }
  if (value.length > max) {
    throw new ConfigError(`${what} is too long (max ${max} characters)`);
  }
  return value;
}

function integer(value, fallback, min, max, what) {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new ConfigError(`${what} must be a whole number from ${min} to ${max}`);
  }
  return n;
}

function oneOf(value, fallback, allowed, what) {
  if (value === undefined || value === null) {
    return fallback;
  }
  if (!allowed.includes(value)) {
    throw new ConfigError(`${what} must be one of: ${allowed.join(', ')}`);
  }
  return value;
}

const bool = (value, fallback) => (value === undefined || value === null ? fallback : Boolean(value));

const id = (value) => (typeof value === 'string' && /^[\w-]{1,64}$/.test(value) ? value : crypto.randomUUID());

function normalizeAction(input, what = 'Action') {
  if (!isObject(input)) {
    throw new ConfigError(`${what} is not valid`);
  }
  const type = oneOf(input.type, 'notify', ACTION_TYPES, `${what} type`);
  const action = {
    id: id(input.id),
    enabled: bool(input.enabled, true),
    on: oneOf(input.on, 'active', ACTION_WHEN, `${what} "when"`),
    type
  };
  if (type === 'system') {
    action.command = text(input.command, '', 4000, `${what} command`);
    if (!action.command.trim()) {
      throw new ConfigError(`${what}: the system command is empty`);
    }
  } else if (type === 'cncjs') {
    action.command = oneOf(input.command, 'gcode:pause', CNCJS_COMMANDS, `${what} CNCjs command`);
  } else if (type === 'gcode') {
    action.gcode = text(input.gcode, '', 4000, `${what} G-code`);
    if (!action.gcode.trim()) {
      throw new ConfigError(`${what}: the G-code is empty`);
    }
  }
  return action;
}

function normalizeState(input, fallbackLabel, fallbackColor, what) {
  const state = isObject(input) ? input : {};
  return {
    label: text(state.label, fallbackLabel, 60, `${what} label`),
    color: oneOf(state.color, fallbackColor, COLORS, `${what} color`)
  };
}

function normalizePin(input, index) {
  if (!isObject(input)) {
    throw new ConfigError(`Pin ${index + 1} is not valid`);
  }
  const gpio = integer(input.gpio, undefined, GPIO_MIN, GPIO_MAX, `Pin ${index + 1}: GPIO number`);
  if (gpio === undefined) {
    throw new ConfigError(`Pin ${index + 1}: choose a GPIO pin`);
  }
  const name = text(input.name, '', 40, `GPIO${gpio} name`).trim() || `GPIO${gpio}`;
  const what = `"${name}"`;
  const mode = oneOf(input.mode, 'input', MODES, `${what} type`);
  const isInput = mode === 'input';

  const pin = {
    id: id(input.id),
    gpio,
    name,
    mode,
    enabled: bool(input.enabled, true),
    grid: oneOf(input.grid === undefined ? undefined : Number(input.grid), 12, GRIDS, `${what} tile width`),
    activeLow: bool(input.activeLow, false),
    active: normalizeState(input.active, isInput ? 'Active' : 'On', isInput ? 'red' : 'green', `${what} active`),
    inactive: normalizeState(input.inactive, isInput ? 'Inactive' : 'Off', isInput ? 'green' : 'grey', `${what} inactive`)
  };

  if (isInput) {
    pin.pull = oneOf(input.pull, 'down', PULLS, `${what} pull resistor`);
    pin.stableMs = integer(input.stableMs, 50, 0, 600000, `${what} hold time (ms)`);
    pin.actionsEnabled = bool(input.actionsEnabled, true);
    const actions = input.actions === undefined ? [] : input.actions;
    if (!Array.isArray(actions) || actions.length > MAX_ACTIONS) {
      throw new ConfigError(`${what}: at most ${MAX_ACTIONS} actions per pin`);
    }
    pin.actions = actions.map((a, i) => normalizeAction(a, `${what} action ${i + 1}`));
  } else {
    pin.outputMode = oneOf(input.outputMode, 'toggle', OUTPUT_MODES, `${what} button type`);
    pin.pulseMs = integer(input.pulseMs, 500, 100, 60000, `${what} pulse length (ms)`);
    pin.initial = integer(input.initial, 0, 0, 1, `${what} state at start`);
  }
  return pin;
}

// Validates settings and fills in defaults. Throws ConfigError with a message
// that is fit to show to the user.
function normalize(input) {
  const source = isObject(input) ? input : {};
  const pins = source.pins === undefined ? [] : source.pins;
  if (!Array.isArray(pins) || pins.length > MAX_PINS) {
    throw new ConfigError(`At most ${MAX_PINS} pins can be configured`);
  }
  const result = { version: VERSION, pins: pins.map(normalizePin) };

  const seenGpio = new Set();
  const seenId = new Set();
  for (const pin of result.pins) {
    if (seenGpio.has(pin.gpio)) {
      throw new ConfigError(`GPIO${pin.gpio} is configured more than once`);
    }
    seenGpio.add(pin.gpio);
    for (const item of [pin, ...(pin.actions || [])]) {
      if (seenId.has(item.id)) {
        item.id = crypto.randomUUID();
      }
      seenId.add(item.id);
    }
  }
  return result;
}

function defaultCncrc() {
  const home = process.env[process.platform === 'win32' ? 'USERPROFILE' : 'HOME'] || '';
  return `${home}/.cncrc`;
}

class Store {
  // file: path of the cncrc file. baseUrl: where CNCjs listens.
  // getToken: returns a valid access token for the CNCjs API.
  constructor({ file, baseUrl, getToken, log = console, fetch = globalThis.fetch }) {
    this.file = file;
    this.baseUrl = baseUrl;
    this.getToken = getToken;
    this.log = log;
    this.fetch = fetch;
  }

  readFile() {
    return JSON.parse(fs.readFileSync(this.file, 'utf8'));
  }

  readSecret() {
    try {
      return this.readFile().secret || '';
    } catch (err) {
      return '';
    }
  }

  // Settings as stored. Problems never stop the service: it starts with no pins.
  load() {
    let stored;
    try {
      const cncrc = this.readFile();
      stored = cncrc && cncrc.state ? cncrc.state[STATE_KEY] : undefined;
    } catch (err) {
      this.log.warn(`Could not read settings from ${this.file}: ${err.message}`);
      return normalize({});
    }
    try {
      return normalize(stored);
    } catch (err) {
      this.log.warn(`Stored settings are not valid and were ignored: ${err.message}`);
      return normalize({});
    }
  }

  async save(config) {
    let res;
    try {
      res = await this.fetch(`${this.baseUrl}/api/state?key=${STATE_KEY}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.getToken()}`
        },
        body: JSON.stringify(config),
        signal: AbortSignal.timeout(5000)
      });
    } catch (err) {
      throw new Error(`CNCjs is not reachable at ${this.baseUrl}, so the settings were not saved`);
    }
    if (!res.ok) {
      throw new Error(`CNCjs refused to save the settings (HTTP ${res.status})`);
    }
  }
}

module.exports = {
  Store,
  ConfigError,
  normalize,
  normalizeAction,
  defaultCncrc,
  STATE_KEY,
  GPIO_MIN,
  GPIO_MAX,
  COLORS,
  GRIDS,
  CNCJS_COMMANDS
};
