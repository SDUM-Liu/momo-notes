const { app, BrowserWindow, Tray, Menu, ipcMain, screen, dialog, nativeImage, safeStorage, powerMonitor, shell } = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const { openStore } = require('./data.cjs')
const { fit, position, center, nearestEdge } = require('./window.cjs')
const { answer, endpoint } = require('./ai.cjs')
const { createUpdates } = require('./updates.cjs')
const { createBrowser } = require('./browser.cjs')
const { opensAtLogin, setOpenAtLogin } = require('./login.cjs')
const { validateProxyPort } = require('../shared/ai.mjs')

app.setName('Momo Notes')
if (process.platform === 'win32') app.setAppUserModelId('io.github.sdumliu.momo-notes')
if (process.platform === 'linux' && process.env.WAYLAND_DISPLAY) app.commandLine.appendSwitch('ozone-platform', 'x11')
if (process.env.MOMO_DATA_DIR && !app.isPackaged) app.setPath('userData', path.resolve(process.env.MOMO_DATA_DIR))

let win, tray, store, drag, anchor, edge, today, dayTimer, updates, browser
let mode = 'pet'
let quitting = false
let asking = false

const currentArea = point => screen.getDisplayNearestPoint(point).workArea
const publicSettings = () => {
  const { key, ...settings } = store.data.settings
  return { ...settings, openAtLogin: opensAtLogin(), hasKey: Boolean(key) }
}
const state = () => ({ mode, edge, today, settings: publicSettings(), update: updates.state, browser: browser.state })

function syncState() {
  win.webContents.send('app:state-changed', state())
}

function setMode(next, activate = true) {
  mode = next
  if (mode !== 'note') browser?.hide()
  win.setBounds(position(mode, currentArea(anchor), anchor, edge))
  syncState()
  if (activate && mode === 'note') {
    win.show()
    win.focus()
  }
}

function toggle() {
  setMode(mode === 'note' ? 'pet' : 'note')
}

function refreshDay() {
  const next = store.today()
  if (next === today) return
  today = next
  win.webContents.send('notes:day-changed', next)
}

function registerIPC() {
  const fromApp = event => event.sender === win.webContents && event.senderFrame === win.webContents.mainFrame
  const handle = (channel, callback) => ipcMain.handle(channel, (event, ...args) => {
    if (!fromApp(event)) throw new Error('请求来源无效')
    return callback(...args)
  })
  const on = (channel, callback) => ipcMain.on(channel, event => {
    if (fromApp(event)) callback()
  })

  handle('app:state', state)
  handle('window:toggle', toggle)
  handle('updates:check', updates.check)
  handle('updates:download', updates.download)
  handle('updates:install', updates.install)
  handle('browser:open', browser.open)
  handle('browser:viewport', bounds => {
    if (mode === 'note' && Object.values(bounds).every(Number.isFinite)) browser.setViewport(bounds)
  })
  handle('browser:hide', browser.hide)
  handle('browser:back', browser.back)
  on('window:drag-start', () => {
    drag = { start: screen.getCursorScreenPoint(), bounds: win.getBounds(), moved: false }
  })
  on('window:drag-move', () => {
    if (!drag) return
    const point = screen.getCursorScreenPoint()
    const dx = point.x - drag.start.x
    const dy = point.y - drag.start.y
    if (Math.hypot(dx, dy) < 5 && !drag.moved) return
    drag.moved = true
    win.setBounds(fit({ ...drag.bounds, x: drag.bounds.x + dx, y: drag.bounds.y + dy }, currentArea(point)))
  })
  on('window:drag-cancel', () => {
    if (drag) win.setBounds(drag.bounds)
    drag = null
  })
  on('window:drag-end', () => {
    const moved = drag?.moved
    drag = null
    if (!moved) {
      if (mode !== 'note') toggle()
      return
    }
    const bounds = win.getBounds()
    const area = currentArea(screen.getCursorScreenPoint())
    edge = store.data.settings.snap ? nearestEdge(bounds, area) : null
    anchor = mode === 'note' && !edge ? { x: bounds.x + bounds.width - 57, y: bounds.y + 68 } : center(bounds)
    if (edge) {
      // Keep the handle next to the pointer when a larger note is docked.
      anchor = screen.getCursorScreenPoint()
      setMode('edge', false)
    } else {
      setMode(mode === 'edge' ? 'pet' : mode, false)
    }
    try {
      store.update({ position: { anchor, edge } })
    } catch {
      dialog.showErrorBox('桃桃便签', '窗口位置无法保存，请检查本地存储。')
    }
  })
  handle('notes:dates', () => {
    refreshDay()
    return store.dates()
  })
  handle('notes:open', date => {
    refreshDay()
    const day = date || today
    const doc = store.data.notes[day]
    if (!doc) throw new Error('日期页不存在')
    return { date: day, doc, today }
  })
  handle('notes:save', (date, doc) => store.saveNote(date, doc))
  handle('settings:edge-image', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
      title: '选择侧边栏形象', properties: ['openFile'],
      filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg'] }],
    })
    if (canceled) return null
    if (fs.statSync(filePaths[0]).size > 15 * 1024 * 1024) throw new Error('请选择 15 MB 以内的图片')
    const image = nativeImage.createFromPath(filePaths[0])
    if (image.isEmpty()) throw new Error('无法打开这张图片')
    const { width, height } = image.getSize()
    const small = width > height ? image.resize({ width: Math.min(width, 256) }) : image.resize({ height: Math.min(height, 256) })
    return small.toDataURL()
  })
  handle('settings:save', values => {
    const { alwaysOnTop, openAtLogin, snap, edgeImage, baseUrl, model, proxyPort, newKey, autoInstallUpdates } = values
    if (baseUrl) endpoint(baseUrl)
    validateProxyPort(proxyPort)
    if (edgeImage && !/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(edgeImage)) throw new Error('侧边栏图片格式有误')
    const oldSettings = store.data.settings
    let key = oldSettings.key
    if (newKey !== null) {
      const insecureLinuxStorage = process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text'
      if (newKey && (!safeStorage.isEncryptionAvailable() || insecureLinuxStorage)) throw new Error('系统凭据加密暂不可用')
      key = newKey ? safeStorage.encryptString(newKey).toString('base64') : ''
    }
    const previousLogin = opensAtLogin()
    const settings = { alwaysOnTop, openAtLogin, snap, edgeImage, baseUrl, model, proxyPort, key, autoInstallUpdates: Boolean(autoInstallUpdates) }
    try {
      if (openAtLogin !== previousLogin) setOpenAtLogin(openAtLogin)
      if (opensAtLogin() !== openAtLogin) throw new Error('系统未接受开机启动设置')
      store.update({ settings })
    } catch (error) {
      if (openAtLogin !== previousLogin) setOpenAtLogin(previousLogin)
      throw error
    }
    win.setAlwaysOnTop(alwaysOnTop)
    updates.setAutomatic(settings.autoInstallUpdates)
    syncState()
    return publicSettings()
  })
  handle('ai:ask', async request => {
    if (asking) throw new Error('上一条提问仍在处理')
    asking = true
    try {
      return await answer(store.data, request)
    } finally {
      asking = false
    }
  })
}

function start() {
  store = openStore(app.getPath('userData'))
  app.dock?.hide()
  today = store.today()
  const area = screen.getPrimaryDisplay().workArea
  const previous = store.data.position
  anchor = previous?.anchor ?? { x: area.x + area.width - 88, y: area.y + Math.round(area.height * 0.66) }
  const usableArea = currentArea(anchor)
  anchor = center(position('pet', usableArea, anchor))

  const icon = path.join(__dirname, '../build/icon.png')
  win = new BrowserWindow({
    ...position('pet', usableArea, anchor),
    title: '桃桃便签',
    icon,
    transparent: true,
    frame: false,
    resizable: false,
    hasShadow: false,
    show: false,
    skipTaskbar: true,
    fullscreenable: false,
    alwaysOnTop: store.data.settings.alwaysOnTop,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false },
  })
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-navigate', event => event.preventDefault())
  win.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  updates = createUpdates(value => {
    if (!quitting && !win.isDestroyed()) win.webContents.send('updates:changed', value)
  })
  updates.setAutomatic(store.data.settings.autoInstallUpdates)
  browser = createBrowser(win, value => {
    if (!quitting && !win.isDestroyed()) win.webContents.send('browser:changed', value)
  })
  registerIPC()
  win.once('ready-to-show', () => win.showInactive())
  win.on('close', event => {
    if (quitting) return
    event.preventDefault()
    setMode('pet', false)
  })
  win.on('closed', browser.dispose)
  win.loadFile(path.join(__dirname, '../dist/index.html'))

  tray = new Tray(nativeImage.createFromPath(icon).resize({ width: 32, height: 32 }))
  tray.setToolTip('桃桃便签')
  tray.on('click', toggle)
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '打开便签', click: () => setMode('note') },
    { label: '显示桌宠', click: () => setMode('pet') },
    { label: '打开数据目录', click: () => shell.openPath(app.getPath('userData')) },
    { type: 'separator' },
    { label: '退出桃桃便签', click: () => app.quit() },
  ]))
  for (const event of ['display-removed', 'display-metrics-changed']) {
    screen.on(event, () => setMode(mode, false))
  }
  dayTimer = setInterval(refreshDay, 5000)
  powerMonitor.on('resume', refreshDay)
  updates.schedule()
}

if (app.requestSingleInstanceLock()) {
  app.on('second-instance', () => { if (win) setMode('note') })
  app.whenReady().then(start).catch(error => {
    dialog.showErrorBox('桃桃便签启动失败', error.message)
    app.quit()
  })
  app.on('before-quit', () => {
    quitting = true
    clearInterval(dayTimer)
    updates?.stop()
  })
} else {
  app.quit()
}
