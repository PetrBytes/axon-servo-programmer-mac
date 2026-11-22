/* Axon Servo Programmer — renderer */
(function () {
  'use strict';
  const A = window.Axon;
  const H = window.AxonHid;
  const native = window.native || {
    // Fallbacks so the page also works in a plain browser for development.
    saveProfile: async (n, d) => { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([JSON.stringify(d, null, 2)])); a.download = n + '.axonprofile.json'; a.click(); return a.download; },
    openProfile: async () => null,
    saveBackup: async () => null,
    listBackups: async () => [],
    confirm: async ({ message }) => window.confirm(message),
    onMenu: () => {},
  };

  const $ = (id) => document.getElementById(id);
  const clone = (o) => JSON.parse(JSON.stringify(o));

  /* --------------------------------------------------------------- state */
  const st = {
    mode: 'none', // none | usb | demo
    transport: null,
    prog: null,
    device: null,
    servo: null, // last read
    base: null, // settings as on the servo
    form: null, // working copy
    busy: false,
  };

  /* -------------------------------------------------------------- schema */
  const pct = (v) => `${Math.round((v / 255) * 100)}%`;
  const AAS = [
    {
      title: 'Motion',
      rows: [
        { key: 'range', label: 'Range', help: 'How far the servo travels across the full signal. 255 is maximum travel.', type: 'slider', min: 1, max: 255 },
        { key: 'neutral', label: 'Center Trim', help: 'Shifts the neutral (center) position.', type: 'slider', min: -127, max: 127 },
        { key: 'deadband', label: 'Deadband', help: 'How much the signal must change before the servo moves. Higher reduces jitter.', type: 'seg', options: ['1', '2', '3', '4'] },
        { key: 'inversion', label: 'Reverse Direction', help: 'Inverts the direction of rotation.', type: 'switch' },
      ],
    },
    {
      title: 'Power',
      rows: [
        { key: 'maxPower', label: 'Max Power', help: 'Maximum motor drive. Lower it to reduce current draw and heat.', type: 'slider', min: 100, max: 255, fmt: pct },
        { key: 'damping', label: 'Damping Factor', help: 'How strongly the servo slows as it reaches the target.', type: 'slider', min: 50, max: 600 },
        { key: 'softStart', label: 'Soft Start', help: 'Moves slowly to position on power-up instead of snapping.', type: 'switch' },
      ],
    },
    {
      title: 'Signal',
      rows: [
        { key: 'ppmRange', label: 'Pulse Range', help: 'The PWM pulse width that maps to full travel.', type: 'seg', options: A.PPM_RANGES.map((r) => r.label), disabledWhen: (s) => s.narrowBand || s.sanwaSSR },
        { key: 'lostPPM', label: 'If Signal Is Lost', help: 'What the servo does when the control signal stops.', type: 'select', options: A.LOST_PPM },
        { key: 'narrowBand', label: 'Narrow Band (450–1050 µs)', help: 'For receivers that output narrow-band pulses.', type: 'switch', exclusive: 'sanwaSSR' },
        { key: 'sanwaSSR', label: 'Sanwa SSR (130–470 µs)', help: 'Sanwa Super Response mode.', type: 'switch', exclusive: 'narrowBand' },
      ],
    },
    { title: 'Overload Protection', wide: true, custom: 'overload' },
  ];
  const UPL = [
    {
      title: 'Settings',
      rows: [
        { key: 'inversion', label: 'Reverse Direction', help: 'Inverts the direction of rotation.', type: 'switch' },
        { key: 'maxPower', label: 'Max Power', help: 'Maximum motor drive.', type: 'slider', min: 100, max: 255, fmt: pct },
        { key: 'proPTL', label: 'ProPTL', help: 'Protection threshold used by this servo family.', type: 'slider', min: 0, max: 255 },
      ],
    },
  ];
  const LABELS = {
    range: 'Range', neutral: 'Center Trim', deadband: 'Deadband', inversion: 'Reverse Direction',
    maxPower: 'Max Power', damping: 'Damping Factor', softStart: 'Soft Start', ppmRange: 'Pulse Range',
    lostPPM: 'If Signal Is Lost', narrowBand: 'Narrow Band', sanwaSSR: 'Sanwa SSR', overload: 'Overload Protection', proPTL: 'ProPTL',
  };

  /* ------------------------------------------------------------ helpers */
  function log(msg) {
    const t = new Date().toLocaleTimeString();
    const body = $('logBody');
    body.textContent += `[${t}] ${msg}\n`;
    body.scrollTop = body.scrollHeight;
  }
  function toast(msg, kind = '') {
    const el = document.createElement('div');
    el.className = `toast ${kind}`;
    el.textContent = msg;
    $('toasts').appendChild(el);
    setTimeout(() => el.remove(), kind === 'bad' ? 7000 : 3800);
    log(msg);
  }
  function setStatus(kind, title, sub) {
    $('status').className = `status ${kind}`;
    $('statusTitle').textContent = title;
    $('statusSub').textContent = sub || '';
  }
  function fmtVal(key, v, s) {
    if (key === 'ppmRange') return A.PPM_RANGES[v]?.label ?? v;
    if (key === 'lostPPM') return A.LOST_PPM[v] ?? v;
    if (key === 'deadband') return String(v + 1);
    if (key === 'maxPower') return `${v} (${pct(v)})`;
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
        if (lv.power !== n.power) out.push({ key: `ol${i}p`, label: `Overload level ${i + 1} power`, from: `${lv.power}%`, to: `${n.power}%` });
        if (lv.time !== n.time) out.push({ key: `ol${i}t`, label: `Overload level ${i + 1} time`, from: `${lv.time}s`, to: `${n.time}s` });
      });
    }
    return out;
  }

  /* ---------------------------------------------------------- rendering */
  function el(tag, cls, html) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html !== undefined) e.innerHTML = html;
    return e;
  }

  function buildRow(def) {
    const row = el('div', 'row');
    row.dataset.key = def.key;
    const head = el('div', 'row-head');
    const lab = el('div');
    lab.appendChild(el('div', 'row-label')).textContent = def.label;
    lab.appendChild(el('div', 'row-help')).textContent = def.help;
    head.appendChild(lab);
    row.appendChild(head);

    if (def.type === 'switch') {
      const sw = el('label', 'switch');
      const inp = document.createElement('input');
      inp.type = 'checkbox';
      inp.addEventListener('change', () => {
        st.form[def.key] = inp.checked;
        if (inp.checked && def.exclusive) st.form[def.exclusive] = false;
        refresh();
      });
      sw.appendChild(inp); sw.appendChild(el('span'));
      head.appendChild(sw);
      row._set = (s) => { inp.checked = !!s[def.key]; };
    } else if (def.type === 'slider') {
      const body = el('div', 'row-body');
      const r = document.createElement('input');
      r.type = 'range'; r.min = def.min; r.max = def.max; r.step = 1;
      const n = document.createElement('input');
      n.type = 'number'; n.className = 'num'; n.min = def.min; n.max = def.max; n.step = 1;
      const u = el('span', 'unit');
      const paint = (v) => { r.style.setProperty('--pct', `${((v - def.min) / (def.max - def.min)) * 100}%`); u.textContent = def.fmt ? def.fmt(v) : ''; };
      r.addEventListener('input', () => { const v = +r.value; n.value = v; st.form[def.key] = v; paint(v); markChanged(); });
      const commit = () => {
        let v = Math.round(Number(n.value));
        if (!Number.isFinite(v)) v = st.form[def.key];
        v = Math.min(def.max, Math.max(def.min, v));
        n.value = v; r.value = v; st.form[def.key] = v; paint(v); markChanged();
      };
      n.addEventListener('change', commit);
      n.addEventListener('keydown', (e) => { if (e.key === 'Enter') n.blur(); });
      body.append(r, n, u);
      row.appendChild(body);
      row._set = (s) => { const v = s[def.key]; r.value = v; n.value = v; paint(v); };
    } else if (def.type === 'seg') {
      const body = el('div', 'row-body');
      const seg = el('div', 'seg');
      const btns = def.options.map((label, i) => {
        const b = el('button'); b.textContent = label; b.type = 'button';
        b.addEventListener('click', () => { st.form[def.key] = i; refresh(); });
        seg.appendChild(b); return b;
      });
      body.appendChild(seg); row.appendChild(body);
      row._set = (s) => btns.forEach((b, i) => b.classList.toggle('on', s[def.key] === i));
    } else if (def.type === 'select') {
      const sel = document.createElement('select');
      def.options.forEach((o, i) => { const op = document.createElement('option'); op.value = i; op.textContent = o; sel.appendChild(op); });
      sel.addEventListener('change', () => { st.form[def.key] = +sel.value; refresh(); });
      head.appendChild(sel);
      row._set = (s) => { sel.value = s[def.key]; };
    }
    row._def = def;
    return row;
  }

  function buildOverload() {
    const wrap = el('div');
    const top = buildRow({ key: 'overload', label: 'Enable Overload Protection', help: 'Reduces power in stages when the servo is stalled for too long, to protect the motor.', type: 'switch' });
    wrap.appendChild(top);
    const row = el('div', 'row');
    row.dataset.key = 'olLevels';
    const t = el('table', 'levels');
    t.innerHTML = '<thead><tr><th>Stage</th><th>Power limit</th><th></th><th>After stalled for</th><th></th></tr></thead>';
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
        // Snap to what the servo can actually store so the UI shows the truth.
        const pb = Math.round((pv * 255) / 100), sb = Math.round(sv / 0.102);
        lv.power = pb === lv.rawPower ? olP(lv.rawPower) : olP(pb);
        lv.time = sb === lv.rawTime ? olT(lv.rawTime) : olT(sb);
        p.value = lv.power; s.value = lv.time; markChanged();
      };
      p.addEventListener('change', commit); s.addEventListener('change', commit);
      [p, s].forEach((x) => x.addEventListener('keydown', (e) => { if (e.key === 'Enter') x.blur(); }));
      const td = (c) => { const d = document.createElement('td'); if (typeof c === 'string') d.textContent = c; else d.appendChild(c); return d; };
      tr.append(td(`Level ${i + 1}`), td(p), td('%'), td(s), td('seconds'));
      tb.appendChild(tr);
      inputs.push([p, s]);
    }
    t.appendChild(tb);
    row.appendChild(t);
    row._set = (sv) => { inputs.forEach(([p, s], i) => { p.value = sv.olLevels[i].power; s.value = sv.olLevels[i].time; }); row.classList.toggle('disabled', !sv.overload); };
    wrap.appendChild(row);
    return wrap;
  }
  const olP = (b) => Math.round(((b * 100) / 255) * 10) / 10;
  const olT = (b) => Math.round(b * 0.102 * 1000) / 1000;

  function buildForm(family) {
    const form = $('form');
    form.innerHTML = '';
    const schema = family === A.FAMILY.UPL ? UPL : AAS;
    for (const sec of schema) {
      const card = el('section', `card${sec.wide ? ' wide' : ''}`);
      card.appendChild(el('h2')).textContent = sec.title;
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
      if (def && def.disabledWhen) row.classList.toggle('disabled', !!def.disabledWhen(st.form));
    });
    markChanged();
  }

  function markChanged() {
    const changes = diff(st.base, st.form);
    const keys = new Set(changes.map((c) => (c.key.startsWith('ol') ? 'olLevels' : c.key)));
    document.querySelectorAll('#form .row').forEach((row) => row.classList.toggle('changed', keys.has(row.dataset.key)));
    const n = changes.length;
    $('btnWriteLabel').textContent = n ? `Write ${n} Change${n > 1 ? 's' : ''}` : 'Write to Servo';
    $('btnWrite').classList.toggle('dirty', n > 0);
    updateButtons();
  }

  function updateButtons() {
    const connected = st.mode !== 'none';
    const loaded = !!st.servo && st.servo.family !== A.FAMILY.ANS;
    const dirty = diff(st.base, st.form).length > 0;
    $('btnRead').disabled = !connected || st.busy;
    $('btnWrite').disabled = !loaded || !dirty || st.busy;
    $('btnRevert').disabled = !dirty || st.busy;
    $('btnFactory').disabled = !loaded || st.busy;
    $('btnProfileSave').disabled = !loaded;
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
      $('emptyText').textContent = 'The official software does not expose parameters for this servo type either.';
      $('btnConnect').hidden = true; $('btnDemo').hidden = true;
      updateButtons();
      return;
    }
    st.base = clone(s.settings);
    st.form = clone(s.settings);
    $('empty').hidden = true; $('editor').hidden = false;
    $('editorTitle').textContent = s.name || 'Servo Settings';
    $('demoPill').hidden = st.mode !== 'demo';
    buildForm(s.family);
    refresh();
  }

  function clearServo() {
    st.servo = st.base = st.form = null;
    $('servoCard').hidden = true;
    $('editor').hidden = true; $('empty').hidden = false;
    $('emptyTitle').textContent = 'Connect your servo';
    $('emptyText').innerHTML = 'Plug the Axon programmer into a USB port, connect a servo to it, then press <b>Read from Servo</b>.';
    $('btnConnect').hidden = st.mode !== 'none';
    $('btnDemo').hidden = st.mode !== 'none';
    updateButtons();
  }

  /* -------------------------------------------------------- connection */
  async function busy(label, fn, { silent = false } = {}) {
    if (st.busy) return;
    st.busy = true; updateButtons();
    const prev = [$('status').className, $('statusTitle').textContent, $('statusSub').textContent];
    setStatus('busy', label, 'Don’t unplug the servo');
    try { return await fn(); }
    catch (e) { if (silent) log(e.message || String(e)); else toast(e.message || String(e), 'bad'); throw e; }
    finally {
      st.busy = false;
      if ($('status').classList.contains('busy')) { $('status').className = prev[0]; $('statusTitle').textContent = prev[1]; $('statusSub').textContent = prev[2]; }
      updateButtons();
    }
  }

  function connectedStatus() {
    if (st.mode === 'demo') setStatus('warn', 'Demo mode', 'Simulated programmer and servo');
    else setStatus('ok', 'Programmer connected', 'Axon USB programmer');
  }

  async function attach(device) {
    if (st.device === device && st.mode === 'usb') return;
    await detach();
    try {
      const t = new H.WebHidTransport(device);
      await t.open();
      st.transport = t; st.device = device; st.mode = 'usb';
      st.prog = new A.Programmer(t, { log });
      log(`Opened ${device.productName || 'Axon programmer'} (report ${t.outId}, ${t.outLen} bytes)`);
      connectedStatus();
      $('btnConnect').hidden = true; $('btnDemo').hidden = true;
      $('emptyText').innerHTML = 'Programmer connected. Plug a servo into it and press <b>Read from Servo</b>.';
      updateButtons();
      try {
        const ok = await st.prog.initModule();
        if (!ok) { setStatus('warn', 'Programmer not ready', 'Unplug it and plug it back in'); return; }
      } catch (e) { log(`Init: ${e.message}`); }
      readServo(true);
    } catch (e) {
      setStatus('bad', 'Could not open programmer', e.message);
      toast(`Could not open the programmer: ${e.message}`, 'bad');
    }
  }

  async function detach() {
    if (st.transport) await st.transport.close();
    st.transport = st.prog = st.device = null;
    st.mode = 'none';
  }

  function startDemo() {
    detach().then(() => {
      st.mode = 'demo';
      st.prog = new A.Programmer(new A.MockServo(), { log, delay: 15 });
      connectedStatus();
      $('btnConnect').hidden = true; $('btnDemo').hidden = true;
      readServo();
    });
  }

  /* ------------------------------------------------------------ actions */
  async function readServo(quiet) {
    if (!st.prog) return;
    if (st.form && diff(st.base, st.form).length && !quiet) {
      const ok = await native.confirm({ message: 'Discard unsaved changes?', detail: 'Reading from the servo will replace the changes you haven’t written yet.', ok: 'Read Anyway' });
      if (!ok) return;
    }
    try {
      const s = await busy('Reading servo…', () => st.prog.readServo(), { silent: !!quiet });
      showServo(s);
      connectedStatus();
      if (st.mode === 'usb') native.saveBackup({ name: s.name, family: s.family, version: s.version, block: Array.from(s.block), settings: s.settings }).catch(() => {});
      toast(`Read ${s.name || 'servo'} (${s.family}, ${s.version})`, 'ok');
    } catch (e) {
      if (quiet) { clearServo(); connectedStatus(); }
    }
  }

  function sheet(title, bodyEl, actions) {
    return new Promise((resolve) => {
      $('sheetTitle').textContent = title;
      const body = $('sheetBody'); body.innerHTML = ''; body.appendChild(bodyEl);
      const bar = $('sheetActions'); bar.innerHTML = '';
      const close = (v) => { $('sheet').hidden = true; document.removeEventListener('keydown', onKey); resolve(v); };
      const onKey = (e) => { if (e.key === 'Escape') close(null); };
      actions.forEach((a) => {
        const b = el('button', `btn ${a.cls || ''}`); b.textContent = a.label;
        b.addEventListener('click', () => close(a.value));
        bar.appendChild(b);
      });
      document.addEventListener('keydown', onKey);
      $('sheet').hidden = false;
    });
  }

  async function writeServo() {
    if (!st.prog || !st.form || st.busy) return;
    const changes = diff(st.base, st.form);
    if (!changes.length) return;
    const t = el('table', 'changes');
    changes.forEach((c) => {
      const tr = document.createElement('tr');
      tr.innerHTML = '<td></td><td class="old"></td><td>→</td><td class="new"></td>';
      tr.children[0].textContent = c.label; tr.children[1].textContent = c.from; tr.children[3].textContent = c.to;
      t.appendChild(tr);
    });
    const go = await sheet(`Write ${changes.length} change${changes.length > 1 ? 's' : ''} to ${st.servo.name || 'servo'}?`, t, [
      { label: 'Cancel', value: false, cls: 'subtle' },
      { label: 'Write', value: true, cls: 'primary' },
    ]);
    if (!go) return;
    try {
      const r = await busy('Writing…', () => st.prog.writeServo(st.form));
      if (r.mismatch.length) {
        toast(`Write finished but ${r.mismatch.length} byte(s) didn’t verify. Read the servo again and check.`, 'warn');
      } else {
        toast('Settings written and verified ✓', 'ok');
      }
      if (st.mode === 'usb') native.saveBackup({ name: r.name, family: r.family, version: r.version, block: Array.from(r.block), settings: r.settings }).catch(() => {});
      showServo(r);
      connectedStatus();
    } catch { /* toast already shown */ }
  }

  function revert() {
    if (!st.base) return;
    st.form = clone(st.base);
    refresh();
  }

  async function factoryReset() {
    if (!st.prog || !st.servo) return;
    const ok = await native.confirm({ message: `Reset ${st.servo.name || 'this servo'} to factory defaults?`, detail: 'All custom settings on the servo will be replaced. A backup of the current settings has already been saved.', ok: 'Reset', destructive: true });
    if (!ok) return;
    try {
      await busy('Resetting…', () => st.prog.factoryDefault());
      toast('Servo reset to factory defaults', 'ok');
      await readServo(true);
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
    if (!st.servo) { toast('Read a servo first, then open the profile to apply it.', 'warn'); return; }
    if (d.family !== st.servo.family) { toast(`Profile is for ${d.family} servos, but this servo is ${st.servo.family}.`, 'bad'); return; }
    // Only take known keys, so a hand-edited file can't inject junk.
    const next = clone(st.base);
    for (const k of Object.keys(next)) if (k in d.settings && typeof d.settings[k] === typeof next[k]) next[k] = clone(d.settings[k]);
    if (Array.isArray(next.olLevels) && next.olLevels.length !== 3) next.olLevels = clone(st.base.olLevels);
    st.form = next;
    refresh();
    toast(`Loaded ${res.name}. Review the changes, then press Write.`, 'ok');
  }

  async function restoreBackup() {
    if (!st.prog || !st.servo) { toast('Read a servo first, then restore a backup to it.', 'warn'); return; }
    const list = (await native.listBackups()).filter((b) => b.family === st.servo.family && Array.isArray(b.block) && b.block.length === A.PARAM_LEN);
    if (!list.length) { toast('No backups for this servo type yet. One is saved every time you read a servo.', 'warn'); return; }
    let chosen = 0;
    const ul = el('ul', 'backup-list');
    list.forEach((b, i) => {
      const li = el('li', i === 0 ? 'sel' : '');
      li.innerHTML = '<span><b></b><br><small></small></span><small></small>';
      li.querySelector('b').textContent = b.name || 'Servo';
      li.querySelectorAll('small')[0].textContent = `${b.family} · ${b.version || ''}`;
      li.querySelectorAll('small')[1].textContent = new Date(b.savedAt).toLocaleString();
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
      toast(r.mismatch.length ? 'Restored, but verification found differences.' : 'Backup restored and verified ✓', r.mismatch.length ? 'warn' : 'ok');
      showServo(r);
      connectedStatus();
    } catch { /* shown */ }
  }

  async function connectClick() {
    if (!navigator.hid) { toast('USB HID is not available.', 'bad'); return; }
    const d = await H.findDevice();
    if (d) attach(d);
    else toast('No Axon programmer found. Check the USB cable and try another port.', 'warn');
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
  const toggleLog = () => { $('log').hidden = !$('log').hidden; };
  $('btnLog').addEventListener('click', toggleLog);
  $('btnLogClose').addEventListener('click', toggleLog);

  native.onMenu((ch) => ({
    read: () => readServo(), write: writeServo, factory: factoryReset, restore: restoreBackup,
    'save-profile': saveProfile, 'open-profile': openProfile, demo: startDemo, log: toggleLog,
  }[ch] || (() => {}))());

  if (navigator.hid) {
    navigator.hid.addEventListener('connect', (e) => { if (H.isAxon(e.device)) { log('Programmer plugged in'); attach(e.device); } });
    navigator.hid.addEventListener('disconnect', async (e) => {
      if (st.device && e.device === st.device) {
        log('Programmer unplugged');
        await detach();
        clearServo();
        setStatus('', 'Programmer unplugged', 'Plug it back in to continue');
      }
    });
    navigator.hid.getDevices().then((ds) => {
      const d = ds.find(H.isAxon);
      if (d) attach(d);
      else setStatus('', 'No programmer found', 'Plug in the Axon USB programmer');
    });
  } else {
    setStatus('bad', 'USB not available', 'Use the Mac app, or try Demo Mode');
  }
  updateButtons();
})();
