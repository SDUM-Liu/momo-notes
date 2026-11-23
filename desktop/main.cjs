const { app, BrowserWindow, Tray, Menu, ipcMain, screen, session, protocol, dialog, nativeImage, safeStorage, powerMonitor, shell } = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const { openStore } = require('./data.cjs')
const { dock, face, fit, position, nearestEdge, resizeNote } = require('./window.cjs')
const { answer, endpoint } = require('./ai.cjs')
const { createUpdates } = require('./updates.cjs')
const { desktopUpdateSource } = require('./update-source.cjs')
const { createInstallerDownloads } = require('./installers.cjs')
const { createBrowser } = require('./browser.cjs')
const { normalizeProfile, sameTarget, deviceProfiles, openTerminal, openRemoteTerminal, hostName } = require('./ssh.cjs')
const { createLocalSSHPipes, createRemoteSSHHost } = require('./ssh-remote.cjs')
const { joinSSHRelay } = require('../shared/ssh-session.mjs')
const { opensAtLogin, setOpenAtLogin } = require('./login.cjs')
const { validateProxyPort } = require('../shared/ai.mjs')
const { codexSetupUrl } = require('../shared/links.mjs')
const { defaultCategory, noteKey, newCategory, datesFor, newDayNote, localDay } = require('../shared/notes.mjs')
const { parsePairing } = require('../shared/sync.mjs')
const { createSync } = require('./sync.cjs')
const { createTcpProbe } = require('./tcp-probe.cjs')
const { createFollower } = require('./follower.cjs')
const { createCodex } = require('./codex.cjs')
const { appServer } = require('./codex-rpc.cjs')

protocol.registerSchemesAsPrivileged([{ scheme: 'momo-media', privileges: { standard: true, secure: true, stream: true } }])
app.setName('Momo Notes')
if (process.platform === 'win32') app.setAppUserModelId('io.github.sdumliu.momo-notes')
if (process.platform === 'linux' && process.env.WAYLAND_DISPLAY) app.commandLine.appendSwitch('ozone-platform', 'x11')
if (process.env.MOMO_DATA_DIR && !app.isPackaged) app.setPath('userData', path.resolve(process.env.MOMO_DATA_DIR))

let win, tray, store, drag, anchor, edge, today, dayTimer, updates, installers, browser, sync, follower, codex
const migration = require('./migration.cjs')
let transfer
let sshDevices
let remoteSSH, localSSH
let profileDirectory
let book, remoteBook
let mode = 'pet'
let hoverTimer
let quitting = false
const tcpProbe = createTcpProbe()
const udpProbe = createTcpProbe("udp")
const closeProbes = () => { tcpProbe.close(); udpProbe.close() }
let asking = false

const currentArea = point => screen.getDisplayNearestPoint(point).workArea
const notesStore = () => follower?.store || store
const notesLocked = () => Boolean(follower?.store || sync.state().locked)
const publicSettings = () => {
  const { key, ...settings } = store.data.settings
  return { ...settings, openAtLogin: opensAtLogin(), hasKey: Boolean(key) }
}
let paintVersion = 0, awaitingPaint, paintTimer
let noteSize
const state = () => ({ mode, edge, today, awaitingPaint, settings: publicSettings(), update: updates.state,
  browser: browser.state, categories: notesStore().data.categories, locked: notesLocked() })

function syncState() {
  win.webContents.send('app:state-changed', state())
}

let ordinaryBrowser
function makeBrowser(partition) {
  const instance = createBrowser(win, value => {
    if (browser === instance && !quitting && !win.isDestroyed()) win.webContents.send('browser:changed', value)
  }, partition)
  return instance
}
function restoreBrowser() {
  if (!ordinaryBrowser) return
  const closed = browser
  browser = ordinaryBrowser
  ordinaryBrowser = undefined
  closed.dispose()
  win.webContents.send('browser:changed', browser.state)
}
function finishResize(version) {
  if (version !== awaitingPaint || version === undefined) return
  awaitingPaint = undefined
  clearTimeout(paintTimer)
  if (!win.isDestroyed()) win.setOpacity(1)
}

function setMode(next, activate = true) {
  clearInterval(hoverTimer)
  if (process.platform !== 'linux' && next !== mode && (next === 'note' || mode === 'note')) {
    clearTimeout(paintTimer)
    const version = ++paintVersion
    awaitingPaint = version
    win.setOpacity(0)
    paintTimer = setTimeout(() => finishResize(version), 230)
  }
  mode = next
  if (mode !== 'note') { remoteBook?.localLock(); restoreBrowser(); browser?.hide() }
  win.setBounds(position(mode, currentArea(anchor), anchor, edge, noteSize))
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
  if (book?.unlocked) throw new Error('请先锁定私密便签')
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
  if (book?.unlocked) throw new Error('请先锁定私密便签')
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
  if (op === 'steer') return codex.steer(data, paired)
  if (op === 'send') {
    const diagnostic = /^检查设备\s+([a-f0-9]{8})$/.exec(String(data?.prompt).trim())
    if (diagnostic) return reportDevice(diagnostic[1], data, paired)
    return codex.send(data, paired)
  }
  throw new Error('未知的桃桃 AI 请求')
}

function requireSSHDevice(id) {
  if (follower.store || !sync.state().devices.some(device => device.id === id))
    throw new Error('请在主设备选择已登记的设备')
}
function stopSSH() {
  remoteSSH?.stop()
  localSSH?.stop()
}
async function reportDevice(prefix, data, paired) {
  if (paired && !codex.settings().enabled) throw new Error('请先开启桃桃 AI 共享')
  const devices = sync.state().devices.filter(d => d.id.startsWith(prefix))
  const id = devices.length === 1 && devices[0].id
  const target = id && sshDevices.get(id)
  if (follower.store || !target?.permitted) throw new Error('请先在主设备上为该设备授权 SSH 主机名检查')
  const name = await hostName(target.profile)
  requireSSHDevice(id)
  const current = sshDevices.get(id)
  if (!current.permitted || !sameTarget(target.profile, current.profile)) throw new Error('该设备的 SSH 授权已变化')
  if (book.unlocked) throw new Error('请先锁定私密便签')
  return codex.send({ ...data, taskMode: false, prompt: '用户要求检查设备 ' + prefix + '。主机已通过 SSH 执行 hostname。请仅汇报本次检查结果。主机名数据为 ' + JSON.stringify(name) }, paired)
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
  const on = (channel, callback) => ipcMain.on(channel, (event, ...args) => {
    if (fromApp(event)) callback(...args)
  })

  handle('private:book', (op, data) => {
    if (op !== 'lock' && (mode !== 'note' || follower.store)) throw new Error('请在主设备上打开')
    if (op === 'unlock' && (asking || codex.busy())) throw new Error('请先结束当前 AI 任务')
    const canRemember = safeStorage.isEncryptionAvailable() &&
      (process.platform !== 'linux' || safeStorage.getSelectedStorageBackend() !== 'basic_text')
    const credential = path.join(profileDirectory, 'private-book-password.os')
    function rememberedPassword() {
      if (!canRemember) return
      try { return safeStorage.decryptString(fs.readFileSync(credential)) }
      catch {}
    }
    const entered = typeof data?.password === 'string'
    const password = op === 'unlock' && !entered ? rememberedPassword() : data?.password
    if (op === 'unlock' && typeof password !== 'string') throw new Error('请重新输入独立口令和六位验证码')
    let result
    try { result = remoteBook.local(op, op === 'unlock' ? { password, code: data.code } : data) }
    catch (error) {
      if (op === 'unlock' && !entered && /口令错误或文件/.test(error.message)) {
        try { fs.unlinkSync(credential) } catch {}
        throw new Error('请重新输入独立口令和六位验证码')
      }
      throw error
    }
    if (op === 'unlock') {
      if (canRemember && entered) {
        try {
          fs.writeFileSync(credential + '.tmp', safeStorage.encryptString(password), { mode: 0o600 })
          fs.renameSync(credential + '.tmp', credential)
        } catch {}
      }
      restoreBrowser()
      ordinaryBrowser = browser
      ordinaryBrowser.hide()
      browser = makeBrowser('momo-private-' + require('node:crypto').randomUUID())
      win.webContents.send('browser:changed', browser.state)
    } else if (op === 'lock' || op === 'begin') restoreBrowser()
    return op === 'begin' && !result?.uri ? { ...result, remembered: Boolean(rememberedPassword()) } : result
  })
  for (const op of ['target', 'ready', 'prepare', 'receive', 'chunk', 'mediaChunk', 'cutover', 'pending', 'finish'])
    handle('handoff:' + op, (...args) => transfer[op](...args))
  handle('migration:file', async (direction, password) => {
    if (book.unlocked || codex.busy() || asking) throw new Error('请先锁定私密便签并结束 AI 任务')
    sync.requireWritable()
    if (direction === 'export') {
      if (follower.store) throw new Error('请在主设备导出')
      const result = await dialog.showSaveDialog(win, { defaultPath: '桃桃便签.momobackup', filters: [{ name: '桃桃迁移包', extensions: ['momobackup'] }] })
      if (result.canceled) return false
      const tmp = result.filePath + '.' + require('node:crypto').randomUUID() + '.tmp'
      const { backupBytes } = require('../shared/media-transfer.mjs')
      const source = require('./disk-media.cjs').diskMedia(profileDirectory)
      const bytes = backupBytes(migration.snapshot(profileDirectory, store, safeStorage), source, data => migration.pack(data, password))
      try {
        await require('node:stream/promises').pipeline(bytes, fs.createWriteStream(tmp, { mode: 0o600, flags: 'wx' }))
        fs.renameSync(tmp, result.filePath)
      } finally { fs.rmSync(tmp, { force: true }) }
      return true
    }
    if (direction !== 'import') throw new Error('未知迁移操作')
    if (sync.state().enabled) throw new Error('请先停止本机的主设备同步')
    const result = await dialog.showOpenDialog(win, { properties: ['openFile'], filters: [{ name: '桃桃迁移包', extensions: ['momobackup'] }] })
    if (result.canceled) return false
    const source = result.filePaths[0]
    const root = app.getPath('userData')
    const { restoreBackup } = require('../shared/media-transfer.mjs')
    const file = await fs.promises.open(source, 'r')
    try {
      const read = async (offset, count) => {
        const buffer = Buffer.allocUnsafe(count)
        let total = 0
        while (total < count) {
          const { bytesRead } = await file.read(buffer, total, count - total, offset + total)
          if (!bytesRead) break
          total += bytesRead
        }
        return buffer.subarray(0, total)
      }
      const id = await restoreBackup((await file.stat()).size, read, box => migration.unpack(box, password),
        data => migration.stage(root, data, safeStorage), id => require('./disk-media.cjs').diskMedia(path.join(root, id)),
        id => migration.discard(root, id))
      migration.activate(root, id)
    } finally { await file.close() }
    app.relaunch(); app.quit()
    return true
  })
  handle('device:ssh-profile', (id, profile) => {
    requireSSHDevice(id)
    return profile === undefined ? sshDevices.get(id).profile : sshDevices.save(id, profile)
  })
  handle('device:ssh-permission', (id, enabled) => {
    requireSSHDevice(id)
    return enabled === undefined ? sshDevices.get(id).permitted : sshDevices.permit(id, enabled)
  })
  handle('device:ssh-connect', async (id, input) => {
    requireSSHDevice(id)
    const target = normalizeProfile(input)
    const before = sshDevices.get(id).profile
    await openTerminal(target)
    requireSSHDevice(id)
    const current = sshDevices.get(id).profile
    if (!sameTarget(before, current) && !sameTarget(target, current)) throw new Error('终端已打开。连接信息在启动期间已更改，请重新选择设备')
    return sshDevices.save(id, target)
  })
  handle('device:ssh-config', (id, alias) => {
    requireSSHDevice(id)
    if (alias === undefined) {
      const entry = sshDevices.get(id)
      return entry.permitted ? entry.profile?.alias || '' : ''
    }
    if (alias !== '') sshDevices.save(id, { alias })
    sshDevices.permit(id, alias !== '')
    return alias
  })
  handle('device:ssh-remote', id => {
    requireSSHDevice(id)
    if (!sync.state().enabled) throw new Error('请先开启主设备同步')
    return remoteSSH.open(id)
  })
  for (const method of ['open', 'read', 'write', 'close']) handle('ssh-local:' + method, localSSH[method])
  handle('device:ssh', (id, alias) => {
    requireSSHDevice(id)
    return openTerminal({ alias }, 'known-terminal')
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
  handle('browser:open', url => browser.open(url))
  handle('browser:viewport', bounds => {
    if (mode === 'note' && Object.values(bounds).every(Number.isFinite)) browser.setViewport(bounds)
  })
  handle('browser:hide', () => browser.hide())
  handle('browser:back', () => browser.back())
  handle('sync:state', sync.state)
  handle('sync:enable', (enabled, ...args) => {
    if (enabled && follower.store) throw new Error('请先取消从设备配对，再开启主设备同步')
    const result = sync.setEnabled(enabled, ...args)
    stopSSH()
    return result
  })
  handle('sync:code', sync.code)
  handle('sync:rotate', () => {
    const result = sync.rotate()
    stopSSH()
    return result
  })
  handle('sync:link', sync.link)
  handle('sync:status', sync.status)
  handle('sync:exchange', sync.exchange)
  for (const [transport, probe] of [['tcp', tcpProbe], ['udp', udpProbe]]) for (const op of ['prepare', 'run', 'cancel']) {
    handle(transport + '-probe:' + op, async (...args) => {
      if (!follower.store || quitting || sync.state().enabled) return { ok: false, reason: 'unpaired' }
      try { return await probe[op](...args) }
      catch (error) { return { ok: false, reason: error.code || 'unavailable' } }
    })
  }
  handle('follower:code', () => follower.code)
  handle('follower:set', value => {
    if (value) {
      if (sync.state().enabled) throw new Error('请先停止本机的主设备同步')
      if (!follower.store && require('./disk-media.cjs').diskMedia(profileDirectory).list().length) {
        throw new Error('本机有多媒体附件，请先迁移至新主设备，或在多媒体中删除后再配对')
      }
      if (sync.owns(parsePairing(value).key)) throw new Error('不能配对本机的主设备配对码')
    }
    follower.setPair(value)
  })
  handle('follower:snapshot', follower.snapshot)
  handle('follower:categories', follower.categories)
  handle('follower:accept', follower.accept)
  handle('follower:reconcile', follower.reconcile)
  handle('follower:draft', follower.draft)
  handle('follower:drafts', follower.drafts)
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
  handle('window:painted', finishResize)
  const dragPoint = value => Number.isFinite(value?.x) && Number.isFinite(value?.y)
    ? { x: Math.round(value.x), y: Math.round(value.y) } : null
  on('window:drag-start', (value, direction) => {
    const start = dragPoint(value)
    if (!start || (direction && (mode !== 'note' || !/^(n|s|e|w|ne|nw|se|sw)$/.test(direction)))) return
    const bounds = win.getBounds()
    drag = { start, bounds, direction, area: screen.getDisplayMatching(bounds).workArea, moved: false }
  })
  on('window:drag-move', value => {
    const point = dragPoint(value)
    if (!drag || !point) return
    const dx = point.x - drag.start.x
    const dy = point.y - drag.start.y
    if (Math.hypot(dx, dy) < 5 && !drag.moved) return
    drag.moved = true
    if (drag.direction) {
      win.setBounds(resizeNote(drag.bounds, drag.area, drag.direction, dx, dy))
      return
    }
    const area = currentArea(point)
    const bounds = fit({ ...drag.bounds, x: drag.bounds.x + dx, y: drag.bounds.y + dy }, area)
    win.setBounds(mode !== 'note' && store.data.settings.snap ? dock(bounds, area, nearestEdge(bounds, area)) : bounds)
  })
  on('window:drag-cancel', () => {
    if (drag) win.setBounds(drag.bounds)
    drag = null
  })
  handle('window:drag-end', () => {
    if (!drag) return true
    const { moved, direction } = drag
    drag = null
    if (!moved) return false
    const bounds = win.getBounds()
    const area = screen.getDisplayMatching(bounds).workArea
    edge = mode !== 'note' && store.data.settings.snap ? nearestEdge(bounds, area) : null
    anchor = face(mode, bounds)
    if (direction) noteSize = { width: bounds.width, height: bounds.height }
    if (edge) {
      setMode('edge', false)
    } else if (mode !== 'note') {
      setMode(mode === 'edge' ? 'pet' : mode, false)
    }
    try {
      store.update({ position: { anchor, edge, faceAnchor: true, noteSize } })
    } catch {
      dialog.showErrorBox('桃桃便签', '窗口位置无法保存，请检查本地存储。')
    }
    return true
  })
  handle('notes:dates', (category = defaultCategory) => {
    refreshDay()
    if (notesLocked()) return datesFor(notesStore().data.notes, category, today)
    return store.dates(category)
  })
  handle('notes:category', name => {
    if (follower.store) throw new Error('请通过同步连接主设备后新建分类')
    sync.requireWritable()
    return store.addCategory(newCategory(name))
  })
  handle('notes:open', (date, category = defaultCategory) => {
    refreshDay()
    const day = date || (notesLocked() ? today : store.today(category))
    const key = noteKey(category, day)
    const data = notesStore().data
    const doc = data.notes[key] || (notesLocked() && (!date || (follower.store && day === today))
      ? newDayNote(data.notes, category, day) : null)
    if (!doc) throw new Error('日期页不存在')
    return { date: day, category, doc, today, rev: data.revisions[key] }
  })
  handle('notes:save', (date, doc, category = defaultCategory, base) => {
    if (follower.store) throw new Error('请通过同步连接主设备后编辑便签')
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
  profileDirectory = migration.activePath(app.getPath('userData'))
  store = openStore(profileDirectory)
  sshDevices = deviceProfiles(profileDirectory)
  book = require('./private-book.cjs').privateBook(profileDirectory)
  remoteBook = require('./remote-book.cjs').remoteBook(book, { isBusy: () => quitting || Boolean(follower?.store) || asking || Boolean(codex?.busy()) })
  session.defaultSession.protocol.handle('momo-media', request => mode === 'note' && !follower?.store && !remoteBook.active
    ? book.mediaResponse(request) : new Response(null, { status: 404 }))
  const lockBook = () => { remoteBook.forceLock(); restoreBrowser(); win?.webContents.send('private:locked') }
  powerMonitor.on('lock-screen', lockBook)
  powerMonitor.on('suspend', lockBook)
  app.dock?.hide()
  today = localDay()
  const area = screen.getPrimaryDisplay().workArea
  const previous = store.data.position
  noteSize = previous?.noteSize
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
  win.webContents.on('render-process-gone', stopSSH)
  win.webContents.on('did-start-loading', stopSSH)
  win.webContents.on('render-process-gone', closeProbes)
  win.webContents.on('did-start-loading', closeProbes)
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
  browser = makeBrowser()
  follower = createFollower(profileDirectory, {
    seal(code) {
      const basic = process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text'
      return safeStorage.isEncryptionAvailable() && !basic ? safeStorage.encryptString(code).toString('base64') : ''
    },
    open: sealed => safeStorage.decryptString(Buffer.from(sealed, 'base64')),
  }, change => {
    if (quitting || win.isDestroyed()) return
    if (change.profileChanged) {
      closeProbes()
      stopSSH()
      lockBook()
      today = follower.store ? localDay() : store.today()
      updates.source(follower.snapshot()?.id)
    }
    win.webContents.send('notes:changed', { ...change,
      ...(change.profileChanged && { categories: notesStore().data.categories, locked: notesLocked() }) })
  })
  if (!follower.store) today = store.today()
  updates.source(follower.snapshot()?.id)
  codex = createCodex(profileDirectory, { get data() { return notesStore().data } }, approveCodex, launchHostCodex)
  sync = createSync(profileDirectory, store, ask, change => {
    if (!quitting && !win.isDestroyed()) win.webContents.send('notes:changed', change)
  }, (op, payload) => codexAction(op, payload, true), desktopUpdateSource(() => store.data.settings.proxyPort), tcpProbe, remoteBook, udpProbe)
  localSSH = createLocalSSHPipes({ isPaired: () => Boolean(!quitting && follower.store && !sync.state().enabled) })
  remoteSSH = createRemoteSSHHost({ takeOffer: id => sync.takeSSHOffer(id), join: joinSSHRelay, launch: openRemoteTerminal })
  transfer = require('./handoff.cjs').handoff({ root: app.getPath('userData'), directory: profileDirectory,
    sync, follower, credentials: safeStorage, snapshot: () => migration.snapshot(profileDirectory, store, safeStorage),
    check() {
      sync.requireWritable()
      if (book.unlocked || asking || codex.busy()) throw new Error('请先锁定私密便签并结束 AI 任务')
    }, restart() { setTimeout(() => { app.relaunch(); app.quit() }, 1000) } })
  registerIPC()
  win.once('ready-to-show', () => win.showInactive())
  win.on('close', event => {
    if (quitting) return
    event.preventDefault()
    setMode(edge ? 'edge' : 'pet', false)
  })
  win.on('closed', () => { clearInterval(hoverTimer); browser.dispose(); ordinaryBrowser?.dispose() })
  win.loadFile(path.join(__dirname, '../dist/index.html'))

  tray = new Tray(nativeImage.createFromPath(icon).resize({ width: 32, height: 32 }))
  tray.setToolTip('桃桃便签')
  tray.on('click', toggle)
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '打开便签', click: () => setMode('note') },
    { label: '显示桌宠', click: () => setMode('pet') },
    { label: '打开数据目录', click: () => shell.openPath(profileDirectory) },
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
    remoteBook?.forceLock()
    closeProbes()
    stopSSH()
    clearInterval(dayTimer)
    updates?.stop()
    installers?.stop()
    sync?.stop()
    codex?.close()
  })
} else {
  app.quit()
}
