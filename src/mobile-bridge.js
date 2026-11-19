import { App } from '@capacitor/app'
import { Capacitor, CapacitorHttp, registerPlugin } from '@capacitor/core'
import { InAppBrowser, DefaultWebViewOptions, ToolbarPosition } from '@capacitor/inappbrowser'
import { SecureStorage } from '@aparajita/capacitor-secure-storage'
import { defaultSettings, defaultCategory, builtInCategories, datesFor, hasContent, newCategory, newDayNote, noteKey, nodeText, localDay } from '../shared/notes.mjs'
import { endpoint, modelAnswer, modelPayload, validateProxyPort } from '../shared/ai.mjs'
import { webUrl } from '../shared/links.mjs'
import { mobileSync } from './sync-client.js'
import { mobileSyncLink } from './rtc-sync.js'
import { mobileUpdates } from './mobile-updates.js'
import { digest } from '../shared/sync.mjs'

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
  const updates = mobileUpdates(native)
  const platform = Capacitor.getPlatform()
  const floatingPet = platform === 'android' && Capacitor.isPluginAvailable('MomoPet')
  const ready = openDatabase()
  const notes = Object.create(null)
  const records = Object.create(null)
  let localDrafts = {}
  let namespace = ''
  let categories = [...builtInCategories]
  let writes = Promise.resolve()
  let mode = 'note'
  let today
  let settings = { ...defaultSettings }
  let hasKey = false
  let browser = { url: '', loading: false, canGoBack: false, error: '' }
  let onState = noop, onDay = noop, onBrowser = noop, onNotes = noop, onSync = noop
  let lastWidget = ''
  const publicSettings = () => ({ ...settings, hasKey })
  const state = () => ({
    mode, today, settings: publicSettings(), browser, categories, locked: sync.state().locked,
    update: updates.state,
  })

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
  }

  async function keepDraft(key, doc) {
    localDrafts = { ...localDrafts, [key]: doc }
    await transaction(await ready, 'settings', true, store => store.put(localDrafts, namespace + 'drafts'))
  }

  function saveNote(date, doc, category = defaultCategory, base) {
    const key = noteKey(category, date)
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
      const next = connection ? digest('momo-notes/cache/' + connection.key) + '/' : ''
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
      for (const key of Object.keys(records)) { delete records[key]; delete notes[key] }
      categories = storedCategories ?? [...builtInCategories]
      localDrafts = storedDrafts ?? {}
      for (const { date, doc, rev, dirty } of source) {
        const key = date.slice(previous.length)
        const record = { doc, rev: rev ?? null, dirty: dirty ?? hasContent(doc) }
        if (migrating) await writeRecord(key, record)
        else { records[key] = record; notes[key] = doc }
      }
      if (migrating) {
        await transaction(db, 'settings', true, store => store.put(categories, namespace + 'categories'))
        await transaction(db, 'settings', true, store => store.put(localDrafts, namespace + 'drafts'))
      }
      onNotes({ categories, profileChanged: true })
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

  async function refreshDay() {
    const date = localDay()
    if (date === today) return
    const previous = today
    today = date
    updateWidget()
    if (previous && previous !== date) onDay(date)
  }

  const runRefresh = () => refreshDay().catch(error => console.error(error))
  const syncLink = mobileSyncLink(connection => sync.disconnected(connection))
  const sync = mobileSync({
    exchange: syncLink.exchange,
    loadCode: () => native ? SecureStorage.getItem('sync-pair').catch(() => null) : Promise.resolve(null),
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
      onSync(value)
      onNotes({ locked: value.locked })
    },
  })
  const backgroundSync = () => sync.run().catch(noop)
  const init = ready.then(async db => {
    settings = { ...settings, ...await transaction(db, 'settings', false, store => store.get('user')) }
    await sync.init()
    if (native) {
      hasKey = Boolean(await SecureStorage.getItem(keyName).catch(() => null))
      await App.addListener('appStateChange', ({ isActive }) => {
        if (isActive) { void runRefresh(); void backgroundSync() }
      })
      await App.addListener('appUrlOpen', ({ url }) => openWidget(url))
      await InAppBrowser.addListener('browserClosed', () => {
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
    mobile: true,
    platform,
    floatingPet,
    liveScan: native && Capacitor.isPluginAvailable('CapacitorBarcodeScanner'),
    petState: () => petOverlay.state(),
    setPet: enabled => petOverlay.setEnabled({ enabled }),
    async getState() { await init; return state() },
    onState: callback => { onState = callback },
    onDay: callback => { onDay = callback },
    onBrowser: callback => { onBrowser = callback },
    onNotes: callback => { onNotes = callback },
    onSync: callback => { onSync = callback },
    syncState: sync.state,
    pairSync: sync.pairWith,
    testSync: sync.test,
    async scanSyncCode() {
      if (floatingPet) await petOverlay.scanner({ active: true })
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
      return result
    },
    runSync: sync.run,
    codex: sync.codex,
    syncDrafts: () => localDrafts,
    onUpdate: updates.onUpdate,
    browserViewport: noop,
    browserBack: noop,
    hideBrowser: noop,
    checkUpdate: updates.checkUpdate,
    openUpdate: updates.openUpdate,
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
      const url = { repo: 'https://github.com/SDUM-Liu/momo-notes', issues: 'https://github.com/SDUM-Liu/momo-notes/issues' }[target]
      if (typeof url !== 'string') return
      if (native) await InAppBrowser.openInExternalBrowser({ url })
      else window.open(url, '_blank', 'noopener,noreferrer')
    },
    async openBrowser(value) {
      const url = webUrl(value)
      if (!native) throw new Error('请在移动安装版中打开网页')
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
