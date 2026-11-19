import { Capacitor, CapacitorHttp, registerPlugin } from '@capacitor/core'
import { releaseCatalog, releasesApi } from '../shared/installers.mjs'

const version = __APP_VERSION__
const components = version.split('.').map(Number)
const updater = registerPlugin('MomoUpdates')

function newerThanInstalled(next) {
  const parts = next.split('.').map(Number)
  const difference = parts.findIndex((part, index) => part !== components[index])
  return difference !== -1 && parts[difference] > components[difference]
}

export function mobileUpdates(native, prepareInstaller) {
  const android = native && Capacitor.getPlatform() === 'android' && Capacitor.isPluginAvailable('MomoUpdates')
  let state = { version, status: native ? 'idle' : 'unavailable' }
  let onUpdate = () => {}
  let asset, initialization

  function show(value) {
    state = { ...value, version }
    onUpdate(state)
  }

  function init() {
    if (!android) return Promise.resolve()
    initialization ??= (async () => {
      const cached = await updater.pending()
      if (cached.target && state.status === 'idle') show(cached)
      await updater.addListener('updateState', show)
    })().catch(() => { initialization = undefined })
    return initialization
  }

  async function installUpdate() {
    const target = state.target
    show({ status: 'installing', target })
    try {
      await prepareInstaller()
      show(await updater.open())
    } catch (error) {
      const cached = await updater.pending().catch(() => null)
      show({ status: cached?.target ? 'install-error' : asset ? 'download-error' : 'check-error',
        target, error: error.message })
    }
  }

  async function downloadUpdate() {
    if (!asset) return checkUpdate()
    const target = state.target
    show({ status: 'downloading', target })
    try {
      await init()
      await updater.download({ version: target, size: asset.size, sha256: asset.sha256 })
    } catch (error) {
      show({ status: 'download-error', target, error: error.message })
      return
    }
    await installUpdate()
  }

  async function checkUpdate() {
    if (!['idle', 'current', 'check-error', 'distribution-unavailable', 'download-error'].includes(state.status)) return
    show({ status: 'checking' })
    let target
    try {
      const response = await CapacitorHttp.get({
        url: releasesApi + '/latest', headers: { Accept: 'application/vnd.github+json' },
        connectTimeout: 15000, readTimeout: 18000,
      })
      if (response.status !== 200) throw new Error('更新检查失败')
      const release = typeof response.data === 'string' ? JSON.parse(response.data) : response.data
      const match = /^v(\d+\.\d+\.\d+)$/.exec(release?.tag_name)
      if (!match || release.draft || release.prerelease) throw new Error('版本信息无效')
      target = match[1]
      if (!newerThanInstalled(target)) { show({ status: 'current' }); return }
      if (!android) { show({ status: 'distribution-unavailable', target }); return }
      asset = releaseCatalog([release], release.tag_name, 'android').versions[0]?.assets
        .find(file => file.name === 'Momo-Notes-' + target + '-Android.apk')
      if (!asset?.sha256 || asset.size > 256 * 1024 * 1024) {
        show({ status: 'check-error', error: '新版暂无可验证的安卓安装包' })
        return
      }
    } catch {
      show({ status: 'check-error' })
      return
    }
    show({ status: 'checking', target })
    await downloadUpdate()
  }

  return {
    get state() { return state },
    onUpdate(callback) { onUpdate = callback; void init() },
    checkUpdate, downloadUpdate, installUpdate,
  }
}
