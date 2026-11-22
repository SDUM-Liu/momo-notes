const fs = require('node:fs')
const path = require('node:path')
const { randomBytes, randomUUID } = require('node:crypto')
const { derive, encrypt, decrypt } = require('./sealed.cjs')
const { openStore } = require('./data.cjs')
const { noteIdentity, builtInCategories, defaultSettings } = require('../shared/notes.mjs')
const purpose = 'momo/migration/v1'
const marker = 'primary-profile.json'
function activePath(root) {
  const filename = path.join(root, marker)
  if (!fs.existsSync(filename)) return root
  const { id } = JSON.parse(fs.readFileSync(filename))
  if (!/^profile-[a-f0-9-]{36}$/.test(id)) throw new Error('设备资料路径无效')
  return path.join(root, id)
}
function snapshot(directory, store, credentials) {
  const { key, ...settings } = store.data.settings
  const file = path.join(directory, 'private-book.enc')
  return { format: 1, notes: store.data.notes, categories: store.data.categories, settings,
    apiKey: key ? credentials.decryptString(Buffer.from(key, 'base64')) : '',
    book: fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null }
}
function pack(data, password) {
  const salt = randomBytes(16), key = derive(password, salt)
  try { return JSON.stringify(encrypt(key, salt, data, purpose)) } finally { key.fill(0) }
}
function unpack(box, password) {
  const opened = decrypt(password, JSON.parse(box), purpose)
  opened.key.fill(0)
  return opened.value
}
function stage(root, data, credentials) {
  if (data?.format !== 1 || !Array.isArray(data.categories) || !data.notes || typeof data.notes !== 'object') throw new Error('迁移包格式有误')
  const id = 'profile-' + randomUUID(), directory = path.join(root, id)
  const store = openStore(directory)
  try {
    for (const category of data.categories) if (!builtInCategories.some(item => item.id === category.id)) store.addCategory(category)
    for (const [key, doc] of Object.entries(data.notes)) {
      const page = noteIdentity(key)
      store.saveNote(page.date, doc, page.category)
    }
    const settings = { ...defaultSettings }
    for (const name of Object.keys(settings)) if (name !== 'key' && typeof data.settings?.[name] === typeof settings[name]) settings[name] = data.settings[name]
    if (data.apiKey) {
      if (!credentials.isEncryptionAvailable() || (process.platform === 'linux' && credentials.getSelectedStorageBackend() === 'basic_text'))
        throw new Error('新主机的系统凭据存储不可用')
      settings.key = credentials.encryptString(data.apiKey).toString('base64')
    }
    store.update({ settings })
    if (data.book) {
      const box = JSON.parse(data.book)
      if (box.v !== 1 || typeof box.data !== 'string') throw new Error('加密便签格式无效')
      fs.writeFileSync(path.join(directory, 'private-book.enc'), data.book, { mode: 0o600 })
    }
    return id
  } catch (error) { fs.rmSync(directory, { recursive: true, force: true }); throw error }
}
function activate(root, id) {
  if (!/^profile-[a-f0-9-]{36}$/.test(id) || !fs.existsSync(path.join(root, id, 'settings.json'))) throw new Error('新主设备资料尚未就绪')
  const file = path.join(root, marker)
  fs.writeFileSync(file + '.tmp', JSON.stringify({ id }), { mode: 0o600 })
  fs.renameSync(file + '.tmp', file)
}
module.exports = { activePath, snapshot, pack, unpack, stage, activate }
