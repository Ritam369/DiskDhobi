'use strict';

/**
 * preload.js — runs in a privileged context and exposes a safe, narrow API
 * to the renderer via contextBridge. The renderer never has access to Node or
 * Electron internals directly.
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // Folder selection
  selectFolder: () => ipcRenderer.invoke('folder:select'),

  // Scanning
  startScan: (rootPath) => ipcRenderer.invoke('scan:start', { rootPath }),
  cancelScan: () => ipcRenderer.invoke('scan:cancel'),

  // Deletion
  previewDelete: (selectedItems) =>
    ipcRenderer.invoke('delete:preview', { selectedItems }),
  confirmDelete: (items) =>
    ipcRenderer.invoke('delete:confirm', { items }),

  // Event listeners (renderer subscribes to streaming events from main)
  onScanProgress: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('scan:progress', handler);
    return () => ipcRenderer.removeListener('scan:progress', handler);
  },

  onScanItem: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('scan:item', handler);
    return () => ipcRenderer.removeListener('scan:item', handler);
  },

  onScanComplete: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('scan:complete', handler);
    return () => ipcRenderer.removeListener('scan:complete', handler);
  },

  onScanError: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('scan:error', handler);
    return () => ipcRenderer.removeListener('scan:error', handler);
  },
});
