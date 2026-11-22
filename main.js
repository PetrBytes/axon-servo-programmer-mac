'use strict';
const { app, BrowserWindow, ipcMain, dialog, Menu, shell, nativeTheme } = require('electron');
const path = require('path');
const fs = require('fs/promises');

const VENDOR_ID = 0x0471;
const PRODUCT_ID = 0x13aa;
const isAxon = (d) => d && d.vendorId === VENDOR_ID && d.productId === PRODUCT_ID;

let win;

function backupsDir() {
  return path.join(app.getPath('userData'), 'backups');
}

function createWindow() {
  win = new BrowserWindow({
    width: 1040,
    height: 760,
    minWidth: 900,
    minHeight: 640,
    title: 'Axon Servo Programmer',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 18, y: 18 },
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1c1c1e' : '#f5f5f7',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  const ses = win.webContents.session;

  // Only ever expose the Axon programmer to the page, and grant it without a picker.
  ses.on('select-hid-device', (event, details, callback) => {
    event.preventDefault();
    const dev = details.deviceList.find(isAxon);
    callback(dev ? dev.deviceId : '');
  });
  ses.setPermissionCheckHandler((_wc, permission) => permission === 'hid');
  ses.setDevicePermissionHandler((d) => d.deviceType === 'hid' && isAxon(d.device));

  win.once('ready-to-show', () => win.show());
  win.loadFile(path.join(__dirname, 'src', 'index.html'));

  // External links open in the browser, never inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e) => e.preventDefault());
}

function buildMenu() {
  const send = (ch) => () => win && win.webContents.send('menu', ch);
  const template = [
    { role: 'appMenu' },
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
        { label: 'Read from Servo', accelerator: 'CmdOrCtrl+R', click: send('read') },
        { label: 'Write to Servo', accelerator: 'CmdOrCtrl+Return', click: send('write') },
        { type: 'separator' },
        { label: 'Restore a Backup…', click: send('restore') },
        { label: 'Reset to Factory Defaults…', click: send('factory') },
        { type: 'separator' },
        { label: 'Demo Mode (no hardware)', click: send('demo') },
      ],
    },
    { label: 'View', submenu: [{ label: 'Toggle Activity Log', accelerator: 'CmdOrCtrl+L', click: send('log') }, { type: 'separator' }, { role: 'togglefullscreen' }, { role: 'toggleDevTools' }] },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/* ------------------------------------------------------------- file IPC */

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
  // Skip if identical to the newest backup of this servo.
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

app.whenReady().then(() => {
  buildMenu();
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', () => app.quit());
