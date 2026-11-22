const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { derive, encrypt, decrypt } = require('./sealed.cjs')
const { privateMedia } = require('./private-media.cjs')
const purpose = 'momo/private-book/v1'
const { enrollmentInfo, enrollmentLifetime, totp, verify } = require('../shared/authenticator.mjs')
const token = (secret, counter) => totp(Buffer.from(secret, 'base64'), counter)
function privateBook(directory) {
  const file = path.join(directory, 'private-book.enc')
  let session, enrollment, timer, nextAttempt = 0
  const media = privateMedia(directory, () => session)
  function lock() {
    media.lock()
    clearTimeout(timer)
    session?.key.fill(0)
    session = undefined
  }
  function touch() { clearTimeout(timer); timer = setTimeout(lock, 5 * 60 * 1000); timer.unref() }
  function persist(s) {
    const box = encrypt(s.key, s.salt, s.value, purpose)
    fs.writeFileSync(file + '.tmp', JSON.stringify(box), { mode: 0o600 })
    fs.renameSync(file + '.tmp', file)
  }
  return { lock, mediaResponse: media.respond,
    get configured() { return fs.existsSync(file) },
    get unlocked() { return Boolean(session) },
    keepAlive() { if (session) touch() },
    call(op, args = {}) {
    if (op === 'lock') { lock(); return }
    if (op === 'begin') {
      lock()
      if (fs.existsSync(file)) return {}
      if (!enrollment || Date.now() >= enrollment.expires) {
        enrollment = { seed: crypto.randomBytes(20), label: 'Private-' + crypto.randomBytes(4).toString('hex').toUpperCase(),
          expires: Date.now() + enrollmentLifetime }
      }
      return enrollmentInfo(enrollment.seed, enrollment.label, enrollment.expires)
    }
    if (op === 'unlock') {
      if (Date.now() < nextAttempt) throw new Error('请稍后再试')
      nextAttempt = Date.now() + 1500
      let s
      if (fs.existsSync(file)) s = decrypt(args.password, JSON.parse(fs.readFileSync(file)), purpose)
      else {
        if (!enrollment || Date.now() >= enrollment.expires) throw new Error('绑定二维码已过期，请关闭后重开并扫描新二维码')
        const salt = crypto.randomBytes(16)
        s = { salt, key: derive(args.password, salt), value: { secret: enrollment.seed.toString('base64'), last: -1, entries: [] } }
      }
      try {
        s.value.last = verify(Buffer.from(s.value.secret, 'base64'), args.code, s.value.last)
        media.recover(s.value.entries)
        persist(s)
      } catch (error) { s.key.fill(0); throw error }
      lock(); enrollment?.seed.fill(0); enrollment = undefined; session = s; touch()
      return s.value.entries
    }
    if (!session) throw new Error('已锁定，请重新验证')
    if (op.startsWith('media')) {
      const result = media.call(op, args, session)
      if (op !== 'mediaRelease') touch()
      return result
    }
    if (op === 'save') {
      if (!Array.isArray(args.entries)) throw new Error('私密便签格式无效')
      const value = { ...session.value, entries: args.entries }
      persist({ ...session, value })
      session.value = value
      touch()
      return
    }
    throw new Error('无效的操作')
  } }
}
module.exports = { privateBook, token }
