const { app } = require('electron')

function createUpdates(onChange) {
  const supported = app.isPackaged && process.platform === 'win32'
  let state = { status: supported ? 'idle' : 'unavailable', version: app.getVersion() }
  const updater = supported ? require('electron-updater').autoUpdater : null
  let startupTimer, interval

  function show(status, details = {}) {
    state = { version: state.version, target: state.target, status, ...details }
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
    show('checking')
    try {
      const result = await updater.checkForUpdates()
      if (result?.isUpdateAvailable) show('available', { target: result.updateInfo.version })
      else show('current')
    } catch (error) {
      console.error('Update check failed:', error.message)
      show('check-error')
    }
  }

  async function download() {
    if (!['available', 'download-error'].includes(state.status)) return
    show('downloading')
    try {
      await updater.downloadUpdate()
      show('ready')
    } catch (error) {
      console.error('Update download failed:', error.message)
      show('download-error')
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
    check,
    download,
    install,
    schedule() {
      if (!supported) return
      startupTimer = setTimeout(check, 5000)
      interval = setInterval(check, 6 * 60 * 60 * 1000)
    },
    stop() {
      clearTimeout(startupTimer)
      clearInterval(interval)
    },
  }
}

module.exports = { createUpdates }
