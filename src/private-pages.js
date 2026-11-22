import { defaultCategory, localDay, newCategory, noteIdentity, noteKey } from '../shared/notes.mjs'

const defaults = [{ id: defaultCategory, name: '密码本' }, { id: 'finds', name: '多媒体' }, { id: 'stories', name: '话题' }]
const mediaCategory = 'finds'
const format = 'fixed-pages-v1'
const blank = () => ({ type: 'doc', content: [{ type: 'paragraph' }] })

function fromEntries(entries, day) {
  const pages = { categories: defaults, notes: {} }
  for (const entry of entries) {
    const category = defaults[entry.tab]
    if (!category || typeof entry.title !== 'string') throw new Error('无法读取旧版条目，请保留原始资料')
    const key = noteKey(category.id, day)
    const doc = pages.notes[key] ??= { type: 'doc', content: [] }
    // In the original file form, the title was also the attachment's display name.
    if (!entry.media || category.id !== mediaCategory || entry.text) {
      if (entry.title) doc.content.push({ type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: entry.title }] })
      for (const line of (entry.text || '').split(/\r?\n/)) {
        doc.content.push({ type: 'paragraph', content: line ? [{ type: 'text', text: line }] : [] })
      }
    }
    if (entry.media) doc.content.push({ type: entry.media.startsWith('data:image/') ? 'image' : 'noteMedia', attrs: { src: entry.media, alt: entry.title } })
  }
  return pages
}

function normalizeNode(node, files) {
  const src = node.attrs?.src
  if (files && ['image', 'noteMedia'].includes(node.type) && typeof src === 'string') {
    const mime = /^data:(image|audio|video)\/([\w.+-]+)(?:;[^,]*)?;base64,/i.exec(src)
    if (mime) {
      const label = { image: '图片', audio: '录音', video: '视频' }[mime[1].toLowerCase()]
      files.push({ id: crypto.randomUUID(), name: node.attrs.alt || node.attrs.title || label + '-' + (files.length + 1) + '.' + mime[2], src })
      return null
    }
  }
  // Earlier releases opened every new day with one empty checklist item.
  const item = node.type === 'taskList' && node.content?.length === 1 && node.content[0]
  const placeholder = item?.content?.length === 1 && item.content[0]
  if (placeholder?.type === 'paragraph' && !placeholder.content?.length) return placeholder
  const next = { ...node }
  if (node.type === 'taskList') next.type = 'bulletList'
  if (node.type === 'taskItem') {
    next.type = 'listItem'
    next.attrs = { ...node.attrs }
    delete next.attrs.checked
    if (!Object.keys(next.attrs).length) delete next.attrs
  }
  if (Array.isArray(node.content)) next.content = node.content.map(child => normalizeNode(child, files)).filter(Boolean)
  if (next.type === 'listItem' && next.content?.[0]?.type !== 'paragraph') {
    next.content = [{ type: 'paragraph' }, ...(next.content || [])]
  } else if (['doc', 'tableCell', 'tableHeader', 'blockquote'].includes(next.type) && !next.content?.length) {
    next.content = [{ type: 'paragraph' }]
  }
  return next
}

function migrate(entries) {
  const old = entries[0]?.kind === 'daily-pages-v1' ? entries[0] : fromEntries(entries, localDay())
  const pages = { kind: format, categories: [...old.categories], homes: {}, notes: {}, files: [] }
  let mediaNotes
  const latestDate = {}
  const history = Object.entries(old.notes).map(([key, document]) => ({ ...noteIdentity(key), document }))
  history.sort((a, b) => a.date.localeCompare(b.date))
  for (const { category, date, document } of history) {
    const doc = normalizeNode(document, category === mediaCategory ? pages.files : undefined)
    const populated = hasPageContent(doc)
    let target = category
    if (category === mediaCategory) {
      if (!populated) continue
      if (!mediaNotes) {
        const name = '媒体笔记'
        let label = name
        for (let n = 2; pages.categories.some(c => c.name === label); n++) label = name + ' ' + n
        mediaNotes = newCategory(label)
        pages.categories.push(mediaNotes)
      }
      target = mediaNotes.id
    }
    pages.notes[noteKey(target, date)] = doc
    latestDate[target] = date
    if (populated) pages.homes[target] = date
  }
  // Prefer the most recent actual content over a later untouched daily placeholder.
  for (const [category, date] of Object.entries(latestDate)) pages.homes[category] ??= date
  return pages
}

function hasPageContent(node) {
  return Boolean(node.text?.length || ['image', 'noteMedia', 'table', 'horizontalRule', 'hardBreak'].includes(node.type)
    || node.content?.some(hasPageContent))
}

export function privatePages(entries, persist) {
  let needsMigration = entries[0]?.kind !== format
  let pages = needsMigration ? migrate(entries) : entries[0]
  let queue = Promise.resolve()
  function change(update) {
    const result = queue.then(async () => {
      if (!pages) throw new Error('已锁定')
      const next = update(pages)
      await persist([next])
      if (!pages) throw new Error('已锁定')
      pages = next
      needsMigration = false
      return next
    })
    queue = result.catch(() => {})
    return result
  }
  return {
    get categories() { return pages.categories },
    get files() { return pages.files },
    close() { pages = null },
    async openNote(date, category) {
      if (!pages?.categories.some(item => item.id === category) || category === mediaCategory) throw new Error('请选择文本分类')
      if (date && !pages.notes[noteKey(category, date)]) throw new Error('日期页不存在')
      if (!pages.homes[category]) {
        const firstDay = localDay()
        await change(p => p.homes[category] ? p : { ...p, homes: { ...p.homes, [category]: firstDay },
          notes: { ...p.notes, [noteKey(category, firstDay)]: blank() } })
      } else if (needsMigration) await change(p => p)
      const home = pages.homes[category]
      const day = date || home
      return { date: day, today: localDay(), category, doc: pages.notes[noteKey(category, day)], isArchive: day !== home }
    },
    async saveNote(date, doc, category) {
      const key = noteKey(category, date)
      const content = normalizeNode(doc)
      await change(p => {
        if (!p.notes[key]) throw new Error('日期页不存在')
        return { ...p, notes: { ...p.notes, [key]: content } }
      })
      return { doc: content }
    },
    listDates(category) {
      return Object.keys(pages.notes).map(noteIdentity).filter(page => page.category === category).map(page => page.date).sort().reverse()
    },
    async addCategory(name) {
      const next = await change(p => ({ ...p, categories: [...p.categories, newCategory(name)] }))
      return next.categories
    },
    async saveFiles(files) {
      const next = await change(p => ({ ...p, files }))
      return next.files
    },
  }
}
