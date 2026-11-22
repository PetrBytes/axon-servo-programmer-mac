'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const invoke = (ch, ...a) => ipcRenderer.invoke(ch, ...a);

contextBridge.exposeInMainWorld('native', {
  appInfo: () => invoke('app:info'),
  openRepo: () => invoke('open:repo'),
  openBackups: () => invoke('open:backups'),
  getSettings: () => invoke('settings:get'),
  setSettings: (patch) => invoke('settings:set', patch),
  readLog: () => invoke('log:read'),
  appendLog: (lines) => invoke('log:append', lines),
  clearLog: () => invoke('log:clear'),
  clearCache: () => invoke('cache:clear'),
  clearBackups: () => invoke('backups:clear'),
  countBackups: () => invoke('backups:count'),
  saveProfile: (suggestedName, data) => invoke('profile:save', { suggestedName, data }),
  openProfile: () => invoke('profile:open'),
  saveBackup: (data) => invoke('backup:save', data),
  listBackups: () => invoke('backup:list'),
  confirm: (opts) => invoke('confirm', opts),
  onMenu: (fn) => ipcRenderer.on('menu', (_e, ch) => fn(ch)),
});
