import { Capacitor, CapacitorHttp, registerPlugin } from '@capacitor/core'
import { releaseCatalog, releasesApi } from '../shared/installers.mjs'
import { receiveUpdateBlocks, verifyUpdate } from '../shared/update-transfer.mjs'

const version = __APP_VERSION__
const components = version.split('.').map(Number)
const updater = registerPlugin('MomoUpdates')

function newerThanInstalled(next) {
  const parts = next.split('.').map(Number)
  const difference = parts.findIndex((part, index) => part !== components[index])
  return difference !== -1 && parts[difference] > components[difference]
}

export function mobileUpdates(native, prepareInstaller, hostRequest = () => null) {
  const android = native && Capacitor.getPlatform() === 'android' && Capacitor.isPluginAvailable('MomoUpdates')
  let state = { version, status: native ? 'idle' : 'unavailable' }
  let onUpdate = () => {}
  let asset, initialization, generation = 0, listeningDirect = false

  function show(value) {
    state = { ...value, version, viaHost: value.viaHost ?? state.viaHost ?? Boolean(hostRequest()) }
    onUpdate(state)
  }

  function init() {
    if (!android) return Promise.resolve()
    initialization ??= (async () => {
      const cached = await updater.pending()
      if (cached.target && state.status === 'idle') show(cached)
      else if (cached.partial && state.status === 'idle') {
        asset = verifyUpdate('android', cached.partial)
        show({ status: 'download-error', target: asset.version, progress: cached.progress, error: '上次下载进度已保留，可以继续下载。' })
      }
      await updater.addListener('updateState', value => {
        if (listeningDirect || value.status !== 'downloading') show(value)
      })
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
    if (state.status === 'downloading') return
    const current = asset
    const target = current.version
    const before = generation
    const relay = hostRequest()
    show({ status: 'downloading', target, viaHost: Boolean(relay) })
    try {
      await init()
      if (generation !== before) return
      const metadata = { version: target, size: current.size, sha256: current.sha256 }
      let complete = false
      if (relay) {
        let started = false
        try {
          const cached = await updater.beginRelay(metadata)
          started = true
          if (cached?.status) show(cached)
          for await (const data of receiveUpdateBlocks(relay, 'android', current, cached?.offset ?? 0)) {
            if (generation !== before) throw new Error('已切换更新来源')
            show(await updater.appendRelay({ data }))
          }
          await updater.finishRelay()
          complete = true
        } catch (error) {
          if (started) await updater.cancelRelay().catch(() => {})
          if (generation !== before) return
        }
      }
      if (!complete) {
        show({ ...state, viaHost: false })
        listeningDirect = true
        try { await updater.download(metadata) } finally { listeningDirect = false }
      }
    } catch (error) {
      if (generation === before) {
        const saved = await updater.pending().catch(() => null)
        if (generation === before) show({ status: 'download-error', target, progress: saved?.progress,
          error: saved?.partial ? '更新下载中断，进度已保留。恢复网络后可继续下载。'
            : relay ? '主设备和手机直连暂时都无法下载安装包，请稍后重试。' : error.message })
      }
      return
    }
    if (generation === before) await installUpdate()
  }

  async function checkUpdate() {
    await init()
    if (!['idle', 'current', 'check-error', 'distribution-unavailable', 'download-error'].includes(state.status)) return
    if (state.status === 'download-error' && asset) return downloadUpdate()
    const before = generation
    const relay = hostRequest()
    show({ status: 'checking', viaHost: Boolean(relay) })
    let target
    try {
      if (relay) {
        try {
          const item = verifyUpdate('android', await relay('info', { channel: 'android' }))
          if (generation !== before) return
          target = item.version
          if (!newerThanInstalled(target)) { show({ status: 'current' }); return }
          if (!android) { show({ status: 'distribution-unavailable', target }); return }
          asset = item
          show({ status: 'checking', target })
          await downloadUpdate()
          return
        } catch {
          if (generation !== before) return
        }
      }
      const response = await CapacitorHttp.get({
        url: releasesApi + '/latest', headers: { Accept: 'application/vnd.github+json' },
        connectTimeout: 15000, readTimeout: 18000,
      })
      if (generation !== before) return
      if (response.status !== 200) throw new Error('更新检查失败')
      const release = typeof response.data === 'string' ? JSON.parse(response.data) : response.data
      const match = /^v(\d+\.\d+\.\d+)$/.exec(release?.tag_name)
      if (!match || release.draft || release.prerelease) throw new Error('版本信息无效')
      target = match[1]
      if (!newerThanInstalled(target)) { show({ status: 'current' }); return }
      if (!android) { show({ status: 'distribution-unavailable', target }); return }
      const item = releaseCatalog([release], release.tag_name, 'android').versions[0]?.assets
        .find(file => file.name === 'Momo-Notes-' + target + '-Android.apk')
      if (!item?.sha256 || item.size > 256 * 1024 * 1024) {
        show({ status: 'check-error', error: '新版暂无可验证的安卓安装包' })
        return
      }
      asset = { ...item, version: target }
    } catch (error) {
      if (generation === before) show({ status: 'check-error', error: relay
        ? '主设备和手机直连暂时都无法检查 GitHub 更新，请稍后重试。' : error.message })
      return
    }
    show({ status: 'checking', target })
    await downloadUpdate()
  }

  return {
    get state() { return { ...state, viaHost: state.viaHost ?? Boolean(hostRequest()) } },
    routeChanged() {
      ++generation
      listeningDirect = false
      const target = asset?.version
      const viaHost = Boolean(hostRequest())
      show(target ? { status: 'download-error', target, viaHost, error: '更新来源已切换，可以继续下载。' }
        : { status: native ? 'idle' : 'unavailable', viaHost })
    },
    onUpdate(callback) { onUpdate = callback; void init() },
    checkUpdate, downloadUpdate, installUpdate,
  }
}
