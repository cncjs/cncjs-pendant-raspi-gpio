'use strict';

// Keeps the live state of every configured pin.
//
// Events:
//   'change' (pin, active)  an input settled into a new state (actions hang off this)
//   'update'                anything changed that a viewer should see

const { EventEmitter } = require('node:events');

const RETRY_MS = 5000;

// The part of a pin's settings that decides how the hardware is requested.
// Pins whose key is unchanged keep running across a settings save.
const hardwareKey = (pin) => JSON.stringify([pin.gpio, pin.mode, pin.enabled, pin.activeLow, pin.pull || '']);

const toActive = (pin, level) => (pin.activeLow ? level === 0 : level === 1);
const toLevel = (pin, active) => ((pin.activeLow ? !active : active) ? 1 : 0);

class PinManager extends EventEmitter {
  constructor(backend, log = console) {
    super();
    this.backend = backend;
    this.log = log;
    this.runtime = new Map(); // pin id -> runtime record
    backend.on('edge', (gpio, level) => this.onEdge(gpio, level));
    backend.on('fault', (gpio, message) => this.onFault(gpio, message));
  }

  async apply(config) {
    const kept = new Map();
    const dropped = [];
    for (const [id, rt] of this.runtime) {
      const pin = config.pins.find((p) => p.id === id);
      if (pin && hardwareKey(pin) === rt.key) {
        rt.pin = pin;
        kept.set(id, rt);
      } else {
        dropped.push(rt);
      }
    }
    // Free pins before requesting any, in case a GPIO moved to another entry.
    await Promise.all(dropped.map((rt) => this.teardown(rt)));

    const next = new Map();
    for (const pin of config.pins) {
      let rt = kept.get(pin.id);
      if (!rt) {
        rt = { pin, key: hardwareKey(pin), level: null, active: null, since: null, error: null };
        if (pin.enabled) {
          await this.setup(rt);
        }
      }
      next.set(pin.id, rt);
    }
    this.runtime = next;
    this.emit('update');
  }

  async setup(rt) {
    const { pin } = rt;
    try {
      if (pin.mode === 'input') {
        const level = await this.backend.watch(pin.gpio, { pull: pin.pull });
        Object.assign(rt, { level, active: toActive(pin, level), since: Date.now() });
      } else {
        await this.drive(rt, pin.initial === 1);
      }
      rt.error = null;
    } catch (err) {
      Object.assign(rt, { level: null, active: null, error: err.message });
      this.log.warn(`GPIO${pin.gpio} (${pin.name}): ${err.message}`);
    }
  }

  async teardown(rt) {
    clearTimeout(rt.stableTimer);
    clearTimeout(rt.pulseTimer);
    clearTimeout(rt.retryTimer);
    rt.gone = true;
    await this.backend.release(rt.pin.gpio).catch(() => {});
  }

  find(gpio, mode) {
    for (const rt of this.runtime.values()) {
      if (rt.pin.gpio === gpio && rt.pin.mode === mode && rt.pin.enabled) {
        return rt;
      }
    }
    return null;
  }

  onEdge(gpio, level) {
    const rt = this.find(gpio, 'input');
    if (!rt) {
      return;
    }
    rt.level = level;
    clearTimeout(rt.stableTimer);
    if (toActive(rt.pin, level) === rt.active) {
      return; // bounced back before the hold time ran out
    }
    const commit = () => {
      const active = toActive(rt.pin, rt.level);
      if (rt.gone || active === rt.active) {
        return;
      }
      rt.active = active;
      rt.since = Date.now();
      this.emit('change', rt.pin, active);
      this.emit('update');
    };
    if (rt.pin.stableMs > 0) {
      rt.stableTimer = setTimeout(commit, rt.pin.stableMs);
    } else {
      commit();
    }
  }

  onFault(gpio, message) {
    const rt = [...this.runtime.values()].find((r) => r.pin.gpio === gpio && r.pin.enabled);
    if (!rt) {
      return;
    }
    this.log.warn(`GPIO${gpio} (${rt.pin.name}): ${message}`);
    Object.assign(rt, { level: null, active: null, error: message });
    this.emit('update');
    clearTimeout(rt.retryTimer);
    rt.retryTimer = setTimeout(async () => {
      if (!rt.gone) {
        await this.setup(rt);
        this.emit('update');
      }
    }, RETRY_MS);
  }

  async drive(rt, active) {
    const level = toLevel(rt.pin, active);
    await this.backend.output(rt.pin.gpio, level);
    Object.assign(rt, { level, active, since: Date.now(), error: null });
  }

  // value: true/false, 'on'/'off', 'toggle', or 'pulse' (on for pulseMs, then off)
  async setOutput(id, value) {
    const rt = this.runtime.get(id);
    if (!rt || rt.pin.mode !== 'output') {
      throw new Error('No such output pin');
    }
    if (!rt.pin.enabled) {
      throw new Error(`"${rt.pin.name}" is disabled`);
    }
    clearTimeout(rt.pulseTimer);
    if (value === 'pulse') {
      await this.drive(rt, true);
      rt.pulseTimer = setTimeout(() => {
        if (rt.gone) {
          return;
        }
        this.drive(rt, false)
          .catch((err) => { rt.error = err.message; })
          .then(() => this.emit('update'));
      }, rt.pin.pulseMs);
    } else if (value === 'toggle') {
      await this.drive(rt, !rt.active);
    } else if (value === true || value === 'on' || value === 1) {
      await this.drive(rt, true);
    } else if (value === false || value === 'off' || value === 0) {
      await this.drive(rt, false);
    } else {
      throw new Error('Output value must be on, off, toggle or pulse');
    }
    this.emit('update');
  }

  state() {
    return [...this.runtime.values()].map((rt) => ({
      id: rt.pin.id,
      gpio: rt.pin.gpio,
      level: rt.level,
      active: rt.active,
      since: rt.since,
      error: rt.error
    }));
  }

  async close() {
    await Promise.all([...this.runtime.values()].map((rt) => this.teardown(rt)));
    this.runtime.clear();
    await this.backend.close();
  }
}

module.exports = { PinManager };
