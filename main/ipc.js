'use strict';

/**
 * ipc.js — registers all IPC handlers and wires up main-process modules.
 *
 * Call registerHandlers(mainWindow) once the BrowserWindow is ready.
 *
 * Channels:
 *   invoke  folder:select         → string | null
 *   invoke  scan:start            → void  (streams via webContents events)
 *   send    scan:progress         ← { scanned, found, currentPath, done? }
 *   send    scan:item             ← Item
 *   send    scan:complete         ← { items[], skipped[], totalScanned }
 *   send    scan:error            ← { message }
 *   invoke  delete:preview        → { items[], totalBytes }
 *   invoke  delete:confirm        → { results[], totalFreed, failureCount }
 */

const { ipcMain, dialog } = require('electron');
const { scan, checkDangerousRoot } = require('./scanner');
const { buildPreview, deleteItems } = require('./deleter');

let activeScan = null; // track if a scan is running (prevent double-scans)

function registerHandlers(mainWindow) {
  // ── folder:select ──────────────────────────────────────────────────────
  ipcMain.handle('folder:select', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Select root folder to scan',
      properties: ['openDirectory'],
    });

    if (result.canceled || result.filePaths.length === 0) return null;
    const chosen = result.filePaths[0];

    // Check if the chosen path is dangerous and include the warning in the
    // response so the renderer can show it — we still return the path so
    // the user can consciously proceed.
    const { dangerous, reason } = checkDangerousRoot(chosen);
    return { path: chosen, dangerous, reason };
  });

  // ── scan:start ─────────────────────────────────────────────────────────
  ipcMain.handle('scan:start', async (_event, { rootPath }) => {
    if (activeScan) {
      return { alreadyRunning: true };
    }

    // Defence-in-depth: re-validate even if the renderer somehow let it through.
    const { dangerous, reason } = checkDangerousRoot(rootPath);
    if (dangerous) {
      return { blocked: true, reason };
    }

    // activeScan doubles as the cancellation signal passed into scan().
    // Setting activeScan.cancelled = true stops the walk at the next entry.
    activeScan = { cancelled: false };

    try {
      const result = await scan(rootPath, {
        signal: activeScan,
        onProgress(stats) {
          if (activeScan && activeScan.cancelled) return;
          if (!mainWindow.isDestroyed()) {
            mainWindow.webContents.send('scan:progress', stats);
          }
        },
        onItem(item) {
          if (activeScan && activeScan.cancelled) return;
          if (!mainWindow.isDestroyed()) {
            mainWindow.webContents.send('scan:item', item);
          }
        },
      });

      // Only send scan:complete if we weren't cancelled mid-way.
      if (!activeScan?.cancelled && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('scan:complete', {
          items: result.items,
          skipped: result.skipped,
          totalScanned: result.items.length,
        });
      }
    } catch (err) {
      if (!mainWindow.isDestroyed()) {
        mainWindow.webContents.send('scan:error', { message: err.message });
      }
    } finally {
      activeScan = null;
    }

    return {};
  });

  // ── scan:cancel ────────────────────────────────────────────────────────
  ipcMain.handle('scan:cancel', async () => {
    if (activeScan) {
      activeScan.cancelled = true;
      // Don't null out activeScan here — scan:start's finally block does that
      // after the walk unwinds. This prevents a race where a new scan starts
      // before the old walk has fully exited.
    }
    return {};
  });

  // ── delete:preview ─────────────────────────────────────────────────────
  ipcMain.handle('delete:preview', async (_event, { selectedItems }) => {
    try {
      return buildPreview(selectedItems);
    } catch (err) {
      throw new Error(`Preview failed: ${err.message}`);
    }
  });

  // ── delete:confirm ─────────────────────────────────────────────────────
  ipcMain.handle('delete:confirm', async (_event, { items }) => {
    try {
      return await deleteItems(items);
    } catch (err) {
      throw new Error(`Deletion failed: ${err.message}`);
    }
  });
}

function unregisterHandlers() {
  ipcMain.removeAllListeners('folder:select');
  ipcMain.removeHandler('folder:select');
  ipcMain.removeHandler('scan:start');
  ipcMain.removeHandler('scan:cancel');
  ipcMain.removeHandler('delete:preview');
  ipcMain.removeHandler('delete:confirm');
}

module.exports = { registerHandlers, unregisterHandlers };
