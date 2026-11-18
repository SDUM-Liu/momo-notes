import { App } from '@capacitor/app'
import { Capacitor, CapacitorHttp, registerPlugin } from '@capacitor/core'
import { InAppBrowser, DefaultWebViewOptions, ToolbarPosition } from '@capacitor/inappbrowser'
import { SecureStorage } from '@aparajita/capacitor-secure-storage'
import { defaultSettings, defaultCategory, builtInCategories, datesFor, hasContent, newCategory, newDayNote, noteKey, localDay } from '../shared/notes.mjs'
import { chatMessages, endpoint, modelAnswer, modelPayload, validateProxyPort } from '../shared/ai.mjs'
import { webUrl } from '../shared/links.mjs'
import { mobileSync } from './sync-client.js'

const keyName = 'ai-key'
const noop = () => {}
const proxy = registerPlugin('MomoProxy')
const syncTransport = registerPlugin('MomoSync')

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
  const ready = openDatabase()
  const notes = Object.create(null)
  const records = Object.create(null)
  let categories = [...builtInCategories]
  let writes = Promise.resolve()
  let mode = 'pet'
  let today
  let settings = { ...defaultSettings }
  let hasKey = false
  let browser = { url: '', loading: false, canGoBack: false, error: '' }
  let onState = noop, onDay = noop, onBrowser = noop, onNotes = noop, onSync = noop
  const publicSettings = () => ({ ...settings, hasKey })
  const state = () => ({
    mode, today, settings: publicSettings(), browser, categories,
    update: { status: 'mobile', version: __APP_VERSION__ },
  })

  function queueWrite(operation) {
    const result = writes.then(operation)
    writes = result.catch(noop)
    return result
  }

  async function writeRecord(key, record) {
    await transaction(await ready, 'notes', true, store => store.put({ date: key, ...record }))
    records[key] = record
    notes[key] = record.doc
  }

  function saveNote(date, doc, category = defaultCategory, base) {
    const key = noteKey(category, date)
    return queueWrite(async () => {
      const previous = records[key]
      const rev = previous?.dirty || base === undefined ? (previous?.rev ?? null) : base
      await writeRecord(key, { doc, rev, dirty: true })
      return { key, doc, rev }
    })
  }

  async function ensurePage(category, date) {
    const key = noteKey(category, date)
    if (!records[key]) await queueWrite(async () => {
      if (!records[key]) await writeRecord(key, { doc: newDayNote(notes, category, date), rev: null, dirty: false })
    })
  }

  function mergeCategories(incoming) {
    return queueWrite(async () => {
      const next = [...categories, ...incoming.filter(item => !categories.some(existing => existing.id === item.id))]
      if (next.length === categories.length) return
      await transaction(await ready, 'settings', true, store => store.put(next, 'categories'))
      categories = next
      onNotes({ categories })
    })
  }

  async function refreshDay() {
    const date = localDay()
    if (date === today) return
    await ensurePage(defaultCategory, date)
    const previous = today
    today = date
    if (previous && previous !== date) onDay(date)
  }

  const runRefresh = () => refreshDay().catch(error => console.error(error))
  const sync = mobileSync({
    exchange: params => syncTransport.exchange(params),
    loadCode: () => native ? SecureStorage.getItem('sync-pair').catch(() => null) : Promise.resolve(null),
    saveCode: code => {
      if (!native) throw new Error('请在移动安装版中配对')
      return code ? SecureStorage.setItem('sync-pair', code) : SecureStorage.removeItem('sync-pair')
    },
    records,
    categories: () => categories,
    setCategories: mergeCategories,
    markForUpload(remote) {
      return queueWrite(async () => {
        for (const [key, record] of Object.entries(records)) {
          if (!record.dirty && hasContent(record.doc) && record.rev !== remote[key]) {
            await writeRecord(key, { ...record, dirty: true })
          }
        }
      })
    },
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
        onNotes(value)
      })
    },
    change: value => onSync(value),
  })
  const backgroundSync = () => sync.run().catch(noop)
  const init = ready.then(async db => {
    for (const { date, doc, rev, dirty } of await transaction(db, 'notes', false, store => store.getAll())) {
      notes[date] = doc
      records[date] = { doc, rev: rev ?? null, dirty: dirty ?? hasContent(doc) }
    }
    settings = { ...settings, ...await transaction(db, 'settings', false, store => store.get('user')) }
    categories = await transaction(db, 'settings', false, store => store.get('categories')) ?? categories
    await sync.init()
    if (native) {
      hasKey = Boolean(await SecureStorage.getItem(keyName).catch(() => null))
      await App.addListener('appStateChange', ({ isActive }) => {
        if (isActive) { void runRefresh(); void backgroundSync() }
      })
      await InAppBrowser.addListener('browserClosed', () => {
        browser = { ...browser, loading: false, closed: true }
        onBrowser(browser)
      })
    }
    await refreshDay()
    setInterval(runRefresh, 5000)
    void backgroundSync()
    setInterval(backgroundSync, 20000)
  })

  return {
    mobile: true,
    async getState() { await init; return state() },
    onState: callback => { onState = callback },
    onDay: callback => { onDay = callback },
    onBrowser: callback => { onBrowser = callback },
    onNotes: callback => { onNotes = callback },
    onSync: callback => { onSync = callback },
    syncState: sync.state,
    pairSync: sync.pairWith,
    unpairSync: sync.unpair,
    runSync: sync.run,
    onUpdate: noop,
    browserViewport: noop,
    browserBack: noop,
    hideBrowser: noop,
    checkUpdate: noop,
    downloadUpdate: noop,
    installUpdate: noop,
    toggle() {
      mode = mode === 'note' ? 'pet' : 'note'
      onState(state())
    },
    async listDates(category = defaultCategory) {
      await refreshDay()
      await ensurePage(category, today)
      return datesFor(notes, category, today)
    },
    async addCategory(name) {
      await mergeCategories([newCategory(name)])
      return categories
    },
    async openNote(date, category = defaultCategory) {
      await refreshDay()
      const day = date || today
      if (!date) await ensurePage(category, day)
      const key = noteKey(category, day)
      if (!notes[key]) throw new Error('日期页不存在')
      return { date: day, category, doc: notes[key], today, rev: records[key].rev }
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
    async copyChat(request) {
      const text = chatMessages(notes, request).map(message => message.content).join('\n\n')
      try { await navigator.clipboard.writeText(text) } catch { return text }
    },
    async openProject(target) {
      const url = { repo: 'https://github.com/SDUM-Liu/momo-notes', issues: 'https://github.com/SDUM-Liu/momo-notes/issues', chat: 'https://chatgpt.com/' }[target]
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
