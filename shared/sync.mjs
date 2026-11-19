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
export const maxPairingLength = 768

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

export function pairingCode(relay, room, key, fallback, backupRoom) {
  const version = fallback ? 'momo3:' : 'momo2:'
  const data = fallback ? [[relay, fallback], room, key, backupRoom] : [relay, room, key]
  return version + btoa(JSON.stringify(data)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

export function parsePairing(value) {
  const code = String(value).trim()
  if (code.startsWith('momo1:')) throw new Error('这是旧版配对码，请在新版主机重新生成二维码')
  if (code.length <= maxPairingLength && /^momo[23]:[\w-]+$/.test(code)) {
    try {
      const [routes, room, key, backupRoom] = JSON.parse(atob(code.slice(6).replaceAll('-', '+').replaceAll('_', '/')))
      if (typeof room !== 'string' || typeof key !== 'string' || !roomPattern.test(room) || !roomPattern.test(key)) throw new Error()
      if (code.startsWith('momo2:') && typeof routes === 'string') return { relay: relayOrigin(routes), room, key }
      if (code.startsWith('momo3:') && Array.isArray(routes) && routes.length === 2 && routes.every(url => typeof url === 'string')) {
        const [relay, fallback] = routes.map(relayOrigin)
        if (relay !== fallback && typeof backupRoom === 'string' && roomPattern.test(backupRoom) && backupRoom !== room) {
          return { relay, fallback, room, backupRoom, key }
        }
      }
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
