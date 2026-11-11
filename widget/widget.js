'use strict';

/* global HEADER_PINS, gpioPins, pinNote, renderPinout */

(function () {
  const params = new URLSearchParams(window.location.search);
  const embedded = window.parent !== window;
  // CNCjs adds ?token= to the widget URL. When the page is opened on its own,
  // fall back to the token CNCjs keeps in this browser.
  const token = params.get('token') || storedToken();

  const COLORS = ['green', 'red', 'amber', 'blue', 'grey'];
  const GRIDS = [[12, 'Full width'], [6, 'Half'], [4, 'Third'], [3, 'Quarter']];
  const WHEN = [['active', 'becomes active'], ['inactive', 'becomes inactive'], ['both', 'changes']];
  const ACTION_TYPES = [
    ['notify', 'Browser alert'], ['system', 'System command'],
    ['cncjs', 'CNCjs command'], ['gcode', 'G-code']
  ];
  const CNCJS_COMMANDS = [
    ['gcode:pause', 'Pause job'], ['gcode:resume', 'Resume job'], ['gcode:stop', 'Stop job'],
    ['feedhold', 'Feed hold'], ['cyclestart', 'Cycle start'], ['unlock', 'Unlock'],
    ['homing', 'Homing'], ['reset', 'Reset']
  ];
  const STATE_DEFAULTS = {
    input: { active: { label: 'Active', color: 'red' }, inactive: { label: 'Inactive', color: 'green' } },
    output: { active: { label: 'On', color: 'green' }, inactive: { label: 'Off', color: 'grey' } }
  };
  // Pins with no second job on the board come first when suggesting one.
  const PREFERRED = [17, 27, 22, 23, 24, 25, 5, 6, 12, 13, 16, 19, 20, 21, 26, 18];

  let status = null; // last report from the service
  let online = false;
  let fatal = ''; // a problem that retrying will not fix
  let flashText = '';
  let flashTimer = null;
  let lines = []; // which GPIO lines other software is using
  let draft = null; // settings being edited; null while the form is closed
  let openPin = null; // id of the pin expanded in the form
  let formError = '';
  const HOLD_MS = 1500; // press and hold this long to open settings when the status row is hidden
  const alerts = new Map(); // pin id -> { label, active, test }

  const $ = (id) => document.getElementById(id);

  function storedToken() {
    try {
      const cnc = JSON.parse(window.localStorage.getItem('cnc') || '{}');
      return ((cnc.state || {}).session || {}).token || '';
    } catch (err) {
      return '';
    }
  }

  // Not crypto.randomUUID(): that only exists on HTTPS pages.
  const uid = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

  const headerPin = (gpio) => (HEADER_PINS.find((p) => p.gpio === gpio) || {}).pin;

  // Adds children to an element. Lists may be nested; null and false are skipped.
  function fill(el, ...children) {
    children.flat(Infinity).forEach((child) => {
      if (child !== null && child !== undefined && child !== false) {
        el.append(child);
      }
    });
    return el;
  }

  function h(tag, props, ...children) {
    const el = fill(document.createElement(tag), children);
    Object.entries(props || {}).forEach(([key, value]) => {
      if (key === 'class') {
        el.className = value;
      } else if (key === 'value') {
        el.value = value;
      } else if (key === 'checked') {
        el.checked = Boolean(value);
      } else if (key.startsWith('on')) {
        el.addEventListener(key.slice(2), value);
      } else if (value === true) {
        el.setAttribute(key, '');
      } else if (value !== false && value !== null && value !== undefined) {
        el.setAttribute(key, value);
      }
    });
    return el;
  }

  // ---- talking to the service -------------------------------------------

  async function api(method, path, body, timeoutMs = 6000) {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), timeoutMs);
    try {
      const res = await fetch(path, {
        method,
        headers: Object.assign({ Authorization: `Bearer ${token}` }, body ? { 'Content-Type': 'application/json' } : {}),
        body: body ? JSON.stringify(body) : undefined,
        signal: abort.signal
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const err = new Error(data.error || `Request failed (HTTP ${res.status})`);
        err.status = res.status;
        throw err;
      }
      return data;
    } catch (err) {
      if (err.name === 'AbortError') {
        throw new Error('The GPIO service did not answer');
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  // One connection at a time, with growing pauses between attempts. If the
  // service is down, requests through the CNCjs mount hang rather than fail,
  // so every attempt is short and nothing retries in a tight loop.
  let stream = null;
  let watchdog = null;
  let retryTimer = null;
  let retryDelay = 5000;

  async function start() {
    clearTimeout(retryTimer);
    try {
      onStatus(await api('GET', 'api/status'));
    } catch (err) {
      if (err.status === 401) {
        fatal = err.message;
        online = false;
        render();
        return;
      }
      offline();
      return;
    }
    listen();
  }

  function listen() {
    const alive = (ms) => {
      clearTimeout(watchdog);
      watchdog = setTimeout(offline, ms);
    };
    stream = new EventSource(`api/events?token=${encodeURIComponent(token)}`);
    alive(10000);
    stream.addEventListener('status', (event) => {
      alive(35000);
      retryDelay = 5000;
      onStatus(JSON.parse(event.data));
    });
    stream.addEventListener('ping', () => alive(35000)); // the service pings every 10 s
    stream.addEventListener('notify', (event) => notify(JSON.parse(event.data)));
    stream.onerror = offline;
  }

  function offline() {
    if (stream) {
      stream.close();
      stream = null;
    }
    clearTimeout(watchdog);
    clearTimeout(retryTimer);
    online = false;
    render();
    retryTimer = setTimeout(start, retryDelay);
    retryDelay = Math.min(retryDelay * 2, 30000);
  }

  function onStatus(next) {
    const first = !status;
    status = next;
    online = true;
    fatal = '';
    // An alert ends when its pin leaves the state that raised it.
    const live = new Map(status.pins.map((p) => [p.id, p]));
    alerts.forEach((alert, id) => {
      if (!alert.test && (!live.has(id) || live.get(id).active !== alert.active)) {
        alerts.delete(id);
      }
    });
    render();
    if (first) {
      post('connect');
    }
  }

  // ---- messages to CNCjs (same ones the widget boilerplate sends) -------

  function post(type, payload) {
    if (embedded) {
      window.parent.postMessage({ token, action: { type, payload: payload || {} } }, window.location.origin);
    }
  }

  function watchSize() {
    if (!embedded || typeof ResizeObserver === 'undefined') {
      return;
    }
    new ResizeObserver(() => {
      const body = document.body;
      post('resize', {
        clientHeight: body.clientHeight,
        clientWidth: body.clientWidth,
        offsetHeight: body.offsetHeight,
        offsetWidth: body.offsetWidth,
        scrollHeight: body.scrollHeight,
        scrollWidth: body.scrollWidth
      });
    }).observe(document.body);
  }

  // ---- alerts ------------------------------------------------------------

  function notify(notice) {
    alerts.set(notice.pinId, { label: notice.label, active: notice.active, test: notice.test });
    if (notice.test) {
      setTimeout(() => {
        const alert = alerts.get(notice.pinId);
        if (alert && alert.test) {
          alerts.delete(notice.pinId);
          render();
        }
      }, 8000);
    }
    if ('Notification' in window && Notification.permission === 'granted') {
      try {
        new Notification(notice.name, { body: notice.label, tag: `cncjs-gpio-${notice.pinId}` });
      } catch (err) {
        // Some browsers only allow notifications from a service worker.
      }
    }
    render();
  }

  // Flags the browser tab while an alert is showing.
  function updateTitle() {
    let doc = document;
    if (embedded) {
      try {
        doc = window.top.document;
      } catch (err) {
        return;
      }
    }
    const plain = doc.title.replace(/^⚠ .*? \| /, '');
    const alert = alerts.values().next().value;
    const wanted = alert ? `⚠ ${alert.label} | ${plain}` : plain;
    if (doc.title !== wanted) {
      doc.title = wanted;
    }
  }

  function flash(text) {
    flashText = text;
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => {
      flashText = '';
      renderBar();
    }, 6000);
    renderBar();
  }

  // ---- compact view ------------------------------------------------------

  function render() {
    renderTiles();
    renderBar();
    updateTitle();
  }

  function renderTiles() {
    const box = $('tiles');
    box.replaceChildren();
    if (!status) {
      return;
    }
    if (status.gpioError) {
      box.append(h('div', { class: 'note is-error' }, `GPIO is not available: ${status.gpioError}`));
    }
    const pins = status.config.pins.filter((pin) => pin.enabled);
    if (!pins.length && !status.gpioError) {
      box.append(h('div', { class: 'note' }, 'No pins set up yet. Use the gear to add one.'));
    }
    const live = new Map(status.pins.map((p) => [p.id, p]));
    pins.forEach((pin) => box.append(tile(pin, live.get(pin.id) || {})));
  }

  function tile(pin, state) {
    const known = state.active === true || state.active === false;
    const look = known ? (state.active ? pin.active : pin.inactive) : { label: '', color: 'grey' };
    const label = state.error ? 'unavailable' : (known ? look.label : '...');
    const where = `GPIO${pin.gpio} (header pin ${headerPin(pin.gpio)})`;
    let detail = '';
    if (state.error) {
      detail = state.error;
    } else if (known) {
      detail = `${state.active ? 'Active' : 'Inactive'} since ${new Date(state.since).toLocaleTimeString()}`;
    }
    const isOutput = pin.mode === 'output';
    const muted = !isOutput && pin.actions.length > 0 && !pin.actionsEnabled;

    return h(isOutput ? 'button' : 'div', {
      class: [
        'tile', `span-${pin.grid}`, `color-${state.error ? 'error' : look.color}`,
        isOutput ? 'is-button' : 'is-indicator', alerts.has(pin.id) ? 'is-alert' : ''
      ].join(' ').trim(),
      type: isOutput ? 'button' : null,
      title: `${pin.name} - ${where}${detail ? `\n${detail}` : ''}${muted ? '\nActions are turned off' : ''}` +
        `${barHidden() ? '\nPress and hold to open settings' : ''}`,
      disabled: isOutput && (Boolean(state.error) || !known),
      onclick: isOutput ? () => press(pin) : null
    },
    h('span', { class: 'tile-name' }, pin.name),
    label ? h('span', { class: 'tile-label' }, label) : null,
    muted ? h('span', { class: 'tile-muted' }, 'actions off') : null);
  }

  async function press(pin) {
    try {
      onStatus(await api('POST', `api/pins/${pin.id}/output`, {
        value: pin.outputMode === 'momentary' ? 'pulse' : 'toggle'
      }));
    } catch (err) {
      flash(err.message);
    }
  }

  // The status row (dot and cog) can be hidden to save space. It comes back
  // whenever there is something to say or no other way to reach the settings.
  function barHidden() {
    return Boolean(embedded && status && status.config.hideBar && online && !fatal && !flashText &&
      !draft && !status.gpioError && status.config.pins.some((pin) => pin.enabled));
  }

  function renderBar() {
    const hidden = barHidden();
    $('bar').classList.toggle('is-tucked', hidden);
    document.body.classList.toggle('is-tucked', hidden);
    let text = flashText || fatal;
    if (!text && !online) {
      text = status ? 'Lost contact with the GPIO service, retrying' : 'Connecting to the GPIO service';
    }
    if (!text && status && status.mock) {
      text = 'Mock GPIO (no hardware)';
    }
    $('dot').className = `dot ${online ? 'is-on' : 'is-off'}`;
    $('dot').title = online ? 'Live' : 'Not connected';
    $('message').textContent = text;
    $('gear').disabled = !status;
  }

  // ---- settings form -----------------------------------------------------

  function withDefaults(pin) {
    const states = STATE_DEFAULTS[pin.mode];
    return Object.assign({
      pull: 'down',
      stableMs: 50,
      actionsEnabled: true,
      actions: [],
      outputMode: 'toggle',
      pulseMs: 500,
      initial: 0,
      active: Object.assign({}, states.active),
      inactive: Object.assign({}, states.inactive)
    }, pin);
  }

  function openSettings() {
    draft = {
      hideBar: Boolean(status.config.hideBar),
      pins: JSON.parse(JSON.stringify(status.config.pins)).map(withDefaults)
    };
    openPin = draft.pins.length === 1 ? draft.pins[0].id : null;
    formError = '';
    renderSettings();
    api('GET', 'api/lines').then((data) => {
      lines = data.lines;
      if (draft) {
        renderSettings();
      }
    }).catch(() => {});
  }

  function closeSettings() {
    draft = null;
    renderSettings();
  }

  // Why a GPIO cannot be chosen for `pin`: taken in this form, or by other software.
  function takenFor(pin) {
    const taken = new Map();
    lines.filter((line) => line.used && !line.own).forEach((line) => {
      taken.set(line.gpio, `in use by ${line.consumer}`);
    });
    draft.pins.filter((other) => other !== pin).forEach((other) => {
      taken.set(other.gpio, `used by "${other.name || `GPIO${other.gpio}`}"`);
    });
    return taken;
  }

  function addPin() {
    const taken = takenFor(null);
    const all = PREFERRED.concat(gpioPins().map((p) => p.gpio));
    const gpio = all.find((n) => !taken.has(n));
    if (gpio === undefined) {
      formError = 'Every GPIO pin is already in use.';
      renderSettings();
      return;
    }
    const pin = withDefaults({ id: uid(), gpio, name: '', mode: 'input', enabled: true, grid: 12, activeLow: false });
    draft.pins.push(pin);
    openPin = pin.id;
    renderSettings();
  }

  function addAction(pin) {
    pin.actions.push({ id: uid(), enabled: true, on: 'active', type: 'notify' });
    renderSettings();
  }

  function setMode(pin, mode) {
    // Swap the stock labels with the mode, but keep anything the user typed.
    ['active', 'inactive'].forEach((key) => {
      const was = STATE_DEFAULTS[pin.mode][key];
      if (pin[key].label === was.label && pin[key].color === was.color) {
        pin[key] = Object.assign({}, STATE_DEFAULTS[mode][key]);
      }
    });
    pin.mode = mode;
  }

  async function save() {
    try {
      const next = await api('PUT', 'api/config', { hideBar: draft.hideBar, pins: draft.pins });
      draft = null;
      formError = '';
      onStatus(next);
      renderSettings();
    } catch (err) {
      formError = err.message;
      renderSettings();
    }
  }

  // -- form controls. Typing updates the draft without redrawing the form;
  //    `redraw` is passed for choices that change which fields are shown.

  function textInput(obj, key, attrs) {
    return h('input', Object.assign({
      type: 'text',
      value: obj[key] === undefined ? '' : obj[key],
      oninput: (event) => { obj[key] = event.target.value; }
    }, attrs));
  }

  function numberInput(obj, key, attrs) {
    return h('input', Object.assign({
      type: 'number',
      value: obj[key] === undefined ? '' : obj[key],
      oninput: (event) => { obj[key] = event.target.value === '' ? '' : Number(event.target.value); }
    }, attrs));
  }

  function textArea(obj, key, attrs) {
    return h('textarea', Object.assign({
      rows: 3,
      spellcheck: 'false',
      value: obj[key] === undefined ? '' : obj[key],
      oninput: (event) => { obj[key] = event.target.value; }
    }, attrs));
  }

  // options: [[value, text, disabled]]
  function select(obj, key, options, redraw) {
    const numeric = typeof options[0][0] === 'number';
    return h('select', {
      value: String(obj[key]),
      onchange: (event) => {
        obj[key] = numeric ? Number(event.target.value) : event.target.value;
        if (redraw) {
          redraw();
        }
      }
    }, options.map(([value, text, disabled]) => h('option', { value: String(value), disabled: Boolean(disabled) }, text)));
  }

  function checkbox(obj, key, text, redraw) {
    return h('label', { class: 'check' },
      h('input', {
        type: 'checkbox',
        checked: obj[key],
        onchange: (event) => {
          obj[key] = event.target.checked;
          if (redraw) {
            redraw();
          }
        }
      }),
      h('span', null, text));
  }

  const field = (label, control, hint) => h('div', { class: 'field' },
    h('span', { class: 'field-label' }, label), control, hint ? h('span', { class: 'hint' }, hint) : null);

  const colorSelect = (state) => select(state, 'color', COLORS.map((c) => [c, c[0].toUpperCase() + c.slice(1)]));

  const stateRow = (label, state) => field(label, h('div', { class: 'row' },
    textInput(state, 'label', { maxlength: 60, placeholder: 'Message' }), colorSelect(state)));

  function renderSettings() {
    const box = $('settings');
    render(); // the status row shows while the form is open
    box.replaceChildren();
    box.hidden = !draft;
    document.body.classList.toggle('is-editing', Boolean(draft));
    if (!draft) {
      return;
    }
    fill(box,
      h('div', { class: 'settings-head' }, h('strong', null, 'Pin settings')),
      draft.pins.map(pinCard),
      h('button', { type: 'button', class: 'button', onclick: addPin }, '+ Add pin'),
      checkbox(draft, 'hideBar',
        `Hide the status row. Press and hold the widget for ${HOLD_MS / 1000} seconds to open settings.`),
      popupRow(),
      formError ? h('div', { class: 'note is-error' }, formError) : null,
      h('div', { class: 'row settings-foot' },
        h('button', { type: 'button', class: 'button is-primary', onclick: save }, 'Save changes'),
        h('button', { type: 'button', class: 'button', onclick: closeSettings }, 'Cancel')),
      h('div', { class: 'hint' }, `v${status.version} - CNCjs link ${status.cncjs.connected ? 'connected' : 'not connected'}`)
    );
  }

  function pinCard(pin, index) {
    const open = pin.id === openPin;
    const move = (step) => () => {
      draft.pins.splice(index + step, 0, draft.pins.splice(index, 1)[0]);
      renderSettings();
    };
    const head = h('div', { class: 'card-head' },
      h('button', {
        type: 'button',
        class: 'card-title',
        'aria-expanded': String(open),
        onclick: () => {
          openPin = open ? null : pin.id;
          renderSettings();
        }
      },
      `${open ? '▾' : '▸'} ${pin.name || 'New pin'}`,
      h('span', { class: 'card-sub' }, ` GPIO${pin.gpio}, ${pin.mode}${pin.enabled ? '' : ', disabled'}`)),
      h('button', { type: 'button', class: 'icon-button', title: 'Move up', disabled: index === 0, onclick: move(-1) }, '▲'),
      h('button', { type: 'button', class: 'icon-button', title: 'Move down', disabled: index === draft.pins.length - 1, onclick: move(1) }, '▼'),
      h('button', {
        type: 'button',
        class: 'icon-button',
        title: 'Remove pin',
        onclick: () => {
          draft.pins.splice(index, 1);
          renderSettings();
        }
      }, '✕'));
    return h('div', { class: `card${open ? ' is-open' : ''}` }, head, open ? pinForm(pin) : null);
  }

  function pinForm(pin) {
    const taken = takenFor(pin);
    const note = pinNote(pin.gpio);
    const isInput = pin.mode === 'input';

    const gpioOptions = gpioPins().map((p) => {
      const reason = taken.get(p.gpio);
      return [p.gpio, `GPIO${p.gpio} (header pin ${p.pin})${reason ? ` - ${reason}` : ''}`, Boolean(reason) && p.gpio !== pin.gpio];
    });

    return h('div', { class: 'card-body' },
      field('Name', textInput(pin, 'name', { maxlength: 40, placeholder: 'e.g. Dust bin' })),
      h('div', { class: 'row' },
        field('Type', h('select', {
          value: pin.mode,
          onchange: (event) => {
            setMode(pin, event.target.value);
            renderSettings();
          }
        }, h('option', { value: 'input' }, 'Input'), h('option', { value: 'output' }, 'Output'))),
        field('Tile width', select(pin, 'grid', GRIDS))),
      checkbox(pin, 'enabled', 'Enabled', renderSettings),

      field('GPIO pin', select(pin, 'gpio', gpioOptions, renderSettings),
        'The GPIO number is not the position on the header. The diagram shows both.'),
      taken.has(pin.gpio) ? h('div', { class: 'note is-error' }, `GPIO${pin.gpio} is ${taken.get(pin.gpio)}.`) : null,
      note ? h('div', { class: 'note' }, note) : null,
      renderPinout({
        selected: pin.gpio,
        taken,
        onPick: (gpio) => {
          pin.gpio = gpio;
          renderSettings();
        }
      }),
      h('div', { class: 'hint' }, 'Header seen with the USB ports at the bottom: pin 1 is top left. Click a green pin to choose it. Grey pins are in use.'),

      isInput ? inputFields(pin) : outputFields(pin));
  }

  function inputFields(pin) {
    return [
      h('div', { class: 'row' },
        field('Pull resistor', select(pin, 'pull', [
          ['down', 'Pull-down'], ['up', 'Pull-up'], ['none', 'None']
        ])),
        field('Must hold for (ms)', numberInput(pin, 'stableMs', { min: 0, max: 600000, step: 50 }))),
      h('div', { class: 'hint' }, 'A new level only counts after lasting this long, which filters out flicker.'),
      checkbox(pin, 'activeLow', 'Active when the pin is LOW'),
      stateRow('Shown when active', pin.active),
      stateRow('Shown when inactive', pin.inactive),

      h('div', { class: 'section' }, 'Actions'),
      checkbox(pin, 'actionsEnabled', 'Run actions (turn off to only watch the pin)'),
      pin.actions.map((action, index) => actionCard(pin, action, index)),
      h('button', { type: 'button', class: 'button', onclick: () => addAction(pin) }, '+ Add action')
    ];
  }

  function outputFields(pin) {
    const momentary = pin.outputMode === 'momentary';
    return [
      h('div', { class: 'row' },
        field('Button', select(pin, 'outputMode', [
          ['toggle', 'Toggle (stays on)'], ['momentary', 'Momentary (pulse)']
        ], renderSettings)),
        momentary
          ? field('On for (ms)', numberInput(pin, 'pulseMs', { min: 100, max: 60000, step: 100 }))
          : field('When the service starts', select(pin, 'initial', [[0, 'Off'], [1, 'On']]))),
      checkbox(pin, 'activeLow', 'On drives the pin LOW'),
      stateRow('Shown when on', pin.active),
      stateRow('Shown when off', pin.inactive),
      h('div', { class: 'hint' }, 'The pin is released (floats) whenever the service is stopped.')
    ];
  }

  function actionCard(pin, action, index) {
    const last = status.results[action.id];
    const result = h('span', { class: `result${last ? (last.ok ? ' is-ok' : ' is-bad') : ''}` },
      last ? `Last run ${new Date(last.time).toLocaleTimeString()}: ${last.ok ? 'ok' : 'failed'} ${last.detail}` : '');

    const test = async (event) => {
      const button = event.target;
      button.disabled = true;
      result.className = 'result';
      result.textContent = 'Running...';
      try {
        const out = await api('POST', 'api/actions/test', {
          pin: Object.assign({}, pin, { actions: [] }),
          action
        }, 65000);
        result.className = `result ${out.ok ? 'is-ok' : 'is-bad'}`;
        result.textContent = `${out.ok ? 'Worked' : 'Failed'}${out.detail ? `: ${out.detail}` : ''}`;
      } catch (err) {
        result.className = 'result is-bad';
        result.textContent = err.message;
      }
      button.disabled = false;
    };

    let body = null;
    if (action.type === 'system') {
      body = [
        textArea(action, 'command', { placeholder: 'curl -s --form-string "message=$GPIO_LABEL" ...' }),
        h('span', { class: 'hint' }, 'Runs on the Pi as the service user. Available: $GPIO_NAME $GPIO_PIN $GPIO_STATE $GPIO_LABEL')
      ];
    } else if (action.type === 'cncjs') {
      body = [
        select(action, 'command', CNCJS_COMMANDS),
        h('span', { class: 'hint' }, 'Sent to the machine CNCjs is connected to.')
      ];
    } else if (action.type === 'gcode') {
      body = [
        textArea(action, 'gcode', { placeholder: 'M5' }),
        h('span', { class: 'hint' }, 'Sent to the machine CNCjs is connected to.')
      ];
    } else {
      body = h('span', { class: 'hint' }, 'Shows the pin\'s message in every open CNCjs browser tab.');
    }

    return h('div', { class: 'action' },
      h('div', { class: 'row' },
        checkbox(action, 'enabled', 'When pin'),
        select(action, 'on', WHEN),
        h('button', {
          type: 'button',
          class: 'icon-button',
          title: 'Remove action',
          onclick: () => {
            pin.actions.splice(index, 1);
            renderSettings();
          }
        }, '✕')),
      h('select', {
        value: action.type,
        'aria-label': 'Action type',
        onchange: (event) => {
          action.type = event.target.value;
          delete action.gcode;
          delete action.command;
          if (action.type === 'cncjs') {
            action.command = 'gcode:pause';
          }
          renderSettings();
        }
      }, ACTION_TYPES.map(([value, text]) => h('option', { value }, text))),
      body,
      h('div', { class: 'row' },
        h('button', { type: 'button', class: 'button', onclick: test }, 'Test'),
        result));
  }

  function popupRow() {
    if (!('Notification' in window) || !window.isSecureContext) {
      return h('div', { class: 'hint' },
        'Desktop pop-ups need HTTPS or localhost. On this address a browser alert flashes the tile and flags the tab title instead.');
    }
    if (Notification.permission === 'granted') {
      return h('div', { class: 'hint' }, 'Desktop pop-ups are on for this browser.');
    }
    if (Notification.permission === 'denied') {
      return h('div', { class: 'hint' }, 'Desktop pop-ups are blocked in this browser\'s site settings.');
    }
    return h('button', {
      type: 'button',
      class: 'button',
      onclick: () => Notification.requestPermission().then(renderSettings)
    }, 'Allow desktop pop-ups for browser alerts');
  }

  // ---- press and hold (only while the status row is hidden) ---------------

  function watchHold() {
    const box = $('tiles');
    let timer = null;
    let origin = null;
    let swallowClick = false;

    const cancel = () => {
      clearTimeout(timer);
      timer = null;
      box.classList.remove('is-holding');
    };

    box.addEventListener('pointerdown', (event) => {
      cancel();
      if (!barHidden() || event.button !== 0) {
        return;
      }
      origin = { x: event.clientX, y: event.clientY };
      box.classList.add('is-holding');
      timer = setTimeout(() => {
        cancel();
        swallowClick = true; // releasing must not also press the button underneath
        openSettings();
      }, HOLD_MS);
    });
    box.addEventListener('pointermove', (event) => {
      if (timer && Math.hypot(event.clientX - origin.x, event.clientY - origin.y) > 10) {
        cancel(); // a drag or scroll, not a hold
      }
    });
    ['pointerup', 'pointercancel', 'pointerleave'].forEach((name) => box.addEventListener(name, () => {
      cancel();
      if (swallowClick) {
        setTimeout(() => { swallowClick = false; }, 50);
      }
    }));
    box.addEventListener('contextmenu', (event) => {
      if (timer || swallowClick) {
        event.preventDefault(); // touch screens open a menu on long press
      }
    });
    box.addEventListener('click', (event) => {
      if (swallowClick) {
        swallowClick = false;
        event.stopPropagation();
        event.preventDefault();
      }
    }, true);
  }

  // ---- start -------------------------------------------------------------

  $('gear').addEventListener('click', () => (draft ? closeSettings() : openSettings()));
  document.addEventListener('click', () => {
    if (alerts.size) {
      alerts.clear();
      render();
    }
  });
  window.addEventListener('message', (event) => {
    // CNCjs posts port changes here. Nothing to do with them, but as in the
    // boilerplate, anything without the right token is ignored.
    if (!event.data || event.data.token !== token) {
      return;
    }
  });

  watchSize();
  watchHold();
  render();
  if (token) {
    start();
  } else {
    fatal = 'Open this page from CNCjs (no access token found).';
    render();
  }
}());
