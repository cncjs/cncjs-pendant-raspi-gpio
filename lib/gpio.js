'use strict';

// GPIO access through the libgpiod v2 command-line tools (gpiodetect, gpioinfo,
// gpioget, gpiomon, gpioset). They ship with Raspberry Pi OS, so nothing has to
// be compiled, and they use the kernel's character-device interface instead of
// the retired /sys/class/gpio one.
//
// Both backends share one interface:
//   init()                      prepare, throws if GPIO is not usable
//   lines()                     [{ gpio, name, used, consumer, own }]
//   watch(gpio, { pull })       start watching an input, resolves its level
//   output(gpio, level)         drive an output to 0 or 1 and hold it
//   release(gpio)               stop using a pin
//   close()                     stop using every pin
//   events: 'edge' (gpio, level), 'fault' (gpio, message)

const { EventEmitter } = require('node:events');
const { spawn, execFile } = require('node:child_process');
const readline = require('node:readline');
const { GPIO_MIN, GPIO_MAX } = require('./config');

const CONSUMER = 'cncjs-gpio';
const BIAS = { up: 'pull-up', down: 'pull-down', none: 'disabled' };
// gpiomon and gpioset keep running while they hold a pin. If they are still
// alive after this long, the request was accepted.
const SETTLE_MS = 80;

// Turns the tools' error text into something a person can act on.
function explain(cmd, text) {
  if (/resource busy/i.test(text)) {
    return 'The pin is in use by other software';
  }
  if (/permission denied/i.test(text)) {
    return 'No permission to use GPIO (add the service user to the "gpio" group)';
  }
  return text.trim() || `${cmd} failed`;
}

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 5000 }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(err.code === 'ENOENT' ? `${cmd} is not installed` : explain(cmd, stderr || err.message)));
        return;
      }
      resolve(stdout);
    });
  });
}

// Parses `gpioinfo` (libgpiod v2) output into line descriptions.
function parseLines(output) {
  const lines = [];
  for (const row of output.split('\n')) {
    const match = /^\s*line\s+(\d+):\s+(?:"([^"]*)"|(\S+))\s+(input|output)(.*)$/.exec(row);
    if (!match) {
      continue;
    }
    const gpio = Number(match[1]);
    if (gpio < GPIO_MIN || gpio > GPIO_MAX) {
      continue;
    }
    const consumer = (/consumer="?([^"\s]+)"?/.exec(match[5]) || [])[1] || '';
    lines.push({
      gpio,
      name: match[2] || match[3] || '',
      used: Boolean(consumer),
      consumer,
      own: consumer === CONSUMER
    });
  }
  return lines;
}

// Picks the chip that carries the 40-pin header from `gpiodetect` output.
function parseChip(output) {
  const chips = output.split('\n')
    .map((row) => /^(\S+)\s+\[([^\]]*)\]/.exec(row))
    .filter(Boolean)
    .map((m) => ({ name: m[1], label: m[2] }));
  const header = chips.find((c) => /^pinctrl-(bcm2|rp1)/.test(c.label));
  return (header || chips[0] || {}).name;
}

class LibgpiodBackend extends EventEmitter {
  constructor() {
    super();
    this.chip = '';
    this.children = new Map(); // gpio -> child process holding the pin
    this.queue = new Map(); // gpio -> promise chain, one request at a time per pin
  }

  async init() {
    const version = await run('gpiomon', ['--version']);
    const major = Number((/v(\d+)\./.exec(version) || [])[1]);
    if (!(major >= 2)) {
      throw new Error('libgpiod v2 tools are required (Raspberry Pi OS 13 "Trixie" or later). ' +
        `Found: ${version.split('\n')[0] || 'unknown version'}`);
    }
    this.chip = parseChip(await run('gpiodetect', []));
    if (!this.chip) {
      throw new Error('No GPIO chip found');
    }
  }

  async lines() {
    return parseLines(await run('gpioinfo', ['-c', this.chip]));
  }

  watch(gpio, { pull }) {
    return this.serial(gpio, async () => {
      await this.stop(gpio);
      const bias = BIAS[pull] || BIAS.none;
      // Read the starting level first; gpiomon only reports changes.
      const stdout = await run('gpioget', ['-c', this.chip, '-b', bias, '-p', '10ms', '--numeric', String(gpio)]);
      const level = stdout.trim() === '1' ? 1 : 0;

      const child = await this.hold(gpio, 'gpiomon',
        ['-c', this.chip, '-b', bias, '-e', 'both', '-C', CONSUMER, '-F', '%o %e', String(gpio)]);
      readline.createInterface({ input: child.stdout }).on('line', (line) => {
        const [offset, edge] = line.trim().split(/\s+/); // edge: 1 rising, 2 falling
        if (Number(offset) === gpio && (edge === '1' || edge === '2')) {
          this.emit('edge', gpio, edge === '1' ? 1 : 0);
        }
      });
      return level;
    });
  }

  output(gpio, level) {
    return this.serial(gpio, async () => {
      // The pin is briefly released between the old and new value.
      await this.stop(gpio);
      await this.hold(gpio, 'gpioset', ['-c', this.chip, '-C', CONSUMER, `${gpio}=${level ? 1 : 0}`]);
    });
  }

  release(gpio) {
    return this.serial(gpio, () => this.stop(gpio));
  }

  async close() {
    await Promise.all([...this.children.keys()].map((gpio) => this.release(gpio)));
  }

  // Runs requests for one pin strictly one after another.
  serial(gpio, task) {
    const next = (this.queue.get(gpio) || Promise.resolve()).catch(() => {}).then(task);
    this.queue.set(gpio, next);
    return next;
  }

  // Starts a tool that holds the pin for as long as it runs.
  hold(gpio, cmd, args) {
    return new Promise((resolve, reject) => {
      const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      let stderr = '';
      let settled = false;
      child.stderr.on('data', (chunk) => { stderr += chunk; });

      const timer = setTimeout(() => {
        settled = true;
        this.children.set(gpio, child);
        resolve(child);
      }, SETTLE_MS);

      const ended = (reason) => {
        clearTimeout(timer);
        if (!settled) {
          settled = true;
          reject(new Error(reason));
        } else if (this.children.get(gpio) === child) {
          // It was holding the pin and stopped without being asked to.
          this.children.delete(gpio);
          this.emit('fault', gpio, reason);
        }
      };
      child.once('error', (err) => ended(err.code === 'ENOENT' ? `${cmd} is not installed` : err.message));
      child.once('exit', (code) => ended(stderr.trim() ? explain(cmd, stderr) : `${cmd} stopped (exit ${code})`));
    });
  }

  stop(gpio) {
    const child = this.children.get(gpio);
    if (!child) {
      return Promise.resolve();
    }
    this.children.delete(gpio);
    if (child.exitCode !== null || child.signalCode !== null) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      child.once('exit', resolve);
      child.kill('SIGTERM');
    });
  }
}

// Stand-in for development and tests: no hardware, levels are set by inject().
class MockBackend extends EventEmitter {
  constructor() {
    super();
    this.levels = new Map();
    this.watching = new Set();
    this.outputs = new Map();
    this.busy = new Map([[3, 'mock-other'], [4, 'mock-other']]);
  }

  async init() {}

  async lines() {
    const lines = [];
    for (let gpio = GPIO_MIN; gpio <= GPIO_MAX; gpio++) {
      const own = this.watching.has(gpio) || this.outputs.has(gpio);
      const consumer = own ? CONSUMER : (this.busy.get(gpio) || '');
      lines.push({ gpio, name: `GPIO${gpio}`, used: Boolean(consumer), consumer, own });
    }
    return lines;
  }

  async watch(gpio, { pull }) {
    this.claim(gpio);
    this.outputs.delete(gpio);
    this.watching.add(gpio);
    if (!this.levels.has(gpio)) {
      this.levels.set(gpio, pull === 'up' ? 1 : 0);
    }
    return this.levels.get(gpio);
  }

  async output(gpio, level) {
    this.claim(gpio);
    this.watching.delete(gpio);
    this.outputs.set(gpio, level ? 1 : 0);
  }

  async release(gpio) {
    this.watching.delete(gpio);
    this.outputs.delete(gpio);
  }

  async close() {
    this.watching.clear();
    this.outputs.clear();
  }

  claim(gpio) {
    if (this.busy.has(gpio)) {
      throw new Error(`GPIO${gpio} is in use by ${this.busy.get(gpio)}`);
    }
  }

  // Pretend the level on an input pin changed.
  inject(gpio, level) {
    const value = level ? 1 : 0;
    if (this.levels.get(gpio) === value) {
      return;
    }
    this.levels.set(gpio, value);
    if (this.watching.has(gpio)) {
      this.emit('edge', gpio, value);
    }
  }
}

module.exports = { LibgpiodBackend, MockBackend, parseLines, parseChip, CONSUMER };
