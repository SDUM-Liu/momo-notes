const fs = require('node:fs')
const path = require('node:path')

const { defaultSettings, localDay, emptyNote, nodeText, hasContent } = require('../shared/notes.mjs')

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
      .filter(name => /^\d{4}-\d{2}-\d{2}\.json$/.test(name))
      .map(name => [name.slice(0, -5), JSON.parse(fs.readFileSync(path.join(noteDirectory, name), 'utf8'))]),
  )
  const data = { notes, settings: { ...defaultSettings, ...saved.settings }, position: saved.position ?? null }

  function update(patch) {
    const next = { settings: data.settings, position: data.position, ...patch }
    writeJson(filename, next)
    Object.assign(data, next)
  }

  function today() {
    const date = localDay()
    if (!data.notes[date]) saveNote(date, emptyNote())
    return date
  }

  function saveNote(date, doc) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || doc?.type !== 'doc') throw new Error('便签数据格式有误')
    writeJson(path.join(noteDirectory, date + '.json'), doc)
    data.notes[date] = doc
  }

  function dates() {
    const current = today()
    return Object.keys(data.notes).filter(date => date === current || hasContent(data.notes[date])).sort().reverse()
  }

  return { get data() { return data }, update, today, saveNote, dates }
}

module.exports = { emptyNote, localDay, nodeText, openStore }
