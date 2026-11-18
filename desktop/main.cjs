const { app, BrowserWindow, Tray, Menu, ipcMain, screen, dialog, nativeImage, safeStorage, powerMonitor, shell } = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const { openStore } = require('./data.cjs')
const { fit, position, center, nearestEdge } = require('./window.cjs')
const { answer, endpoint } = require('./ai.cjs')

app.setName('Momo Notes')
app.setAppUserModelId('io.github.sdumliu.momo-notes')
if (process.env.MOMO_DATA_DIR && !app.isPackaged) app.setPath('userData', path.resolve(process.env.MOMO_DATA_DIR))

let win, tray, store, drag, anchor, edge, today, dayTimer
let mode = 'pet'
let quitting = false
let asking = false

const currentArea = point => screen.getDisplayNearestPoint(point).workArea
const loginOptions = () => app.isPackaged ? { path: process.execPath } : { path: process.execPath, args: [app.getAppPath()] }
const publicSettings = () => {
  const { key, ...settings } = store.data.settings
  return { ...settings, openAtLogin: app.getLoginItemSettings(loginOptions()).openAtLogin, hasKey: Boolean(key) }
}
const state = () => ({ mode, edge, today, settings: publicSettings() })

function syncState() {
  win.webContents.send('app:state-changed', state())
}

function setMode(next, activate = true) {
  mode = next
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
    const { alwaysOnTop, openAtLogin, snap, edgeImage, baseUrl, model, proxyPort, newKey } = values
    if (baseUrl) endpoint(baseUrl)
    if (proxyPort && (!/^\d{1,5}$/.test(proxyPort) || Number(proxyPort) < 1 || Number(proxyPort) > 65535)) {
      throw new Error('代理端口应为 1–65535 的整数')
    }
    if (edgeImage && !/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(edgeImage)) throw new Error('侧边栏图片格式有误')
    const oldSettings = store.data.settings
    let key = oldSettings.key
    if (newKey !== null) {
      if (newKey && !safeStorage.isEncryptionAvailable()) throw new Error('Windows 凭据加密暂不可用')
      key = newKey ? safeStorage.encryptString(newKey).toString('base64') : ''
    }
    const previousLogin = app.getLoginItemSettings(loginOptions()).openAtLogin
    const settings = { alwaysOnTop, openAtLogin, snap, edgeImage, baseUrl, model, proxyPort, key }
    try {
      if (openAtLogin !== previousLogin) app.setLoginItemSettings({ ...loginOptions(), openAtLogin })
      if (app.getLoginItemSettings(loginOptions()).openAtLogin !== openAtLogin) throw new Error('Windows 未接受开机启动设置')
      store.update({ settings })
    } catch (error) {
      if (openAtLogin !== previousLogin) app.setLoginItemSettings({ ...loginOptions(), openAtLogin: previousLogin })
      throw error
    }
    win.setAlwaysOnTop(alwaysOnTop)
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
  registerIPC()
  win.once('ready-to-show', () => win.showInactive())
  win.on('close', event => {
    if (quitting) return
    event.preventDefault()
    setMode('pet', false)
  })
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
  })
} else {
  app.quit()
}
