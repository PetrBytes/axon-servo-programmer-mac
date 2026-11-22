'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const invoke = (ch, ...a) => ipcRenderer.invoke(ch, ...a);

let initial = {};
try { initial = ipcRenderer.sendSync('settings:sync') || {}; } catch { /* ignore */ }

contextBridge.exposeInMainWorld('native', {
  initial,
  onQuitHint: (fn) => ipcRenderer.on('quit-hint', () => fn()),
  appInfo: () => invoke('app:info'),
  openRepo: () => invoke('open:repo'),
  openBackups: () => invoke('open:backups'),
  getSettings: () => invoke('settings:get'),
  setSettings: (patch) => invoke('settings:set', patch),
  readLog: () => invoke('log:read'),
  appendLog: (lines) => invoke('log:append', lines),
  clearLog: () => invoke('log:clear'),
  clearCache: () => invoke('cache:clear'),
  cacheSize: () => invoke('cache:size'),
  logSize: () => invoke('log:size'),
  backupsSize: () => invoke('backups:size'),
  setState: (s) => ipcRenderer.send('state', s),
  update: {
    state: () => invoke('update:state'),
    check: () => invoke('update:check'),
    download: () => invoke('update:download'),
    install: () => invoke('update:install'),
    skip: (v) => invoke('update:skip', v),
    onState: (fn) => ipcRenderer.on('update:state', (_e, s) => fn(s)),
  },
  clearBackups: () => invoke('backups:clear'),
  countBackups: () => invoke('backups:count'),
  saveProfile: (suggestedName, data) => invoke('profile:save', { suggestedName, data }),
  openProfile: () => invoke('profile:open'),
  saveBackup: (data) => invoke('backup:save', data),
  listBackups: () => invoke('backup:list'),
  confirm: (opts) => invoke('confirm', opts),
  onMenu: (fn) => ipcRenderer.on('menu', (_e, ch) => fn(ch)),
});
