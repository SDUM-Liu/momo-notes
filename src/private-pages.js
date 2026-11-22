import { datesFor, defaultCategory, localDay, newCategory, newDayNote, noteKey } from '../shared/notes.mjs'

const defaults = [{ id: defaultCategory, name: '密码本' }, { id: 'finds', name: '多媒体' }, { id: 'stories', name: '话题' }]

function fromEntries(entries, day) {
  const pages = { kind: 'daily-pages-v1', categories: defaults, notes: {} }
  for (const entry of entries) {
    const category = defaults[entry.tab]
    if (!category || typeof entry.title !== 'string') throw new Error('无法读取旧版条目，请保留原始资料')
    const key = noteKey(category.id, day)
    const doc = pages.notes[key] ??= { type: 'doc', content: [] }
    if (entry.title) doc.content.push({ type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: entry.title }] })
    for (const line of (entry.text || '').split(/\r?\n/)) doc.content.push({ type: 'paragraph', content: line ? [{ type: 'text', text: line }] : [] })
    if (entry.media) doc.content.push({ type: entry.media.startsWith('data:image/') ? 'image' : 'noteMedia', attrs: { src: entry.media, alt: entry.title } })
  }
  return pages
}

export function privatePages(entries, persist) {
  const legacy = entries[0]?.kind !== 'daily-pages-v1'
  let pages = legacy ? fromEntries(entries, localDay()) : entries[0]
  let needsMigration = legacy
  let queue = Promise.resolve()
  let closed = false
  function change(update) {
    const result = queue.then(async () => {
      if (closed) throw new Error('已锁定')
      const next = update(pages)
      await persist([next])
      if (!closed) pages = next
      needsMigration = false
      return next
    })
    queue = result.catch(() => {})
    return result
  }
  return {
    get categories() { return pages.categories },
    close() { closed = true; pages = null },
    async openNote(date, category) {
      const today = localDay(), day = date || today, key = noteKey(category, day)
      if (!pages.notes[key]) await change(p => ({ ...p, notes: { ...p.notes, [key]: newDayNote(p.notes, category, day) } }))
      else if (needsMigration) await change(p => ({ ...p }))
      return { date: day, category, today, doc: pages.notes[key] }
    },
    async saveNote(date, doc, category) {
      await change(p => ({ ...p, notes: { ...p.notes, [noteKey(category,date)]: doc } }))
      return { doc }
    },
    listDates(category) { return datesFor(pages.notes, category, localDay()) },
    async addCategory(name) {
      const next = await change(p => ({ ...p, categories: [...p.categories, newCategory(name)] }))
      return next.categories
    },
  }
}
