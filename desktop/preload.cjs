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
  onUpdate: listen('updates:changed'),
  checkUpdate: invoke('updates:check'),
  downloadUpdate: invoke('updates:download'),
  installUpdate: invoke('updates:install'),
  installerCatalog: invoke('installers:catalog'),
  downloadInstaller: invoke('installers:download'),
  openInstallerDirectory: invoke('installers:reveal'),
  onInstallerProgress: listen('installers:progress'),
  onBrowser: listen('browser:changed'),
  openBrowser: invoke('browser:open'),
  browserViewport: invoke('browser:viewport'),
  hideBrowser: invoke('browser:hide'),
  browserBack: invoke('browser:back'),
  toggle: invoke('window:toggle'),
  dragStart: () => ipcRenderer.send('window:drag-start'),
  dragMove: () => ipcRenderer.send('window:drag-move'),
  dragEnd: () => ipcRenderer.send('window:drag-end'),
  cancelDrag: () => ipcRenderer.send('window:drag-cancel'),
  listDates: invoke('notes:dates'),
  openNote: invoke('notes:open'),
  saveNote: invoke('notes:save'),
  addCategory: invoke('notes:category'),
  onNotes: listen('notes:changed'),
  syncState: invoke('sync:state'),
  enableSync: invoke('sync:enable'),
  syncCode: invoke('sync:code'),
  rotateSync: invoke('sync:rotate'),
  syncLink: invoke('sync:link'),
  syncLinkStatus: invoke('sync:status'),
  syncExchange: invoke('sync:exchange'),
  followerCode: invoke('follower:code'),
  setFollower: invoke('follower:set'),
  followerSnapshot: invoke('follower:snapshot'),
  followerCategories: invoke('follower:categories'),
  followerAccept: invoke('follower:accept'),
  followerReconcile: invoke('follower:reconcile'),
  openProject: invoke('project:open'),
  codex: invoke('codex:action'),
  codexSettings: invoke('codex:settings'),
  codexConfigure: invoke('codex:configure'),
  codexShare: invoke('codex:share'),
  codexFolder: invoke('codex:folder'),
  saveSettings: invoke('settings:save'),
  chooseEdgeImage: invoke('settings:edge-image'),
  ask: invoke('ai:ask'),
})
