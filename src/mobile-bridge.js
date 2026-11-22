import { App } from '@capacitor/app'
import { Capacitor, CapacitorHttp, registerPlugin } from '@capacitor/core'
import { InAppBrowser, DefaultWebViewOptions, ToolbarPosition } from '@capacitor/inappbrowser'
import { SecureStorage } from '@aparajita/capacitor-secure-storage'
import { defaultSettings, defaultCategory, builtInCategories, datesFor, noteIdentity, validateCategory, hasContent, newCategory, newDayNote, noteKey, nodeText, localDay } from '../shared/notes.mjs'
import { endpoint, modelAnswer, modelPayload, validateProxyPort } from '../shared/ai.mjs'
import { codexSetupUrl, webUrl } from '../shared/links.mjs'
import { mobileHandoff } from './mobile-handoff.js'
import { keyFor, box, openBox } from './mobile-sealed.js'
import { mobileBook } from './mobile-book.js'
import { backupBytes, restoreBackup, base64Block } from '../shared/media-transfer.mjs'
import { spoolBackup, releaseBackup } from './backup-file.js'
import { mobileMedia } from './mobile-media.js'
import { mobileSync } from './sync-client.js'
import { mobileSyncLink } from './rtc-sync.js'
import { mobileUpdates } from './mobile-updates.js'
import { digest, parsePairing, transferId } from '../shared/sync.mjs'
import { createHostSync } from '../shared/host-sync.mjs'
import { createUpdateSource } from '../shared/update-transfer.mjs'
import relayDefaults from '../shared/relay.json'

const keyName = 'ai-key'
const noop = () => {}
const proxy = registerPlugin('MomoProxy')
const syncTransport = registerPlugin('MomoSync')
const petOverlay = registerPlugin('MomoPet')
const barcodeScanner = registerPlugin('CapacitorBarcodeScanner')

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('momo-notes', 1)
    request.onupgradeneeded = () => {
      request.result.createObjectStore('notes', { keyPath: 'date' })
      request.result.createObjectStore('settings')
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

function transaction(db, store, write, operation) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, write ? 'readwrite' : 'readonly')
    const request = operation(tx.objectStore(store))
    tx.oncomplete = () => resolve(request.result)
    tx.onabort = () => reject(tx.error || request.error)
    tx.onerror = () => reject(tx.error || request.error)
  })
}

export function createMobileBridge() {
  const native = Capacitor.isNativePlatform()
  const platform = Capacitor.getPlatform()
  const floatingPet = platform === 'android' && Capacitor.isPluginAvailable('MomoPet')
  const updates = mobileUpdates(native, async () => {
    if (floatingPet && document.documentElement.dataset.momoFloating === 'true') await petOverlay.foreground()
  }, () => !hostSelected && sync.state().enabled ? sync.update : null)
  const ready = openDatabase()
  const notes = Object.create(null)
  const records = Object.create(null)
  const revisions = Object.create(null)
  let localDrafts = {}
  let primaryPrefix = '', transferringRole = false
  let namespace = ''
  let categories = [...builtInCategories]
  let writes = Promise.resolve()
  let mode = 'note'
  let today
  let settings = { ...defaultSettings }
  let hasKey = false
  let hostSelected = false, host, hostConfig = {}, hostSave = Promise.resolve(), changingRole = false
  let browser = { url: '', loading: false, canGoBack: false, error: '' }
  let onState = noop, onDay = noop, onBrowser = noop, onNotes = noop, onSync = noop
  let lastWidget = ''
  const publicSettings = () => ({ ...settings, hasKey })
  const state = () => ({
    mode, today, settings: publicSettings(), browser, categories, locked: syncStatus().locked, mobileHost: hostSelected,
    update: updates.state,
  })
  let privatePickerUntil = 0
  const privatePickerActive = () => Boolean(ordinaryBrowser && Date.now() < privatePickerUntil)
  let privateLockListener = noop, ordinaryBrowser, privateWebPage = false
  const bookOperation = mobileBook(
    async () => transaction(await ready, 'settings', false, store => store.get(primaryPrefix + 'private-book')),
    async value => transaction(await ready, 'settings', true, store => store.put(value, primaryPrefix + 'private-book')),
    () => hostSelected && !changingRole && !transferringRole && document.documentElement.dataset.momoFloating !== 'true',
    () => mobileMedia(primaryPrefix))
  async function privateBook(op, args) {
    if (op === 'background' && privatePickerActive()) return
    const result = await bookOperation(op, args)
    if (op === 'unlock') {
      ordinaryBrowser = browser
      browser = { url: '', loading: false, canGoBack: false }
      onBrowser(browser)
    } else if ((op === 'lock' || op === 'background') && ordinaryBrowser) {
      privatePickerUntil = 0
      if (privateWebPage) void InAppBrowser.close().catch(noop)
      privateWebPage = false
      browser = ordinaryBrowser
      ordinaryBrowser = undefined
      onBrowser(browser)
      if (op === 'background') privateLockListener()
    }
    return result
  }
  window.addEventListener('momo-floating-open', () => {
    privatePickerUntil = 0
    void privateBook('background')
  })
  const syncStatus = () => hostSelected ? host.state() : sync.state()

  function queueWrite(operation) {
    const result = writes.then(operation)
    writes = result.catch(noop)
    return result
  }

  function updateWidget() {
    if (!native || !today) return
    const pending = []
    function collect(node) {
      if (node.type === 'taskItem' && !node.attrs?.checked && hasContent(node.content?.[0] ?? {})) {
        pending.push(nodeText(node.content[0]).trim())
      }
      node.content?.forEach(collect)
    }
    collect(notes[noteKey(defaultCategory, today)] || newDayNote(notes, defaultCategory, today))
    const data = { date: today, count: pending.length, preview: pending.slice(0, 2).map(text => text.slice(0, 80)).join(' · ') }
    const snapshot = JSON.stringify(data)
    if (snapshot === lastWidget) return
    lastWidget = snapshot
    void syncTransport.updateWidget(data).catch(() => { if (lastWidget === snapshot) lastWidget = '' })
  }

  function openWidget(url) {
    if (!/^momonotes:\/\/today\/?$/.test(url ?? '')) return
    mode = 'note'
    onState(state())
    onNotes({ openToday: true })
  }

  async function writeRecord(key, record) {
    await transaction(await ready, 'notes', true, store => store.put({ date: namespace + key, ...record }))
    records[key] = record
    notes[key] = record.doc
    if (record.rev) revisions[key] = record.rev
  }

  async function keepDraft(key, doc) {
    localDrafts = { ...localDrafts, [key]: doc }
    await transaction(await ready, 'settings', true, store => store.put(localDrafts, namespace + 'drafts'))
  }

  function saveNote(date, doc, category = defaultCategory, base) {
    const key = noteKey(category, date)
    if (transferringRole) throw new Error('正在移交主设备')
    if (hostSelected) return host.write({ key, doc, base: base ?? records[key]?.rev })
    return queueWrite(async () => {
      const previous = records[key]
      const rev = previous?.dirty || base === undefined ? (previous?.rev ?? null) : base
      const saved = await sync.edit({ key, doc, base: rev }).catch(async error => {
        if (namespace && error.code !== 'NOTE_STALE') await keepDraft(key, doc)
        throw error
      })
      await writeRecord(key, { doc: saved.doc, rev: saved.rev, dirty: false })
      updateWidget()
      return saved
    })
  }

  async function activate(connection, oldCode) {
    return queueWrite(async () => {
      const db = await ready
      const next = connection ? digest('momo-notes/cache/' + connection.key) + '/' : primaryPrefix
      const oldKey = /^momo1:[^:]+:([a-f0-9]{64})$/.exec(oldCode || '')?.[1]
      let legacyProfile = await transaction(db, 'settings', false, store => store.get('legacy-profile'))
      if (!legacyProfile && oldKey) {
        legacyProfile = digest('momo-notes/cache/' + oldKey) + '/'
        await transaction(db, 'settings', true, store => store.put(legacyProfile, 'legacy-profile'))
      }
      const saved = await transaction(db, 'notes', false, store => store.getAll())
      const loaded = saved.filter(item => next ? item.date.startsWith(next) : !item.date.includes('/'))
      // A legacy cache is reusable only by the host that has the same encryption key.
      const migrating = next && !loaded.length && next === legacyProfile
      const hidden = !next && Boolean(legacyProfile)
      const previous = migrating ? '' : next
      const storedCategories = hidden ? null : await transaction(db, 'settings', false, store => store.get(previous + 'categories'))
      const storedDrafts = hidden ? null : await transaction(db, 'settings', false, store => store.get(previous + 'drafts'))
      const source = hidden ? [] : migrating ? saved.filter(item => !item.date.includes('/')) : loaded

      namespace = next
      for (const key of Object.keys(records)) { delete records[key]; delete notes[key]; delete revisions[key] }
      categories = storedCategories ?? [...builtInCategories]
      localDrafts = storedDrafts ?? {}
      for (const { date, doc, rev, dirty } of source) {
        const key = date.slice(previous.length)
        const record = { doc, rev: rev ?? (hostSelected ? digest(JSON.stringify(doc)) : null), dirty: dirty ?? hasContent(doc) }
        if (migrating) await writeRecord(key, record)
        else { records[key] = record; notes[key] = doc; if (record.rev) revisions[key] = record.rev }
      }
      if (migrating) {
        await transaction(db, 'settings', true, store => store.put(categories, namespace + 'categories'))
        await transaction(db, 'settings', true, store => store.put(localDrafts, namespace + 'drafts'))
      }
      onNotes({ categories, profileChanged: true, locked: syncStatus().locked })
      updateWidget()
    })
  }

  function mergeCategories(incoming) {
    return queueWrite(async () => {
      const next = [...categories, ...incoming.filter(item => !categories.some(existing => existing.id === item.id))]
      if (next.length === categories.length) return
      await transaction(await ready, 'settings', true, store => store.put(next, namespace + 'categories'))
      categories = next
      onNotes({ categories })
    })
  }

  const primaryStore = {
    get data() { return { notes, revisions, categories } },
    addCategory: item => mergeCategories([item]),
    async saveNote(day, doc, category) {
      const key = noteKey(category, day)
      const rev = digest(JSON.stringify(doc))
      await queueWrite(() => writeRecord(key, { doc, rev, dirty: false }))
      updateWidget()
      return rev
    },
    async today(category) {
      const day = localDay()
      if (!notes[noteKey(category, day)]) await this.saveNote(day, newDayNote(notes, category, day), category)
      return day
    },
  }

  const hostUpdates = createUpdateSource(async (url, range) => {
    const response = await CapacitorHttp.get({
      url, responseType: range ? 'arraybuffer' : 'text',
      headers: range ? { Range: range, 'Accept-Encoding': 'identity' } : { Accept: 'application/vnd.github+json, text/plain' },
      connectTimeout: 12000, readTimeout: 35000,
    })
    return { status: response.status, range: Object.entries(response.headers ?? {})
      .find(([name]) => name.toLowerCase() === 'content-range')?.[1],
    data: typeof response.data === 'string' ? response.data : JSON.stringify(response.data) }
  })

  async function refreshDay() {
    const date = localDay()
    if (date === today) return
    const previous = today
    today = date
    updateWidget()
    if (previous && previous !== date) onDay(date)
  }

  const runRefresh = () => refreshDay().catch(error => console.error(error))
  async function diagnoseSync(options) {
    if (platform === 'android' && Capacitor.isPluginAvailable('MomoSync')) {
      return (await syncTransport.diagnose(options)).status
    }
    if (!native) return null
    try {
      const result = await CapacitorHttp.get({
        url: new URL('/health', options.relay).href, connectTimeout: 5000, readTimeout: 5000, disableRedirects: true,
      })
      if (result.status === 200 && result.data?.service === 'momo-sync') return 'websocket_unavailable'
    } catch {}
    return 'service_unavailable'
  }
  const syncLink = mobileSyncLink(connection => sync.disconnected(connection), diagnoseSync)
  const sync = mobileSync({
    editing: () => document.activeElement?.isContentEditable === true,
    exchange: syncLink.exchange,
    loadCode: () => native && !hostSelected ? SecureStorage.getItem('sync-pair').catch(() => null) : Promise.resolve(null),
    saveCode: code => {
      if (!native) throw new Error('请在移动安装版中配对')
      return code ? SecureStorage.setItem('sync-pair', code) : SecureStorage.removeItem('sync-pair')
    },
    records,
    activate,
    categories: () => categories,
    setCategories: mergeCategories,
    keepDraft,
    accept(key, snapshot, value, pushed) {
      return queueWrite(async () => {
        const current = records[key]
        if (current !== snapshot) {
          if (pushed && current?.dirty && JSON.stringify(snapshot.doc) === JSON.stringify(value.doc)) {
            await writeRecord(key, { ...current, rev: value.rev })
            onNotes({ key, doc: current.doc, rev: value.rev })
          }
          return
        }
        await writeRecord(key, { doc: value.doc, rev: value.rev, dirty: false })
        updateWidget()
        onNotes(value)
      })
    },
    change: value => {
      if (hostSelected) return
      onSync(value)
      onNotes({ locked: value.locked })
    },
  })
  const dbGet = async key => transaction(await ready,'settings',false,s => s.get(key))
  const dbPut = async (key,value) => transaction(await ready,'settings',true,s => value == null ? s.delete(key) : s.put(value,key))
  const secure = {
    async get(name) { const raw = await SecureStorage.getItem(name).catch(() => null); return raw ? JSON.parse(raw) : null },
    set(name,value) { return value == null ? SecureStorage.removeItem(name) : SecureStorage.setItem(name,JSON.stringify(value)) },
  }
  async function portableSnapshot() {
    if (!native || !hostSelected || host.state().locked) throw new Error('请在同步结束后从主设备导出')
    await writes
    const book = await dbGet(primaryPrefix + 'private-book')
    return { format:1, notes:structuredClone(notes), categories:structuredClone(categories), settings:{...settings,key:''},
      apiKey:await SecureStorage.getItem(keyName).catch(() => '') || '', book:book ? JSON.stringify(book) : null }
  }
  async function stageProfile(data, config) {
    if (data?.format !== 1 || !Array.isArray(data.categories) || !data.notes) throw new Error('迁移包格式无效')
    const prefix = 'primary-' + transferId() + '/'
    const cats = [...builtInCategories,...data.categories.filter(c => !builtInCategories.some(b => b.id === c.id)).map(validateCategory)]
    const records = Object.entries(data.notes).map(([key,doc]) => {
      if (!cats.some(c => c.id === noteIdentity(key).category) || doc?.type !== 'doc' || !Array.isArray(doc.content)) throw new Error('便签数据有误')
      return { date:prefix + key, doc, rev:digest(JSON.stringify(doc)), dirty:false }
    })
    const book = data.book ? JSON.parse(data.book) : null
    const db = await ready
    await new Promise((resolve,reject) => {
      const tx = db.transaction(['settings','notes'],'readwrite')
      tx.oncomplete = resolve; tx.onabort = () => reject(tx.error); tx.onerror = () => reject(tx.error)
      for (const record of records) tx.objectStore('notes').put(record)
      const metadata = tx.objectStore('settings')
      metadata.put(cats,prefix + 'categories')
      if (book) metadata.put(book,prefix + 'private-book')
      metadata.put({...defaultSettings,...data.settings,key:''},prefix + 'user')
    })
    await secure.set('staged-' + prefix.slice(0,-1),{config,apiKey:data.apiKey || ''})
    return prefix
  }
  async function applyPromotion(prefix) {
    const credentials = await secure.get('staged-' + prefix.slice(0,-1))
    if (!credentials) throw new Error('接管资料不存在')
    const settings = await dbGet(prefix + 'user')
    await secure.set('promotion',prefix)
    await SecureStorage.setItem('sync-host',JSON.stringify(credentials.config || {}))
    if (credentials.apiKey) await SecureStorage.setItem(keyName,credentials.apiKey)
    else await SecureStorage.removeItem(keyName).catch(noop)
    const db = await ready
    await new Promise((resolve,reject) => {
      const tx = db.transaction('settings','readwrite'), s = tx.objectStore('settings')
      s.put(true,'primary-role'); s.put(prefix,'primary-prefix'); s.put(settings,'user')
      tx.oncomplete = resolve; tx.onabort = () => reject(tx.error); tx.onerror = () => reject(tx.error)
    })
    const rx = await secure.get('handoff-receive')
    if (rx?.staged === prefix) { rx.done = Date.now(); await secure.set('handoff-receive',rx) }
    await SecureStorage.removeItem('sync-pair').catch(noop)
    await secure.set('promotion',null)
    await secure.set('staged-' + prefix.slice(0,-1),null)
  }
  async function demote(code) {
    if (host && host.owns(parsePairing(code).key)) { host.retire(); await hostSave }
    else if (!host) {
      const retired = await secure.get('sync-host')
      if (retired?.key === parsePairing(code).key) {
        delete retired.key; delete retired.owner; retired.enabled = false; retired.devices = []
        await secure.set('sync-host',retired)
      }
    }
    await SecureStorage.setItem('sync-pair',code)
    await dbPut('primary-role',false)
    hostSelected = false
  }
  const mediaFor = (prefix = primaryPrefix) => mobileMedia(prefix)
  async function discardStage(prefix) {
    if (!/^primary-[0-9a-f]{32}\/$/.test(prefix) || prefix === primaryPrefix) throw new Error('暂存资料路径无效')
    await mediaFor(prefix).clear()
    const db = await ready
    await new Promise((resolve, reject) => {
      const tx = db.transaction(['notes', 'settings'], 'readwrite')
      const keys = IDBKeyRange.bound(prefix, prefix + '\uffff')
      tx.objectStore('notes').delete(keys); tx.objectStore('settings').delete(keys)
      tx.oncomplete = resolve; tx.onabort = () => reject(tx.error)
    })
    await secure.set('staged-' + prefix.slice(0,-1), null)
  }
  const handoff = mobileHandoff({ get:dbGet,put:dbPut,secure,pair:async () => {
    if (hostSelected) throw new Error('请在已绑定的从设备上接收')
    return SecureStorage.getItem('sync-pair')
  },snapshot:portableSnapshot,stage:stageProfile, mediaFor, discard:discardStage,
    retireMedia:async () => {
      await mediaFor().clear()
      await dbPut(primaryPrefix + 'private-book', null)
    },activate:async prefix => {
    await applyPromotion(prefix); setTimeout(() => location.reload(),1200)
  },demote,current:() => {
    if (!hostSelected || host.state().locked) throw new Error('请在同步结束后移交主设备')
    return {config:{...hostConfig},pair:host.code()}
  } })
  const backgroundSync = () => sync.run(true).catch(noop)
  const init = ready.then(async db => {
    if (native) {
      const recovery = await secure.get('promotion')
      if (recovery) await applyPromotion(recovery)
      const retiring = await secure.get('handoff-send')
      if (retiring) await demote(retiring.pair)
    }
    primaryPrefix = await dbGet('primary-prefix') || ''
    settings = { ...settings, ...await transaction(db, 'settings', false, store => store.get('user')) }
    hostSelected = Boolean(await transaction(db, 'settings', false, store => store.get('primary-role')))
    if (hostSelected && document.documentElement.dataset.momoFloating !== 'true') await mobileMedia(primaryPrefix).recover()
    if (native) {
      const saved = await SecureStorage.getItem('sync-host').catch(() => null)
      if (saved) { try { hostConfig = JSON.parse(saved) } catch {} }
    }
    host = createHostSync({ config: hostConfig, store: primaryStore, defaults: relayDefaults, update: hostUpdates,
      persist() {
        const value = JSON.stringify(hostConfig)
        hostSave = hostSave.catch(noop).then(() => SecureStorage.setItem('sync-host', value))
        void hostSave.catch(noop)
      },
      notify(value) {
        if (!hostSelected) return
        onNotes(value)
        onSync(host.state())
      },
    })
    await sync.init()
    if (native) {
      hasKey = Boolean(await SecureStorage.getItem(keyName).catch(() => null))
      await App.addListener('appStateChange', ({ isActive }) => {
        if (isActive) { void runRefresh(); void backgroundSync() } else void privateBook('background')
      })
      await App.addListener('appUrlOpen', ({ url }) => openWidget(url))
      await InAppBrowser.addListener('browserClosed', () => {
        privateWebPage = false
        browser = { ...browser, loading: false, closed: true }
        onBrowser(browser)
      })
    }
    await refreshDay()
    if (native) {
      const launch = await App.getLaunchUrl().catch(() => null)
      if (/^momonotes:\/\/today\/?$/.test(launch?.url ?? '')) mode = 'note'
    }
    setInterval(runRefresh, 5000)
    void backgroundSync()
    setInterval(backgroundSync, 20000)
    setInterval(() => { void sync.probe() }, 2500)
    updateWidget()
  })

  return {
    mobile: true, privateBook, privatePickerActive,
    privatePicker(active) { privatePickerUntil = active ? Date.now() + 90000 : 0 },
    onPrivateLock(callback) { privateLockListener = callback },
    releaseBackup,
    async handoff(op,...args) {
      await init
      if (!native || document.documentElement.dataset.momoFloating === 'true') return null
      if (op !== 'cutover') return handoff(op,...args)
      transferringRole = true
      try { await privateBook('lock'); return await handoff(op,...args) } finally { transferringRole = false }
    },
    async migrationFile(direction,password,file) {
      await init
      if (!native || document.documentElement.dataset.momoFloating === 'true') throw new Error('请在手机全屏应用中迁移')
      if (direction === 'export') {
        const salt = crypto.getRandomValues(new Uint8Array(16)), key = await keyFor(password,salt)
        const bytes = backupBytes(await portableSnapshot(), mediaFor(), async data =>
          JSON.stringify(await box(key, salt, data, 'momo/migration/v1')))
        if (platform === 'android') {
          const { token } = await syncTransport.saveBackup()
          try {
            for await (const part of bytes) {
              for (let n = 0; n < part.length; n += 256 * 1024) {
                await syncTransport.appendBackup({ token, part: base64Block(part.subarray(n, n + 256 * 1024)) })
              }
            }
            await syncTransport.closeBackup({ token })
          } catch (error) {
            await syncTransport.closeBackup({ token, abort: true }).catch(noop)
            throw error
          }
          return true
        }
        return spoolBackup(bytes)
      }
      if (direction !== 'import' || !file) throw new Error('请选择迁移包')
      if (host.state().enabled || sync.state().enabled) throw new Error('请先停止同步或取消配对，再在新主设备导入')
      const staged = await restoreBackup(file.size, async (offset, count) =>
        new Uint8Array(await file.slice(offset, offset + count).arrayBuffer()),
        async envelope => (await openBox(password, JSON.parse(envelope), 'momo/migration/v1')).value,
        data => stageProfile(data, null), mediaFor, discardStage)
      await applyPromotion(staged); location.reload(); return true
    },
    supportsFollower: true,
    platform,
    floatingPet,
    liveScan: native && Capacitor.isPluginAvailable('CapacitorBarcodeScanner'),
    petState: () => petOverlay.state(),
    setPet: enabled => petOverlay.setEnabled({ enabled }),
    onPetPermissionReturn: callback => petOverlay.addListener('permissionReturn', callback),
    async getState() { await init; return state() },
    onState: callback => { onState = callback },
    onDay: callback => { onDay = callback },
    onBrowser: callback => { onBrowser = callback },
    onNotes: callback => { onNotes = callback },
    onSync: callback => { onSync = callback },
    async syncState() { await init; return syncStatus() },
    async sshHint(scope, value) {
      await init
      if (hostSelected || changingRole) throw new Error('请在已配对的从设备操作')
      return sync.sshHint(scope, value)
    },
    wifiAddress: platform === 'android' && native ? async () => (await syncTransport.wifiAddress()).address : undefined,
    async selectSyncRole(role) {
      await init
      if (changingRole) throw new Error('正在切换设备角色')
      const next = role === 'host'
      if (next === hostSelected) return syncStatus()
      if (next && sync.state().enabled) throw new Error('请先取消从设备配对')
      if (!next && host.state().enabled) throw new Error('请先停止主设备同步')
      changingRole = true
      try {
        if (!next && (await mobileMedia(primaryPrefix).list()).length) throw new Error('请先迁移附件至新主设备')
        await privateBook('lock')
        if (document.documentElement.dataset.momoFloating !== 'true') await mobileMedia(primaryPrefix).recover()
        await transaction(await ready, 'settings', true, store => store.put(next, 'primary-role'))
        hostSelected = next
        await activate(undefined)
        updates.routeChanged()
        onState(state())
        return syncStatus()
      } finally { changingRole = false }
    },
    async enableSync(enabled, relay, fallback) {
      await init
      if (!hostSelected || !native) throw new Error('请在移动安装版中选择主设备')
      const value = host.setEnabled(enabled, relay, fallback)
      await hostSave
      return value
    },
    async syncLink() { await init; return hostSelected ? host.link() : null },
    async syncLinkStatus(...args) { return host.status(...args) },
    async syncCode() { return host.code() },
    async rotateSync() { const value = host.rotate(); await hostSave; return value },
    syncExchange: value => hostSelected && !transferringRole ? host.exchange(value) : null,
    async pairSync(code) {
      await init
      if (hostSelected || changingRole) throw new Error('请先切换为从设备')
      if (host.owns(parsePairing(code).key)) throw new Error('不能配对本机的配对码')
      try { return await sync.pairWith(code) } finally { updates.routeChanged() }
    },
    testSync: sync.test,
    async scanSyncCode() {
      if (floatingPet) {
        await petOverlay.foreground()
        await petOverlay.scanner({ active: true })
      }
      try {
        // The scanner's QR_CODE and BACK values select live decoding from the rear camera.
        const result = await barcodeScanner.scanBarcode({
          hint: 0, cameraDirection: 1, scanInstructions: '将主机配对二维码放入取景框',
          cancelButtonAccessibilityLabel: '关闭扫码',
          torchButtonOnAccessibilityLabel: '关闭补光灯',
          torchButtonOffAccessibilityLabel: '开启补光灯',
        })
        return result.ScanResult
      } finally {
        if (floatingPet) await petOverlay.scanner({ active: false }).catch(noop)
      }
    },
    async unpairSync() {
      const result = await sync.unpair()
      syncLink.close()
      updates.routeChanged()
      return result
    },
    runSync: sync.run,
    editorIdle: backgroundSync,
    async codex(...args) {
      if (hostSelected) throw new Error('手机作为主设备时，桃桃 AI 不可用')
      return sync.codex(...args)
    },
    syncDrafts: () => localDrafts,
    onUpdate: updates.onUpdate,
    browserViewport: noop,
    browserBack: noop,
    hideBrowser: noop,
    checkUpdate: updates.checkUpdate,
    downloadUpdate: updates.downloadUpdate,
    installUpdate: updates.installUpdate,
    toggle() {
      if (mode === 'note' && floatingPet) return petOverlay.dismiss()
      mode = mode === 'note' ? 'pet' : 'note'
      onState(state())
    },
    async listDates(category = defaultCategory) {
      await refreshDay()
      const days = datesFor(notes, category, today)
      return days.includes(today) ? days : [today, ...days]
    },
    async addCategory(name) {
      const item = newCategory(name)
      if (transferringRole) throw new Error('正在移交主设备')
      if (hostSelected) return host.category(item)
      await mergeCategories(await sync.addCategory(item))
      return categories
    },
    async openNote(date, category = defaultCategory) {
      await refreshDay()
      const day = date || today
      const key = noteKey(category, day)
      if (!notes[key] && date && day !== today) throw new Error('日期页不存在')
      return { date: day, category, doc: notes[key] || newDayNote(notes, category, day), today, rev: records[key]?.rev ?? null }
    },
    saveNote,
    async saveSettings({ newKey, baseUrl, model, proxyPort }) {
      if (baseUrl) endpoint(baseUrl)
      validateProxyPort(proxyPort)
      const next = { ...settings, baseUrl, model, proxyPort }
      if (newKey !== null) {
        if (!native && newKey) throw new Error('请在移动安装版中保存密钥')
        if (native && newKey) await SecureStorage.setItem(keyName, newKey)
        if (native && !newKey && hasKey) await SecureStorage.removeItem(keyName)
        hasKey = Boolean(newKey)
      }
      await transaction(await ready, 'settings', true, store => store.put(next, 'user'))
      settings = next
      return publicSettings()
    },
    async ask(request) {
      if (hostSelected) throw new Error('手机作为主设备时，桃桃 AI 不可用')
      if (sync.state().enabled) return sync.ask(request)
      const data = modelPayload({ notes, settings }, request)
      if (!native) throw new Error('请在移动安装版中连接 AI')
      const key = await SecureStorage.getItem(keyName)
      const url = endpoint(settings.baseUrl).href
      const authorization = key ? 'Bearer ' + key : ''
      if (settings.proxyPort) {
        const result = await proxy.post({ url, port: Number(settings.proxyPort), body: JSON.stringify(data), authorization })
        if (result.status < 200 || result.status >= 300) throw new Error('AI API 返回 HTTP ' + result.status)
        return modelAnswer(JSON.parse(result.body))
      }
      const result = await CapacitorHttp.post({
        url,
        data,
        headers: { 'Content-Type': 'application/json', ...(authorization ? { Authorization: authorization } : {}) },
        connectTimeout: 15000, readTimeout: 45000, disableRedirects: true,
      })
      if (result.status < 200 || result.status >= 300) throw new Error('AI API 返回 HTTP ' + result.status)
      return modelAnswer(result.data)
    },
    async openProject(target) {
      const url = {
        repo: 'https://github.com/SDUM-Liu/momo-notes',
        issues: 'https://github.com/SDUM-Liu/momo-notes/issues',
        codexSetup: codexSetupUrl,
        termux: 'https://termux.dev/en/',
      }[target]
      if (typeof url !== 'string') return
      if (native) await InAppBrowser.openInExternalBrowser({ url })
      else window.open(url, '_blank', 'noopener,noreferrer')
    },
    async openBrowser(value) {
      const url = webUrl(value)
      if (!native) throw new Error('请在移动安装版中打开网页')
      if (floatingPet) await petOverlay.foreground()
      privateWebPage = Boolean(ordinaryBrowser)
      browser = { ...browser, url, closed: false }
      onBrowser(browser)
      await InAppBrowser.openInWebView({
        url,
        options: {
          ...DefaultWebViewOptions,
          showURL: true,
          showToolbar: true,
          toolbarPosition: ToolbarPosition.TOP,
          showNavigationButtons: true,
          closeButtonText: '🍑 返回便签',
          clearCache: false,
          clearSessionCache: false,
          android: { ...DefaultWebViewOptions.android, isIsolated: true },
        },
      })
    },
  }
}
