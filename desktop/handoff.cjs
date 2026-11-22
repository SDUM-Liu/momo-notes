const fs = require('node:fs')
const path = require('node:path')
const { randomBytes, createHash, createHmac } = require('node:crypto')
const { seal, unseal, parsePairing, pairingCode, digest } = require('../shared/sync.mjs')
const migration = require('./migration.cjs')
const { diskMedia } = require('./disk-media.cjs')
const { mediaCatalog, mediaReceiver, outgoingBlock, decodeBlock } = require('../shared/media-transfer.mjs')
const hex = () => randomBytes(32).toString('hex')
const hash = s => createHash('sha256').update(s).digest('hex')
const proof = (key, room) => createHmac('sha256', key).update('momo-handoff/' + room).digest('hex')
const chunkSize = 256 * 1024
function handoff({ root, directory, sync, follower, snapshot, credentials, restart, check }) {
  const receiving = path.join(root, 'handoff-receive.json'), outgoing = path.join(root, 'handoff-send.json')
  const read = f => fs.existsSync(f) ? JSON.parse(fs.readFileSync(f)) : null
  function write(f, data) { fs.writeFileSync(f + '.tmp', JSON.stringify(data), { mode: 0o600 }); fs.renameSync(f + '.tmp', f) }
  let rx = read(receiving), tx = read(outgoing), buffer, incomingMedia
  const sourceMedia = diskMedia(directory)
  if (rx?.staged && migration.activePath(root) === path.join(root, rx.staged) && !rx.done) {
    rx.done = true; rx.completed = Date.now(); write(receiving, rx)
  }
  if (rx?.done && Date.now() - (rx.completed || 0) > 86400000) rx = null
  function demote() {
    if (sync.owns(parsePairing(tx.pair).key)) sync.retire()
    if (follower.code !== tx.pair) follower.setPair(tx.pair)
  }
  if (tx && tx.directory === directory) demote()
  function target() {
    if (!rx) return null
    return { ...rx.link, code: pairingCode(rx.link.relay, rx.link.room, rx.link.key) }
  }
  function ready() {
    const pair = parsePairing(follower.code)
    if (rx && rx.bound === hash(pair.key) && !rx.done) return target()
    const owner = hex()
    rx = { link: { relay: pair.relay, room: digest(owner), key: hex(), owner }, bound: hash(pair.key) }
    write(receiving, rx)
    return target()
  }
  async function receive(wire) {
    if (!rx) return null
    const { key, room } = rx.link
    const req = unseal(key, 'handoff', wire)
    if (!/^[a-f0-9]{32}$/.test(req.id)) return null
    let result
    try {
      if (rx.done) result = { done: true, checksum: rx.checksum }
      else {
        const pair = parsePairing(follower.code)
        if (rx.bound !== hash(pair.key)) throw new Error('接收设备的配对已变化')
        if (req.op === 'hello') result = { proof: proof(pair.key, room), staged: rx.checksum, mediaVersion: 1 }
        else if (req.op === 'chunk') {
          if (!/^[a-f0-9]{64}$/.test(req.checksum) || !Number.isSafeInteger(req.index) || req.index < 0 || req.index >= 2048 ||
              typeof req.chunk !== 'string' || req.chunk.length > chunkSize || !req.chunk.length) throw new Error('无效的数据分块')
          const file = path.join(root, 'handoff-part.enc')
          if (req.index === 0) {
            if (rx.building) {
              migration.discard(root, rx.building)
              delete rx.building; incomingMedia = undefined
            }
            delete rx.staged; delete rx.checksum; write(receiving, rx)
            fs.writeFileSync(file, '', { mode: 0o600 }); rx.next = 0; rx.incoming = req.checksum }
          if (rx.incoming !== req.checksum || req.index !== rx.next) throw new Error('分块顺序有误，请重新传输')
          fs.appendFileSync(file, req.chunk); rx.next++; result = true
        } else if (req.op === 'stage') {
          const file = path.join(root, 'handoff-part.enc'), box = fs.readFileSync(file, 'utf8')
          if (hash(box) !== req.checksum) throw new Error('迁移数据校验失败')
          const payload = migration.unpack(box, key)
          if (payload.sync?.key !== pair.key || !payload.sync.enabled) throw new Error('只有当前主设备的数据可接管')
          const id = migration.stage(root, payload.data, credentials)
          write(path.join(root, id, 'sync.json'), payload.sync)
          fs.unlinkSync(file)
          if (payload.media?.length) {
            rx.building = id; write(receiving, rx)
            incomingMedia = mediaReceiver(payload.media, diskMedia(path.join(root, id)))
            result = { waitingForMedia: true }
          } else {
            rx.staged = id; rx.checksum = req.checksum; write(receiving, rx)
            result = { staged: rx.checksum }
          }
        } else if (req.op === 'mediaChunk' && incomingMedia && req.checksum === rx.incoming) {
          await incomingMedia.write(req.fileId, req.index, decodeBlock(req.bytes))
          result = true
        } else if (req.op === 'mediaFinish' && incomingMedia && req.checksum === rx.incoming) {
          await incomingMedia.finish()
          rx.staged = rx.building; delete rx.building
          rx.checksum = req.checksum; write(receiving, rx); incomingMedia = undefined
          result = { staged: rx.checksum }
        } else if (req.op === 'activate') {
          if (!rx.staged || rx.checksum !== req.checksum) throw new Error('接收设备尚未校验数据')
          migration.activate(root, rx.staged); rx.done = true; rx.completed = Date.now(); write(receiving, rx)
          restart(); result = { done: true, checksum: rx.checksum }
        } else throw new Error('未知迁移操作')
      }
      return seal(key, 'handoff/' + req.id, { value: result })
    } catch (e) { return seal(key, 'handoff/' + req.id, { error: e.message }) }
  }
  async function prepare(code, challenge, mediaVersion) {
    check()
    const dest = parsePairing(code)
    const current = sync.link()
    if (!current || follower.store || proof(current.key, dest.room) !== challenge) throw new Error('目标设备尚未绑定本主机')
    const data = snapshot(), config = read(path.join(directory, 'sync.json'))
    if (sourceMedia.list().length && mediaVersion !== 1) throw new Error('请先将接收设备升级至支持大附件的版本')
    const media = await mediaCatalog(sourceMedia)
    const packed = migration.pack({ data, sync: config, media }, dest.key)
    if (packed.length > 512 * 1024 * 1024) throw new Error('迁移数据超过 512 MB')
    buffer = { code, media, fingerprint: hash(JSON.stringify(data)), checksum: hash(packed), packed, pair: sync.code() }
    return { media, checksum: buffer.checksum, count: Math.ceil(packed.length / chunkSize) }
  }
  function cutover(code, checksum) {
    check()
    if (buffer?.code !== code || buffer.checksum !== checksum || buffer.pair !== sync.code() ||
        hash(JSON.stringify(snapshot())) !== buffer.fingerprint) throw new Error('传输期间资料发生变化，请重试')
    tx = { directory, code, pair: buffer.pair, checksum }
    write(outgoing, tx); buffer = undefined; demote()
  }
  return { target, ready, prepare, receive, cutover,
    chunk(i) { if (!buffer || !Number.isSafeInteger(i) || i < 0) throw new Error('请重新传输'); return buffer.packed.slice(i * chunkSize, (i + 1) * chunkSize) },
    mediaChunk(fileIndex, index) { return outgoingBlock(sourceMedia, buffer?.media, fileIndex, index) },
    pending() { return tx?.directory === directory ? { code: tx.code, checksum: tx.checksum } : null },
    finish(sum) {
      if (!tx || tx.directory !== directory || !tx.checksum || tx.checksum !== sum) throw new Error('迁移状态不符')
      sourceMedia.clear()
      fs.rmSync(path.join(directory, 'private-book.enc'), { force: true })
      fs.unlinkSync(outgoing); tx = undefined; restart() },
  }
}
module.exports = { handoff }
