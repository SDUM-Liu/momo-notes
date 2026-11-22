import { digest, parsePairing, pairingCode, seal, unseal, transferId } from '../shared/sync.mjs'
import { keyFor, box, openBox, mac } from './mobile-sealed.js'

const purpose = 'momo/migration/v1'
const chunkSize = 256 * 1024
export function mobileHandoff({ get, put, secure, pair, snapshot, stage, activate, demote, current }) {
  const enc = new TextEncoder()
  const signature = async (key, room) => [...await mac(enc.encode(key),enc.encode('momo-handoff/' + room),'SHA-256')].map(n => n.toString(16).padStart(2,'0')).join('')
  let buffer, incoming, nextIndex = 0
  async function target() {
    const rx = await secure.get('handoff-receive')
    if (!rx || (rx.done && Date.now() - rx.done > 86400000)) return null
    return { ...rx.link, code: pairingCode(rx.link.relay,rx.link.room,rx.link.key) }
  }
  async function receive(wire) {
    const rx = await secure.get('handoff-receive')
    if (!rx) return null
    const { key, room } = rx.link
    const r = unseal(key,'handoff',wire)
    if (!/^[a-f0-9]{32}$/.test(r.id)) return null
    let result
    try {
      if (rx.done) result = { done: true, checksum: rx.sum }
      else {
        const old = parsePairing(await pair())
        if (rx.bound !== digest(old.key)) throw new Error('配对已变化')
        if (r.op === 'hello') result = { proof: await signature(old.key,room) }
        else if (r.op === 'chunk') {
          if (typeof r.chunk !== 'string' || r.chunk.length > chunkSize || !Number.isInteger(r.index) || r.index < 0 || r.index >= 2048) throw new Error('数据块无效')
          if (!r.index) { nextIndex = 0; incoming = r.checksum }
          if (nextIndex !== r.index || incoming !== r.checksum) throw new Error('请重新传输')
          await put('transfer-part/' + r.index, r.chunk); nextIndex++; result = true
        } else if (r.op === 'stage') {
          const chunks = []
          for (let i=0;i<nextIndex;i++) chunks.push(await get('transfer-part/' + i))
          const packed = chunks.join('')
          if (digest(packed) !== r.checksum) throw new Error('迁移文件校验失败')
          const { value } = await openBox(key,JSON.parse(packed),purpose)
          if (value.sync?.key !== old.key || !value.sync.enabled) throw new Error('来源主机有误')
          const staged = await stage(value.data, value.sync)
          rx.staged = staged; rx.sum = r.checksum; await secure.set('handoff-receive',rx)
          for (let i=0;i<nextIndex;i++) await put('transfer-part/' + i,null)
          result = { staged: rx.sum }
        } else if (r.op === 'activate' && rx.sum && rx.sum === r.checksum) {
          await activate(rx.staged)
          rx.done = Date.now(); await secure.set('handoff-receive',rx)
          result = { done: true, checksum: rx.sum }
        } else throw new Error('迁移状态有误')
      }
      return seal(key,'handoff/' + r.id,{ value:result })
    } catch(e) { return seal(key,'handoff/' + r.id,{ error:e.message }) }
  }
  return async function handle(op,...args) {
    if (op === 'target') return target()
    if (op === 'ready') {
      const old = parsePairing(await pair()), existing = await secure.get('handoff-receive')
      if (!existing || existing.done || existing.bound !== digest(old.key)) {
        const owner = transferId()+transferId()
        await secure.set('handoff-receive',{ bound:digest(old.key), link:{ relay:old.relay, owner, room:digest(owner), key:transferId()+transferId() } })
      }
      return target()
    }
    if (op === 'receive') return receive(args[0])
    if (op === 'pending') return secure.get('handoff-send')
    if (op === 'prepare') {
      const [code,challenge] = args, dest = parsePairing(code), original = current()
      if (await signature(original.config.key,dest.room) !== challenge) throw new Error('目标未绑定本机')
      const data = await snapshot(), salt = crypto.getRandomValues(new Uint8Array(16))
      const key = await keyFor(dest.key,salt)
      const packed = JSON.stringify(await box(key,salt,{data,sync:original.config},purpose))
      if (packed.length > 512*1024*1024) throw new Error('迁移包超过 512 MB')
      buffer = { code, packed, pair:original.pair, checksum:digest(packed), fingerprint:digest(JSON.stringify(data)) }
      return { checksum:buffer.checksum, count:Math.ceil(packed.length/chunkSize) }
    }
    if (op === 'chunk') return buffer.packed.slice(args[0]*chunkSize,(args[0]+1)*chunkSize)
    if (op === 'cutover') {
      if (buffer?.code !== args[0] || buffer.checksum !== args[1] || buffer.pair !== current().pair ||
          buffer.fingerprint !== digest(JSON.stringify(await snapshot()))) throw new Error('数据已变化，请重新传输')
      await secure.set('handoff-send',{ code:buffer.code, checksum:buffer.checksum, pair:buffer.pair })
      await demote(buffer.pair); buffer = undefined; return
    }
    if (op === 'finish') {
      const p = await secure.get('handoff-send')
      if (p?.checksum !== args[0]) throw new Error('接管状态有误')
      await secure.set('handoff-send',null); setTimeout(() => location.reload(),1000)
    }
  }
}
