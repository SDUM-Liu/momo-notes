import { App } from '@capacitor/app'
import { Capacitor, CapacitorHttp } from '@capacitor/core'
import { InAppBrowser, DefaultWebViewOptions, ToolbarPosition } from '@capacitor/inappbrowser'
import { SecureStorage } from '@aparajita/capacitor-secure-storage'
import { defaultSettings, emptyNote, hasContent, localDay } from '../shared/notes.mjs'
import { endpoint, modelAnswer, modelPayload } from '../shared/ai.mjs'
import { webUrl } from '../shared/links.mjs'

const keyName = 'ai-key'
const noop = () => {}

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
  let mode = 'pet'
  let today
  let settings = { ...defaultSettings }
  let hasKey = false
  let browser = { url: '', loading: false, canGoBack: false, error: '' }
  let onState = noop, onDay = noop, onBrowser = noop
  const publicSettings = () => ({ ...settings, hasKey })
  const state = () => ({
    mode, today, settings: publicSettings(), browser,
    update: { status: 'mobile', version: __APP_VERSION__ },
  })

  async function saveNote(date, doc) {
    const db = await ready
    await transaction(db, 'notes', true, store => store.put({ date, doc }))
    notes[date] = doc
  }

  async function refreshDay() {
    const date = localDay()
    if (date === today) return
    if (!notes[date]) await saveNote(date, emptyNote())
    const previous = today
    today = date
    if (previous && previous !== date) onDay(date)
  }

  const runRefresh = () => refreshDay().catch(error => console.error(error))
  const init = ready.then(async db => {
    for (const { date, doc } of await transaction(db, 'notes', false, store => store.getAll())) notes[date] = doc
    settings = { ...settings, ...await transaction(db, 'settings', false, store => store.get('user')) }
    if (native) {
      hasKey = Boolean(await SecureStorage.getItem(keyName).catch(() => null))
      await App.addListener('appStateChange', ({ isActive }) => { if (isActive) void runRefresh() })
      await InAppBrowser.addListener('browserClosed', () => {
        browser = { ...browser, loading: false, closed: true }
        onBrowser(browser)
      })
    }
    await refreshDay()
    setInterval(runRefresh, 5000)
  })

  return {
    mobile: true,
    async getState() { await init; return state() },
    onState: callback => { onState = callback },
    onDay: callback => { onDay = callback },
    onBrowser: callback => { onBrowser = callback },
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
    async listDates() {
      await refreshDay()
      return Object.keys(notes).filter(date => date === today || hasContent(notes[date])).sort().reverse()
    },
    async openNote(date) {
      await refreshDay()
      const day = date || today
      if (!notes[day]) throw new Error('日期页不存在')
      return { date: day, doc: notes[day], today }
    },
    saveNote,
    async saveSettings({ newKey, baseUrl, model }) {
      if (baseUrl) endpoint(baseUrl)
      const next = { ...settings, baseUrl, model }
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
      const data = modelPayload({ notes, settings }, request)
      if (!native) throw new Error('请在移动安装版中连接 AI')
      const key = await SecureStorage.getItem(keyName)
      const result = await CapacitorHttp.post({
        url: endpoint(settings.baseUrl).href,
        data,
        headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: 'Bearer ' + key } : {}) },
        connectTimeout: 15000, readTimeout: 45000, disableRedirects: true,
      })
      if (result.status < 200 || result.status >= 300) throw new Error('AI API 返回 HTTP ' + result.status)
      return modelAnswer(result.data)
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
          closeButtonText: '返回便签',
          clearCache: false,
          clearSessionCache: false,
          android: { ...DefaultWebViewOptions.android, isIsolated: true },
        },
      })
    },
  }
}
