const { app, net, shell } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const { createHash } = require('node:crypto')
const { Readable, Transform } = require('node:stream')
const { pipeline } = require('node:stream/promises')
const { findInstaller, installerCatalog } = require('../shared/installers.mjs')

async function storeFile(source, folder, name) {
  const { name: base, ext } = path.parse(name)
  for (let attempt = 0; ; attempt++) {
    const destination = path.join(folder, attempt ? base + ' (' + attempt + ')' + ext : name)
    try {
      await fs.promises.copyFile(source, destination, fs.constants.COPYFILE_EXCL)
      return destination
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
    }
  }
}

function createInstallerDownloads(onProgress) {
  const arch = process.platform === 'darwin' && app.runningUnderARM64Translation ? 'arm64' : process.arch
  const load = installerCatalog(async url => {
    const response = await net.fetch(url, {
      headers: { Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(18000),
    })
    if (!response.ok) throw new Error(response.status === 403 || response.status === 429
      ? 'GitHub 暂时限制了版本查询，请稍后重试' : '无法读取 GitHub 版本列表，请检查网络')
    return response.json()
  }, process.platform + '-' + arch)
  const downloadsDirectory = () => app.getPath('downloads')
  let controller

  async function reveal(folder) {
    try { return (await shell.openPath(folder)) === '' } catch { return false }
  }

  async function download(id) {
    if (controller) throw new Error('已有安装包正在下载')
    const target = new AbortController()
    controller = target
    let staging, temporary
    try {
      const asset = findInstaller(await load(), id)
      const folder = downloadsDirectory()
      await fs.promises.mkdir(folder, { recursive: true })
      staging = await fs.promises.mkdtemp(path.join(folder, '.momo-install-'))
      temporary = path.join(staging, 'download')
      const signal = AbortSignal.any([target.signal, AbortSignal.timeout(30 * 60 * 1000)])
      const response = await net.fetch(asset.url, { signal })
      if (!response.ok || !response.body) throw new Error('无法下载此安装包，请检查网络后重试')
      const hash = createHash('sha256')
      let bytes = 0, previous = -1
      const meter = new Transform({
        transform(chunk, _encoding, done) {
          bytes += chunk.length
          if (bytes > asset.size) return done(new Error('安装包大小与发布记录不符，请刷新版本列表'))
          hash.update(chunk)
          const percent = Math.floor(bytes * 100 / asset.size)
          if (percent !== previous) { previous = percent; onProgress(percent) }
          done(null, chunk)
        },
      })
      await pipeline(Readable.fromWeb(response.body), meter, fs.createWriteStream(temporary, { flags: 'wx' }), { signal })
      if (bytes !== asset.size || (asset.sha256 && hash.digest('hex') !== asset.sha256)) {
        throw new Error('安装包校验失败，请重新下载')
      }
      if (process.platform === 'linux' && asset.platform.startsWith('linux-')) {
        await fs.promises.chmod(temporary, 0o755)
      }
      if (process.platform === 'win32') {
        await fs.promises.writeFile(temporary + ':Zone.Identifier', '[ZoneTransfer]\r\nZoneId=3\r\nHostUrl=' + asset.url + '\r\n')
          .catch(() => {}) // Downloads can be on a drive without NTFS streams.
      }
      const destination = await storeFile(temporary, folder, asset.name)
      return { name: path.basename(destination), opened: await reveal(folder) }
    } finally {
      if (temporary) await fs.promises.unlink(temporary).catch(() => {})
      if (staging) await fs.promises.rmdir(staging).catch(() => {})
      controller = undefined
    }
  }

  return {
    async catalog() { return { ...await load(), directory: downloadsDirectory() } },
    download,
    reveal: () => reveal(downloadsDirectory()),
    stop() { controller?.abort() },
  }
}

module.exports = { createInstallerDownloads }
