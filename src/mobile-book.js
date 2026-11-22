import { bytes, base64, keyFor, box, openBox } from './mobile-sealed.js'
import { enrollmentInfo, enrollmentLifetime, verify } from '../shared/authenticator.mjs'
import { sessionMedia } from './mobile-media.js'
const purpose = 'momo/private-book/v1'
export function mobileBook(read, write, primary, getMedia) {
  let session, enrollment, nextAttempt = 0, revision = 0, timer
  let attachments, closing = Promise.resolve()
  function lock() {
    ++revision; session = undefined; clearTimeout(timer)
    if (attachments) {
      const cleanup = attachments.close()
      const finished = Promise.all([closing, cleanup]).then(() => {})
      // The next unlock performs recovery if a busy filesystem rejected this cleanup.
      closing = finished.catch(() => {})
      attachments = undefined
      return finished
    }
    return closing
  }
  function touch() { clearTimeout(timer); timer = setTimeout(() => { void lock().catch(() => {}) }, 300000) }
  function guard(version) {
    if (version !== revision || !primary()) throw new Error('私密便签已锁定')
  }
  async function save(s, value, version) {
    const sealed = await box(s.key, s.salt, value, purpose)
    guard(version)
    await write(sealed)
    guard(version)
  }
  let queue = Promise.resolve()
  async function operation(op, args = {}) {
    if (!primary()) throw new Error('请在主设备打开私密便签')
    if (op === 'begin') {
      await lock()
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
      if (session) await lock()
      const version = revision, stored = await read()
      await closing
      let s
      if (stored) s = await openBox(args.password, stored, purpose)
      else {
        if (!enrollment || Date.now() >= enrollment.expires) throw new Error('绑定二维码已过期，请关闭后重开并扫描新二维码')
        const salt = crypto.getRandomValues(new Uint8Array(16))
        s = { salt, key: await keyFor(args.password, salt), value: { secret: base64(enrollment.seed), last: -1, entries: [] } }
      }
      s.value.last = verify(bytes(s.value.secret), args.code, s.value.last)
      const store = getMedia?.()
      const files = () => s.value.entries?.[0]?.files?.filter(file => file.storage === 'chunks-v1') || []
      guard(version)
      if (store) await store.recover(new Set(files().map(file => file.id)))
      await save(s, s.value, version)
      enrollment?.seed.fill(0); enrollment = undefined; session = s
      if (store) attachments = sessionMedia(store, s.key, () => guard(version), touch, files)
      touch(); return s.value.entries
    }
    if (op !== 'save' || !session || !Array.isArray(args.entries)) throw new Error('请重新验证')
    const s = session, value = { ...s.value, entries: args.entries }; await save(s, value, revision); s.value = value
    if (session === s) touch()
  }
  return (op, args) => {
    if (op === 'background') { if (session || !enrollment) return lock(); ++revision; return Promise.resolve() }
    if (op === 'lock') return lock()
    if (op.startsWith('media')) {
      if (!attachments || !primary()) return Promise.reject(new Error('请在主设备重新验证'))
      return attachments.run(op, args || {})
    }
    const version = revision
    const next = queue.then(() => { guard(version); return operation(op,args) }); queue = next.catch(() => {}); return next
  }
}
