import { bytes, base64, keyFor, box, openBox } from './mobile-sealed.js'
import { enrollmentInfo, enrollmentLifetime, verify } from '../shared/authenticator.mjs'
const purpose = 'momo/private-book/v1'
export function mobileBook(read, write, primary) {
  let session, enrollment, nextAttempt = 0, revision = 0, timer
  function lock() { ++revision; session = undefined; clearTimeout(timer) }
  function touch() { clearTimeout(timer); timer = setTimeout(lock, 300000) }
  const save = (s, value) => box(s.key, s.salt, value, purpose).then(write)
  let queue = Promise.resolve()
  async function operation(op, args = {}) {
    if (!primary()) throw new Error('请在主设备打开私密便签')
    if (op === 'begin') {
      lock()
      if (await read()) return {}
      if (!enrollment || Date.now() >= enrollment.expires) {
        enrollment = { seed: crypto.getRandomValues(new Uint8Array(20)), label: 'Private-' + crypto.randomUUID().slice(0,8).toUpperCase(),
          expires: Date.now() + enrollmentLifetime }
      }
      return enrollmentInfo(enrollment.seed, enrollment.label, enrollment.expires)
    }
    if (op === 'unlock') {
      if (Date.now() < nextAttempt) throw new Error('请稍后再试')
      nextAttempt = Date.now() + 1500
      const version = revision, stored = await read()
      let s
      if (stored) s = await openBox(args.password, stored, purpose)
      else {
        if (!enrollment || Date.now() >= enrollment.expires) throw new Error('绑定二维码已过期，请关闭后重开并扫描新二维码')
        const salt = crypto.getRandomValues(new Uint8Array(16))
        s = { salt, key: await keyFor(args.password, salt), value: { secret: base64(enrollment.seed), last: -1, entries: [] } }
      }
      s.value.last = verify(bytes(s.value.secret), args.code, s.value.last)
      if (version !== revision || !primary()) throw new Error('已锁定')
      await save(s, s.value)
      if (version !== revision || !primary()) throw new Error('已锁定')
      enrollment?.seed.fill(0); enrollment = undefined; session = s; touch(); return s.value.entries
    }
    if (op !== 'save' || !session || !Array.isArray(args.entries)) throw new Error('请重新验证')
    if (new Blob([JSON.stringify(args.entries)]).size > 128 * 1024 * 1024) throw new Error('超过 128 MB 上限')
    const s = session, value = { ...s.value, entries: args.entries }; await save(s, value); s.value = value
    if (session === s) touch()
  }
  return (op, args) => {
    if (op === 'background') { if (session || !enrollment) lock(); else ++revision; return Promise.resolve() }
    if (op === 'lock') { lock(); return Promise.resolve() }
    const next = queue.then(() => operation(op,args)); queue = next.catch(() => {}); return next
  }
}
