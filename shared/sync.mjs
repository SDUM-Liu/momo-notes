import { gcm } from '@noble/ciphers/aes.js'
import { sha256 } from '@noble/hashes/sha2.js'

export const wireLimit = 32 * 1024 * 1024
const encoder = new TextEncoder()
const decoder = new TextDecoder()
const hex = bytes => Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
function fromHex(value) {
  return Uint8Array.from(value.match(/../g), byte => Number.parseInt(byte, 16))
}

export const relayProtocol = 'momo-sync-v1'
export const roomPattern = /^[a-f0-9]{64}$/

export function relayOrigin(value) {
  const url = new URL(String(value ?? '').trim())
  const loopback = ['localhost', '127.0.0.1'].includes(url.hostname)
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))
      || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('请输入有效的 HTTPS 同步服务地址')
  return url.origin
}

export const digest = value => hex(sha256(encoder.encode(value)))
export const transferId = () => hex(crypto.getRandomValues(new Uint8Array(16)))

export function joinToken(key) {
  return digest('momo-sync-v2/join/' + key)
}

export function pairingCode(relay, room, key) {
  return 'momo2:' + btoa(JSON.stringify([relay, room, key])).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

export function parsePairing(value) {
  const code = String(value).trim()
  if (code.startsWith('momo1:')) throw new Error('这是旧版配对码，请在新版主机重新生成二维码')
  if (code.length <= 480 && /^momo2:[\w-]+$/.test(code)) {
    try {
      const [relay, room, key] = JSON.parse(atob(code.slice(6).replaceAll('-', '+').replaceAll('_', '/')))
      if (roomPattern.test(room) && roomPattern.test(key)) return { relay: relayOrigin(relay), room, key }
    } catch {}
  }
  throw new Error('请复制完整的主机配对码')
}

function b64(bytes) {
  let out = ''
  for (let offset = 0; offset < bytes.length; offset += 8192) out += String.fromCharCode(...bytes.subarray(offset, offset + 8192))
  return btoa(out)
}

export function seal(key, context, data) {
  const nonce = crypto.getRandomValues(new Uint8Array(12))
  const cipher = gcm(fromHex(key), nonce, encoder.encode('momo-sync-v1/' + context))
  const body = cipher.encrypt(encoder.encode(JSON.stringify(data)))
  return hex(nonce) + '.' + b64(body)
}

export function unseal(key, context, wire) {
  if (typeof wire !== 'string' || wire.length > wireLimit || !/^[a-f0-9]{24}\./.test(wire)) throw new Error('同步数据无效')
  const cipher = gcm(fromHex(key), fromHex(wire.slice(0, 24)), encoder.encode('momo-sync-v1/' + context))
  return JSON.parse(decoder.decode(cipher.decrypt(Uint8Array.from(atob(wire.slice(25)), char => char.charCodeAt(0)))))
}
