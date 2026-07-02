const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getDrives: () => ipcRenderer.invoke('get-drives'),
  chooseFolder: () => ipcRenderer.invoke('choose-folder'),
  startScan: (root) => ipcRenderer.invoke('start-scan', root),
  cancelScan: () => ipcRenderer.invoke('cancel-scan'),
  trashItems: (paths) => ipcRenderer.invoke('trash-items', paths),
  showInFolder: (p) => ipcRenderer.invoke('show-in-folder', p),
  onProgress: (fn) => ipcRenderer.on('scan-progress', (_e, d) => fn(d)),
  onDone: (fn) => ipcRenderer.on('scan-done', (_e, d) => fn(d)),
  onError: (fn) => ipcRenderer.on('scan-error', (_e, d) => fn(d))
});
