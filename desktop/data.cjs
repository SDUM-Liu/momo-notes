const fs = require('node:fs')
const path = require('node:path')

const defaultSettings = {
  alwaysOnTop: true, openAtLogin: false, snap: true, edgeImage: '',
  baseUrl: '', model: '', proxyPort: '', key: '',
}

function localDay(date = new Date()) {
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return [date.getFullYear(), month, day].join('-')
}

function emptyNote() {
  return {
    type: 'doc',
    content: [{
      type: 'taskList',
      content: [{
        type: 'taskItem', attrs: { checked: false },
        content: [{ type: 'paragraph' }],
      }],
    }],
  }
}

function nodeText(node, withStatus = false) {
  if (node.type === 'image') return '[图片]'
  if (node.type === 'hardBreak') return '\n'
  const separator = ['paragraph', 'heading'].includes(node.type) ? '' : '\n'
  const content = node.text ?? (node.content ?? []).map(child => nodeText(child, withStatus)).join(separator)
  if (withStatus && node.type === 'taskItem') return (node.attrs?.checked ? '[已完成] ' : '[待办] ') + content
  return content
}

function hasContent(node) {
  return Boolean(node.text?.trim() || ['image', 'table'].includes(node.type) || node.content?.some(hasContent))
}

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
