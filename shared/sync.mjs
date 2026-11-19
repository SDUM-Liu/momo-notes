import { gcm } from '@noble/ciphers/aes.js'

export const syncPort = 38425
export const wireLimit = 32 * 1024 * 1024
const encoder = new TextEncoder()
const decoder = new TextDecoder()
const hex = bytes => Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
function fromHex(value) {
  return Uint8Array.from(value.match(/../g), byte => Number.parseInt(byte, 16))
}

export function validHost(host) {
  return typeof host === 'string' && /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)
    && host.split('.').every(part => +part <= 255 && String(+part) === part)
}

export function tailscaleAddress(host) {
  const [first, second] = String(host).split('.').map(Number)
  return first === 100 && second >= 64 && second <= 127
}

export function pairingCode(host, key) {
  return 'momo1:' + host + ':' + key
}

export function parsePairing(value) {
  const parts = /^momo1:([^:]+):([a-f0-9]{64})$/.exec(String(value).trim())
  if (!parts || !validHost(parts[1])) throw new Error('请复制完整的主机配对码')
  return { host: parts[1], port: syncPort, key: parts[2] }
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
