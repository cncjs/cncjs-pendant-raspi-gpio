'use strict';

// Runs the actions attached to an input pin when it changes state.
//
// Events:
//   'notify' ({ pinId, name, label, active, time, test })  show an alert in open browsers
//   'result'                                                an action finished

const { EventEmitter } = require('node:events');
const { exec } = require('node:child_process');

const COMMAND_TIMEOUT_MS = 60000;
const OUTPUT_LIMIT = 500;

const clip = (text) => {
  const s = String(text || '').trim();
  return s.length > OUTPUT_LIMIT ? `${s.slice(0, OUTPUT_LIMIT)}...` : s;
};

class Actions extends EventEmitter {
  constructor({ cncjs, log = console }) {
    super();
    this.cncjs = cncjs;
    this.log = log;
    this.last = new Map(); // action id -> { time, ok, detail }
  }

  // Called when an input pin settles into a new state.
  handle(pin, active) {
    if (!pin.actionsEnabled) {
      return;
    }
    for (const action of pin.actions || []) {
      const wanted = action.on === 'both' || (action.on === 'active') === active;
      if (action.enabled && wanted) {
        this.run(pin, action, active).catch(() => {});
      }
    }
  }

  // Runs one action and records how it went. Rejects if it failed.
  async run(pin, action, active, { test = false } = {}) {
    const state = active ? pin.active : pin.inactive;
    const label = state.label || `${pin.name} ${active ? 'active' : 'inactive'}`;
    const what = `${pin.name}: ${action.type}${test ? ' (test)' : ''}`;
    try {
      const detail = await this.perform(pin, action, active, label, test);
      this.log.info(`${what} ok${detail ? ` - ${detail}` : ''}`);
      this.record(action, true, detail);
      return detail;
    } catch (err) {
      this.log.warn(`${what} failed - ${err.message}`);
      this.record(action, false, err.message);
      throw err;
    }
  }

  async perform(pin, action, active, label, test) {
    switch (action.type) {
      case 'notify':
        this.emit('notify', { pinId: pin.id, name: pin.name, label, active, time: Date.now(), test });
        return '';
      case 'system':
        return this.shell(action.command, {
          GPIO_NAME: pin.name,
          GPIO_PIN: String(pin.gpio),
          GPIO_STATE: active ? 'active' : 'inactive',
          GPIO_LABEL: label
        });
      case 'cncjs': {
        const port = await this.cncjs.command(action.command);
        return `sent ${action.command} to ${port}`;
      }
      case 'gcode': {
        const port = await this.cncjs.command('gcode', action.gcode);
        return `sent G-code to ${port}`;
      }
      default:
        throw new Error(`Unknown action type "${action.type}"`);
    }
  }

  // Runs a shell command the same way CNCjs events do, as the service's user.
  shell(command, env) {
    return new Promise((resolve, reject) => {
      exec(command, {
        timeout: COMMAND_TIMEOUT_MS,
        env: { ...process.env, ...env }
      }, (err, stdout, stderr) => {
        if (err) {
          const why = err.killed ? `timed out after ${COMMAND_TIMEOUT_MS / 1000}s` : `exit ${err.code}`;
          reject(new Error(clip(`${why} ${stderr || stdout}`)));
          return;
        }
        resolve(clip(stdout));
      });
    });
  }

  record(action, ok, detail) {
    this.last.set(action.id, { time: Date.now(), ok, detail: detail || '' });
    this.emit('result');
  }

  results() {
    return Object.fromEntries(this.last);
  }
}

module.exports = { Actions };
