'use strict';

// Ties the parts together: settings, pins, actions and the CNCjs connection.
//
// Events:
//   'status'          something a viewer shows has changed
//   'notify' (notice) an alert for open browsers

const { EventEmitter } = require('node:events');
const { normalize } = require('./config');
const { PinManager } = require('./pins');
const { Actions } = require('./actions');
const pkg = require('../package.json');

class App extends EventEmitter {
  constructor({ secret, store, backend, cncjs, mock = false, log = console }) {
    super();
    this.secret = secret;
    this.store = store;
    this.backend = backend;
    this.cncjs = cncjs;
    this.mock = mock;
    this.log = log;
    this.config = normalize({});
    this.gpioError = null;

    this.pins = new PinManager(backend, log);
    this.actions = new Actions({ cncjs, log });

    // Several things often change at once (a pin, then each of its actions),
    // so viewers get one combined report.
    let pending = null;
    const changed = () => {
      pending = pending || setTimeout(() => {
        pending = null;
        this.emit('status');
      }, 25);
    };
    this.pins.on('update', changed);
    this.pins.on('change', (pin, active) => {
      this.log.info(`${pin.name} (GPIO${pin.gpio}) is now ${active ? 'active' : 'inactive'}`);
      this.actions.handle(pin, active);
    });
    this.actions.on('result', changed);
    this.actions.on('notify', (notice) => this.emit('notify', notice));
    cncjs.on('change', changed);
  }

  async start() {
    this.config = this.store.load();
    try {
      await this.backend.init();
    } catch (err) {
      // Keep serving the widget so the reason is visible there.
      this.gpioError = err.message;
      this.log.error(`GPIO is not available: ${err.message}`);
      return;
    }
    await this.pins.apply(this.config);
    this.log.info(`Watching ${this.config.pins.filter((p) => p.enabled).length} pin(s)`);
  }

  status() {
    return {
      version: pkg.version,
      mock: this.mock,
      gpioError: this.gpioError,
      cncjs: { connected: this.cncjs.connected },
      config: this.config,
      pins: this.pins.state(),
      results: this.actions.results()
    };
  }

  async lines() {
    return this.gpioError ? [] : this.backend.lines();
  }

  async saveConfig(input) {
    const config = normalize(input);
    await this.store.save(config);
    this.config = config;
    if (!this.gpioError) {
      await this.pins.apply(config);
    }
    this.emit('status');
    return this.status();
  }

  async stop() {
    this.cncjs.close();
    await this.pins.close();
  }
}

module.exports = { App };
