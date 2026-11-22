const assert = require('node:assert/strict')
const { before, after, test } = require('node:test')
const { emptyNote, localDay, noteKey } = require('../shared/notes.mjs')

let server, privatePages
before(async () => {
  const { createServer } = await import('vite')
  server = await createServer({ server: { middlewareMode: true }, appType: 'custom' })
  privatePages = (await server.ssrLoadModule('/src/private-pages.js')).privatePages
})
after(async () => { await server?.close() })

const paragraph = text => ({ type: 'paragraph', content: text ? [{ type: 'text', text }] : [] })
const doc = (...content) => ({ type: 'doc', content })

test('a private category uses one stable page across days and reopens, including after a failed save', async t => {
  const start = new Date('2026-10-10T12:00:00')
  t.mock.timers.enable({ apis: ['Date'], now: start.getTime() })
  let saved, writes = 0, full = false
  const persist = async value => {
    if (full) throw new Error('storage full')
    saved = structuredClone(value)
    writes++
  }
  const first = privatePages([], persist)
  const page = await first.openNote(undefined, 'stories')
  assert.equal(page.date, localDay(start))
  assert.deepEqual(page.doc, { type: 'doc', content: [{ type: 'paragraph' }] })
  await first.saveNote(page.date, doc(paragraph('kept')), 'stories')
  full = true
  await assert.rejects(first.saveNote(page.date, doc(paragraph('lost')), 'stories'), /storage full/)
  assert.deepEqual((await first.openNote(undefined, 'stories')).doc, doc(paragraph('kept')))
  first.close()
  t.mock.timers.setTime(start.getTime() + 86400000 * 7)
  const reopen = privatePages(saved, persist)
  const next = await reopen.openNote(undefined, 'stories')
  assert.equal(next.date, page.date)
  assert.equal(next.isArchive, false)
  assert.deepEqual(next.doc, doc(paragraph('kept')))
  assert.deepEqual(reopen.listDates('stories'), [page.date])
  assert.equal(writes, 2)
})

test('v1 migration collects media across dates, keeps dated text and table structure, and preserves manual text styling', async () => {
  const categories = [{id:'todo',name:'密码本'}, {id:'finds',name:'多媒体'}, {id:'stories',name:'话题'}]
  const marked = { type:'text', text:'旧条目', marks:[{type:'strike'}] }
  const task = { type:'taskList', content:[{type:'taskItem', attrs:{checked:true}, content:[{type:'paragraph',content:[marked]}]}] }
  const audio = { type:'noteMedia', attrs:{alt:'话筒',src:'data:audio/webm;codecs=opus;base64,YQ=='} }
  const image = { type:'image', attrs:{alt:'风景',src:'data:image/jpeg;base64,Yg=='} }
  const table = { type:'table', content:[{type:'tableRow',content:[{type:'tableCell', content:[paragraph('表注'),image]}]}] }
  let saved
  const persist = async value => { saved = structuredClone(value) }
  const old = [{ kind:'daily-pages-v1', categories, notes:{
    '2026-01-02':doc(task), '2026-01-03':emptyNote(), '2026-01-01':doc(paragraph('早期')),
    'finds__2026-01-02':doc(table), 'finds__2026-01-04':doc(audio),
    'stories__2026-01-02':doc(image),
  } }]
  const book = privatePages(old, persist)
  const main = await book.openNote(undefined,'todo')
  assert.equal(main.date,'2026-01-02')
  assert.deepEqual(main.doc.content[0],{type:'bulletList',content:[{type:'listItem',content:[{type:'paragraph',content:[marked]}]}]})
  assert((await book.openNote('2026-01-01','todo')).isArchive)
  assert.deepEqual(book.listDates('todo'), ['2026-01-03','2026-01-02','2026-01-01'])
  assert.deepEqual(book.files.map(f => [f.name,f.src]), [['风景',image.attrs.src],['话筒',audio.attrs.src]])
  const recovered = book.categories.find(c => c.name === '媒体笔记').id
  const note = await book.openNote(undefined,recovered)
  assert.deepEqual(note.doc.content[0].content[0].content[0].content, [paragraph('表注')])
  assert.equal(note.date,'2026-01-02')
  assert.deepEqual((await book.openNote(undefined,'stories')).doc,doc(image))
  assert(!Object.keys(saved[0].notes).some(key => key.startsWith('finds__')))
  const name = await book.addCategory('分区')
  const newest = await book.openNote(undefined, name.at(-1).id)
  assert.deepEqual(newest.doc.content,[{type:'paragraph'}])
  const ids = book.files.map(f=>f.id)
  const reopened = privatePages(saved,persist)
  assert.deepEqual(reopened.files.map(f=>f.id),ids)
})

test('legacy attachment titles become file names; batch changes and rejected writes keep complete snapshots', async () => {
  let saved, reject = false
  const book = privatePages([{title:'过去的照片',text:'',tab:1,media:'data:image/png;base64,AA=='}],async value=>{
    if (reject) throw new Error('已满')
    saved = structuredClone(value)
  })
  assert.equal(book.files[0].name,'过去的照片')
  assert(!book.categories.some(c=>c.name==='媒体笔记'))
  const home = await book.openNote(undefined,'todo')
  const added = { id:crypto.randomUUID(), name:'示例', src:'data:video/mp4;base64,AA==' }
  await Promise.all([book.saveNote(home.date,doc(paragraph('persist')),'todo'), book.saveFiles([...book.files,added])])
  assert.equal(saved[0].files.length,2)
  assert.deepEqual(saved[0].notes[noteKey('todo',home.date)],doc(paragraph('persist')))
  reject = true
  await assert.rejects(book.saveFiles([]), /已满/)
  assert.equal(book.files.length,2)
  reject = false
  await book.saveFiles(book.files.filter(f=>f.id!==added.id))
  assert.equal(saved[0].files.length,1)
})
