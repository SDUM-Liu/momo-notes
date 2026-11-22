const { randomBytes, scryptSync, createCipheriv, createDecipheriv } = require('node:crypto')

function derive(password, salt) {
  if (typeof password !== 'string' || password.length < 12 || password.length > 512)
    throw new Error('请输入 12 至 512 个字符的口令')
  return scryptSync(password, salt, 32, { N: 65536, r: 8, p: 1, maxmem: 96 * 1024 * 1024 })
}
function encrypt(key, salt, value, purpose) {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(Buffer.from(purpose))
  const data = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()])
  return { v: 1, salt: salt.toString('base64'), iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') }
}
function decrypt(password, box, purpose) {
  const salt = Buffer.from(box.salt, 'base64')
  if (box.v !== 1 || salt.length !== 16) throw new Error('文件格式有误')
  const key = derive(password, salt)
  try {
    const cipher = createDecipheriv('aes-256-gcm', key, Buffer.from(box.iv, 'base64'), { authTagLength: 16 })
    cipher.setAAD(Buffer.from(purpose))
    cipher.setAuthTag(Buffer.from(box.tag, 'base64'))
    const clear = Buffer.concat([cipher.update(Buffer.from(box.data, 'base64')), cipher.final()])
    try { return { key, salt, value: JSON.parse(clear.toString('utf8')) } } finally { clear.fill(0) }
  } catch {
    key.fill(0)
    throw new Error('口令错误或文件已损坏')
  }
}
module.exports = { derive, encrypt, decrypt }
