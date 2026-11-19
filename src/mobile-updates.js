import { CapacitorHttp } from '@capacitor/core'
import { InAppBrowser } from '@capacitor/inappbrowser'
import { releasePage, releasesApi } from '../shared/installers.mjs'

const version = __APP_VERSION__
const components = version.split('.').map(Number)

function newerThanInstalled(next) {
  const parts = next.split('.').map(Number)
  const difference = parts.findIndex((part, index) => part !== components[index])
  return difference !== -1 && parts[difference] > components[difference]
}

export function mobileUpdates(native) {
  let state = { version, status: native ? 'idle' : 'unavailable' }
  let onUpdate = () => {}

  function show(status, target) {
    state = { version, status, target }
    onUpdate(state)
  }

  return {
    get state() { return state },
    onUpdate(callback) { onUpdate = callback },
    async checkUpdate() {
      if (!['idle', 'current', 'check-error'].includes(state.status)) return
      show('checking')
      try {
        const response = await CapacitorHttp.get({
          url: releasesApi + '/latest', headers: { Accept: 'application/vnd.github+json' },
          connectTimeout: 15000, readTimeout: 18000,
        })
        if (response.status !== 200) throw new Error('更新检查失败')
        const release = typeof response.data === 'string' ? JSON.parse(response.data) : response.data
        const match = /^v(\d+\.\d+\.\d+)$/.exec(release?.tag_name)
        if (!match || release.draft || release.prerelease) throw new Error('版本信息无效')
        if (newerThanInstalled(match[1])) show('available', match[1])
        else show('current')
      } catch { show('check-error') }
    },
    async openUpdate() {
      if (state.status === 'available') {
        await InAppBrowser.openInExternalBrowser({ url: releasePage + '/tag/v' + state.target })
      }
    },
  }
}
