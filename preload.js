'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('native', {
  saveProfile: (suggestedName, data) => ipcRenderer.invoke('profile:save', { suggestedName, data }),
  openProfile: () => ipcRenderer.invoke('profile:open'),
  saveBackup: (data) => ipcRenderer.invoke('backup:save', data),
  listBackups: () => ipcRenderer.invoke('backup:list'),
  confirm: (opts) => ipcRenderer.invoke('confirm', opts),
  onMenu: (fn) => ipcRenderer.on('menu', (_e, ch) => fn(ch)),
});
