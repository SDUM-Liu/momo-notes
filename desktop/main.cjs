const { app, BrowserWindow, Tray, Menu, ipcMain, screen, session, dialog, nativeImage, safeStorage, powerMonitor, shell } = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const { openStore } = require('./data.cjs')
const { dock, face, fit, position, nearestEdge } = require('./window.cjs')
const { answer, endpoint } = require('./ai.cjs')
const { createUpdates } = require('./updates.cjs')
const { desktopUpdateSource } = require('./update-source.cjs')
const { createInstallerDownloads } = require('./installers.cjs')
const { createBrowser } = require('./browser.cjs')
const { opensAtLogin, setOpenAtLogin } = require('./login.cjs')
const { validateProxyPort } = require('../shared/ai.mjs')
const { codexSetupUrl } = require('../shared/links.mjs')
const { defaultCategory, noteKey, newCategory, datesFor, newDayNote, emptyNote, localDay } = require('../shared/notes.mjs')
const { parsePairing } = require('../shared/sync.mjs')
const { createSync } = require('./sync.cjs')
const { createFollower } = require('./follower.cjs')
const { createCodex } = require('./codex.cjs')
const { appServer } = require('./codex-rpc.cjs')

app.setName('Momo Notes')
if (process.platform === 'win32') app.setAppUserModelId('io.github.sdumliu.momo-notes')
if (process.platform === 'linux' && process.env.WAYLAND_DISPLAY) app.commandLine.appendSwitch('ozone-platform', 'x11')
if (process.env.MOMO_DATA_DIR && !app.isPackaged) app.setPath('userData', path.resolve(process.env.MOMO_DATA_DIR))

let win, tray, store, drag, anchor, edge, today, dayTimer, updates, installers, browser, sync, follower, codex
let mode = 'pet'
let hoverTimer
let quitting = false
let asking = false

const currentArea = point => screen.getDisplayNearestPoint(point).workArea
const notesStore = () => follower?.store || store
const notesLocked = () => Boolean(follower?.store || sync.state().locked)
const publicSettings = () => {
  const { key, ...settings } = store.data.settings
  return { ...settings, openAtLogin: opensAtLogin(), hasKey: Boolean(key) }
}
const state = () => ({ mode, edge, today, settings: publicSettings(), update: updates.state,
  browser: browser.state, categories: notesStore().data.categories, locked: notesLocked() })

function syncState() {
  win.webContents.send('app:state-changed', state())
}

function setMode(next, activate = true) {
  clearInterval(hoverTimer)
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
  setMode(mode === 'note' ? edge ? 'edge' : 'pet' : 'note')
}

function revealDockedPet() {
  if (mode !== 'edge' || !edge || drag) return
  setMode('pet', false)
  hoverTimer = setInterval(() => {
    if (drag) return
    const p = screen.getCursorScreenPoint()
    const b = win.getBounds()
    if (p.x < b.x || p.y < b.y || p.x >= b.x + b.width || p.y >= b.y + b.height) setMode('edge', false)
  }, 80)
}

function refreshDay() {
  if (sync?.state().locked) return
  const next = follower.store ? localDay() : store.today()
  if (next === today) return
  today = next
  win.webContents.send('notes:day-changed', next)
}

async function ask(request) {
  if (asking) throw new Error('上一条提问仍在处理')
  asking = true
  try {
    const visible = notesStore().data
    return await answer({ ...visible, settings: store.data.settings }, request)
  } finally {
    asking = false
  }
}

function codexAction(op, data, paired = false) {
  if (op === 'notes') return codex.ask(data, paired)
  if (op === 'job' || op === 'interrupt') {
    const job = codex.jobResult(data, paired)
    return op === 'job' ? job : codex.interrupt(data)
  }
  if (op === 'active') return codex.active(paired)
  if (op === 'models') return codex.models()
  if (op === 'display-check') return codex.displayCheck(paired)
  if (op === 'list') return codex.list(data, paired)
  if (op === 'read') return codex.read(data, paired)
  if (op === 'send') return codex.send(data, paired)
  throw new Error('未知的桃桃 AI 请求')
}

async function launchHostCodex(options) {
  const port = store.data.settings.proxyPort
  if (port) {
    validateProxyPort(port)
    return appServer({ ...options, proxy: 'http://127.0.0.1:' + port })
  }
  const rules = await session.defaultSession.resolveProxy('https://chatgpt.com/').catch(() => '')
  const systemProxy = /^(PROXY|HTTPS)\s+([a-z\d.-]+:\d{1,5}|\[[a-f\d:]+\]:\d{1,5})$/i.exec(rules.split(';')[0].trim())
  const proxy = systemProxy && (systemProxy[1].toUpperCase() === 'HTTPS' ? 'https://' : 'http://') + systemProxy[2]
  return appServer({ ...options, proxy })
}

async function approveCodex(method, request) {
  const detail = request.networkApprovalContext?.host
    ? '网络目的地：' + String(request.networkApprovalContext.host)
    : method === 'item/fileChange/requestApproval'
      ? '文件授权范围：' + (request.grantRoot || codex.settings().folder)
      : '工作目录：' + (request.cwd || codex.settings().folder) + '\n' + (request.command || '未提供命令预览')
  if (win.isDestroyed()) return 'decline'
  win.show()
  const result = await dialog.showMessageBox(win, {
    type: 'question', title: '桃桃 AI · 权限申请', buttons: ['拒绝', '仅允许这一次'],
    defaultId: 0, cancelId: 0, message: '桃桃 AI 正在请求额外权限', detail: detail.slice(0, 6000),
  })
  return result.response === 1 ? 'accept' : 'decline'
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
  handle('updates:transfer-reply', updates.reply)
  handle('installers:catalog', installers.catalog)
  handle('installers:download', installers.download)
  handle('installers:reveal', installers.reveal)
  handle('browser:open', browser.open)
  handle('browser:viewport', bounds => {
    if (mode === 'note' && Object.values(bounds).every(Number.isFinite)) browser.setViewport(bounds)
  })
  handle('browser:hide', browser.hide)
  handle('browser:back', browser.back)
  handle('sync:state', sync.state)
  handle('sync:enable', (enabled, ...args) => {
    if (enabled && follower.store) throw new Error('请先取消从设备配对，再开启主设备同步')
    return sync.setEnabled(enabled, ...args)
  })
  handle('sync:code', sync.code)
  handle('sync:rotate', sync.rotate)
  handle('sync:link', sync.link)
  handle('sync:status', sync.status)
  handle('sync:exchange', sync.exchange)
  handle('follower:code', () => follower.code)
  handle('follower:set', value => {
    if (value) {
      if (sync.state().enabled) throw new Error('请先停止本机的主设备同步')
      if (sync.owns(parsePairing(value).key)) throw new Error('不能配对本机的主设备配对码')
    }
    follower.setPair(value)
  })
  handle('follower:snapshot', follower.snapshot)
  handle('follower:categories', follower.categories)
  handle('follower:accept', follower.accept)
  handle('follower:reconcile', follower.reconcile)
  handle('codex:action', (op, data) => codexAction(op, data))
  handle('codex:settings', codex.settings)
  handle('codex:configure', values => codex.configure(Object.fromEntries(
    ['enabled', 'fullAccess', 'write', 'shareAll'].filter(key => typeof values?.[key] === 'boolean').map(key => [key, values[key]]),
  )))
  handle('codex:share', codex.share)
  handle('codex:folder', async action => {
    if (action === 'reset') return codex.configure({ folder: null })
    if (action === 'open') {
      const error = await shell.openPath(codex.folder())
      if (error) throw new Error(error)
      return codex.settings()
    }
    const result = await dialog.showOpenDialog(win, {
      title: '选择桃桃 AI 的工作目录', properties: ['openDirectory'], defaultPath: codex.settings().folder,
    })
    return result.canceled ? codex.settings() : codex.configure({ folder: result.filePaths[0] })
  })
  handle('project:open', target => {
    const url = {
      repo: 'https://github.com/SDUM-Liu/momo-notes',
      issues: 'https://github.com/SDUM-Liu/momo-notes/issues',
      codexSetup: codexSetupUrl,
    }[target]
    if (typeof url === 'string') return shell.openExternal(url)
  })
  on('window:edge-hover', revealDockedPet)
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
    const area = currentArea(point)
    const bounds = fit({ ...drag.bounds, x: drag.bounds.x + dx, y: drag.bounds.y + dy }, area)
    win.setBounds(store.data.settings.snap ? dock(bounds, area, nearestEdge(bounds, area)) : bounds)
  })
  on('window:drag-cancel', () => {
    if (drag) win.setBounds(drag.bounds)
    drag = null
  })
  on('window:drag-end', () => {
    if (!drag) return
    const moved = drag?.moved
    drag = null
    if (!moved) {
      if (mode !== 'note') toggle()
      return
    }
    const bounds = win.getBounds()
    const area = currentArea(screen.getCursorScreenPoint())
    edge = store.data.settings.snap ? nearestEdge(bounds, area) : null
    anchor = face(mode, bounds)
    if (edge) {
      setMode('edge', false)
    } else {
      setMode(mode === 'edge' ? 'pet' : mode, false)
    }
    try {
      store.update({ position: { anchor, edge, faceAnchor: true } })
    } catch {
      dialog.showErrorBox('桃桃便签', '窗口位置无法保存，请检查本地存储。')
    }
  })
  handle('notes:dates', (category = defaultCategory) => {
    refreshDay()
    if (notesLocked()) return datesFor(notesStore().data.notes, category, today)
    return store.dates(category)
  })
  handle('notes:category', name => {
    if (follower.store) throw new Error('从设备只读，请在主设备新建分类')
    sync.requireWritable()
    return store.addCategory(newCategory(name))
  })
  handle('notes:open', (date, category = defaultCategory) => {
    refreshDay()
    const day = date || (notesLocked() ? today : store.today(category))
    const key = noteKey(category, day)
    const data = notesStore().data
    const doc = data.notes[key] || (!date && notesLocked() ? (follower.store ? emptyNote() : newDayNote(data.notes, category, day)) : null)
    if (!doc) throw new Error('日期页不存在')
    return { date: day, category, doc, today, rev: data.revisions[key] }
  })
  handle('notes:save', (date, doc, category = defaultCategory, base) => {
    if (follower.store) throw new Error('从设备只读，请在主设备编辑便签')
    sync.requireWritable()
    const key = noteKey(category, date)
    return base === undefined
      ? { rev: store.saveNote(date, doc, category), doc, key }
      : sync.write({ key, doc, base })
  })
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
      store.update({ settings, ...(!snap && edge ? { position: { anchor, edge: null, faceAnchor: true } } : {}) })
    } catch (error) {
      if (openAtLogin !== previousLogin) setOpenAtLogin(previousLogin)
      throw error
    }
    win.setAlwaysOnTop(alwaysOnTop)
    if (!snap && edge) {
      edge = null
      setMode(mode === 'edge' ? 'pet' : mode, false)
    }
    updates.setAutomatic(settings.autoInstallUpdates)
    syncState()
    return publicSettings()
  })
  handle('ai:ask', ask)
}

function start() {
  store = openStore(app.getPath('userData'))
  app.dock?.hide()
  today = localDay()
  const area = screen.getPrimaryDisplay().workArea
  const previous = store.data.position
  anchor = previous?.anchor ?? { x: area.x + area.width - 88, y: area.y + Math.round(area.height * 0.66) }
  const usableArea = currentArea(anchor)
  if (previous?.anchor && !previous.faceAnchor && !previous.edge) anchor = { ...anchor, y: anchor.y - 37 }
  edge = store.data.settings.snap && ['left','right','top','bottom'].includes(previous?.edge) ? previous.edge : null
  mode = edge ? 'edge' : 'pet'
  anchor = face(mode, position(mode, usableArea, anchor, edge))

  const icon = path.join(__dirname, '../build/icon.png')
  win = new BrowserWindow({
    ...position(mode, usableArea, anchor, edge),
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
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), sandbox: true, contextIsolation: true,
      nodeIntegration: false, backgroundThrottling: false },
  })
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-navigate', event => event.preventDefault())
  win.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  updates = createUpdates(value => {
    if (!quitting && !win.isDestroyed()) win.webContents.send('updates:changed', value)
  }, request => {
    if (quitting || win.isDestroyed()) throw new Error('更新已取消')
    win.webContents.send('updates:transfer', request)
  })
  updates.setAutomatic(store.data.settings.autoInstallUpdates)
  installers = createInstallerDownloads(progress => {
    if (!quitting && !win.isDestroyed()) win.webContents.send('installers:progress', progress)
  })
  browser = createBrowser(win, value => {
    if (!quitting && !win.isDestroyed()) win.webContents.send('browser:changed', value)
  })
  follower = createFollower(app.getPath('userData'), {
    seal(code) {
      const basic = process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text'
      return safeStorage.isEncryptionAvailable() && !basic ? safeStorage.encryptString(code).toString('base64') : ''
    },
    open: sealed => safeStorage.decryptString(Buffer.from(sealed, 'base64')),
  }, change => {
    if (quitting || win.isDestroyed()) return
    if (change.profileChanged) {
      today = follower.store ? localDay() : store.today()
      updates.source(follower.snapshot()?.id)
    }
    win.webContents.send('notes:changed', { ...change,
      ...(change.profileChanged && { categories: notesStore().data.categories, locked: notesLocked() }) })
  })
  if (!follower.store) today = store.today()
  updates.source(follower.snapshot()?.id)
  codex = createCodex(app.getPath('userData'), { get data() { return notesStore().data } }, approveCodex, launchHostCodex)
  sync = createSync(app.getPath('userData'), store, ask, change => {
    if (!quitting && !win.isDestroyed()) win.webContents.send('notes:changed', change)
  }, (op, payload) => codexAction(op, payload, true), desktopUpdateSource(() => store.data.settings.proxyPort))
  registerIPC()
  win.once('ready-to-show', () => win.showInactive())
  win.on('close', event => {
    if (quitting) return
    event.preventDefault()
    setMode(edge ? 'edge' : 'pet', false)
  })
  win.on('closed', () => { clearInterval(hoverTimer); browser.dispose() })
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
    screen.on(event, () => setMode(edge && mode === 'pet' ? 'edge' : mode, false))
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
    installers?.stop()
    sync?.stop()
    codex?.close()
  })
} else {
  app.quit()
}
