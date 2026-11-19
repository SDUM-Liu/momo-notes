import { Capacitor, CapacitorHttp, registerPlugin } from '@capacitor/core'
import { InAppBrowser } from '@capacitor/inappbrowser'
import { findInstaller, installerCatalog } from '../shared/installers.mjs'

const systemDownloads = registerPlugin('MomoDownloads')

export function mobileInstallers(native, platform) {
  const android = platform === 'android' && Capacitor.isPluginAvailable('MomoDownloads')
  const capabilities = () => android ? systemDownloads.capabilities() : Promise.resolve({ managed: false })
  let progress = () => {}
  let downloading = false
  const load = installerCatalog(async url => {
    const response = await CapacitorHttp.get({
      url, headers: { Accept: 'application/vnd.github+json' }, connectTimeout: 15000, readTimeout: 18000,
    })
    if (response.status < 200 || response.status >= 300) throw new Error('无法读取 GitHub 版本列表，请检查网络后重试')
    return typeof response.data === 'string' ? JSON.parse(response.data) : response.data
  }, platform)

  async function reveal() {
    return android && (await systemDownloads.openDirectory()).opened
  }

  async function transfer(asset) {
    for (const retryName of [false, true]) {
      const file = await systemDownloads.start({ url: asset.url, name: asset.name, retryName })
      for (;;) {
        const result = await systemDownloads.status({ id: file.id })
        if (result.status === 'exists' && !retryName) break
        if (result.status === 'done' && result.bytes === asset.size) {
          return { name: file.name, opened: await reveal().catch(() => false) }
        }
        if (result.status !== 'waiting') throw new Error('安装包下载失败或大小不符，请重试')
        progress(result.progress)
        await new Promise(resolve => setTimeout(resolve, 750))
      }
    }
  }

  return {
    async installerCatalog() {
      const [catalog, { managed }] = await Promise.all([load(), capabilities()])
      return { ...catalog, managed, directory: managed ? '系统下载目录' : '' }
    },
    async downloadInstaller(id) {
      if (downloading) throw new Error('已有安装包正在下载')
      downloading = true
      try {
        const asset = findInstaller(await load(), id)
        if ((await capabilities()).managed) return await transfer(asset)
        if (native) await InAppBrowser.openInExternalBrowser({ url: asset.url })
        else window.open(asset.url, '_blank', 'noopener,noreferrer')
        return { external: true }
      } finally { downloading = false }
    },
    openInstallerDirectory: reveal,
    onInstallerProgress(callback) { progress = callback },
  }
}
