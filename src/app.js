/* Axon Servo Programmer — renderer */
(function () {
  'use strict';
  const A = window.Axon;
  const H = window.AxonHid;

  /* -------- native bridge (with browser fallbacks for development/tests) */
  const LS = {
    get: (k, d) => { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
    set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* ignore */ } },
  };
  const DEFAULTS = { theme: 'system', glass: 60, showLog: true, autoRead: true, showDemo: true, logRetention: 'forever', autoUpdate: true, updateInterval: 'daily', includePrerelease: true, skippedVersion: '', onboarded: false };
  const native = window.native || {
    appInfo: async () => ({ version: '1.2.0-dev', repo: 'https://github.com/PetrBytes/axon-servo-programmer-mac' }),
    openRepo: async () => window.open('https://github.com/PetrBytes/axon-servo-programmer-mac'),
    openBackups: async () => {},
    getSettings: async () => ({ ...DEFAULTS, ...LS.get('settings', {}) }),
    setSettings: async (p) => { const s = { ...DEFAULTS, ...LS.get('settings', {}), ...p }; LS.set('settings', s); return s; },
    readLog: async () => LS.get('log', []),
    appendLog: async (lines) => LS.set('log', [...LS.get('log', []), ...lines].slice(-3000)),
    clearLog: async () => LS.set('log', []),
    clearCache: async () => ({ freed: 1234567 }),
    cacheSize: async () => 1234567,
    logSize: async () => JSON.stringify(LS.get('log', [])).length,
    backupsSize: async () => 0,
    clearBackups: async () => 0,
    countBackups: async () => 0,
    setState: () => {},
    saveProfile: async (n, d) => { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([JSON.stringify(d, null, 2)])); a.download = n + '.axonprofile.json'; a.click(); return a.download; },
    openProfile: async () => null,
    saveBackup: async () => null,
    listBackups: async () => [],
    confirm: async ({ message }) => window.confirm(message),
    onMenu: () => {},
    update: (() => {
      let s = { status: 'idle' }; const subs = [];
      const set = (p) => { s = { ...s, ...p }; subs.forEach((f) => f(s)); return s; };
      return {
        state: async () => s,
        check: async () => { set({ status: 'checking' }); await new Promise((r) => setTimeout(r, 300)); return set({ status: 'available', checkedAt: Date.now(), info: { version: '1.3.0', name: '1.3.0', prerelease: true, notes: '- Example release notes\n- Shown in the browser build', asset: { size: 81e6 } } }); },
        download: async () => { for (let i = 1; i <= 10; i++) { set({ status: 'downloading', progress: i / 10 }); await new Promise((r) => setTimeout(r, 60)); } return set({ status: 'ready' }); },
        install: async () => set({ status: 'manual', manualPath: '~/Downloads/Axon-Servo-Programmer-1.3.0-arm64.dmg' }),
        skip: async () => set({ status: 'uptodate', info: null }),
        onState: (f) => subs.push(f),
      };
    })(),
  };

  const $ = (id) => document.getElementById(id);
  const clone = (o) => JSON.parse(JSON.stringify(o));
  const POLL_MS = 400; // Windows polls every 300 ms

  /* --------------------------------------------------------------- state */
  const st = {
    mode: 'none', // none | usb | demo
    transport: null, prog: null, device: null, mock: null,
    servo: null, base: null, form: null,
    busy: false, present: false, misses: 0, pollTimer: null,
    settings: { ...DEFAULTS },
    logCount: 0,
    update: { status: 'idle' },
    version: '',
  };

  /* -------------------------------------------------------------- themes */
  const THEMES = [
    { id: 'system', name: 'System' },
    { id: 'light', name: 'Light' },
    { id: 'dark', name: 'Dark' },
    { id: 'midnight', name: 'Midnight' },
    { id: 'aurora', name: 'Aurora' },
    { id: 'sunset', name: 'Sunset' },
    { id: 'glass', name: 'Liquid Glass' },
  ];
  const mq = window.matchMedia('(prefers-color-scheme: dark)');
  function applyTheme() {
    const t = st.settings.theme;
    const dark = t === 'dark' || ['midnight', 'aurora', 'sunset'].includes(t) || ((t === 'system' || t === 'glass') && mq.matches);
    const root = document.documentElement;
    root.dataset.theme = dark ? 'dark' : 'light';
    root.style.colorScheme = dark ? 'dark' : 'light';
    if (['midnight', 'aurora', 'sunset', 'glass'].includes(t)) root.dataset.skin = t; else delete root.dataset.skin;
    root.style.setProperty('--glass', String((st.settings.glass ?? 60) / 100));
    $('glassGroup').hidden = t !== 'glass';
  }
  mq.addEventListener('change', applyTheme);

  function makeStars() {
    const W = 2600, Hh = 1700;
    [[260, 1, 'rgba(255,255,255,.9)'], [140, 1.4, 'rgba(255,255,255,.95)'], [60, 2, 'rgba(255,240,220,1)']].forEach(([n, size, col], i) => {
      const shadows = [];
      for (let k = 0; k < n; k++) shadows.push(`${Math.round(Math.random() * W)}px ${Math.round(Math.random() * Hh)}px 0 ${size > 1.5 ? 0.6 : 0}px ${col}`);
      const elx = document.querySelector(`.stars.s${i + 1}`);
      elx.style.width = elx.style.height = `${size}px`;
      elx.style.boxShadow = shadows.join(',');
    });
  }

  function renderThemePicker(container, compact) {
    container.innerHTML = '';
    THEMES.forEach((t) => {
      const b = el('button', 'theme-opt');
      b.type = 'button';
      b.dataset.theme = t.id;
      b.append(el('span', `theme-sw sw-${t.id}`), el('span', '', t.name));
      b.addEventListener('click', async () => {
        st.settings = await native.setSettings({ theme: t.id });
        applyTheme(); syncPrefs();
      });
      container.appendChild(b);
    });
    if (compact) container.classList.add('compact');
  }

  /* -------------------------------------------------------------- schema */
  const pctOf = (v) => `${(Math.round((v * 1000) / 255) / 10).toFixed(1)} %`;
  const SENS = ['Ultra High', 'High', 'Medium', 'Low'];
  const PPM_LABELS = ['500~2500 µs', '900~2100 µs', '1100~1900 µs'];
  const LOST = ['Release', 'Keep Position', 'Go Neutral Position'];

  const AAS = [
    { title: 'Motion', rows: [
      { key: 'range', label: 'Range', win: 'Servo Angle', help: 'How far the servo turns across the full PPM range. 255 = maximum travel.', type: 'slider', min: 1, max: 255 },
      { key: 'neutral', label: 'Middle Position', win: 'Servo Neutral', help: 'Trims the centre point. 0 = factory centre.', type: 'slider', min: -127, max: 127 },
      { key: 'deadband', label: 'Sensitivity', win: 'Deadband', help: 'How small a signal change the servo reacts to. Ultra High reacts to the tiniest change; Low ignores small jitter.', type: 'seg', options: SENS },
      { key: 'inversion', label: 'Inversion', help: 'Reverses the direction of rotation.', type: 'switch' },
    ] },
    { title: 'Power', rows: [
      { key: 'maxPower', label: 'Max Power', win: 'PWM Power', help: 'Maximum motor drive. Lower it to reduce current draw, heat and brownouts.', type: 'slider', min: 100, max: 255, fmt: pctOf },
      { key: 'damping', label: 'Damping Factor', help: 'How strongly the servo slows down as it reaches the target. Higher = softer stop.', type: 'slider', min: 50, max: 600 },
      { key: 'softStart', label: 'Soft Start', help: 'Moves slowly to position at power-up instead of snapping.', type: 'switch' },
    ] },
    { title: 'Signal', rows: [
      { key: 'ppmRange', label: 'PPM Range', help: 'The pulse width the servo treats as full travel. Match it to what your controller sends. In FTC, REV hubs output about 600~2400 µs by default and can be changed in code with ServoImplEx.setPwmRange().', type: 'seg', options: PPM_LABELS, disabledWhen: (s) => s.narrowBand || s.sanwaSSR },
      { key: 'lostPPM', label: 'Lose PPM Protection', help: 'What the servo does if the signal stops (e.g. robot disabled or cable unplugged).', type: 'select', options: LOST },
      { key: 'narrowBand', label: 'Narrow Band', win: '450~1050 µs', help: 'For narrow-band receivers. Not used in FTC. Halves Range when switched on, like the Windows software.', type: 'switch', disabledWhen: (s) => s.sanwaSSR },
      { key: 'sanwaSSR', label: 'SANWA SSR', win: '130~470 µs', help: 'Sanwa Super Response mode. Not used in FTC. Rescales Range when switched on, like the Windows software.', type: 'switch', disabledWhen: (s) => s.narrowBand },
    ] },
    { title: 'Over Load Protection', wide: true, custom: 'overload' },
  ];
  const UPL = [
    { title: 'Parameters', rows: [
      { key: 'inversion', label: 'Inversion', help: 'Reverses the direction of rotation.', type: 'switch' },
      { key: 'maxPower', label: 'Max Power', help: 'Maximum motor drive.', type: 'slider', min: 100, max: 255, fmt: pctOf },
      { key: 'proPTL', label: 'ProPTL', help: 'Protection threshold for this servo family (as in the Windows UPL tab).', type: 'slider', min: 0, max: 255 },
    ] },
  ];
  const LABELS = {
    range: 'Range', neutral: 'Middle Position', deadband: 'Sensitivity', inversion: 'Inversion',
    maxPower: 'Max Power', damping: 'Damping Factor', softStart: 'Soft Start', ppmRange: 'PPM Range',
    lostPPM: 'Lose PPM Protection', narrowBand: 'Narrow Band', sanwaSSR: 'SANWA SSR', overload: 'Over Load Protection', proPTL: 'ProPTL',
  };

  /* ------------------------------------------------------------- helpers */
  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }
  const fmtBytes = (n) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1048576).toFixed(1)} MB`);
  const ago = (t) => { if (!t) return 'never'; const s = Math.round((Date.now() - t) / 1000); if (s < 60) return 'just now'; if (s < 3600) return `${Math.round(s / 60)} min ago`; if (s < 86400) return `${Math.round(s / 3600)} h ago`; return new Date(t).toLocaleDateString(); };

  /* ------------------------------------------------------------- logging */
  const pad = (n) => String(n).padStart(2, '0');
  function stamp(d = new Date()) {
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }
  function renderLogLine(raw, old) {
    const [ts, kind, ...rest] = String(raw).split('|');
    const line = el('div', `log-line ${kind || ''}${old ? ' old' : ''}`);
    const t = el('time', '', (ts || '').slice(11, 19) || ts);
    t.title = ts;
    line.append(t, el('span', 'msg', rest.join('|') || raw));
    return line;
  }
  let sessionBox = null;
  function log(msg, kind = 'info') {
    const raw = `${stamp()}|${kind}|${msg}`;
    const b = $('logBody');
    const stick = b.scrollHeight - b.scrollTop - b.clientHeight < 30;
    sessionBox.appendChild(renderLogLine(raw));
    if (stick) b.scrollTop = b.scrollHeight;
    st.logCount++;
    $('logCount').textContent = st.logCount;
    native.appendLog([raw]).catch(() => {});
  }
  /** History stays above; each launch opens on a clean "New session" view. */
  async function loadLog() {
    const lines = await native.readLog().catch(() => []);
    const b = $('logBody');
    b.innerHTML = '';
    const frag = document.createDocumentFragment();
    if (lines.length) {
      frag.appendChild(el('div', 'log-hint', '↑ older sessions'));
      lines.forEach((l) => frag.appendChild(renderLogLine(l, true)));
    }
    sessionBox = el('div', 'log-session');
    const sep = el('div', 'log-sep');
    const now = new Date();
    sep.append(el('b', '', `// new session · ${now.toLocaleDateString()} ${pad(now.getHours())}:${pad(now.getMinutes())}`));
    if (lines.length) sep.append(el('span', '', `// scroll up to see history (${lines.length})`));
    sessionBox.appendChild(sep);
    frag.appendChild(sessionBox);
    b.appendChild(frag);
    st.logCount = lines.length;
    $('logCount').textContent = st.logCount;
    requestAnimationFrame(() => { b.scrollTop = sessionBox.offsetTop - b.offsetTop; });
  }

  function toast(msg, kind = '', { quiet = false } = {}) {
    const t = el('div', `toast ${kind}`, msg);
    $('toasts').appendChild(t);
    setTimeout(() => t.remove(), kind === 'bad' ? 7000 : 3800);
    if (!quiet) log(msg, kind || 'info');
  }
  function setStatus(kind, title, sub) {
    $('status').className = `status card-ish ${kind}`;
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

  /* ----------------------------------------------------------- the form */
  function guardNumber(n) {
    // Scrolling the page must never change a value by accident.
    n.addEventListener('wheel', () => n.blur(), { passive: true });
    n.addEventListener('keydown', (e) => { if (e.key === 'Enter') n.blur(); });
  }

  function buildRow(def) {
    const row = el('div', 'row');
    row.dataset.key = def.key;
    const head = el('div', 'row-head');
    const lab = el('div');
    const l = el('div', 'row-label', def.label);
    if (def.win) l.appendChild(el('span', 'win', def.win));
    lab.append(l, el('div', 'row-help', def.help));
    head.appendChild(lab);
    row.appendChild(head);

    if (def.type === 'switch') {
      const sw = el('label', 'switch');
      const inp = Object.assign(document.createElement('input'), { type: 'checkbox' });
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
      n.addEventListener('change', () => {
        let v = Math.round(Number(n.value));
        if (!Number.isFinite(v)) v = st.form[def.key];
        v = Math.min(def.max, Math.max(def.min, v));
        n.value = v; r.value = v; st.form[def.key] = v; paint(v); markChanged();
      });
      guardNumber(n);
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

  /* Windows behaviour (ckNBClick / ckSSRClick). */
  function onToggle(key, on) {
    const s = st.form;
    if (key === 'narrowBand') {
      if (s.sanwaSSR) return;
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
    const thead = el('thead'); const hr = el('tr');
    ['', 'PWM (%)', 'Time (s)'].forEach((h) => hr.appendChild(el('th', '', h)));
    thead.appendChild(hr); t.appendChild(thead);
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
        const pb = Math.round((pv * 255) / 100), sb = Math.round(sv / 0.102);
        lv.power = olP(pb === lv.rawPower ? lv.rawPower : pb);
        lv.time = olT(sb === lv.rawTime ? lv.rawTime : sb);
        p.value = lv.power; s.value = lv.time; markChanged();
      };
      [p, s].forEach((x) => { x.addEventListener('change', commit); guardNumber(x); });
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
    $('writeBadge').hidden = n === 0;
    $('writeBadge').textContent = n;
    $('btnWrite').title = n ? `Write ${n} change${n > 1 ? 's' : ''} (⌘↩)` : 'Write (⌘↩)';
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
    $('btnProfileOpen').disabled = st.busy;
    $('btnRestore').disabled = st.busy;
    $('btnHome').hidden = !connected;
    $('btnHome').title = st.mode === 'demo' ? 'Exit demo mode' : 'Disconnect and go back to the start screen';
    $('editor').classList.toggle('locked', st.busy);
    $('unplugBanner').hidden = !(st.servo && !st.present && connected);
    $('servoChip').textContent = st.present ? 'Connected' : 'Unplugged';
    $('servoChip').classList.toggle('off', !st.present);
    native.setState({ busy: st.busy, dirty: d });
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
      setEmptyButtons(false);
      updateButtons();
      return;
    }
    st.base = clone(s.settings);
    st.form = clone(s.settings);
    $('empty').hidden = true; $('editor').hidden = false;
    $('editorTitle').textContent = s.name || 'Servo Settings';
    $('editorSub').textContent = s.family === A.FAMILY.UPL ? 'UPL servo. Changes are only sent when you press Write.' : 'Changes are only sent to the servo when you press Write.';
    $('demoPill').hidden = st.mode !== 'demo';
    const warn = A.softCheck(s.family, s.block);
    $('softBanner').hidden = !warn.length;
    $('softText').textContent = warn.length ? `This servo’s data looks different from what this app expects (${warn.join('; ')}). Check the values against the Windows software before writing.` : '';
    buildForm(s.family);
    refresh();
  }

  function setEmptyButtons(show) {
    $('btnConnect').hidden = !show;
    $('btnDemo').hidden = !show || !st.settings.showDemo;
    $('emptyNeed').hidden = !show;
  }

  function showEmpty(title, html) {
    st.servo = st.base = st.form = null;
    $('servoCard').hidden = true;
    $('editor').hidden = true; $('empty').hidden = false;
    $('emptyTitle').textContent = title;
    $('emptyText').innerHTML = html;
    setEmptyButtons(st.mode === 'none');
    updateButtons();
  }
  const HOME_TEXT = 'Plug the <b>Axon Servo Programmer</b> into your Mac (a USB-C adapter is fine) and connect a servo to it. Its settings load automatically.';

  /* -------------------------------------------------------------- busy */
  async function busy(label, fn, { silent = false } = {}) {
    if (st.busy) throw new Error('Busy');
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
    else setStatus('', 'No programmer connected', 'Plug in the Axon Servo Programmer');
  }

  /* ---------------------------------------------------- servo polling */
  let polling = false;
  function startPolling() {
    stopPolling();
    st.present = false; st.misses = 0;
    st.pollTimer = setInterval(pollOnce, POLL_MS);
    pollOnce();
  }
  function stopPolling() { if (st.pollTimer) clearInterval(st.pollTimer); st.pollTimer = null; }
  async function pollOnce() {
    if (!st.prog || st.busy || polling) return;
    polling = true;
    const prog = st.prog;
    let fam = null;
    try { fam = await prog.probe(); } catch { fam = null; }
    polling = false;
    if (st.prog !== prog) return;
    if (fam) { st.misses = 0; if (!st.present) servoPlugged(fam); }
    else if (st.present && ++st.misses >= 2) servoUnplugged();
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
    if (st.mode === 'demo') {
      const ok = !dirty() || await native.confirm({ message: 'Programmer plugged in. Leave demo mode?', detail: 'Your unsaved demo changes will be discarded.', ok: 'Leave Demo' });
      if (!ok) return;
    }
    await detach();
    try {
      const t = new H.WebHidTransport(device);
      await t.open();
      st.transport = t; st.device = device; st.mode = 'usb';
      st.prog = new A.Programmer(t);
      log('Programmer plugged in', 'usb');
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
    const t = st.transport;
    st.transport = st.prog = st.device = st.mock = null;
    st.mode = 'none';
    st.present = false;
    if (t) await t.close();
  }

  async function startDemo() {
    if (st.mode === 'usb') { toast('Disconnect the programmer to use demo mode.', 'warn', { quiet: true }); return; }
    if (st.mode === 'demo') return;
    await detach();
    st.mode = 'demo';
    st.mock = new A.MockServo();
    st.prog = new A.Programmer(st.mock, { delay: 12 });
    log('Demo mode started (simulated programmer)', 'usb');
    $('demoPlug').textContent = 'Unplug servo';
    connectedStatus();
    setEmptyButtons(false);
    startPolling();
  }

  async function goHome() {
    if (st.mode === 'none' || st.busy) return;
    const leaving = st.mode === 'demo' ? 'Exit demo mode?' : 'Disconnect the programmer?';
    if (dirty()) {
      const ok = await native.confirm({ message: leaving, detail: 'You have changes that haven’t been written. They will be discarded.', ok: st.mode === 'demo' ? 'Exit Demo' : 'Disconnect', destructive: true });
      if (!ok) return;
    }
    log(st.mode === 'demo' ? 'Demo mode ended' : 'Disconnected from programmer', 'usb');
    await detach();
    showEmpty('Connect your servo', HOME_TEXT);
    connectedStatus();
  }

  /* ------------------------------------------------------------ actions */
  async function readServo({ auto = false } = {}) {
    if (!st.prog || st.busy) return;
    if (!auto && dirty()) {
      const ok = await native.confirm({ message: 'Discard unsaved changes?', detail: 'Reading from the servo replaces the changes you haven’t written yet.', ok: 'Read Anyway', destructive: true });
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

  /** In-app sheet. No Enter-to-confirm, so a stray key press can't write. Esc cancels. */
  function sheet(title, bodyEl, actions) {
    return new Promise((resolve) => {
      $('sheetTitle').textContent = title;
      const body = $('sheetBody'); body.innerHTML = ''; body.appendChild(bodyEl);
      const bar = $('sheetActions'); bar.innerHTML = '';
      const close = (v) => { $('sheet').hidden = true; document.removeEventListener('keydown', onKey, true); resolve(v); };
      const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(null); } };
      actions.forEach((a) => {
        const b = el('button', `btn ${a.cls || ''}`, a.label);
        b.addEventListener('click', () => close(a.value));
        bar.appendChild(b);
      });
      document.addEventListener('keydown', onKey, true);
      $('sheet').hidden = false;
      bar.querySelector('.subtle')?.focus();
    });
  }

  async function writeServo() {
    if (!st.prog || !st.form || st.busy || !st.present) return;
    const changes = diff(st.base, st.form);
    if (!changes.length) return;
    const wrap = el('div');
    const t = el('table', 'changes');
    changes.forEach((c) => {
      const tr = document.createElement('tr');
      tr.append(el('td', '', c.label), el('td', 'old', c.from), el('td', '', '→'), el('td', 'new', c.to));
      t.appendChild(tr);
    });
    wrap.appendChild(t);
    const warn = A.softCheck(st.servo.family, st.servo.block);
    if (warn.length) wrap.appendChild(el('p', 'sheet-text', `⚠️ This servo’s data looked unusual when read (${warn.join('; ')}). Only write if the values on screen match what you expect.`));
    const go = await sheet(`Write ${changes.length} change${changes.length > 1 ? 's' : ''} to ${st.servo.name || 'servo'}?`, wrap, [
      { label: 'Cancel', value: false, cls: 'subtle' },
      { label: warn.length ? 'Write Anyway' : 'Write', value: true, cls: warn.length ? 'primary danger' : 'primary' },
    ]);
    if (!go) return;
    try {
      const expect = { family: st.servo.family, version: st.servo.version, block: Array.from(st.servo.block) };
      const r = await busy('Writing…', () => st.prog.writeServo(st.form, { expect }));
      changes.forEach((c) => log(`  ${c.label}: ${c.from} → ${c.to}`));
      if (r.mismatch.length) toast(`Written, but ${r.mismatch.length} byte(s) didn’t verify. Read the servo again and check, or restore a backup.`, 'warn');
      else toast('Success write parameter! (verified)', 'ok');
      if (st.mode === 'usb') native.saveBackup({ name: r.name, family: r.family, version: r.version, block: Array.from(r.block), settings: r.settings }).catch(() => {});
      showServo(r);
      connectedStatus();
    } catch { /* toast shown */ }
  }

  async function revert() {
    if (!st.base || !dirty()) return;
    const n = diff(st.base, st.form).length;
    const ok = await native.confirm({ message: `Discard ${n} unsaved change${n > 1 ? 's' : ''}?`, detail: 'The settings go back to what is stored on the servo.', ok: 'Discard', destructive: true });
    if (!ok) return;
    st.form = clone(st.base);
    refresh();
    log('Changes discarded');
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
    if (!Array.isArray(next.olLevels) || next.olLevels.length !== 3) next.olLevels = clone(st.base.olLevels);
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
      const ok = await native.confirm({ message: `This backup is from a “${b.name}”, but the connected servo is a “${st.servo.name}”.`, detail: 'Only the user settings are copied (never calibration), but a different model may still behave differently.', ok: 'Restore Anyway', destructive: true });
      if (!ok) return;
    }
    try {
      const expect = { family: st.servo.family, version: st.servo.version, block: Array.from(st.servo.block) };
      const r = await busy('Restoring…', () => st.prog.writeServo(null, { rawBlock: Uint8Array.from(b.block), expect }));
      toast(r.mismatch.length ? 'Restored, but verification found differences.' : `Backup from ${new Date(b.savedAt).toLocaleString()} restored ✓`, r.mismatch.length ? 'warn' : 'ok');
      showServo(r);
      connectedStatus();
    } catch { /* shown */ }
  }

  async function connectClick() {
    if (!navigator.hid) { toast('USB HID is not available here.', 'bad'); return; }
    const d = await H.findDevice();
    if (d) attach(d);
    else toast('No Axon Servo Programmer found. Check the cable is a data cable (not charge-only), try another port or adapter.', 'warn');
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
  }
  function applyShowLog() { $('activity').classList.toggle('hidden-pref', !st.settings.showLog); }
  async function toggleLogPref() {
    st.settings = await native.setSettings({ showLog: !st.settings.showLog });
    applyShowLog();
    if (st.settings.showLog) setLogCollapsed(false);
    syncPrefs();
  }

  /* ------------------------------------------------------------ updates */
  function renderUpdate(u) {
    st.update = u || { status: 'idle' };
    const info = u && u.info;
    const actions = $('updActions');
    actions.innerHTML = '';
    const btn = (label, cls, fn) => { const b = el('button', `btn small ${cls || ''}`, label); b.addEventListener('click', fn); actions.appendChild(b); return b; };
    $('updProgress').hidden = true;
    $('updNotes').hidden = true;
    let title = 'Axon Servo Programmer', sub = `Version ${st.version}`;
    const has = info && ['available', 'downloading', 'ready', 'installing', 'relaunching', 'manual'].includes(u.status);
    if (has) {
      title = `Version ${info.version} is available${info.prerelease ? ' (pre-release)' : ''}`;
      sub = `You have ${st.version}${info.asset && info.asset.size ? ` · ${fmtBytes(info.asset.size)}` : ''}`;
      if (info.notes) { $('updNotes').hidden = false; $('updNotes').textContent = info.notes; }
    }
    switch (u && u.status) {
      case 'checking': sub = 'Checking for updates…'; break;
      case 'uptodate': sub = `You’re up to date (${st.version}) · checked ${ago(u.checkedAt || Date.now())}`; btn('Check Now', '', checkUpdates); break;
      case 'error': sub = `Couldn’t check: ${u.error}`; btn('Try Again', '', checkUpdates); break;
      case 'available':
        btn('Download & Install', 'primary', async () => { await native.update.download(); });
        btn('Skip This Version', 'subtle', async () => { await native.update.skip(info.version); });
        break;
      case 'downloading':
        sub = `Downloading… ${Math.round((u.progress || 0) * 100)}%`;
        $('updProgress').hidden = false; $('updBar').style.width = `${Math.round((u.progress || 0) * 100)}%`;
        break;
      case 'ready':
        sub = 'Downloaded and ready to install.';
        btn('Restart & Install', 'primary', installUpdate);
        break;
      case 'installing': sub = 'Verifying and installing…'; break;
      case 'relaunching': sub = 'Restarting…'; break;
      case 'manual': sub = `Opened the installer in Finder${u.manualPath ? ` (${u.manualPath.split('/').pop()})` : ''}. Drag the app into Applications to finish.${u.error ? ` (${u.error})` : ''}`; break;
      default: btn('Check for Updates', '', checkUpdates);
    }
    $('updTitle').textContent = title;
    $('updSub').textContent = sub;
    const show = has && u.status !== 'manual';
    $('updateBanner').hidden = !show;
    $('tabUpdateDot').hidden = !show;
    if (show) $('updateBannerVer').textContent = u.status === 'downloading' ? `Downloading ${info.version}… ${Math.round((u.progress || 0) * 100)}%` : u.status === 'ready' ? `${info.version} ready — restart to install` : `Version ${info.version} · click to see what’s new`;
    $('aboutCheck').disabled = u && ['checking', 'downloading', 'installing'].includes(u.status);
  }
  async function checkUpdates() { renderUpdate({ ...st.update, status: 'checking' }); renderUpdate(await native.update.check()); }
  async function installUpdate() {
    if (st.busy) { toast('Wait for the servo to finish writing first.', 'warn', { quiet: true }); return; }
    if (dirty()) {
      const ok = await native.confirm({ message: 'Install the update now?', detail: 'You have changes that haven’t been written to the servo. They will be lost when the app restarts.', ok: 'Install Anyway', destructive: true });
      if (!ok) return;
    }
    native.setState({ busy: false, dirty: false });
    try { renderUpdate(await native.update.install()); } catch (e) { toast(e.message, 'bad'); }
  }

  /* -------------------------------------------------------- preferences */
  function prefsTab(name) {
    document.querySelectorAll('.prefs-tab').forEach((b) => b.classList.toggle('on', b.dataset.tab === name));
    document.querySelectorAll('.prefs-pane').forEach((p) => { p.hidden = p.dataset.pane !== name; });
    if (name === 'data') refreshDataInfo();
  }
  async function refreshDataInfo() {
    $('prefLogInfo').textContent = `${st.logCount} entr${st.logCount === 1 ? 'y' : 'ies'}.`;
    const [cs, ls, bs, n] = await Promise.all([native.cacheSize(), native.logSize(), native.backupsSize(), native.countBackups()].map((p) => p.catch(() => 0)));
    $('cacheSize').textContent = fmtBytes(cs || 0);
    $('logSize').textContent = fmtBytes(ls || 0);
    $('backupSize').textContent = fmtBytes(bs || 0);
    $('prefBackupInfo').textContent = n ? `${n} saved automatically when servos were read.` : 'None yet. One is saved every time a servo is read.';
  }
  function syncPrefs() {
    document.querySelectorAll('.theme-opt').forEach((b) => b.classList.toggle('on', b.dataset.theme === st.settings.theme));
    $('prefShowLog').checked = st.settings.showLog;
    $('prefAutoRead').checked = st.settings.autoRead;
    $('prefShowDemo').checked = st.settings.showDemo;
    $('prefRetention').value = st.settings.logRetention;
    $('prefAutoUpdate').checked = st.settings.autoUpdate;
    $('prefUpdateInterval').value = st.settings.updateInterval;
    $('prefUpdateInterval').disabled = !st.settings.autoUpdate;
    $('prefPre').checked = st.settings.includePrerelease;
    $('glassRange').value = st.settings.glass ?? 60;
    $('glassGroup').hidden = st.settings.theme !== 'glass';
  }
  function openPrefs(tab = 'appearance') {
    if (!$('welcome').hidden) return;
    syncPrefs();
    prefsTab(tab);
    $('prefs').hidden = false;
  }
  function closePrefs() { $('prefs').hidden = true; }

  /* ----------------------------------------------------------- welcome */
  function openWelcome() {
    $('wAutoRead').checked = st.settings.autoRead;
    $('wAutoUpdate').checked = st.settings.autoUpdate;
    $('wShowDemo').checked = st.settings.showDemo;
    syncPrefs();
    closePrefs();
    $('welcome').hidden = false;
  }
  async function finishWelcome() {
    st.settings = await native.setSettings({ autoRead: $('wAutoRead').checked, autoUpdate: $('wAutoUpdate').checked, showDemo: $('wShowDemo').checked, onboarded: true });
    $('welcome').hidden = true;
    setEmptyButtons(st.mode === 'none');
    log('Setup complete');
  }

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
  $('btnHome').addEventListener('click', goHome);
  $('demoPill').addEventListener('click', demoTogglePlug);
  $('btnSettings').addEventListener('click', () => openPrefs());
  $('updateBanner').addEventListener('click', () => openPrefs('updates'));
  $('activityHead').addEventListener('click', () => setLogCollapsed(!$('activity').classList.contains('collapsed')));

  document.querySelectorAll('.prefs-tab').forEach((b) => b.addEventListener('click', () => prefsTab(b.dataset.tab)));
  const pref = (id, key, get = (e) => e.target.checked, after) => $(id).addEventListener('change', async (e) => { st.settings = await native.setSettings({ [key]: get(e) }); syncPrefs(); if (after) after(); });
  pref('prefShowLog', 'showLog', undefined, applyShowLog);
  pref('prefAutoRead', 'autoRead');
  pref('prefShowDemo', 'showDemo', undefined, () => { if (st.mode === 'none' && !st.servo) setEmptyButtons(true); });
  pref('prefAutoUpdate', 'autoUpdate');
  pref('prefPre', 'includePrerelease');
  pref('prefRetention', 'logRetention', (e) => e.target.value);
  pref('prefUpdateInterval', 'updateInterval', (e) => e.target.value);
  $('glassRange').addEventListener('input', (e) => { document.documentElement.style.setProperty('--glass', String(e.target.value / 100)); });
  $('glassRange').addEventListener('change', async (e) => { st.settings = await native.setSettings({ glass: +e.target.value }); });
  $('prefClearLog').addEventListener('click', async () => {
    const ok = await native.confirm({ message: 'Clear the activity log?', detail: `All ${st.logCount} entries will be deleted.`, ok: 'Clear Log', destructive: true });
    if (!ok) return;
    await native.clearLog();
    await loadLog();
    refreshDataInfo();
    toast('Activity log cleared', 'ok', { quiet: true });
  });
  $('prefClearCache').addEventListener('click', async () => {
    const r = await native.clearCache();
    refreshDataInfo();
    toast(`Cache cleared${r && r.freed ? ` · freed ${fmtBytes(r.freed)}` : ''}`, 'ok', { quiet: true });
  });
  $('prefShowBackups').addEventListener('click', () => native.openBackups());
  $('prefClearBackups').addEventListener('click', async () => {
    const ok = await native.confirm({ message: 'Delete all servo backups?', detail: 'You won’t be able to restore old settings from them. This can’t be undone.', ok: 'Delete All', destructive: true });
    if (!ok) return;
    const n = await native.clearBackups();
    refreshDataInfo();
    toast(`Deleted ${n} backup${n === 1 ? '' : 's'}`, 'ok', { quiet: true });
  });
  $('prefShowWelcome').addEventListener('click', openWelcome);
  $('prefsDone').addEventListener('click', closePrefs);
  $('prefs').addEventListener('mousedown', (e) => { if (e.target === $('prefs')) closePrefs(); });
  $('aboutGithub').addEventListener('click', () => native.openRepo());
  $('aboutIssue').addEventListener('click', async () => { const i = await native.appInfo(); window.open(i.repo + '/issues'); });
  $('aboutCheck').addEventListener('click', () => { prefsTab('updates'); checkUpdates(); });
  $('welcomeGo').addEventListener('click', finishWelcome);
  native.update.onState(renderUpdate);

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('prefs').hidden) { closePrefs(); return; }
    if (!window.native && (e.metaKey || e.ctrlKey)) {
      if (e.key === ',') { e.preventDefault(); openPrefs(); }
      if (e.key.toLowerCase() === 'l') { e.preventDefault(); toggleLogPref(); }
    }
  });

  native.onMenu((ch) => ({
    read: () => readServo(), write: writeServo, revert, factory: factoryReset, restore: restoreBackup,
    'save-profile': saveProfile, 'open-profile': openProfile, demo: startDemo, log: toggleLogPref,
    settings: () => openPrefs(), home: goHome, 'check-updates': () => { openPrefs('updates'); checkUpdates(); },
  }[ch] || (() => {}))());

  /* --------------------------------------------------------------- boot */
  (async function boot() {
    st.settings = { ...st.settings, ...(await native.getSettings().catch(() => ({}))) };
    makeStars();
    renderThemePicker($('themeGrid'), false);
    renderThemePicker($('welcomeThemes'), true);
    applyTheme();
    applyShowLog();
    setLogCollapsed(LS.get('logCollapsed', false));
    const info = await native.appInfo().catch(() => ({ version: '?' }));
    st.version = info.version;
    $('aboutVer').textContent = `Version ${info.version}`;
    await loadLog();
    log(`App started (version ${info.version})`);
    renderUpdate(await native.update.state().catch(() => ({ status: 'idle' })));
    setEmptyButtons(true);
    if (!st.settings.onboarded) openWelcome();

    if (navigator.hid) {
      navigator.hid.addEventListener('connect', (e) => { if (H.isAxon(e.device)) attach(e.device); });
      navigator.hid.addEventListener('disconnect', async (e) => {
        if (st.device && e.device === st.device) {
          log('Programmer unplugged', 'usb');
          await detach();
          showEmpty('Connect your servo', HOME_TEXT);
          setStatus('', 'Programmer unplugged', 'Plug it back in to continue');
        }
      });
      const d = (await navigator.hid.getDevices()).find(H.isAxon);
      if (d) attach(d); else connectedStatus();
    } else {
      setStatus('bad', 'USB not available', 'Use the Mac app, or try Demo Mode');
    }
    updateButtons();
  })();
})();
