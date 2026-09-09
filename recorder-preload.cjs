const { contextBridge, ipcRenderer } = require('electron');
ipcRenderer.send('recorder:preload-ready');

contextBridge.exposeInMainWorld('researchRecorder', {
  getStatus: () => ipcRenderer.invoke('recorder:get-status'),
  rendererReady: () => ipcRenderer.invoke('recorder:renderer-ready'),
  mediaStage: stage => ipcRenderer.invoke('recorder:media-stage', stage),
  saveConfig: config => ipcRenderer.invoke('recorder:save-config', config),
  start: () => ipcRenderer.invoke('recorder:start'),
  stop: () => ipcRenderer.invoke('recorder:stop'),
  quit: () => ipcRenderer.invoke('recorder:quit'),
  openFolder: () => ipcRenderer.invoke('recorder:open-folder'),
  mediaReady: details => ipcRenderer.invoke('recorder:media-ready', details),
  mediaFailed: details => ipcRenderer.invoke('recorder:media-failed', details),
  cameraChunk: chunk => ipcRenderer.invoke('recorder:camera-chunk', chunk),
  audioChunk: chunk => ipcRenderer.invoke('recorder:audio-chunk', chunk),
  rotateCamera: details => ipcRenderer.invoke('recorder:rotate-camera', details),
  onCommand: callback => { const handler = (_event, command) => callback(command); ipcRenderer.on('recorder:command', handler); return () => ipcRenderer.removeListener('recorder:command', handler); },
});
