import { scryptAsync } from '@noble/hashes/scrypt.js'
const encoder = new TextEncoder()
export const bytes = value => Uint8Array.from(atob(value), c => c.charCodeAt(0))
export function base64(data) {
  let text = ''
  for (let i = 0; i < data.length; i += 8192) text += String.fromCharCode(...data.subarray(i, i + 8192))
  return btoa(text)
}
export async function keyFor(password, salt) {
  if (typeof password !== 'string' || password.length < 12 || password.length > 512) throw new Error('请输入 12 至 512 个字符的口令')
  const raw = await scryptAsync(encoder.encode(password), salt, { N: 65536, r: 8, p: 1, dkLen: 32 })
  try { return await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt','decrypt']) } finally { raw.fill(0) }
}
export async function box(key, salt, value, purpose) {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: encoder.encode(purpose) }, key, encoder.encode(JSON.stringify(value))))
  return { v: 1, salt: base64(salt), iv: base64(iv), tag: base64(cipher.subarray(-16)), data: base64(cipher.subarray(0,-16)) }
}
export async function openBox(password, sealed, purpose) {
  if (sealed.v !== 1) throw new Error('文件格式无效')
  const salt = bytes(sealed.salt), key = await keyFor(password, salt)
  const ciphertext = bytes(sealed.data), tag = bytes(sealed.tag)
  if (tag.length !== 16 || salt.length !== 16) throw new Error('文件格式无效')
  const input = new Uint8Array(ciphertext.length + 16); input.set(ciphertext); input.set(tag, ciphertext.length)
  try {
    const clear = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes(sealed.iv), additionalData: encoder.encode(purpose) }, key, input))
    try { return { value: JSON.parse(new TextDecoder().decode(clear)), key, salt } } finally { clear.fill(0) }
  } catch { throw new Error('口令错误或文件损坏') }
}
export async function mac(key, data, hash) {
  const imported = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash }, false, ['sign'])
  return new Uint8Array(await crypto.subtle.sign('HMAC', imported, data))
}
