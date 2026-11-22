/* Axon Servo Programmer — renderer */
(function () {
  'use strict';
  const A = window.Axon;
  const H = window.AxonHid;

  /* -------- native bridge (with browser fallbacks for development) */
  const LS = {
    get: (k, d) => { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
    set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* ignore */ } },
  };
  const native = window.native || {
    appInfo: async () => ({ version: 'dev', repo: 'https://github.com/PetrBytes/axon-servo-programmer-mac' }),
    openRepo: async () => window.open('https://github.com/PetrBytes/axon-servo-programmer-mac'),
    openBackups: async () => {},
    getSettings: async () => LS.get('settings', { theme: 'system', showLog: true, autoRead: true }),
    setSettings: async (p) => { const s = { ...LS.get('settings', { theme: 'system', showLog: true, autoRead: true }), ...p }; LS.set('settings', s); return s; },
    readLog: async () => LS.get('log', []),
    appendLog: async (lines) => LS.set('log', [...LS.get('log', []), ...lines].slice(-3000)),
    clearLog: async () => LS.set('log', []),
    clearCache: async () => true,
    clearBackups: async () => 0,
    countBackups: async () => 0,
    saveProfile: async (n, d) => { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([JSON.stringify(d, null, 2)])); a.download = n + '.axonprofile.json'; a.click(); return a.download; },
    openProfile: async () => null,
    saveBackup: async () => null,
    listBackups: async () => [],
    confirm: async ({ message }) => window.confirm(message),
    onMenu: () => {},
  };

  const $ = (id) => document.getElementById(id);
  const clone = (o) => JSON.parse(JSON.stringify(o));
  const POLL_MS = 400; // Windows polls every 300 ms

  /* --------------------------------------------------------------- state */
  const st = {
    mode: 'none', // none | usb | demo
    transport: null,
    prog: null,
    device: null,
    mock: null,
    servo: null, // last read result
    base: null, // settings as stored on the servo
    form: null, // working copy
    busy: false,
    present: false, // servo detected by polling
    misses: 0,
    pollTimer: null,
    settings: { theme: 'system', showLog: true, autoRead: true },
    logCount: 0,
  };

  /* -------------------------------------------------------------- schema
   * label = name used in the Windows software, so teams can follow
   * existing guides. `win` shows the Windows readout prefix where it differs. */
  const pctOf = (v) => `${(Math.round((v * 1000) / 255) / 10).toFixed(1)} %`;
  const SENS = ['Ultra High', 'High', 'Medium', 'Low'];
  const PPM_LABELS = ['500~2500 µs', '900~2100 µs', '1100~1900 µs'];
  const LOST = ['Release', 'Keep Position', 'Go Neutral Position'];

  const AAS = [
    {
      title: 'Motion',
      rows: [
        { key: 'range', label: 'Range', win: 'Servo Angle', help: 'How far the servo turns across the full PPM range. 255 = maximum travel.', type: 'slider', min: 1, max: 255 },
        { key: 'neutral', label: 'Middle Position', win: 'Servo Neutral', help: 'Trims the centre point. 0 = factory centre.', type: 'slider', min: -127, max: 127 },
        { key: 'deadband', label: 'Sensitivity', win: 'Deadband', help: 'How small a signal change the servo reacts to. Ultra High reacts to the tiniest change; Low ignores small jitter.', type: 'seg', options: SENS },
        { key: 'inversion', label: 'Inversion', help: 'Reverses the direction of rotation.', type: 'switch' },
      ],
    },
    {
      title: 'Power',
      rows: [
        { key: 'maxPower', label: 'Max Power', win: 'PWM Power', help: 'Maximum motor drive. Lower it to reduce current draw, heat and brownouts.', type: 'slider', min: 100, max: 255, fmt: pctOf },
        { key: 'damping', label: 'Damping Factor', help: 'How strongly the servo slows down as it reaches the target. Higher = softer stop.', type: 'slider', min: 50, max: 600 },
        { key: 'softStart', label: 'Soft Start', help: 'Moves slowly to position at power-up instead of snapping.', type: 'switch' },
      ],
    },
    {
      title: 'Signal',
      rows: [
        { key: 'ppmRange', label: 'PPM Range', help: 'The pulse width the servo treats as full travel. Match it to what your controller sends. In FTC, REV hubs output about 600~2400 µs by default and can be changed in code with ServoImplEx.setPwmRange().', type: 'seg', options: PPM_LABELS, disabledWhen: (s) => s.narrowBand || s.sanwaSSR },
        { key: 'lostPPM', label: 'Lose PPM Protection', help: 'What the servo does if the signal stops (e.g. robot disabled or cable unplugged).', type: 'select', options: LOST },
        { key: 'narrowBand', label: 'Narrow Band', win: '450~1050 µs', help: 'For narrow-band receivers. Not used in FTC. Halves Range when switched on, like the Windows software.', type: 'switch', disabledWhen: (s) => s.sanwaSSR },
        { key: 'sanwaSSR', label: 'SANWA SSR', win: '130~470 µs', help: 'Sanwa Super Response mode. Not used in FTC. Rescales Range when switched on, like the Windows software.', type: 'switch', disabledWhen: (s) => s.narrowBand },
      ],
    },
    { title: 'Over Load Protection', wide: true, custom: 'overload' },
  ];
  const UPL = [
    {
      title: 'Parameters',
      rows: [
        { key: 'inversion', label: 'Inversion', help: 'Reverses the direction of rotation.', type: 'switch' },
        { key: 'maxPower', label: 'Max Power', help: 'Maximum motor drive.', type: 'slider', min: 100, max: 255, fmt: pctOf },
        { key: 'proPTL', label: 'ProPTL', help: 'Protection threshold for this servo family (as in the Windows UPL tab).', type: 'slider', min: 0, max: 255 },
      ],
    },
  ];
  const LABELS = {
    range: 'Range', neutral: 'Middle Position', deadband: 'Sensitivity', inversion: 'Inversion',
    maxPower: 'Max Power', damping: 'Damping Factor', softStart: 'Soft Start', ppmRange: 'PPM Range',
    lostPPM: 'Lose PPM Protection', narrowBand: 'Narrow Band', sanwaSSR: 'SANWA SSR', overload: 'Over Load Protection', proPTL: 'ProPTL',
  };

  /* ------------------------------------------------------------- logging */
  const pad = (n) => String(n).padStart(2, '0');
  function stamp(d = new Date()) {
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }
  function renderLogLine(raw) {
    const [ts, kind, ...rest] = String(raw).split('|');
    const msg = rest.join('|');
    const line = document.createElement('div');
    line.className = `log-line ${kind || ''}`;
    const t = document.createElement('time');
    t.textContent = (ts || '').slice(11, 19) || ts;
    t.title = ts;
    const m = document.createElement('span');
    m.className = 'msg';
    m.textContent = msg || raw;
    line.append(t, m);
    return line;
  }
  function logAtBottom() {
    const b = $('logBody');
    return b.scrollHeight - b.scrollTop - b.clientHeight < 24;
  }
  function log(msg, kind = 'info') {
    const raw = `${stamp()}|${kind}|${msg}`;
    const b = $('logBody');
    const stick = logAtBottom();
    b.querySelector('.log-empty')?.remove();
    b.appendChild(renderLogLine(raw));
    while (b.childElementCount > 3000) b.firstElementChild.remove();
    if (stick) b.scrollTop = b.scrollHeight;
    st.logCount++;
    $('logCount').textContent = st.logCount;
    native.appendLog([raw]).catch(() => {});
  }
  async function loadLog() {
    const lines = await native.readLog().catch(() => []);
    const b = $('logBody');
    b.innerHTML = '';
    if (!lines.length) b.innerHTML = '<div class="log-empty">Nothing yet. Events show up here.</div>';
    const frag = document.createDocumentFragment();
    lines.forEach((l) => frag.appendChild(renderLogLine(l)));
    b.appendChild(frag);
    st.logCount = lines.length;
    $('logCount').textContent = st.logCount;
    b.scrollTop = b.scrollHeight;
  }

  function toast(msg, kind = '', { quiet = false } = {}) {
    const el = document.createElement('div');
    el.className = `toast ${kind}`;
    el.textContent = msg;
    $('toasts').appendChild(el);
    setTimeout(() => el.remove(), kind === 'bad' ? 7000 : 3800);
    if (!quiet) log(msg, kind || 'info');
  }
  function setStatus(kind, title, sub) {
    $('status').className = `status ${kind}`;
    $('statusTitle').textContent = title;
    $('statusSub').textContent = sub || '';
  }

  /* ---------------------------------------------------------- formatting */
  function fmtVal(key, v) {
    if (key === 'ppmRange') return PPM_LABELS[v] ?? v;
    if (key === 'lostPPM') return LOST[v] ?? v;
    if (key === 'deadband') return SENS[v] ?? v;
    if (key === 'maxPower') return `${v} (${pctOf(v)})`;
    if (typeof v === 'boolean') return v ? 'On' : 'Off';
    return String(v);
  }
  function diff(a, b) {
    if (!a || !b) return [];
    const out = [];
    for (const k of Object.keys(LABELS)) {
      if (!(k in a)) continue;
      if (a[k] !== b[k]) out.push({ key: k, label: LABELS[k], from: fmtVal(k, a[k]), to: fmtVal(k, b[k]) });
    }
    if (a.olLevels && b.olLevels && b.overload) {
      a.olLevels.forEach((lv, i) => {
        const n = b.olLevels[i];
        if (lv.power !== n.power) out.push({ key: `ol${i}p`, label: `Level ${i + 1} PWM`, from: `${lv.power} %`, to: `${n.power} %` });
        if (lv.time !== n.time) out.push({ key: `ol${i}t`, label: `Level ${i + 1} Time`, from: `${lv.time} s`, to: `${n.time} s` });
      });
    }
    return out;
  }
  const dirty = () => diff(st.base, st.form).length > 0;

  /* ----------------------------------------------------------- rendering */
  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  function buildRow(def) {
    const row = el('div', 'row');
    row.dataset.key = def.key;
    const head = el('div', 'row-head');
    const lab = el('div');
    const l = el('div', 'row-label', def.label);
    if (def.win) l.appendChild(el('span', 'win', def.win));
    lab.appendChild(l);
    lab.appendChild(el('div', 'row-help', def.help));
    head.appendChild(lab);
    row.appendChild(head);

    if (def.type === 'switch') {
      const sw = el('label', 'switch');
      const inp = document.createElement('input');
      inp.type = 'checkbox';
      inp.addEventListener('change', () => { onToggle(def.key, inp.checked); refresh(); });
      sw.append(inp, el('span'));
      head.appendChild(sw);
      row._set = (s) => { inp.checked = !!s[def.key]; inp.disabled = !!(def.disabledWhen && def.disabledWhen(s)); };
    } else if (def.type === 'slider') {
      const body = el('div', 'row-body');
      const r = Object.assign(document.createElement('input'), { type: 'range', min: def.min, max: def.max, step: 1 });
      const n = Object.assign(document.createElement('input'), { type: 'number', className: 'num', min: def.min, max: def.max, step: 1 });
      const ro = el('span', 'readout');
      const paint = (v) => {
        r.style.setProperty('--pct', `${((v - def.min) / (def.max - def.min)) * 100}%`);
        ro.textContent = def.fmt ? def.fmt(v) : '';
        ro.hidden = !def.fmt;
      };
      r.addEventListener('input', () => { const v = +r.value; n.value = v; st.form[def.key] = v; paint(v); markChanged(); });
      const commit = () => {
        let v = Math.round(Number(n.value));
        if (!Number.isFinite(v)) v = st.form[def.key];
        v = Math.min(def.max, Math.max(def.min, v));
        n.value = v; r.value = v; st.form[def.key] = v; paint(v); markChanged();
      };
      n.addEventListener('change', commit);
      n.addEventListener('keydown', (e) => { if (e.key === 'Enter') n.blur(); });
      body.append(r, n, ro);
      row.appendChild(body);
      row._set = (s) => { const v = s[def.key]; r.value = v; n.value = v; paint(v); };
    } else if (def.type === 'seg') {
      const body = el('div', 'row-body');
      const seg = el('div', 'seg');
      const btns = def.options.map((label, i) => {
        const b = el('button', '', label); b.type = 'button';
        b.addEventListener('click', () => { st.form[def.key] = i; refresh(); });
        seg.appendChild(b); return b;
      });
      body.appendChild(seg); row.appendChild(body);
      row._set = (s) => btns.forEach((b, i) => b.classList.toggle('on', s[def.key] === i));
    } else if (def.type === 'select') {
      const sel = document.createElement('select');
      def.options.forEach((o, i) => sel.appendChild(Object.assign(document.createElement('option'), { value: i, textContent: o })));
      sel.addEventListener('change', () => { st.form[def.key] = +sel.value; refresh(); });
      head.appendChild(sel);
      row._set = (s) => { sel.value = s[def.key]; };
    }
    row._def = def;
    return row;
  }

  /* Windows behaviour (ckNBClick / ckSSRClick): NB and SSR exclude each
   * other, and switching them rescales Range because the pulse window changes. */
  function onToggle(key, on) {
    const s = st.form;
    if (key === 'narrowBand') {
      if (s.sanwaSSR) return; // Windows refuses NB while SSR is on
      s.narrowBand = on;
      s.range = Math.min(255, Math.max(1, on ? Math.trunc(s.range / 2) : s.range * 2));
      return;
    }
    if (key === 'sanwaSSR') {
      if (s.narrowBand) return;
      s.sanwaSSR = on;
      s.range = Math.min(255, Math.max(1, Math.trunc(on ? s.range * 0.4048582995951417 : s.range * 2.47)));
      return;
    }
    s[key] = on;
  }

  const olP = (b) => Math.round(((b * 100) / 255) * 10) / 10;
  const olT = (b) => Math.round(b * 0.102 * 1000) / 1000;
  function buildOverload() {
    const wrap = el('div');
    wrap.appendChild(buildRow({ key: 'overload', label: 'Over Load Protection', help: 'When the servo stays stalled, power is cut back in three stages to protect the motor. Each level applies after its time.', type: 'switch' }));
    const row = el('div', 'row');
    row.dataset.key = 'olLevels';
    const t = el('table', 'levels');
    t.innerHTML = '<thead><tr><th></th><th>PWM (%)</th><th>Time (s)</th></tr></thead>';
    const tb = document.createElement('tbody');
    const inputs = [];
    for (let i = 0; i < 3; i++) {
      const tr = document.createElement('tr');
      const p = Object.assign(document.createElement('input'), { type: 'number', className: 'num', min: 0, max: 100, step: 0.1 });
      const s = Object.assign(document.createElement('input'), { type: 'number', className: 'num', min: 0, max: 26, step: 0.102 });
      const commit = () => {
        const lv = st.form.olLevels[i];
        let pv = Number(p.value); if (!Number.isFinite(pv)) pv = lv.power;
        let sv = Number(s.value); if (!Number.isFinite(sv)) sv = lv.time;
        pv = Math.min(100, Math.max(0, pv)); sv = Math.min(26, Math.max(0, sv));
        // Snap to what the servo can store so the screen shows the truth.
        const pb = Math.round((pv * 255) / 100), sb = Math.round(sv / 0.102);
        lv.power = olP(pb === lv.rawPower ? lv.rawPower : pb);
        lv.time = olT(sb === lv.rawTime ? lv.rawTime : sb);
        p.value = lv.power; s.value = lv.time; markChanged();
      };
      [p, s].forEach((x) => { x.addEventListener('change', commit); x.addEventListener('keydown', (e) => { if (e.key === 'Enter') x.blur(); }); });
      const td = (c) => { const d = document.createElement('td'); if (typeof c === 'string') d.textContent = c; else d.appendChild(c); return d; };
      tr.append(td(`Level ${i + 1}`), td(p), td(s));
      tb.appendChild(tr);
      inputs.push([p, s]);
    }
    t.appendChild(tb);
    row.appendChild(t);
    row._set = (sv) => { inputs.forEach(([p, s], i) => { p.value = sv.olLevels[i].power; s.value = sv.olLevels[i].time; }); row.classList.toggle('disabled', !sv.overload); };
    wrap.appendChild(row);
    return wrap;
  }

  function buildForm(family) {
    const form = $('form');
    form.innerHTML = '';
    for (const sec of family === A.FAMILY.UPL ? UPL : AAS) {
      const card = el('section', `card${sec.wide ? ' wide' : ''}`);
      card.appendChild(el('h2', '', sec.title));
      if (sec.custom === 'overload') card.appendChild(buildOverload());
      else sec.rows.forEach((r) => card.appendChild(buildRow(r)));
      form.appendChild(card);
    }
  }

  function refresh() {
    if (!st.form) return;
    document.querySelectorAll('#form .row').forEach((row) => {
      if (row._set) row._set(st.form);
      const def = row._def;
      if (def && def.type !== 'switch' && def.disabledWhen) row.classList.toggle('disabled', !!def.disabledWhen(st.form));
    });
    markChanged();
  }

  function markChanged() {
    const changes = diff(st.base, st.form);
    const keys = new Set(changes.map((c) => (c.key.startsWith('ol') ? 'olLevels' : c.key)));
    document.querySelectorAll('#form .row').forEach((row) => row.classList.toggle('changed', keys.has(row.dataset.key)));
    const n = changes.length;
    $('btnWriteLabel').textContent = n ? `Write ${n} Change${n > 1 ? 's' : ''}` : 'Write';
    $('btnWrite').classList.toggle('dirty', n > 0);
    updateButtons();
  }

  function updateButtons() {
    const connected = st.mode !== 'none';
    const loaded = !!st.servo && st.servo.family !== A.FAMILY.ANS;
    const d = dirty();
    $('btnRead').disabled = !connected || st.busy;
    $('btnWrite').disabled = !loaded || !d || st.busy || !st.present;
    $('btnRevert').disabled = !d || st.busy;
    $('btnFactory').disabled = !loaded || st.busy || !st.present;
    $('btnProfileSave').disabled = !loaded;
    $('unplugBanner').hidden = !(st.servo && !st.present && st.mode !== 'none');
    $('servoChip').textContent = st.present ? 'Connected' : 'Unplugged';
    $('servoChip').classList.toggle('off', !st.present);
  }

  function showServo(s) {
    st.servo = s;
    $('servoCard').hidden = false;
    $('servoName').textContent = s.name || 'Axon Servo';
    $('servoFamily').textContent = s.family;
    $('servoVersion').textContent = s.version;
    $('servoMade').textContent = s.manufactured || '—';
    if (s.family === A.FAMILY.ANS) {
      st.base = st.form = null;
      $('editor').hidden = true; $('empty').hidden = false;
      $('emptyTitle').textContent = 'This servo has no adjustable settings';
      $('emptyText').textContent = 'The Windows software does not expose parameters for this servo type either.';
      $('btnConnect').hidden = true; $('btnDemo').hidden = true;
      updateButtons();
      return;
    }
    st.base = clone(s.settings);
    st.form = clone(s.settings);
    $('empty').hidden = true; $('editor').hidden = false;
    $('editorTitle').textContent = s.name || 'Servo Settings';
    $('editorSub').textContent = s.family === A.FAMILY.UPL ? 'UPL servo. Changes are only sent when you press Write.' : 'Changes are only sent to the servo when you press Write.';
    $('demoPill').hidden = st.mode !== 'demo';
    buildForm(s.family);
    refresh();
  }

  function showEmpty(title, html) {
    st.servo = st.base = st.form = null;
    $('servoCard').hidden = true;
    $('editor').hidden = true; $('empty').hidden = false;
    $('emptyTitle').textContent = title;
    $('emptyText').innerHTML = html;
    $('btnConnect').hidden = st.mode !== 'none';
    $('btnDemo').hidden = st.mode !== 'none';
    updateButtons();
  }

  /* -------------------------------------------------------------- busy */
  async function busy(label, fn, { silent = false } = {}) {
    if (st.busy) return Promise.reject(new Error('Busy'));
    st.busy = true; updateButtons();
    const prev = [$('status').className, $('statusTitle').textContent, $('statusSub').textContent];
    setStatus('busy', label, 'Don’t unplug the servo');
    try { return await fn(); }
    catch (e) { if (silent) log(e.message || String(e), 'warn'); else toast(e.message || String(e), 'bad'); throw e; }
    finally {
      st.busy = false;
      if ($('status').classList.contains('busy')) { $('status').className = prev[0]; $('statusTitle').textContent = prev[1]; $('statusSub').textContent = prev[2]; }
      updateButtons();
    }
  }

  function connectedStatus() {
    const servoTxt = st.present ? 'Servo connected' : 'No servo connected';
    if (st.mode === 'demo') setStatus('warn', 'Demo mode', `Simulated · ${servoTxt.toLowerCase()}`);
    else if (st.mode === 'usb') setStatus(st.present ? 'ok' : 'warn', 'Programmer connected', servoTxt);
  }

  /* ---------------------------------------------------- servo polling */
  function startPolling() {
    stopPolling();
    st.present = false; st.misses = 0;
    st.pollTimer = setInterval(pollOnce, POLL_MS);
    pollOnce();
  }
  function stopPolling() {
    if (st.pollTimer) clearInterval(st.pollTimer);
    st.pollTimer = null;
  }
  let polling = false;
  async function pollOnce() {
    if (!st.prog || st.busy || polling) return;
    polling = true;
    let fam = null;
    try { fam = await st.prog.probe(); } catch { fam = null; }
    polling = false;
    if (!st.prog) return;
    if (fam) {
      st.misses = 0;
      if (!st.present) servoPlugged(fam);
    } else if (st.present && ++st.misses >= 2) {
      servoUnplugged();
    }
  }
  function servoPlugged(fam) {
    st.present = true;
    log(`Servo plugged in (${fam})`, 'usb');
    connectedStatus();
    updateButtons();
    if (dirty()) { toast('Servo plugged in. You have unsaved changes, so it wasn’t read automatically.', 'warn', { quiet: true }); return; }
    if (st.settings.autoRead) readServo({ auto: true });
    else if (!st.servo) showEmpty('Servo connected', 'Press <b>Read</b> to load its settings.');
  }
  function servoUnplugged() {
    st.present = false;
    log('Servo unplugged', 'usb');
    connectedStatus();
    if (st.servo && !dirty()) showEmpty('Plug in a servo', 'Connect a servo to the programmer. Its settings load automatically.');
    updateButtons();
  }

  /* -------------------------------------------------------- connection */
  async function attach(device) {
    if (st.device === device && st.mode === 'usb') return;
    await detach();
    try {
      const t = new H.WebHidTransport(device);
      await t.open();
      st.transport = t; st.device = device; st.mode = 'usb';
      st.prog = new A.Programmer(t);
      log('Programmer plugged in', 'usb');
      $('btnConnect').hidden = true; $('btnDemo').hidden = true;
      connectedStatus();
      showEmpty('Plug in a servo', 'Programmer connected. Connect a servo and its settings load automatically.');
      try {
        const ok = await st.prog.initModule();
        if (!ok) { setStatus('bad', 'Programmer not ready', 'Unplug it and plug it back in'); log('Programmer did not initialise', 'bad'); return; }
      } catch (e) { log(`Programmer init: ${e.message}`, 'warn'); }
      startPolling();
    } catch (e) {
      setStatus('bad', 'Could not open programmer', e.message);
      toast(`Could not open the programmer: ${e.message}`, 'bad');
    }
  }

  async function detach() {
    stopPolling();
    if (st.transport) await st.transport.close();
    st.transport = st.prog = st.device = st.mock = null;
    st.mode = 'none';
    st.present = false;
  }

  async function startDemo() {
    if (st.mode === 'usb') { toast('Unplug the programmer to use demo mode.', 'warn'); return; }
    await detach();
    st.mode = 'demo';
    st.mock = new A.MockServo();
    st.prog = new A.Programmer(st.mock, { delay: 12 });
    log('Demo mode started (simulated programmer)', 'usb');
    $('btnConnect').hidden = true; $('btnDemo').hidden = true;
    connectedStatus();
    startPolling();
  }

  /* ------------------------------------------------------------ actions */
  async function readServo({ auto = false } = {}) {
    if (!st.prog || st.busy) return;
    if (!auto && dirty()) {
      const ok = await native.confirm({ message: 'Discard unsaved changes?', detail: 'Reading from the servo replaces the changes you haven’t written yet.', ok: 'Read Anyway' });
      if (!ok) return;
    }
    try {
      const s = await busy('Reading…', () => st.prog.readServo(), { silent: auto });
      st.present = true; st.misses = 0;
      showServo(s);
      connectedStatus();
      if (st.mode === 'usb') native.saveBackup({ name: s.name, family: s.family, version: s.version, block: Array.from(s.block), settings: s.settings }).catch(() => {});
      log(`Read ${s.name || 'servo'} · ${s.family} ${s.version}`, 'ok');
    } catch { /* logged */ }
  }

  function sheet(title, bodyEl, actions) {
    return new Promise((resolve) => {
      $('sheetTitle').textContent = title;
      const body = $('sheetBody'); body.innerHTML = ''; body.appendChild(bodyEl);
      const bar = $('sheetActions'); bar.innerHTML = '';
      const close = (v) => { $('sheet').hidden = true; document.removeEventListener('keydown', onKey, true); resolve(v); };
      const onKey = (e) => {
        if (e.key === 'Escape') { e.stopPropagation(); close(null); }
        if (e.key === 'Enter') { const p = actions.find((a) => a.cls === 'primary'); if (p) { e.preventDefault(); close(p.value); } }
      };
      actions.forEach((a) => {
        const b = el('button', `btn ${a.cls || ''}`, a.label);
        b.addEventListener('click', () => close(a.value));
        bar.appendChild(b);
      });
      document.addEventListener('keydown', onKey, true);
      $('sheet').hidden = false;
    });
  }

  async function writeServo() {
    if (!st.prog || !st.form || st.busy || !st.present) return;
    const changes = diff(st.base, st.form);
    if (!changes.length) return;
    const t = el('table', 'changes');
    changes.forEach((c) => {
      const tr = document.createElement('tr');
      tr.append(el('td', '', c.label), el('td', 'old', c.from), el('td', '', '→'), el('td', 'new', c.to));
      t.appendChild(tr);
    });
    const go = await sheet(`Write ${changes.length} change${changes.length > 1 ? 's' : ''} to ${st.servo.name || 'servo'}?`, t, [
      { label: 'Cancel', value: false, cls: 'subtle' },
      { label: 'Write', value: true, cls: 'primary' },
    ]);
    if (!go) return;
    try {
      const r = await busy('Writing…', () => st.prog.writeServo(st.form));
      changes.forEach((c) => log(`  ${c.label}: ${c.from} → ${c.to}`));
      if (r.mismatch.length) toast(`Written, but ${r.mismatch.length} byte(s) didn’t verify. Read the servo again and check.`, 'warn');
      else toast('Success write parameter! (verified)', 'ok');
      if (st.mode === 'usb') native.saveBackup({ name: r.name, family: r.family, version: r.version, block: Array.from(r.block), settings: r.settings }).catch(() => {});
      showServo(r);
      connectedStatus();
    } catch { /* toast shown */ }
  }

  function revert() {
    if (!st.base) return;
    st.form = clone(st.base);
    refresh();
    if (!st.present && st.mode !== 'none') showEmpty('Plug in a servo', 'Connect a servo to the programmer. Its settings load automatically.');
  }

  async function factoryReset() {
    if (!st.prog || !st.servo || !st.present) return;
    const ok = await native.confirm({ message: `Reset ${st.servo.name || 'this servo'} to factory defaults?`, detail: 'This is the Windows “Default” button. All custom settings on the servo are replaced. A backup of the current settings was saved when it was read.', ok: 'Reset', destructive: true });
    if (!ok) return;
    try {
      await busy('Resetting…', () => st.prog.factoryDefault());
      toast('Success to default!', 'ok');
      await readServo({ auto: true });
    } catch { /* shown */ }
  }

  async function saveProfile() {
    if (!st.form || !st.servo) return;
    const data = { app: 'axon-mac', format: 1, family: st.servo.family, servo: st.servo.name, settings: st.form };
    const name = await native.saveProfile((st.servo.name || 'servo').replace(/\s+/g, '-'), data);
    if (name) toast(`Saved profile ${name}`, 'ok');
  }

  async function openProfile() {
    let res;
    try { res = await native.openProfile(); } catch (e) { toast(`Couldn’t open profile: ${e.message}`, 'bad'); return; }
    if (!res) return;
    const d = res.data;
    if (!d || d.app !== 'axon-mac' || !d.settings) { toast('That file isn’t an Axon profile.', 'bad'); return; }
    if (!st.servo || !st.base) { toast('Plug in and read a servo first, then open the profile to apply it.', 'warn'); return; }
    if (d.family !== st.servo.family) { toast(`That profile is for ${d.family} servos, but this servo is ${st.servo.family}.`, 'bad'); return; }
    const next = clone(st.base);
    for (const k of Object.keys(next)) if (k in d.settings && typeof d.settings[k] === typeof next[k]) next[k] = clone(d.settings[k]);
    if (Array.isArray(next.olLevels) && next.olLevels.length !== 3) next.olLevels = clone(st.base.olLevels);
    st.form = next;
    refresh();
    toast(`Loaded ${res.name}. Review the changes, then press Write.`, 'ok');
  }

  async function restoreBackup() {
    if (!st.prog || !st.servo || !st.present) { toast('Plug in and read a servo first, then restore a backup to it.', 'warn', { quiet: true }); return; }
    const list = (await native.listBackups()).filter((b) => b.family === st.servo.family && Array.isArray(b.block) && b.block.length === A.PARAM_LEN);
    if (!list.length) { toast('No backups for this servo type yet. One is saved every time a servo is read.', 'warn', { quiet: true }); return; }
    let chosen = 0;
    const ul = el('ul', 'backup-list');
    list.forEach((b, i) => {
      const li = el('li', i === 0 ? 'sel' : '');
      const left = el('span');
      left.append(el('b', '', b.name || 'Servo'), document.createElement('br'), el('small', '', `${b.family} · ${b.version || ''}`));
      li.append(left, el('small', '', new Date(b.savedAt).toLocaleString()));
      li.addEventListener('click', () => { chosen = i; ul.querySelectorAll('li').forEach((x, j) => x.classList.toggle('sel', j === i)); });
      ul.appendChild(li);
    });
    const go = await sheet('Restore a backup', ul, [{ label: 'Cancel', value: false, cls: 'subtle' }, { label: 'Restore to Servo', value: true, cls: 'primary' }]);
    if (!go) return;
    const b = list[chosen];
    if (b.name && st.servo.name && b.name !== st.servo.name) {
      const ok = await native.confirm({ message: `This backup is from a “${b.name}”, but the connected servo is a “${st.servo.name}”.`, detail: 'Restoring settings from a different model can make it behave badly.', ok: 'Restore Anyway', destructive: true });
      if (!ok) return;
    }
    try {
      const r = await busy('Restoring…', () => st.prog.writeServo(null, { rawBlock: Uint8Array.from(b.block) }));
      toast(r.mismatch.length ? 'Restored, but verification found differences.' : `Backup from ${new Date(b.savedAt).toLocaleString()} restored ✓`, r.mismatch.length ? 'warn' : 'ok');
      showServo(r);
      connectedStatus();
    } catch { /* shown */ }
  }

  async function connectClick() {
    if (!navigator.hid) { toast('USB HID is not available here.', 'bad'); return; }
    const d = await H.findDevice();
    if (d) attach(d);
    else toast('No Axon programmer found. Check the USB cable and try another port.', 'warn');
  }

  function demoTogglePlug() {
    if (!st.mock) return;
    st.mock.present = !st.mock.present;
    $('demoPlug').textContent = st.mock.present ? 'Unplug servo' : 'Plug in servo';
  }

  /* ----------------------------------------------------- log visibility */
  function setLogCollapsed(c) {
    $('activity').classList.toggle('collapsed', c);
    $('activityHead').setAttribute('aria-expanded', String(!c));
    LS.set('logCollapsed', c);
    if (!c) $('logBody').scrollTop = $('logBody').scrollHeight;
  }
  function applyShowLog() {
    $('activity').classList.toggle('hidden-pref', !st.settings.showLog);
  }
  async function toggleLogPref() {
    st.settings = await native.setSettings({ showLog: !st.settings.showLog });
    applyShowLog();
    if (st.settings.showLog) setLogCollapsed(false);
    syncPrefs();
  }

  /* -------------------------------------------------------------- theme */
  const mq = window.matchMedia('(prefers-color-scheme: dark)');
  function applyTheme() {
    const t = st.settings.theme === 'system' ? (mq.matches ? 'dark' : 'light') : st.settings.theme;
    document.documentElement.dataset.theme = t;
    document.documentElement.style.colorScheme = t;
  }
  mq.addEventListener('change', applyTheme);

  /* -------------------------------------------------------- preferences */
  function prefsTab(name) {
    document.querySelectorAll('.prefs-tab').forEach((b) => b.classList.toggle('on', b.dataset.tab === name));
    document.querySelectorAll('.prefs-pane').forEach((p) => { p.hidden = p.dataset.pane !== name; });
    if (name === 'data') refreshDataInfo();
  }
  async function refreshDataInfo() {
    $('prefLogInfo').textContent = `${st.logCount} entr${st.logCount === 1 ? 'y' : 'ies'}, kept until you clear it.`;
    const n = await native.countBackups().catch(() => 0);
    $('prefBackupInfo').textContent = n ? `${n} saved automatically when servos were read.` : 'None yet. One is saved every time a servo is read.';
  }
  function syncPrefs() {
    document.querySelectorAll('#themePick button').forEach((b) => b.classList.toggle('on', b.dataset.theme === st.settings.theme));
    $('prefShowLog').checked = st.settings.showLog;
    $('prefAutoRead').checked = st.settings.autoRead;
  }
  function openPrefs(tab = 'general') {
    syncPrefs();
    prefsTab(tab);
    $('prefs').hidden = false;
    document.querySelector('.prefs-tab.on')?.focus();
  }
  function closePrefs() { $('prefs').hidden = true; }

  /* -------------------------------------------------------------- wiring */
  $('btnRead').addEventListener('click', () => readServo());
  $('btnWrite').addEventListener('click', writeServo);
  $('btnRevert').addEventListener('click', revert);
  $('btnFactory').addEventListener('click', factoryReset);
  $('btnProfileSave').addEventListener('click', saveProfile);
  $('btnProfileOpen').addEventListener('click', openProfile);
  $('btnRestore').addEventListener('click', restoreBackup);
  $('btnConnect').addEventListener('click', connectClick);
  $('btnDemo').addEventListener('click', startDemo);
  $('demoPill').addEventListener('click', demoTogglePlug);
  $('btnSettings').addEventListener('click', () => openPrefs());
  $('activityHead').addEventListener('click', () => setLogCollapsed(!$('activity').classList.contains('collapsed')));

  document.querySelectorAll('.prefs-tab').forEach((b) => b.addEventListener('click', () => prefsTab(b.dataset.tab)));
  document.querySelectorAll('#themePick button').forEach((b) => b.addEventListener('click', async () => {
    st.settings = await native.setSettings({ theme: b.dataset.theme });
    applyTheme(); syncPrefs();
  }));
  $('prefShowLog').addEventListener('change', async (e) => { st.settings = await native.setSettings({ showLog: e.target.checked }); applyShowLog(); });
  $('prefAutoRead').addEventListener('change', async (e) => { st.settings = await native.setSettings({ autoRead: e.target.checked }); });
  $('prefClearLog').addEventListener('click', async () => {
    await native.clearLog();
    await loadLog();
    refreshDataInfo();
    toast('Activity log cleared', 'ok', { quiet: true });
  });
  $('prefClearCache').addEventListener('click', async () => { await native.clearCache(); toast('Cache cleared', 'ok', { quiet: true }); });
  $('prefShowBackups').addEventListener('click', () => native.openBackups());
  $('prefClearBackups').addEventListener('click', async () => {
    const ok = await native.confirm({ message: 'Delete all servo backups?', detail: 'You won’t be able to restore old settings from them. This can’t be undone.', ok: 'Delete All', destructive: true });
    if (!ok) return;
    const n = await native.clearBackups();
    refreshDataInfo();
    toast(`Deleted ${n} backup${n === 1 ? '' : 's'}`, 'ok', { quiet: true });
  });
  $('prefsDone').addEventListener('click', closePrefs);
  $('prefs').addEventListener('mousedown', (e) => { if (e.target === $('prefs')) closePrefs(); });
  $('aboutGithub').addEventListener('click', () => native.openRepo());
  $('aboutIssue').addEventListener('click', async () => { const i = await native.appInfo(); window.open(i.repo + '/issues'); });

  document.addEventListener('keydown', (e) => {
    if (!$('prefs').hidden && e.key === 'Escape') { closePrefs(); return; }
    // Fallback shortcuts for the browser build (the Mac menu handles these in the app).
    if (!window.native && (e.metaKey || e.ctrlKey)) {
      if (e.key === ',') { e.preventDefault(); openPrefs(); }
      if (e.key.toLowerCase() === 'l') { e.preventDefault(); toggleLogPref(); }
    }
  });

  native.onMenu((ch) => ({
    read: () => readServo(), write: writeServo, revert, factory: factoryReset, restore: restoreBackup,
    'save-profile': saveProfile, 'open-profile': openProfile, demo: startDemo, log: toggleLogPref,
    settings: () => openPrefs(),
  }[ch] || (() => {}))());

  /* --------------------------------------------------------------- boot */
  (async function boot() {
    st.settings = { ...st.settings, ...(await native.getSettings().catch(() => ({}))) };
    applyTheme();
    applyShowLog();
    setLogCollapsed(LS.get('logCollapsed', false));
    native.appInfo().then((i) => { $('aboutVer').textContent = `Version ${i.version}`; }).catch(() => {});
    await loadLog();
    log('App started');

    if (navigator.hid) {
      navigator.hid.addEventListener('connect', (e) => { if (H.isAxon(e.device)) attach(e.device); });
      navigator.hid.addEventListener('disconnect', async (e) => {
        if (st.device && e.device === st.device) {
          log('Programmer unplugged', 'usb');
          await detach();
          showEmpty('Connect your servo', 'Plug the Axon programmer into a USB port and connect a servo to it. Its settings load automatically.');
          setStatus('', 'Programmer unplugged', 'Plug it back in to continue');
        }
      });
      const ds = await navigator.hid.getDevices();
      const d = ds.find(H.isAxon);
      if (d) attach(d);
      else setStatus('', 'No programmer found', 'Plug in the Axon USB programmer');
    } else {
      setStatus('bad', 'USB not available', 'Use the Mac app, or try Demo Mode');
    }
    updateButtons();
  })();
})();
