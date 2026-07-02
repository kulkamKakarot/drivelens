const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { Worker } = require('worker_threads');

let win = null;
let scanWorker = null;

function stopWorker() {
  if (scanWorker) {
    scanWorker.terminate().catch(() => {});
    scanWorker = null;
  }
}

function createWindow() {
  win = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 960,
    minHeight: 620,
    backgroundColor: '#0f1115',
    autoHideMenuBar: true,
    title: 'DriveLens',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true
    }
  });
  // The app is fully local: block any window creation or navigation away
  // from the bundled UI (defense-in-depth against injected content).
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.on('closed', () => { win = null; });
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  stopWorker();
  app.quit();
});

// ---- IPC input validation ----
// The renderer is sandboxed, but validate everything it sends anyway.
function isValidPath(p) {
  return typeof p === 'string' &&
    p.length > 0 &&
    p.length < 4096 &&
    /^[A-Za-z]:\\/.test(p) &&      // absolute local path only
    !p.includes('\0') &&
    !/(^|\\)\.\.(\\|$)/.test(p);  // no ".." path segments
}

// ---- Drive discovery ----
ipcMain.handle('get-drives', () => {
  const drives = [];
  for (let i = 65; i <= 90; i++) {
    const letter = String.fromCharCode(i);
    const root = letter + ':\\';
    try {
      const s = fs.statfsSync(root);
      const total = s.bsize * s.blocks;
      const free = s.bsize * s.bavail;
      if (total > 0) drives.push({ letter, root, total, free });
    } catch (_) { /* drive letter not present */ }
  }
  return drives;
});

ipcMain.handle('choose-folder', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: 'Choose a folder to scan',
    properties: ['openDirectory']
  });
  return r.canceled ? null : r.filePaths[0];
});

// ---- Scanning ----
ipcMain.handle('start-scan', (_e, root) => {
  if (!isValidPath(root)) return false;
  stopWorker();
  scanWorker = new Worker(path.join(__dirname, 'scanner-worker.js'), {
    workerData: { root }
  });
  scanWorker.on('message', (msg) => {
    if (!win || win.isDestroyed()) return;
    if (msg.type === 'progress') {
      win.webContents.send('scan-progress', msg);
    } else if (msg.type === 'done') {
      win.webContents.send('scan-done', msg);
      stopWorker();
    }
  });
  scanWorker.on('error', (err) => {
    if (win && !win.isDestroyed()) {
      win.webContents.send('scan-error', String((err && err.message) || err));
    }
    stopWorker();
  });
  return true;
});

ipcMain.handle('cancel-scan', () => {
  stopWorker();
  return true;
});

// ---- File operations ----
ipcMain.handle('trash-items', async (_e, paths) => {
  if (!Array.isArray(paths) || paths.length > 500) return [];
  const results = [];
  for (const p of paths) {
    if (!isValidPath(p)) {
      results.push({ path: String(p).slice(0, 200), ok: false, error: 'Invalid path' });
      continue;
    }
    try {
      await shell.trashItem(p);
      results.push({ path: p, ok: true });
    } catch (err) {
      results.push({ path: p, ok: false, error: String((err && err.message) || err) });
    }
  }
  return results;
});

ipcMain.handle('show-in-folder', (_e, p) => {
  if (!isValidPath(p)) return false;
  shell.showItemInFolder(p);
  return true;
});
