import { bytes, base64, keyFor, box, openBox, mac } from './mobile-sealed.js'
const purpose = 'momo/private-book/v1'
export function mobileBook(read, write, primary) {
  let session, seed, nextAttempt = 0, revision = 0, timer
  function lock() { ++revision; session = seed = undefined; clearTimeout(timer) }
  function touch() { clearTimeout(timer); timer = setTimeout(lock, 300000) }
  const save = (s, value) => box(s.key, s.salt, value, purpose).then(write)
  let queue = Promise.resolve()
  async function operation(op, args = {}) {
    if (!primary()) throw new Error('请在主设备打开私密便签')
    if (op === 'begin') {
      lock()
      if (await read()) return {}
      seed = crypto.getRandomValues(new Uint8Array(20)); touch()
      const bits = [...seed].map(n => n.toString(2).padStart(8,'0')).join('')
      const secret = bits.match(/.{5}/g).map(v => 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'[parseInt(v,2)]).join('')
      return { uri: 'otpauth://totp/Momo:Private?issuer=Momo&digits=6&period=30&secret=' + secret }
    }
    if (op === 'unlock') {
      if (Date.now() < nextAttempt) throw new Error('请稍后再试')
      nextAttempt = Date.now() + 1500
      const version = revision, stored = await read()
      let s
      if (stored) s = await openBox(args.password, stored, purpose)
      else {
        if (!seed) throw new Error('请重新扫码绑定')
        const salt = crypto.getRandomValues(new Uint8Array(16))
        s = { salt, key: await keyFor(args.password, salt), value: { secret: base64(seed), last: -1, entries: [] } }
      }
      const now = Math.floor(Date.now()/30000)
      for (const n of [now, now-1, now+1]) {
        if (n <= s.value.last) continue
        const input = new Uint8Array(8); new DataView(input.buffer).setBigUint64(0, BigInt(n))
        const h = await mac(bytes(s.value.secret), input, 'SHA-1')
        const numeric = (new DataView(h.buffer).getUint32(h[19] & 15) & 0x7fffffff) % 1000000
        if (String(numeric).padStart(6,'0') !== args.code) continue
        if (version !== revision || !primary()) throw new Error('已锁定')
        s.value.last = n; await save(s, s.value)
        if (version !== revision || !primary()) throw new Error('已锁定')
        session = s; seed = undefined; touch(); return s.value.entries
      }
      throw new Error('验证码无效或已经使用')
    }
    if (op !== 'save' || !session || !Array.isArray(args.entries)) throw new Error('请重新验证')
    if (new Blob([JSON.stringify(args.entries)]).size > 128 * 1024 * 1024) throw new Error('超过 128 MB 上限')
    const s = session, value = { ...s.value, entries: args.entries }; await save(s, value); s.value = value
    if (session === s) touch()
  }
  return (op, args) => {
    if (op === 'background') { if (session || !seed) lock(); else ++revision; return Promise.resolve() }
    if (op === 'lock') { lock(); return Promise.resolve() }
    const next = queue.then(() => operation(op,args)); queue = next.catch(() => {}); return next
  }
}
