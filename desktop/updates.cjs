const { app } = require('electron')
const { existsSync } = require('node:fs')
const { join } = require('node:path')
const { createUpdateFeed } = require('./update-feed.cjs')

function createUpdates(onChange, send) {
  const supported = app.isPackaged && (process.platform !== 'linux' || Boolean(process.env.APPIMAGE))
    && existsSync(join(process.resourcesPath, 'app-update.yml'))
  let state = { status: supported ? 'idle' : 'unavailable', version: app.getVersion() }
  const updater = supported ? require('electron-updater').autoUpdater : null
  const channel = process.platform === 'win32' ? 'win' : process.platform === 'linux' ? 'linux' : null
  const feed = channel ? createUpdateFeed(send, channel) : null
  let startupTimer, interval, source = '', generation = 0, automatic = false, activeCheck, activeDownload, checkedToken, downloadToken

  function show(status, details = {}) {
    state = { version: state.version, target: state.target, status, viaHost: Boolean(source), ...details }
    onChange(state)
  }

  if (updater) {
    updater.autoDownload = false
    updater.autoInstallOnAppQuit = false
    updater.allowPrerelease = false
    updater.allowDowngrade = false
    updater.on('download-progress', ({ percent }) => {
      const progress = Math.round(Math.max(0, Math.min(percent, 100)))
      if (state.status === 'downloading' && state.progress !== progress) show('downloading', { progress })
    })
    updater.on('error', () => {
      if (state.status === 'installing') show('install-error')
    })
  }

  async function check() {
    if (!['idle', 'current', 'check-error'].includes(state.status)) return
    if (activeCheck) await activeCheck.catch(() => {})
    if (!['idle', 'current', 'check-error'].includes(state.status)) return
    const before = generation
    show('checking')
    try {
      if (source) {
        if (!feed) throw new Error('该平台目前没有应用内更新包')
        const url = await feed.open()
        if (before !== generation) return
        updater.setFeedURL({ provider: 'generic', url, useMultipleRangeRequest: false })
      }
      activeCheck = updater.checkForUpdates()
      const result = await activeCheck
      if (before !== generation) return
      if (result?.isUpdateAvailable) {
        checkedToken = result.cancellationToken
        show('available', { target: result.updateInfo.version })
        if (automatic) void download()
      } else {
        show('current')
      }
    } catch (error) {
      if (before !== generation) return
      console.error('Update check failed:', error.message)
      show('check-error', source ? { error: feed?.error || '无法通过主设备检查更新，请确认主设备在线且已更新。' } : {})
    } finally { activeCheck = undefined }
  }

  async function download() {
    if (!['available', 'download-error'].includes(state.status)) return
    if (activeDownload) await activeDownload.catch(() => {})
    if (!['available', 'download-error'].includes(state.status)) return
    const before = generation
    show('downloading')
    const token = checkedToken
    downloadToken = token
    try {
      updater.autoInstallOnAppQuit = automatic
      activeDownload = updater.downloadUpdate(token)
      await activeDownload
      if (before === generation) show('ready')
    } catch (error) {
      if (before !== generation) return
      console.error('Update download failed:', error.message)
      show('download-error', source ? { error: feed?.error || '主设备更新下载中断，请重试。' } : {})
    } finally {
      if (downloadToken === token) { activeDownload = downloadToken = undefined }
    }
  }

  function install() {
    if (!['ready', 'install-error'].includes(state.status)) return
    show('installing')
    try {
      updater.quitAndInstall(true, true)
    } catch (error) {
      console.error('Update installer failed:', error.message)
      show('install-error')
    }
  }

  return {
    get state() { return state },
    reply(id, result) { feed?.reply(id, result) },
    source(identity) {
      const next = identity || ''
      if (next === source) return
      source = next
      ++generation
      checkedToken = undefined
      downloadToken?.cancel()
      feed?.close()
      if (updater) {
        updater.autoInstallOnAppQuit = false
        updater.disableDifferentialDownload = Boolean(source)
        if (!source) updater.setFeedURL({ provider: 'github', owner: 'SDUM-Liu', repo: 'momo-notes', releaseType: 'release' })
      }
      show(updater ? 'idle' : 'unavailable', { target: undefined })
    },
    check,
    download,
    install,
    setAutomatic(enabled) {
      if (!updater || enabled === automatic) return
      automatic = enabled
      updater.autoInstallOnAppQuit = enabled && state.status === 'ready'
      if (!enabled) return
      if (state.status === 'ready') show('available')
      if (['available', 'download-error'].includes(state.status)) void download()
    },
    schedule() {
      if (!supported) return
      startupTimer = setTimeout(check, 5000)
      interval = setInterval(check, 6 * 60 * 60 * 1000)
    },
    stop() {
      downloadToken?.cancel()
      feed?.close()
      clearTimeout(startupTimer)
      clearInterval(interval)
    },
  }
}

module.exports = { createUpdates }
