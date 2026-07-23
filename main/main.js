'use strict';

const { app, BrowserWindow, session } = require('electron');
const path = require('path');
const { registerHandlers, unregisterHandlers } = require('./ipc');

// Keep a global reference so the window is not garbage-collected.
let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 780,
    minWidth: 800,
    minHeight: 600,
    title: 'DiskDhobi',
    show: false, // show only after 'ready-to-show' to avoid white flash
    backgroundColor: '#1a1a2e',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      // Security: renderer cannot use Node.js APIs directly.
      nodeIntegration: false,
      contextIsolation: true,
      // No remote content — fully offline.
      webSecurity: true,
    },
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  mainWindow.on('closed', () => {
    unregisterHandlers();
    mainWindow = null;
  });

  // Block any accidental network requests (should never happen, but belt + braces).
  session.defaultSession.webRequest.onBeforeRequest(
    { urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] },
    (_details, callback) => {
      callback({ cancel: true });
    }
  );

  // Register all IPC channels.
  registerHandlers(mainWindow);
}

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    // macOS convention — re-create window if dock icon is clicked and none exist.
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  // On Linux/Windows, quit when all windows are closed.
  if (process.platform !== 'darwin') app.quit();
});
