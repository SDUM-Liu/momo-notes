const fs = require('node:fs')
const path = require('node:path')
const { createHash } = require('node:crypto')
const { openStore, revisionOf } = require('./data.cjs')
const { builtInCategories, noteIdentity, validateCategory } = require('../shared/notes.mjs')
const { parsePairing } = require('../shared/sync.mjs')

function createFollower(directory, credentials, notify) {
  const filename = path.join(directory, 'follower.json')
  let active

  function profile(code) {
    const { key } = parsePairing(code)
    const id = createHash('sha256').update('momo-notes/follower/' + key).digest('hex')
    const cache = path.join(directory, 'followed-notes', id)
    fs.mkdirSync(cache, { recursive: true, mode: 0o700 })
    return { id, code, store: openStore(cache), cache }
  }

  if (fs.existsSync(filename)) {
    try {
      const { sealed, code } = JSON.parse(fs.readFileSync(filename, 'utf8'))
      if (sealed || code) active = profile(sealed ? credentials.open(sealed) : code)
    } catch {}
  }

  function setPair(value) {
    const code = String(value || '').trim()
    const next = code ? profile(code) : undefined
    const sealed = code && credentials.seal(code)
    fs.writeFileSync(filename + '.tmp', JSON.stringify(sealed ? { sealed } : { code }), { mode: 0o600 })
    fs.renameSync(filename + '.tmp', filename)
    active = next
    notify({ profileChanged: true })
  }

  function current(id) {
    if (!active || active.id !== id) throw new Error('主设备已切换，请重新同步')
    return active
  }

  return {
    setPair,
    get code() { return active?.code ?? '' },
    get store() { return active?.store },
    snapshot() {
      return active ? { id: active.id, revisions: active.store.data.revisions, categories: active.store.data.categories } : null
    },
    categories(id, values) {
      const { store } = current(id)
      const custom = values.filter(item => item.id?.startsWith('cat-')).map(validateCategory)
      const categories = [...builtInCategories, ...custom]
      if (JSON.stringify(categories) !== JSON.stringify(store.data.categories)) {
        store.update({ categories })
        notify({ categories })
      }
    },
    accept(id, key, { doc, rev }) {
      const { store } = current(id)
      const { date, category } = noteIdentity(key)
      if (!doc || revisionOf(doc) !== rev) throw new Error('主设备便签校验失败')
      store.saveNote(date, doc, category)
      notify({ key, doc, rev })
    },
    reconcile(id, revisions) {
      const { cache, store } = current(id)
      for (const key of Object.keys(store.data.revisions)) {
        if (Object.hasOwn(revisions, key)) continue
        fs.rmSync(path.join(cache, 'notes', key + '.json'), { force: true })
        delete store.data.notes[key]
        delete store.data.revisions[key]
        notify({ key, removed: true })
      }
    },
  }
}

module.exports = { createFollower }
