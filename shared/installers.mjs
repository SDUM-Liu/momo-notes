export const releasePage = 'https://github.com/SDUM-Liu/momo-notes/releases'
export const releasesApi = 'https://api.github.com/repos/SDUM-Liu/momo-notes/releases'
const tagPattern = /^v\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/
const platformFiles = [
  ['win32-x64', 'Windows · x64', /^-Setup-x64\.exe$/],
  ['win32-arm64', 'Windows · ARM64', /^-Setup-arm64\.exe$/],
  ['darwin-arm64', 'macOS · Apple 芯片', /^-mac-arm64\.dmg$/],
  ['darwin-x64', 'macOS · Intel', /^-mac-x64\.dmg$/],
  ['linux-x64', 'Linux · x64', /^-linux-(?:x86_64|x64)\.AppImage$/],
  ['linux-arm64', 'Linux · ARM64', /^-linux-(?:aarch64|arm64)\.AppImage$/],
  ['android', 'Android · APK', /^-Android(?:-debug)?\.apk$/],
  ['ios', 'iOS · 模拟器', /^-iOS-Simulator\.zip$/],
]

function assetFor(release, asset) {
  const version = release.tag_name.slice(1)
  const prefix = 'Momo-Notes-' + version
  if (!Number.isSafeInteger(asset.id) || asset.id <= 0 || !Number.isSafeInteger(asset.size) || asset.size <= 0
      || asset.state !== 'uploaded' || typeof asset.name !== 'string' || !asset.name.startsWith(prefix)) return
  const [platform] = platformFiles.find(([, , pattern]) => pattern.test(asset.name.slice(prefix.length))) ?? []
  const url = releasePage + '/download/' + release.tag_name + '/' + asset.name
  if (!platform || asset.browser_download_url !== url) return
  return {
    id: asset.id, name: asset.name, size: asset.size, platform, url,
    sha256: /^sha256:[a-f0-9]{64}$/i.test(asset.digest ?? '') ? asset.digest.slice(7).toLowerCase() : null,
  }
}

export function releaseCatalog(releases, latest, preferredPlatform) {
  const ordered = releases.filter(item => item?.draft === false && tagPattern.test(item.tag_name))
    .sort((a, b) => Date.parse(b.published_at) - Date.parse(a.published_at))
  const versions = ordered.map(release => ({
    tag: release.tag_name, prerelease: release.prerelease === true,
    assets: (release.assets ?? []).map(item => assetFor(release, item)).filter(Boolean),
  })).filter(release => release.assets.length)
  latest = versions.some(version => version.tag === latest && !version.prerelease)
    ? latest : versions.find(version => !version.prerelease)?.tag
  const available = new Set(versions.flatMap(version => version.assets.map(asset => asset.platform)))
  const targets = platformFiles.filter(([id]) => available.has(id)).map(([id, label]) => ({ id, label }))
  return { versions, latest, targets, preferredPlatform: available.has(preferredPlatform) ? preferredPlatform : '' }
}

export function installerCatalog(get, preferredPlatform) {
  let cached, loading
  return async function load() {
    if (cached && cached.expires > Date.now()) return cached.data
    if (!loading) {
      loading = (async () => {
        const latestRequest = get(releasesApi + '/latest').catch(() => null)
        const releases = []
        for (let page = 1; ; page++) {
          const items = await get(releasesApi + '?per_page=100&page=' + page)
          if (!Array.isArray(items)) throw new Error('GitHub 未返回有效的版本列表')
          releases.push(...items)
          if (items.length < 100) break
        }
        const data = releaseCatalog(releases, (await latestRequest)?.tag_name, preferredPlatform)
        cached = { data, expires: Date.now() + 5 * 60 * 1000 }
        return data
      })().finally(() => { loading = null })
    }
    return loading
  }
}

export function findInstaller(catalog, id) {
  const asset = catalog.versions.flatMap(version => version.assets).find(item => item.id === id)
  if (!asset) throw new Error('此安装包已不可用，请重新打开版本列表')
  return asset
}
