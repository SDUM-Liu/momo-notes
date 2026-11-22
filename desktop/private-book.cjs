const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { derive, encrypt, decrypt } = require('./sealed.cjs')
const purpose = 'momo/private-book/v1'
const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

function base32(bytes) {
  let bits = 0, value = 0, result = ''
  for (const byte of bytes) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) { bits -= 5; result += alphabet[(value >>> bits) & 31] }
  }
  if (bits) result += alphabet[(value << (5 - bits)) & 31]
  return result
}
function token(secret, counter) {
  const buf = Buffer.alloc(8)
  buf.writeBigUInt64BE(BigInt(counter))
  const h = crypto.createHmac('sha1', Buffer.from(secret, 'base64')).update(buf).digest()
  return String((h.readUInt32BE(h[19] & 15) & 0x7fffffff) % 1000000).padStart(6, '0')
}
function privateBook(directory) {
  const file = path.join(directory, 'private-book.enc')
  let session, enrollment, timer, nextAttempt = 0
  function lock() {
    clearTimeout(timer)
    session?.key.fill(0)
    session = enrollment = undefined
  }
  function touch() { clearTimeout(timer); timer = setTimeout(lock, 5 * 60 * 1000); timer.unref() }
  function persist(s) {
    const box = encrypt(s.key, s.salt, s.value, purpose)
    fs.writeFileSync(file + '.tmp', JSON.stringify(box), { mode: 0o600 })
    fs.renameSync(file + '.tmp', file)
  }
  return { lock, get unlocked() { return Boolean(session) }, call(op, args = {}) {
    if (op === 'lock') { lock(); return }
    if (op === 'begin') {
      lock()
      if (fs.existsSync(file)) return {}
      enrollment = crypto.randomBytes(20)
      touch()
      return { uri: 'otpauth://totp/Momo:Private?issuer=Momo&digits=6&period=30&secret=' + base32(enrollment) }
    }
    if (op === 'unlock') {
      if (Date.now() < nextAttempt) throw new Error('请稍后再试')
      nextAttempt = Date.now() + 1500
      let s
      if (fs.existsSync(file)) s = decrypt(args.password, JSON.parse(fs.readFileSync(file)), purpose)
      else {
        if (!enrollment) throw new Error('请重新扫码绑定')
        const salt = crypto.randomBytes(16)
        s = { salt, key: derive(args.password, salt), value: { secret: enrollment.toString('base64'), last: -1, entries: [] } }
      }
      try {
        const now = Math.floor(Date.now() / 30000)
        const accepted = [now, now - 1, now + 1].find(n => n > s.value.last && token(s.value.secret, n) === args.code)
        if (accepted === undefined) throw new Error('验证码无效或已经使用，请等待下一组')
        s.value.last = accepted
        persist(s)
      } catch (error) { s.key.fill(0); throw error }
      lock(); session = s; touch()
      return s.value.entries
    }
    if (!session) throw new Error('已锁定，请重新验证')
    if (op === 'save') {
      if (!Array.isArray(args.entries) || Buffer.byteLength(JSON.stringify(args.entries)) > 128 * 1024 * 1024) throw new Error('私密便签超出 128 MB 上限')
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
