import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'

export const blockSize = 1024 * 1024
const envelopeBytes = 28
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const hexDigest = /^[a-f0-9]{64}$/
export function blockCount(file) { return Math.ceil(file.size / blockSize) }
export function rawLength(file, index) {
  return Math.min(blockSize, file.size - index * blockSize) + envelopeBytes
}
function checkCatalog(files, requireDigest) {
  if (!Array.isArray(files)) throw new Error('附件清单格式无效')
  const ids = new Set()
  for (const file of files) {
    if (!file || typeof file.id !== 'string' || !uuid.test(file.id) || ids.has(file.id) ||
        !Number.isSafeInteger(file.size) || file.size < 0 || typeof file.mime !== 'string' ||
        (file.mime.length > 200 || !/^(image|audio|video)\/[a-z0-9.+_-]+(?:;[a-z0-9 ._,=";+:-]+)?$/i.test(file.mime)) || (requireDigest && !hexDigest.test(file.digest))) {
      throw new Error('附件清单有误')
    }
    ids.add(file.id)
  }
}
export async function mediaCatalog(store) {
  const files = await store.list()
  checkCatalog(files, false)
  const catalog = []
  for (const { id, size, mime } of files) {
    const file = { id, size, mime }
    const hash = sha256.create()
    for (let index = 0; index < blockCount(file); index++) {
      const bytes = await store.readRaw(id, index)
      if (bytes.byteLength !== rawLength(file, index)) throw new Error('附件不完整')
      hash.update(bytes)
    }
    catalog.push({ ...file, digest: bytesToHex(hash.digest()) })
  }
  return catalog
}

// The destination stays inactive until every block of every file matches the encrypted manifest.
export function mediaReceiver(catalog, destination) {
  checkCatalog(catalog, true)
  let fileIndex = 0, next = 0, hash = sha256.create()
  async function finishFile() {
    const file = catalog[fileIndex]
    if (bytesToHex(hash.digest()) !== file.digest) throw new Error('附件内容校验失败，请重新传输')
    await destination.finishRaw(file)
    fileIndex++; next = 0; hash = sha256.create()
  }
  async function skipEmpty() {
    while (catalog[fileIndex]?.size === 0) await finishFile()
  }
  return {
    async write(id, index, bytes) {
      await skipEmpty()
      const file = catalog[fileIndex]
      if (!file || file.id !== id || index !== next || bytes.byteLength !== rawLength(file, index)) throw new Error('附件分块顺序或大小有误')
      await destination.writeRaw(file, index, bytes)
      hash.update(bytes)
      if (++next === blockCount(file)) await finishFile()
    },
    async finish() {
      await skipEmpty()
      if (fileIndex !== catalog.length) throw new Error('附件传输尚未完成')
    },
  }
}

export function base64Block(bytes) {
  let text = ''
  for (let i = 0; i < bytes.length; i += 8192) text += String.fromCharCode(...bytes.subarray(i, i + 8192))
  return btoa(text)
}
export function decodeBlock(text) {
  if (typeof text !== 'string' || text.length > Math.ceil((blockSize + envelopeBytes) / 3) * 4) throw new Error('附件数据块无效')
  return Uint8Array.from(atob(text), c => c.charCodeAt(0))
}
export async function outgoingBlock(store, catalog, fileIndex, index) {
  const file = catalog?.[fileIndex]
  if (!Number.isSafeInteger(fileIndex) || !file || !Number.isSafeInteger(index) || index < 0 || index >= blockCount(file)) throw new Error('附件索引无效')
  return base64Block(await store.readRaw(file.id, index))
}

const encoder = new TextEncoder()
const decoder = new TextDecoder()
const magic = encoder.encode('MOMOBK2\n')
export async function* backupBytes(data, source, encrypt) {
  const media = await mediaCatalog(source)
  if (!media.length) { yield encoder.encode(await encrypt(data)); return }
  const header = encoder.encode(await encrypt({ ...data, media }))
  const length = new Uint8Array(4)
  new DataView(length.buffer).setUint32(0, header.length)
  yield magic; yield length; yield header
  for (const file of media) {
    const hash = sha256.create()
    for (let i = 0; i < blockCount(file); i++) {
      const raw = await source.readRaw(file.id, i)
      hash.update(raw)
      yield raw
    }
    if (bytesToHex(hash.digest()) !== file.digest) throw new Error('导出期间附件发生变化，请重试')
  }
}

export async function restoreBackup(size, read, decrypt, stage, mediaFor, discard) {
  async function exact(offset, count) {
    if (offset + count > size) throw new Error('迁移包不完整')
    const bytes = await read(offset, count)
    if (bytes.length !== count) throw new Error('迁移包不完整')
    return bytes
  }
  const signature = await exact(0, magic.length)
  const v2 = magic.every((byte, i) => signature[i] === byte)
  let offset = 0, headerSize = size
  if (v2) {
    const bytes = await exact(magic.length, 4)
    headerSize = new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0)
    offset = magic.length + 4
  }
  // This bound applies only to the old single JSON envelope / text metadata.
  if (headerSize > 512 * 1024 * 1024) throw new Error('迁移包的便签索引过大')
  const data = await decrypt(decoder.decode(await exact(offset, headerSize)))
  offset += headerSize
  const catalog = data.media ?? []
  checkCatalog(catalog, true)
  for (const file of catalog) {
    if (file.size > size || !Number.isSafeInteger(file.size + blockCount(file) * envelopeBytes)) throw new Error('迁移包附件长度无效')
  }
  if (catalog.reduce((sum, file) => sum + file.size + blockCount(file) * envelopeBytes, offset) !== size) throw new Error('迁移包长度不符')
  const staged = await stage(data)
  try {
    const sink = mediaReceiver(catalog, mediaFor(staged))
    for (const file of catalog) {
      for (let i = 0; i < blockCount(file); i++) {
        const bytes = await exact(offset, rawLength(file, i))
        await sink.write(file.id, i, bytes)
        offset += bytes.length
      }
    }
    await sink.finish()
    return staged
  } catch (error) {
    await discard(staged)
    throw error
  }
}
