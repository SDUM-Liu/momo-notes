const fs = require('node:fs')
const path = require('node:path')

const chunkSize = 1024 * 1024
const overhead = 12 + 16
const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/

function validId(id) {
  if (typeof id !== 'string' || !uuid.test(id)) throw new Error('无效的附件标识')
  return id
}

function metadata(value) {
  const id = validId(value?.id)
  const { size, mime } = value
  if (!Number.isSafeInteger(size) || size < 0 || !Number.isSafeInteger(size + Math.ceil(size / chunkSize) * overhead)) {
    throw new Error('无效的附件大小')
  }
  if (typeof mime !== 'string' || mime.length > 200 || !/^(image|audio|video)\/[a-z0-9.+_-]+(?:;[a-z0-9 ._,=";+:-]+)?$/i.test(mime)) {
    throw new Error('无效的媒体类型')
  }
  return { id, size, mime }
}

function chunkLength(meta, index) {
  if (!Number.isSafeInteger(index) || index < 0 || index >= Math.ceil(meta.size / chunkSize)) throw new Error('附件分块位置无效')
  return Math.min(chunkSize, meta.size - index * chunkSize)
}

function sameMeta(a, b) {
  return a.id === b.id && a.size === b.size && a.mime === b.mime
}

// Each packed file contains consecutive, independently authenticated ciphertext blocks.
// Non-secret sidecar fields permit locked backups; file names live in the encrypted book only.
function diskMedia(directory) {
  const root = path.resolve(directory, 'private-media-v1')
  const location = (id, pending = false) => path.join(root, (pending ? '.incoming-' : '') + validId(id))
  const file = dir => path.join(dir, 'chunks.bin')
  const clean = dir => fs.rmSync(dir, { recursive: true, force: true })
  const entries = () => fs.existsSync(root) ? fs.readdirSync(root, { withFileTypes: true }) : []
  const ids = () => entries().filter(e => e.isDirectory() && uuid.test(e.name)).map(e => e.name)

  function readMeta(id, pending = false) {
    const value = metadata(JSON.parse(fs.readFileSync(path.join(location(id, pending), 'meta.json'), 'utf8')))
    if (value.id !== id) throw new Error('附件索引不匹配')
    return value
  }
  function begin(value) {
    const meta = metadata(value)
    fs.mkdirSync(root, { recursive: true, mode: 0o700 })
    if (fs.existsSync(location(meta.id))) throw new Error('附件标识已被使用')
    const bytesNeeded = BigInt(meta.size + Math.ceil(meta.size / chunkSize) * overhead)
    try {
      const { bavail, bsize } = fs.statfsSync(root, { bigint: true })
      if (bavail * bsize < bytesNeeded) throw new Error('磁盘空间不足，请清理空间后重试')
    } catch (error) {
      if (!['ENOSYS', 'ENOTSUP'].includes(error.code)) throw error
    }
    const pending = location(meta.id, true)
    fs.mkdirSync(pending, { mode: 0o700 })
    try {
      fs.writeFileSync(path.join(pending, 'meta.json'), JSON.stringify(meta), { mode: 0o600 })
      fs.writeFileSync(file(pending), '', { flag: 'wx', mode: 0o600 })
    } catch (error) { clean(pending); throw error }
  }
  function readRaw(id, index) {
    const meta = readMeta(id)
    const bytes = Buffer.allocUnsafe(chunkLength(meta, index) + overhead)
    const fd = fs.openSync(file(location(id)), 'r')
    try {
      let done = 0
      while (done < bytes.length) {
        const read = fs.readSync(fd, bytes, done, bytes.length - done, index * (chunkSize + overhead) + done)
        if (!read) throw new Error('附件数据不完整')
        done += read
      }
    } finally { fs.closeSync(fd) }
    return bytes
  }
  function writeRaw(value, index, bytes) {
    const meta = metadata(value)
    const length = chunkLength(meta, index) + overhead
    if (!(bytes instanceof Uint8Array) || bytes.byteLength !== length) throw new Error('附件分块长度有误')
    if (fs.existsSync(location(meta.id))) {
      if (sameMeta(readMeta(meta.id), meta) && readRaw(meta.id, index).equals(bytes)) return
      throw new Error('附件已存在且内容不同')
    }
    const dir = location(meta.id, true)
    if (!fs.existsSync(dir)) {
      if (index !== 0) throw new Error('请从第一个附件分块开始传输')
      begin(meta)
    }
    if (!sameMeta(readMeta(meta.id, true), meta)) throw new Error('附件分块元数据有误')
    const offset = index * (chunkSize + overhead)
    const fd = fs.openSync(file(dir), 'r+')
    try {
      const size = fs.fstatSync(fd).size
      if (size < offset) throw new Error('附件分块顺序有误')
      if (size >= offset + length) {
        const stored = Buffer.allocUnsafe(length)
        if (fs.readSync(fd, stored, 0, length, offset) === length && stored.equals(bytes)) return
        throw new Error('已写入的附件分块不匹配')
      }
      let written = 0
      while (written < length) {
        const n = fs.writeSync(fd, bytes, written, length - written, offset + written)
        if (!n) throw new Error('无法写入附件分块')
        written += n
      }
    } finally { fs.closeSync(fd) }
  }
  function finishRaw(value) {
    const meta = metadata(value)
    const finalDir = location(meta.id)
    if (fs.existsSync(finalDir)) {
      if (!sameMeta(readMeta(meta.id), meta)) throw new Error('附件标识已被使用')
      return
    }
    const dir = location(meta.id, true)
    if (!meta.size && !fs.existsSync(dir)) begin(meta)
    if (!sameMeta(readMeta(meta.id, true), meta) || fs.statSync(file(dir)).size !== meta.size + overhead * Math.ceil(meta.size / chunkSize)) {
      throw new Error('附件尚未完整写入')
    }
    fs.renameSync(dir, finalDir)
  }
  return {
    list: () => ids().map(id => readMeta(id)), readRaw, writeRaw, finishRaw, begin, readMeta,
    abort: id => clean(location(id, true)),
    remove: id => clean(location(id)),
    clear: () => clean(root),
    recover(keep) {
      for (const e of entries()) {
        if (e.isDirectory() && e.name.startsWith('.incoming-') && uuid.test(e.name.slice(10))) clean(location(e.name.slice(10), true))
      }
      for (const id of ids()) if (!keep.has(id)) clean(location(id))
    },
  }
}

module.exports = { diskMedia, metadata, validId, chunkSize, chunkLength }
