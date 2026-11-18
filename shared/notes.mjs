export const defaultSettings = {
  alwaysOnTop: true, openAtLogin: false, snap: true, edgeImage: '',
  baseUrl: '', model: '', proxyPort: '', key: '', autoInstallUpdates: false,
}

export const defaultCategory = 'todo'
export const builtInCategories = [
  { id: defaultCategory, name: '待办' },
  { id: 'finds', name: '好物' },
  { id: 'stories', name: '趣事' },
  { id: 'thoughts', name: '思考' },
]

export function noteKey(category, date) {
  return category === defaultCategory ? date : category + '__' + date
}

export function noteIdentity(key) {
  const parts = /^(?:(finds|stories|thoughts|cat-[0-9a-f]{32})__)?(\d{4}-\d{2}-\d{2})$/.exec(key)
  if (!parts) throw new Error('便签日期或分类无效')
  return { category: parts[1] || defaultCategory, date: parts[2] }
}

export function validateCategory(value) {
  if (typeof value?.name !== 'string' || !value.name.trim() || value.name.length > 24
      || !/^cat-[a-f0-9]{32}$/.test(value.id)) throw new Error('分类名称无效')
  return { id: value.id, name: value.name.trim() }
}

export function newCategory(name) {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  const id = 'cat-' + Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
  return validateCategory({ id, name: String(name).trim() })
}

export function localDay(date = new Date()) {
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return [date.getFullYear(), month, day].join('-')
}

export function emptyNote() {
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

export function nodeText(node, withStatus = false) {
  if (node.type === 'image') return '[图片]'
  if (node.type === 'hardBreak') return '\n'
  const separator = ['paragraph', 'heading'].includes(node.type) ? '' : '\n'
  const content = node.text ?? (node.content ?? []).map(child => nodeText(child, withStatus)).join(separator)
  if (withStatus && node.type === 'taskItem') return (node.attrs?.checked ? '[已完成] ' : '[待办] ') + content
  return content
}

export function hasContent(node) {
  return Boolean(node.text?.trim() || ['image', 'table'].includes(node.type) || node.content?.some(hasContent))
}

export function datesFor(notes, category, today) {
  return Object.keys(notes).map(noteIdentity).filter(page =>
    page.category === category && (page.date === today || hasContent(notes[noteKey(category, page.date)])),
  ).map(page => page.date).sort().reverse()
}

function carryItems(node) {
  if (node.type === 'taskItem') {
    const nested = node.content?.filter(block => block.type === 'taskList').flatMap(carryItems) ?? []
    if (node.attrs?.checked || !hasContent(node)) return nested
    const content = node.content.filter(block => block.type !== 'taskList')
    if (nested.length) content.push({ type: 'taskList', content: nested })
    return [{ ...node, content }]
  }
  return node.content?.flatMap(carryItems) ?? []
}

export function newDayNote(notes, category, date) {
  const previous = datesFor(notes, category, date).find(day => day < date)
  const items = previous ? carryItems(notes[noteKey(category, previous)]) : []
  return items.length ? { type: 'doc', content: [{ type: 'taskList', content: items }] } : emptyNote()
}
