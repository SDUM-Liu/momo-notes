const assert = require('node:assert/strict')
const { test } = require('node:test')
const { createHostSync } = require('../shared/host-sync.mjs')
const { unseal } = require('../shared/sync.mjs')

test('downloads history in batches, keeps large pages compatible, and notices host edits', async t => {
  const { createServer } = await import('vite')
  const server = await createServer({ logLevel: 'silent', server: { middlewareMode: true, ws: false }, appType: 'custom' })
  t.after(() => server.close())
  const { mobileSync } = await server.ssrLoadModule('/src/sync-client.js')
  const keyFor = day => '2026-09-' + String(day).padStart(2, '0')
  const note = text => ({ type:'doc', content:[{ type:'paragraph', content:[{ type:'text', text }] }] })
  const notes = {}, revisions = {}, records = {}
  for (let day = 1; day <= 27; day++) {
    const key = keyFor(day)
    notes[key] = note(day === 27 ? '图'.repeat(600000) : '便签 ' + day)
    revisions[key] = 'rev-' + day
  }
  const config = {}
  const host = createHostSync({ config, store:{ data:{ notes, revisions, categories:[] } },
    defaults:{ url:'https://relay.example.com' }, notify() {}, persist() {} })
  host.setEnabled(true)
  host.status('online', host.link().room)
  t.after(() => host.stop())
  const calls = []
  let pendingEdit
  const follower = mobileSync({
    records, readOnly:true, loadCode:host.code, saveCode() {}, activate() {}, setCategories() {}, change() {},
    accept(key, _previous, page) {
      records[key] = page
      if (page.rev === 'changed') pendingEdit?.()
    },
    async exchange(_connection, wire) {
      const { op } = unseal(config.key, 'request', wire)
      calls.push(op)
      return { via:'relay', message:await host.exchange(wire) }
    },
  })
  await follower.init()
  await follower.run()
  assert.equal(Object.keys(records).length, 27)
  assert.deepEqual(calls.slice(2, -1), ['get-pages', 'get', 'get-pages', 'get-pages'])
  assert.deepEqual(records[keyFor(27)].doc, notes[keyFor(27)])

  notes[keyFor(8)] = note('新内容')
  revisions[keyFor(8)] = 'changed'
  const updated = new Promise(resolve => { pendingEdit = resolve })
  await follower.probe()
  await updated
  assert.deepEqual(records[keyFor(8)].doc, notes[keyFor(8)])
  await follower.run()
})
