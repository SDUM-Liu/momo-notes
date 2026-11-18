const { contextBridge, ipcRenderer } = require('electron')

const invoke = channel => (...args) => ipcRenderer.invoke(channel, ...args)
const listen = channel => callback => {
  const listener = (_event, value) => callback(value)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

contextBridge.exposeInMainWorld('momo', {
  getState: invoke('app:state'),
  onState: listen('app:state-changed'),
  onDay: listen('notes:day-changed'),
  toggle: invoke('window:toggle'),
  dragStart: () => ipcRenderer.send('window:drag-start'),
  dragMove: () => ipcRenderer.send('window:drag-move'),
  dragEnd: () => ipcRenderer.send('window:drag-end'),
  cancelDrag: () => ipcRenderer.send('window:drag-cancel'),
  listDates: invoke('notes:dates'),
  openNote: invoke('notes:open'),
  saveNote: invoke('notes:save'),
  saveSettings: invoke('settings:save'),
  chooseEdgeImage: invoke('settings:edge-image'),
  ask: invoke('ai:ask'),
})
