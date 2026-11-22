'use strict';
const { app, BrowserWindow, ipcMain, dialog, Menu, shell, nativeTheme } = require('electron');
const path = require('path');
const fs = require('fs/promises');
const fss = require('fs');

const VENDOR_ID = 0x0471;
const PRODUCT_ID = 0x13aa;
const REPO_URL = 'https://github.com/PetrBytes/axon-servo-programmer-mac';
const LOG_MAX_LINES = 3000;
const isAxon = (d) => d && d.vendorId === VENDOR_ID && d.productId === PRODUCT_ID;

let win;

/* ------------------------------------------------------------ storage */
const dataPath = (...p) => path.join(app.getPath('userData'), ...p);
const backupsDir = () => dataPath('backups');
const logFile = () => dataPath('activity.log');
const settingsFile = () => dataPath('settings.json');

const DEFAULT_SETTINGS = { theme: 'system', showLog: true, autoRead: true };
let settings = { ...DEFAULT_SETTINGS };

function loadSettings() {
  try { settings = { ...DEFAULT_SETTINGS, ...JSON.parse(fss.readFileSync(settingsFile(), 'utf8')) }; }
  catch { settings = { ...DEFAULT_SETTINGS }; }
  nativeTheme.themeSource = ['light', 'dark', 'system'].includes(settings.theme) ? settings.theme : 'system';
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
async function readLog() {
  await logQueue;
  try {
    const lines = (await fs.readFile(logFile(), 'utf8')).split('\n').filter(Boolean);
    if (lines.length > LOG_MAX_LINES) {
      const keep = lines.slice(-LOG_MAX_LINES);
      await fs.writeFile(logFile(), keep.join('\n') + '\n');
      return keep;
    }
    return lines;
  } catch { return []; }
}

/* ------------------------------------------------------------- window */
function bgColor() { return nativeTheme.shouldUseDarkColors ? '#1c1c1e' : '#f5f5f7'; }

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
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
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

  win.once('ready-to-show', () => win.show());
  win.loadFile(path.join(__dirname, 'src', 'index.html'));
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https:\/\//.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e) => e.preventDefault());
}

nativeTheme.on('updated', () => { if (win) win.setBackgroundColor(bgColor()); });

function buildMenu() {
  const send = (ch) => () => win && win.webContents.send('menu', ch);
  const template = [
    {
      label: app.name,
      submenu: [
        { role: 'about' },
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
        { type: 'separator' },
        { role: 'close' },
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
    { role: 'windowMenu' },
    { role: 'help', submenu: [{ label: 'Project on GitHub', click: () => shell.openExternal(REPO_URL) }, { label: 'Report a Problem', click: () => shell.openExternal(REPO_URL + '/issues') }, { type: 'separator' }, { role: 'toggleDevTools' }] },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/* ---------------------------------------------------------------- IPC */
ipcMain.handle('app:info', () => ({ version: app.getVersion(), repo: REPO_URL, electron: process.versions.electron }));
ipcMain.handle('open:repo', () => shell.openExternal(REPO_URL));
ipcMain.handle('open:backups', async () => { await fs.mkdir(backupsDir(), { recursive: true }); return shell.openPath(backupsDir()); });

ipcMain.handle('settings:get', () => settings);
ipcMain.handle('settings:set', async (_e, patch) => {
  const next = { ...settings };
  if (patch && ['light', 'dark', 'system'].includes(patch.theme)) next.theme = patch.theme;
  if (patch && typeof patch.showLog === 'boolean') next.showLog = patch.showLog;
  if (patch && typeof patch.autoRead === 'boolean') next.autoRead = patch.autoRead;
  settings = next;
  nativeTheme.themeSource = settings.theme;
  await saveSettings();
  return settings;
});

ipcMain.handle('log:read', () => readLog());
ipcMain.handle('log:append', (_e, lines) => appendLog(Array.isArray(lines) ? lines.slice(0, 100) : [String(lines)]));
ipcMain.handle('log:clear', async () => { await logQueue; await fs.rm(logFile(), { force: true }); return true; });

ipcMain.handle('cache:clear', async () => {
  const ses = win.webContents.session;
  await ses.clearCache();
  await ses.clearStorageData({ storages: ['cachestorage', 'shadercache', 'serviceworkers'] });
  return true;
});
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

app.setAboutPanelOptions({ applicationName: 'Axon Servo Programmer', credits: 'Unofficial. Not affiliated with Axon.\n' + REPO_URL });

app.whenReady().then(() => {
  loadSettings();
  buildMenu();
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', () => app.quit());
