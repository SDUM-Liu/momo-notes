const fs = require('node:fs')
const path = require('node:path')
const { createHash } = require('node:crypto')

const { defaultSettings, localDay, emptyNote, nodeText, builtInCategories, defaultCategory, noteKey,
  noteIdentity, datesFor, newDayNote, validateCategory } = require('../shared/notes.mjs')
const revisionOf = doc => createHash('sha256').update(JSON.stringify(doc)).digest('hex')

function writeJson(filename, value) {
  fs.writeFileSync(filename + '.tmp', JSON.stringify(value), { encoding: 'utf8', mode: 0o600 })
  fs.renameSync(filename + '.tmp', filename)
}

function openStore(directory) {
  const noteDirectory = path.join(directory, 'notes')
  fs.mkdirSync(noteDirectory, { recursive: true })
  const filename = path.join(directory, 'settings.json')
  const saved = fs.existsSync(filename) ? JSON.parse(fs.readFileSync(filename, 'utf8')) : {}
  const notes = Object.fromEntries(
    fs.readdirSync(noteDirectory)
      .filter(name => /^(?:(?:finds|stories|thoughts|cat-[a-f0-9]{32})__)?\d{4}-\d{2}-\d{2}\.json$/.test(name))
      .map(name => [name.slice(0, -5), JSON.parse(fs.readFileSync(path.join(noteDirectory, name), 'utf8'))]),
  )
  const revisions = Object.fromEntries(Object.entries(notes).map(([key, doc]) => [key, revisionOf(doc)]))
  const data = {
    notes, revisions, settings: { ...defaultSettings, ...saved.settings }, position: saved.position ?? null,
    categories: [...builtInCategories, ...(saved.categories ?? [])],
  }

  function update(patch) {
    const next = { settings: data.settings, position: data.position, categories: data.categories, ...patch }
    writeJson(filename, { ...next, categories: next.categories.filter(item => item.id.startsWith('cat-')) })
    Object.assign(data, next)
  }

  function today(category = defaultCategory) {
    requireCategory(category)
    const date = localDay()
    if (!data.notes[noteKey(category, date)]) saveNote(date, newDayNote(notes, category, date), category)
    return date
  }

  function requireCategory(category) {
    if (!data.categories.some(item => item.id === category)) throw new Error('便签分类不存在')
  }

  function saveNote(date, doc, category = defaultCategory) {
    requireCategory(category)
    const key = noteKey(category, date)
    noteIdentity(key)
    if (doc?.type !== 'doc' || !Array.isArray(doc.content)) throw new Error('便签数据格式有误')
    const revision = revisionOf(doc)
    if (revision !== revisions[key]) {
      writeJson(path.join(noteDirectory, key + '.json'), doc)
      notes[key] = doc
      revisions[key] = revision
    }
    return revision
  }

  function addCategory(value) {
    const item = validateCategory(value)
    if (!data.categories.some(existing => existing.id === item.id)) update({ categories: [...data.categories, item] })
    return data.categories
  }

  return { data, update, today, saveNote, addCategory, dates: (category = defaultCategory) => datesFor(notes, category, today(category)) }
}

module.exports = { emptyNote, localDay, nodeText, openStore, revisionOf }
