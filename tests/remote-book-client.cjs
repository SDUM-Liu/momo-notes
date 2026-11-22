const assert = require('node:assert/strict')
const { test, before, after } = require('node:test')
const { randomBytes, randomUUID } = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { privateBook, token } = require('../desktop/private-book.cjs')
const { remoteBook: service } = require('../desktop/remote-book.cjs')
const { derive, encrypt } = require('../desktop/sealed.cjs')

let vite, client
before(async () => {
  const { createServer } = await import('vite')
  vite = await createServer({ server: { middlewareMode: true }, appType: 'custom' })
  client = (await vite.ssrLoadModule('/src/remote-book.js')).remoteBook
})
after(async () => { await vite?.close() })
const chunk = 1024 * 1024
function gate() {
  let resolve
  const promise = new Promise(r => { resolve = r })
  return { resolve, promise }
}

function fixture(t, entries = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'momo-replica-book-'))
  const password = 'test-only-replica-password'
  const secret = randomBytes(20).toString('base64')
  const salt = randomBytes(16), key = derive(password, salt)
  const box = encrypt(key, salt, { secret, last: -1, entries }, 'momo/private-book/v1')
  key.fill(0)
  fs.writeFileSync(path.join(dir, 'private-book.enc'), JSON.stringify(box))
  const book = privateBook(dir), host = service(book), phone = randomUUID()
  t.after(() => { host.forceLock(); fs.rmSync(dir, { recursive: true, force: true }) })
  const calls = []
  const send = async (op, args) => { calls.push(op); return host.call(phone, op, args) }
  const auth = (offset = 0) => ({ password, code: token(secret, Math.floor(Date.now() / 30000) + offset) })
  return { send, calls, auth, host }
}

async function upload(book, parts) {
  const meta = { id: randomUUID(), mime: 'audio/wav', size: parts.reduce((n, p) => n + p.length, 0) }
  await book('mediaBegin', meta)
  for (const [index, bytes] of parts.entries()) await book('mediaWrite', { id: meta.id, index, bytes })
  await book('mediaFinish', { id: meta.id })
  await book('save', { entries: [{ files: [{ ...meta, name: 'recording.wav', storage: 'chunks-v1' }] }] })
  return meta.id
}

test('large UTF-8 manifests exceed the wire limit and survive a real primary save and reopen', async t => {
  const text = 'p'.repeat(chunk - 5) + '🍑' + '文本'.repeat(5600000)
  const primary = fixture(t, [{ text }]), book = client(primary.send)
  try {
    assert.deepEqual(await book('begin'), {})
    assert.equal((await book('unlock', primary.auth()))[0].text, text)
    await book('save', { entries: [{ text: '新' + text, end: '🎵' }] })
    assert(primary.calls.filter(c => c === 'manifestRead').length > 32)
    assert(primary.calls.filter(c => c === 'saveWrite').length > 32)
    await book('lock')
    const [stored] = await book('unlock', primary.auth(1))
    assert.equal(stored.text, '新' + text)
    assert.equal(stored.end, '🎵')
  } finally { await book('lock') }
})

test('chunked uploads reach the primary and a removed or externally locked preview cannot be read', async t => {
  const primary = fixture(t), parts = [randomBytes(chunk), randomBytes(49)]
  let expired = 0
  const book = client(primary.send, () => expired++)
  try {
    await book('unlock', primary.auth())
    const id = await upload(book, parts)
    const url = await book('mediaPreview', { id })
    assert.deepEqual(Buffer.from(await (await fetch(url)).arrayBuffer()), Buffer.concat(parts))
    await book('mediaRelease', { id })
    await assert.rejects(fetch(url))
    const again = await book('mediaPreview', { id })
    primary.host.forceLock()
    await assert.rejects(book('mediaInfo', { id }), { code: 'PRIVATE_LOCKED' })
    await assert.rejects(fetch(again))
    await assert.rejects(book('mediaPreview', { id }), { code: 'PRIVATE_LOCKED' })
    assert.equal(expired, 1)
  } finally { await book('lock') }
})

test('closing an in-flight preview cancels immediately and reopening works', async t => {
  const primary = fixture(t), waiting = gate(), resume = gate()
  const book = client(async (op, args) => {
    if (op === 'mediaRead') { waiting.resolve(); await resume.promise }
    return primary.send(op, args)
  })
  try {
    await book('unlock', primary.auth())
    const id = await upload(book, [Buffer.from('x')])
    const rejected = assert.rejects(book('mediaPreview', { id }))
    await waiting.promise
    await book('mediaRelease', { id })
    await rejected
    resume.resolve()
    const url = await book('mediaPreview', { id })
    assert.equal(await (await fetch(url)).text(), 'x')
    await book('background')
    await assert.rejects(fetch(url))
  } finally { resume.resolve(); await book('lock') }
})

test('an unlock reply arriving after background cannot reopen the follower or primary', async t => {
  const primary = fixture(t), waiting = gate(), resume = gate(), closed = gate()
  const book = client(async (op, args) => {
    if (op === 'unlock') { waiting.resolve(); await resume.promise }
    const result = await primary.send(op, args)
    if (op === 'lock') closed.resolve()
    return result
  })
  try {
    const rejected = assert.rejects(book('unlock', primary.auth()), { code: 'PRIVATE_LOCKED' })
    await waiting.promise
    await book('background')
    resume.resolve()
    await rejected
    await closed.promise
    assert(!primary.host.active)
    assert(!primary.calls.includes('manifestRead'))
  } finally { resume.resolve(); await book('lock') }
})

test('the idle deadline discards previews and prevents subsequent saves', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1800000000000 })
  const primary = fixture(t)
  let expired = 0
  const book = client(primary.send, () => expired++)
  try {
    await book('unlock', primary.auth())
    const id = await upload(book, [])
    const url = await book('mediaPreview', { id })
    t.mock.timers.tick(5 * 60 * 1000 + 1)
    assert.equal(expired, 1)
    await assert.rejects(fetch(url))
    await assert.rejects(book('save', { entries: [] }), { code: 'PRIVATE_LOCKED' })
  } finally { await book('lock') }
})
