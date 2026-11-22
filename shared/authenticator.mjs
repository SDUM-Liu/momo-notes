import { hmac } from '@noble/hashes/hmac.js'
import { sha1 } from '@noble/hashes/legacy.js'

const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
export const enrollmentLifetime = 15 * 60 * 1000
export function enrollmentInfo(seed, label, expires) {
  let bits = 0, value = 0, secret = ''
  for (const byte of seed) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) { bits -= 5; secret += alphabet[(value >>> bits) & 31] }
  }
  if (bits) secret += alphabet[(value << (5 - bits)) & 31]
  return { label, expires, uri: 'otpauth://totp/Momo:' + encodeURIComponent(label) +
    '?secret=' + secret + '&issuer=Momo&algorithm=SHA1&digits=6&period=30' }
}
export function totp(seed, counter) {
  const buf = new Uint8Array(8)
  new DataView(buf.buffer).setBigUint64(0, BigInt(counter))
  const hash = hmac(sha1, seed, buf)
  const number = new DataView(hash.buffer, hash.byteOffset).getUint32(hash[19] & 15) & 0x7fffffff
  return String(number % 1000000).padStart(6, '0')
}
export function verify(seed, input, last, time = Date.now()) {
  const code = String(input ?? '').normalize('NFKC').replace(/\s/g,'')
  if (!/^\d{6}$/.test(code)) throw new Error('请输入身份验证器显示的六位数字')
  const now = Math.floor(time / 30000)
  const matches = [now, now - 1, now + 1].filter(n => n >= 0 && totp(seed,n) === code)
  const fresh = matches.find(n => n > last)
  if (fresh !== undefined) return fresh
  if (matches.length) {
    if (last > now + 1) throw new Error('设备时间早于上次解锁，请检查自动设置时间')
    throw new Error('这一组验证码已经使用，请等待身份验证器显示下一组')
  }
  for (let delta = 2; delta <= 10; delta++) {
    if ([now - delta, now + delta].some(n => n >= 0 && totp(seed,n) === code))
      throw new Error('验证码与本机时间不一致，请在主设备和身份验证器手机上开启自动设置时间，再输入新码')
  }
  throw new Error(last < 0 ? '验证码与本次绑定不匹配，请核对二维码下方的条目编号并输入当前六位码' :
    '验证码不匹配，请核对已绑定的身份验证器条目和两台设备的时间')
}
