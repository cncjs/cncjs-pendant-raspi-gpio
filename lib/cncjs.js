'use strict';

// Connection to the CNCjs server, used only to send commands to the machine.
//
// Unlike the pendant boilerplate this never opens a serial port. It asks CNCjs
// which port is already open and sends through that, so it cannot fight with
// CNCjs (or a GRBL hat) over the port.

const { EventEmitter } = require('node:events');
const io = require('socket.io-client'); // must stay on 2.x to match CNCjs's socket.io

const LIST_TIMEOUT_MS = 3000;

class CncjsClient extends EventEmitter {
  // getToken: returns a fresh access token signed with the CNCjs secret.
  constructor({ address, port, getToken, log = console }) {
    super();
    this.url = `ws://${address}:${port}`;
    this.getToken = getToken;
    this.log = log;
    this.socket = null;
    this.connected = false;
  }

  connect() {
    const socket = io.connect(this.url, { query: `token=${this.getToken()}` });
    this.socket = socket;

    socket.on('connect', () => {
      this.log.info(`Connected to CNCjs at ${this.url}`);
      this.setConnected(true);
    });
    socket.on('disconnect', () => {
      if (this.socket) {
        this.log.warn('Lost connection to CNCjs');
      }
      this.setConnected(false);
    });
    socket.on('reconnect_attempt', () => {
      // Tokens expire, so sign a new one for every attempt.
      socket.io.opts.query = `token=${this.getToken()}`;
    });
    socket.on('error', (err) => {
      this.log.warn(`CNCjs connection error: ${(err && err.message) || err}`);
    });
  }

  setConnected(connected) {
    if (this.connected !== connected) {
      this.connected = connected;
      this.emit('change');
    }
  }

  // Resolves the serial port CNCjs currently has open, or null.
  openPort() {
    return new Promise((resolve, reject) => {
      const { socket } = this;
      const timer = setTimeout(() => {
        socket.removeListener('serialport:list', onList);
        reject(new Error('CNCjs did not answer'));
      }, LIST_TIMEOUT_MS);
      const onList = (ports) => {
        clearTimeout(timer);
        const open = (Array.isArray(ports) ? ports : []).find((p) => p && p.inuse);
        resolve(open ? open.port : null);
      };
      socket.once('serialport:list', onList);
      socket.emit('list');
    });
  }

  // Sends a Controller API command (e.g. 'gcode:pause', or 'gcode' with text)
  // to the machine CNCjs is connected to. Resolves the serial port used.
  async command(cmd, ...args) {
    if (!this.socket || !this.connected) {
      throw new Error('not connected to CNCjs');
    }
    const port = await this.openPort();
    if (!port) {
      throw new Error('CNCjs has no machine connected');
    }
    this.socket.emit('command', port, cmd, ...args);
    return port;
  }

  close() {
    const { socket } = this;
    this.socket = null;
    this.connected = false;
    if (socket) {
      socket.close();
    }
  }
}

module.exports = { CncjsClient };
