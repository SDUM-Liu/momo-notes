import { load } from 'js-yaml'
import { releaseCatalog, releasePage, releasesApi } from './installers.mjs'

export const updateBlockSize = 512 * 1024
const maxSize = 512 * 1024 * 1024
const versionPattern = /^\d{1,3}\.\d{1,3}\.\d{1,3}$/
const channels = {
  win: { platform: 'win32-x64', manifest: 'latest.yml' },
  linux: { platform: 'linux-x64', manifest: 'latest-linux.yml' },
  android: { platform: 'android' },
}

export function verifyUpdate(channel, value) {
  if (!Object.hasOwn(channels, channel) || !value || !versionPattern.test(value.version)
      || !Number.isSafeInteger(value.size) || value.size <= 0 || value.size > maxSize
      || !/^[a-f0-9]{64}$/.test(value.sha256)) throw new Error('主设备返回的更新资料无效')
  const prefix = 'Momo-Notes-' + value.version
  const names = {
    win: [prefix + '-Setup-x64.exe'],
    linux: [prefix + '-linux-x86_64.AppImage'],
    android: [prefix + '-Android.apk'],
  }
  if (!names[channel].includes(value.name) || (channel !== 'android' && !/^[A-Za-z0-9+/]{86}==$/.test(value.sha512))) {
    throw new Error('主设备返回的安装包资料无效')
  }
  return value
}

function decodeText(response) {
  if (response.status !== 200 || typeof response.data !== 'string' || response.data.length > 1024 * 1024) {
    throw new Error('主设备无法读取正式版本，请检查主设备代理网络')
  }
  return response.data
}

export function createUpdateSource(get) {
  const snapshots = new Map()
  const reading = new Map()
  let requests = 0

  async function metadata(channel, requestedVersion) {
    if (!Object.hasOwn(channels, channel)) throw new Error('更新平台无效')
    const cacheKey = requestedVersion ? channel + '/' + requestedVersion : channel
    const known = snapshots.get(cacheKey)
    if (known && Date.now() - known.checkedAt < 60000) return known
    if (reading.has(cacheKey)) return reading.get(cacheKey)
    const operation = (async () => {
      const url = releasesApi + (requestedVersion ? '/tags/v' + requestedVersion : '/latest')
      const info = JSON.parse(decodeText(await get(url)))
      const version = String(info.tag_name || '').slice(1)
      const route = channels[channel]
      const asset = releaseCatalog([info], info.tag_name, route.platform).versions[0]?.assets
        .find(file => file.platform === route.platform && !file.name.endsWith('-debug.apk'))
      if (!asset || info.prerelease || info.draft || !versionPattern.test(version)) throw new Error('正式版本缺少此平台安装包')
      const { name, size, sha256, url: assetUrl } = asset
      if (requestedVersion && requestedVersion !== version) throw new Error('更新版本与请求不一致')
      let sha512
      if (route.manifest) {
        const text = decodeText(await get(releasePage + '/download/v' + version + '/' + route.manifest))
        const details = load(text)
        if (details?.version !== version) throw new Error('正式版更新清单与版本不一致')
        sha512 = details.files?.find(file => file.url === name)?.sha512
      }
      const value = verifyUpdate(channel, { version, name, size, sha256, sha512 })
      const snapshot = { value, url: assetUrl, checkedAt: Date.now() }
      snapshots.set(cacheKey, snapshot)
      snapshots.set(channel + '/' + version, snapshot)
      while (snapshots.size > 12) snapshots.delete(snapshots.keys().next().value)
      return snapshot
    })().finally(() => reading.delete(cacheKey))
    reading.set(cacheKey, operation)
    return operation
  }

  return async (op, { channel, version, offset } = {}) => {
    if (op === 'info') return (await metadata(channel)).value
    if (op !== 'block') throw new Error('未知的更新请求')
    if (typeof version !== 'string' || !versionPattern.test(version)) throw new Error('更新版本无效')
    const snapshot = snapshots.get(channel + '/' + version) ?? await metadata(channel, version)
    const item = snapshot?.value
    if (!item || item.version !== version) throw new Error('请重新检查主设备上的最新版本')
    if (!Number.isSafeInteger(offset) || offset < 0 || offset >= item.size || offset % updateBlockSize) {
      throw new Error('安装包分段位置无效')
    }
    if (requests >= 8) throw new Error('主设备正在转发其他更新，请稍后重试')
    ++requests
    try {
      const end = Math.min(offset + updateBlockSize, item.size) - 1
      const response = await get(snapshot.url, 'bytes=' + offset + '-' + end)
      const size = end + 1 - offset
      const data = typeof response.data === 'string' ? response.data.replace(/\s/g, '') : ''
      if (response.status !== 206 || response.range !== 'bytes ' + offset + '-' + end + '/' + item.size
          || data.length !== 4 * Math.ceil(size / 3) || atob(data).length !== size) {
        throw new Error('主设备未能读取完整的安装包分段，请检查代理网络')
      }
      return data
    } finally { --requests }
  }
}

export async function* receiveUpdateBlocks(request, channel, item, start = 0) {
  if (!Number.isSafeInteger(start) || start < 0 || start > item.size ||
      (start !== item.size && start % updateBlockSize)) throw new Error('安装包续传位置无效')
  for (let offset = start; offset < item.size;) {
    const batch = []
    for (let index = 0; index < 3 && offset < item.size; index++, offset += updateBlockSize) {
      const position = offset
      batch.push(Promise.resolve().then(() => request('block', { channel, version: item.version, offset: position }))
        .then(data => ({ data }), error => ({ error })))
    }
    for (const result of batch) {
      const { data, error } = await result
      if (error) throw error
      yield data
    }
  }
}
