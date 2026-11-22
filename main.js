'use strict';
const { app, BrowserWindow, ipcMain, dialog, Menu, shell, nativeTheme, net } = require('electron');
const path = require('path');
const fs = require('fs/promises');
const fss = require('fs');
const updater = require('./updater');

const VENDOR_ID = 0x0471;
const PRODUCT_ID = 0x13aa;
const REPO_URL = 'https://github.com/PetrBytes/axon-servo-programmer-mac';
const LOG_MAX_LINES = 3000;
const isAxon = (d) => d && d.vendorId === VENDOR_ID && d.productId === PRODUCT_ID;

let win;

/* PERFORMANCE: switch off Chromium features this app never uses.
 * - SpareRendererForSitePerProcess keeps an extra idle renderer process alive
 * - media/translate/WebRTC services are irrelevant for a USB tool */
app.commandLine.appendSwitch('disable-features', [
  'SpareRendererForSitePerProcess', 'MediaRouter', 'HardwareMediaKeyHandling', 'GlobalMediaControls',
  'Translate', 'WebRtcHideLocalIpsWithMdns', 'AutofillServerCommunication', 'OptimizationHints',
].join(','));

/* ------------------------------------------------------------ storage */
const dataPath = (...p) => path.join(app.getPath('userData'), ...p);
const backupsDir = () => dataPath('backups');
const logFile = () => dataPath('activity.log');
const settingsFile = () => dataPath('settings.json');

const THEMES = ['system', 'light', 'dark', 'midnight', 'aurora', 'sunset', 'glass'];
const LOG_RETENTION = ['forever', 'session', 'last100', 'last500', 'last1000', 'days7', 'days30'];
const UPDATE_INTERVALS = { launch: 0, daily: 24 * 3600e3, weekly: 7 * 24 * 3600e3 };
const DEFAULT_SETTINGS = {
  theme: 'system', glass: 60, showLog: true, autoRead: true, showDemo: true,
  logRetention: 'forever', autoUpdate: true, updateInterval: 'daily', includePrerelease: true,
  lastUpdateCheck: 0, skippedVersion: '', onboarded: false,
};
const themeSourceFor = (t) => (t === 'light' ? 'light' : ['dark', 'midnight', 'aurora', 'sunset'].includes(t) ? 'dark' : 'system');
let settings = { ...DEFAULT_SETTINGS };

function loadSettings() {
  try { settings = { ...DEFAULT_SETTINGS, ...JSON.parse(fss.readFileSync(settingsFile(), 'utf8')) }; }
  catch { settings = { ...DEFAULT_SETTINGS }; }
  if (!THEMES.includes(settings.theme)) settings.theme = 'system';
  nativeTheme.themeSource = themeSourceFor(settings.theme);
}
async function saveSettings() {
  await fs.mkdir(app.getPath('userData'), { recursive: true });
  await fs.writeFile(settingsFile(), JSON.stringify(settings, null, 2));
}

// Serialise log writes so lines never interleave or get lost.
let logQueue = Promise.resolve();
function appendLog(lines) {
  logQueue = logQueue.then(async () => {
    await fs.mkdir(app.getPath('userData'), { recursive: true });
    await fs.appendFile(logFile(), lines.map((l) => String(l).replace(/\n/g, ' ') + '\n').join(''));
  }).catch(() => {});
  return logQueue;
}
let retentionApplied = false;
async function readLog() {
  await logQueue;
  let lines;
  try { lines = (await fs.readFile(logFile(), 'utf8')).split('\n').filter(Boolean); } catch { return []; }
  const before = lines.length;
  if (!retentionApplied) {
    // Retention is applied once per launch, to the history from earlier sessions.
    retentionApplied = true;
    const r = settings.logRetention;
    if (r === 'session') lines = [];
    else if (r.startsWith('last')) lines = lines.slice(-Number(r.slice(4)));
    else if (r.startsWith('days')) {
      const cutoff = Date.now() - Number(r.slice(4)) * 24 * 3600e3;
      lines = lines.filter((l) => { const t = Date.parse(l.slice(0, 19).replace(' ', 'T')); return !Number.isFinite(t) || t >= cutoff; });
    }
  }
  if (lines.length > LOG_MAX_LINES) lines = lines.slice(-LOG_MAX_LINES);
  if (lines.length !== before) await fs.writeFile(logFile(), lines.length ? lines.join('\n') + '\n' : '');
  return lines;
}

/* ------------------------------------------------------------- window */
function bgColor() {
  if (settings.theme === 'glass') return '#00000000';
  if (settings.theme === 'midnight') return '#000000';
  return nativeTheme.shouldUseDarkColors ? '#1c1c1e' : '#f5f5f7';
}
function applyWindowTheme() {
  if (!win) return;
  try { win.setVibrancy(settings.theme === 'glass' ? 'under-window' : null); } catch { /* not macOS */ }
  win.setBackgroundColor(bgColor());
}

function createWindow() {
  win = new BrowserWindow({
    width: 1120,
    height: 780,
    minWidth: 940,
    minHeight: 640,
    title: 'Axon Servo Programmer',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 18, y: 18 },
    backgroundColor: bgColor(),
    vibrancy: settings.theme === 'glass' ? 'under-window' : undefined,
    visualEffectState: 'followWindow',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false, // the dictionary service costs memory and isn't needed
      enableWebSQL: false,
      v8CacheOptions: 'bypassHeatCheck', // cache compiled JS on first run -> faster launches
      backgroundThrottling: true,
    },
  });

  const ses = win.webContents.session;
  ses.on('select-hid-device', (event, details, callback) => {
    event.preventDefault();
    const dev = details.deviceList.find(isAxon);
    callback(dev ? dev.deviceId : '');
  });
  ses.setPermissionCheckHandler((_wc, permission) => permission === 'hid');
  ses.setDevicePermissionHandler((d) => d.deviceType === 'hid' && isAxon(d.device));

  win.on('close', (e) => { if (!confirmQuitSync()) e.preventDefault(); else allowQuit = true; });
  win.once('ready-to-show', () => win.show());
  win.loadFile(path.join(__dirname, 'src', 'index.html'));
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https:\/\//.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e) => e.preventDefault());
}

nativeTheme.on('updated', () => { if (win) win.setBackgroundColor(bgColor()); });

/* -------------------------------------------- quit / close protection */
let rendererState = { busy: false, dirty: false };
let allowQuit = false;
ipcMain.on('state', (_e, s) => { rendererState = { busy: !!(s && s.busy), dirty: !!(s && s.dirty) }; });

function confirmQuitSync() {
  if (allowQuit) return true;
  if (rendererState.busy) {
    dialog.showMessageBoxSync(win, { type: 'warning', buttons: ['OK'], message: 'Please wait — the servo is being written.', detail: 'Quitting now could leave the servo half-written. The app will be ready to quit in a moment.' });
    return false;
  }
  if (rendererState.dirty) {
    const r = dialog.showMessageBoxSync(win, { type: 'question', buttons: ['Cancel', 'Quit Without Writing'], defaultId: 0, cancelId: 0, message: 'You have changes that haven’t been written to the servo.', detail: 'If you quit now they will be lost.' });
    return r === 1;
  }
  return true;
}
app.on('before-quit', (e) => { if (!confirmQuitSync()) e.preventDefault(); else allowQuit = true; });

function buildMenu() {
  const send = (ch) => () => win && win.webContents.send('menu', ch);
  const template = [
    {
      label: app.name,
      submenu: [
        { role: 'about' },
        { label: 'Check for Updates…', click: send('check-updates') },
        { type: 'separator' },
        { label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: send('settings') },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'File',
      submenu: [
        { label: 'Open Profile…', accelerator: 'CmdOrCtrl+O', click: send('open-profile') },
        { label: 'Save Profile…', accelerator: 'CmdOrCtrl+S', click: send('save-profile') },
        { type: 'separator' },
        { label: 'Show Backups Folder', click: async () => { await fs.mkdir(backupsDir(), { recursive: true }); shell.openPath(backupsDir()); } },
      ],
    },
    { role: 'editMenu' },
    {
      label: 'Servo',
      submenu: [
        { label: 'Read', accelerator: 'CmdOrCtrl+R', click: send('read') },
        { label: 'Write', accelerator: 'CmdOrCtrl+Return', click: send('write') },
        { label: 'Discard Changes', click: send('revert') },
        { type: 'separator' },
        { label: 'Restore a Backup…', click: send('restore') },
        { label: 'Default (Factory Reset)…', click: send('factory') },
        { type: 'separator' },
        { label: 'Demo Mode (no hardware)', click: send('demo') },
        { label: 'Back to Start Screen', click: send('home') },
      ],
    },
    {
      label: 'View',
      submenu: [
        { label: 'Show/Hide Activity Log', accelerator: 'CmdOrCtrl+L', click: send('log') },
        { type: 'separator' },
        { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    // No Close item: ⌘W does nothing, only ⌘Q quits (as requested).
    { label: 'Window', submenu: [{ role: 'minimize' }, { role: 'zoom' }, { type: 'separator' }, { role: 'front' }] },
    { role: 'help', submenu: [{ label: 'Project on GitHub', click: () => shell.openExternal(REPO_URL) }, { label: 'Report a Problem', click: () => shell.openExternal(REPO_URL + '/issues') }, { type: 'separator' }, { role: 'toggleDevTools' }] },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/* ---------------------------------------------------------------- IPC */
ipcMain.handle('app:info', () => ({ version: app.getVersion(), repo: REPO_URL, electron: process.versions.electron }));
ipcMain.handle('open:repo', () => shell.openExternal(REPO_URL));
ipcMain.handle('open:backups', async () => { await fs.mkdir(backupsDir(), { recursive: true }); return shell.openPath(backupsDir()); });

ipcMain.handle('settings:get', () => settings);
ipcMain.handle('settings:set', async (_e, patch = {}) => {
  const next = { ...settings };
  if (THEMES.includes(patch.theme)) next.theme = patch.theme;
  if (Number.isFinite(patch.glass)) next.glass = Math.max(0, Math.min(100, Math.round(patch.glass)));
  for (const k of ['showLog', 'autoRead', 'showDemo', 'autoUpdate', 'includePrerelease', 'onboarded']) if (typeof patch[k] === 'boolean') next[k] = patch[k];
  if (LOG_RETENTION.includes(patch.logRetention)) next.logRetention = patch.logRetention;
  if (patch.updateInterval in UPDATE_INTERVALS) next.updateInterval = patch.updateInterval;
  if (typeof patch.skippedVersion === 'string') next.skippedVersion = patch.skippedVersion.slice(0, 40);
  const themeChanged = next.theme !== settings.theme;
  settings = next;
  nativeTheme.themeSource = themeSourceFor(settings.theme);
  if (themeChanged) applyWindowTheme();
  await saveSettings();
  scheduleUpdateChecks();
  return settings;
});

ipcMain.handle('log:read', () => readLog());
ipcMain.handle('log:append', (_e, lines) => appendLog(Array.isArray(lines) ? lines.slice(0, 100) : [String(lines)]));
ipcMain.handle('log:clear', async () => { await logQueue; await fs.rm(logFile(), { force: true }); return true; });

const CACHE_DIRS = ['Cache', 'Code Cache', 'GPUCache', 'DawnGraphiteCache', 'DawnWebGPUCache', 'Shared Dictionary', 'Crashpad'];
async function dirSize(p) {
  let total = 0;
  let entries;
  try { entries = await fs.readdir(p, { withFileTypes: true }); } catch { return 0; }
  for (const e of entries) {
    const full = path.join(p, e.name);
    if (e.isDirectory()) total += await dirSize(full);
    else { try { total += (await fs.stat(full)).size; } catch { /* gone */ } }
  }
  return total;
}
async function cacheSize() {
  let total = 0;
  for (const d of CACHE_DIRS) total += await dirSize(dataPath(d));
  total += await dirSize(updater.workDir());
  return total;
}
ipcMain.handle('cache:size', () => cacheSize());
ipcMain.handle('cache:clear', async () => {
  const before = await cacheSize();
  const ses = win.webContents.session;
  await ses.clearCache();
  try { await ses.clearCodeCaches({}); } catch { /* older Electron */ }
  await ses.clearStorageData({ storages: ['cachestorage', 'shadercache', 'serviceworkers'] });
  await fs.rm(updater.workDir(), { recursive: true, force: true });
  const after = await cacheSize();
  return { before, after, freed: Math.max(0, before - after) };
});
ipcMain.handle('log:size', async () => { try { return (await fs.stat(logFile())).size; } catch { return 0; } });
ipcMain.handle('backups:size', () => dirSize(backupsDir()));
ipcMain.handle('backups:clear', async () => {
  const dir = backupsDir();
  let n = 0;
  try {
    for (const f of await fs.readdir(dir)) if (f.endsWith('.json')) { await fs.rm(path.join(dir, f), { force: true }); n++; }
  } catch { /* none */ }
  return n;
});
ipcMain.handle('backups:count', async () => {
  try { return (await fs.readdir(backupsDir())).filter((f) => f.endsWith('.json')).length; } catch { return 0; }
});

ipcMain.handle('profile:save', async (_e, { suggestedName, data }) => {
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    title: 'Save Servo Profile',
    defaultPath: path.join(app.getPath('documents'), `${suggestedName || 'servo'}.axonprofile.json`),
    filters: [{ name: 'Axon Profile', extensions: ['json'] }],
  });
  if (canceled || !filePath) return null;
  await fs.writeFile(filePath, JSON.stringify(data, null, 2));
  return path.basename(filePath);
});

ipcMain.handle('profile:open', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: 'Open Servo Profile',
    defaultPath: app.getPath('documents'),
    filters: [{ name: 'Axon Profile', extensions: ['json'] }],
    properties: ['openFile'],
  });
  if (canceled || !filePaths[0]) return null;
  const text = await fs.readFile(filePaths[0], 'utf8');
  return { name: path.basename(filePaths[0]), data: JSON.parse(text) };
});

ipcMain.handle('backup:save', async (_e, data) => {
  const dir = backupsDir();
  await fs.mkdir(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const safe = String(data.name || 'servo').replace(/[^A-Za-z0-9_-]+/g, '_');
  const files = (await fs.readdir(dir)).filter((f) => f.startsWith(safe + '_')).sort();
  if (files.length) {
    try {
      const last = JSON.parse(await fs.readFile(path.join(dir, files[files.length - 1]), 'utf8'));
      if (JSON.stringify(last.block) === JSON.stringify(data.block)) return files[files.length - 1];
    } catch { /* ignore unreadable backup */ }
  }
  const file = `${safe}_${stamp}.json`;
  await fs.writeFile(path.join(dir, file), JSON.stringify({ ...data, savedAt: new Date().toISOString() }, null, 2));
  return file;
});

ipcMain.handle('backup:list', async () => {
  const dir = backupsDir();
  await fs.mkdir(dir, { recursive: true });
  const files = (await fs.readdir(dir)).filter((f) => f.endsWith('.json')).sort().reverse();
  const out = [];
  for (const f of files.slice(0, 100)) {
    try {
      const d = JSON.parse(await fs.readFile(path.join(dir, f), 'utf8'));
      out.push({ file: f, name: d.name, savedAt: d.savedAt, family: d.family, block: d.block, version: d.version });
    } catch { /* skip */ }
  }
  return out;
});

ipcMain.handle('confirm', async (_e, { message, detail, ok = 'OK', destructive = false }) => {
  const { response } = await dialog.showMessageBox(win, {
    type: destructive ? 'warning' : 'question',
    buttons: [ok, 'Cancel'],
    defaultId: destructive ? 1 : 0,
    cancelId: 1,
    message,
    detail,
  });
  return response === 0;
});

/* ------------------------------------------------------------ updates */
let updateState = { status: 'idle', info: null, error: null, progress: 0, file: null };
const pushUpdate = () => win && !win.isDestroyed() && win.webContents.send('update:state', updateState);
const setUpdate = (patch) => { updateState = { ...updateState, ...patch }; pushUpdate(); return updateState; };

async function checkForUpdates({ manual = false } = {}) {
  if (['checking', 'downloading', 'installing'].includes(updateState.status)) return updateState;
  setUpdate({ status: 'checking', error: null });
  try {
    const info = await updater.check(net.fetch, app.getVersion(), { includePrerelease: settings.includePrerelease, arch: process.arch });
    settings.lastUpdateCheck = Date.now();
    await saveSettings();
    if (info && !manual && settings.skippedVersion === info.version) return setUpdate({ status: 'uptodate', info: null, skipped: info.version });
    if (updateState.file && updateState.info && info && updateState.info.version === info.version) return setUpdate({ status: 'ready', info });
    return setUpdate({ status: info ? 'available' : 'uptodate', info, checkedAt: Date.now() });
  } catch (e) {
    return setUpdate({ status: 'error', error: e.message });
  }
}

let updateTimer = null;
function scheduleUpdateChecks() {
  if (updateTimer) clearInterval(updateTimer);
  updateTimer = null;
  if (!settings.autoUpdate) return;
  const due = () => {
    const iv = UPDATE_INTERVALS[settings.updateInterval] ?? UPDATE_INTERVALS.daily;
    return iv === 0 ? false : Date.now() - (settings.lastUpdateCheck || 0) >= iv;
  };
  updateTimer = setInterval(() => { if (settings.autoUpdate && due()) checkForUpdates(); }, 3600e3);
}

ipcMain.handle('update:state', () => updateState);
ipcMain.handle('update:check', () => checkForUpdates({ manual: true }));
ipcMain.handle('update:skip', async (_e, version) => { settings.skippedVersion = String(version || ''); await saveSettings(); return setUpdate({ status: 'uptodate', info: null }); });
ipcMain.handle('update:download', async () => {
  const info = updateState.info;
  if (!info) throw new Error('No update to download.');
  if (updateState.status === 'downloading') return updateState;
  setUpdate({ status: 'downloading', progress: 0, error: null });
  try {
    let lastSent = 0;
    const file = await updater.download(net.fetch, info, (got, total) => {
      const p = total ? got / total : 0;
      if (p - lastSent >= 0.01 || p === 1) { lastSent = p; setUpdate({ progress: p }); }
    });
    return setUpdate({ status: 'ready', file, progress: 1 });
  } catch (e) {
    return setUpdate({ status: 'error', error: e.message });
  }
});
ipcMain.handle('update:install', async () => {
  const { info, file } = updateState;
  if (!info || !file) throw new Error('Download the update first.');
  if (rendererState.busy) throw new Error('Wait for the servo write to finish first.');
  setUpdate({ status: 'installing', error: null });
  const target = await updater.currentBundle(process.execPath);
  try {
    if (!target || process.platform !== 'darwin') throw Object.assign(new Error('manual'), { manual: true });
    const staged = await updater.stage(file, info.version);
    await updater.scheduleSwap(staged, target, process.pid);
    allowQuit = true;
    setTimeout(() => app.quit(), 300);
    return setUpdate({ status: 'relaunching' });
  } catch (e) {
    // Anything unexpected: hand the DMG to the user instead of risking a broken install.
    try {
      const dest = await updater.openManually(file, app.getPath('downloads'), shell.openPath);
      return setUpdate({ status: 'manual', error: e.manual ? null : e.message, manualPath: dest });
    } catch (e2) {
      return setUpdate({ status: 'error', error: e2.message });
    }
  }
});

app.setAboutPanelOptions({ applicationName: 'Axon Servo Programmer', credits: 'Unofficial. Not affiliated with Axon.\n' + REPO_URL });

app.whenReady().then(() => {
  loadSettings();
  buildMenu();
  createWindow();
  scheduleUpdateChecks();
  if (settings.autoUpdate) {
    const iv = UPDATE_INTERVALS[settings.updateInterval] ?? UPDATE_INTERVALS.daily;
    if (iv === 0 || Date.now() - (settings.lastUpdateCheck || 0) >= iv) setTimeout(() => checkForUpdates(), 8000);
  }
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', () => app.quit());
