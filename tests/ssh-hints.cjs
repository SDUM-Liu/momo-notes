const assert = require('node:assert/strict')
const { randomBytes, randomUUID } = require('node:crypto')
const { test } = require('node:test')
const { createHostSync } = require('../shared/host-sync.mjs')
const { normalizeSSHEndpoint } = require('../shared/ssh-endpoint.mjs')
const { seal, unseal } = require('../shared/sync.mjs')

function primary() {
  const config = {}
  const host = createHostSync({ config, defaults: { url: 'https://relay.example' },
    store: { data: { categories: [], revisions: {} } }, notify() {}, persist() {} })
  host.setEnabled(true)
  const { relay, room } = host.link()
  host.status('online', room, relay)
  async function request(op, payload) {
    const id = randomBytes(12).toString('hex')
    const wire = seal(config.key, 'request', { id, time: Date.now(), op, payload })
    return unseal(config.key, 'reply/' + id, await host.exchange(wire))
  }
  return { host, config, room, request }
}

test('SSH endpoints accept configured accounts and IP literals, and reject ambiguous destination syntax', () => {
  const value = { host: '[2001:db8::2]', user: 'alice@example.test', port: '8022' }
  assert.deepEqual(normalizeSSHEndpoint(value), { host: '2001:db8::2', user: value.user, port: 8022 })
  const windows = { host: 'workstation.example.', user: 'OFFICE\\alice', port: 22 }
  assert.deepEqual(normalizeSSHEndpoint(windows), windows)
  for (const host of ['user@host', 'host:22', '192.168.0.999', '1 2', '-p2', '', 'https://host']) {
    assert.throws(() => normalizeSSHEndpoint({ ...value, host }))
  }
  for (const port of [0, -2, 65536, '2.3', 'NaN']) assert.throws(() => normalizeSSHEndpoint({ ...value, port }))
  for (const user of ['', '-x', 'a b', 'bad;', 'bob@-example']) assert.throws(() => normalizeSSHEndpoint({ ...value, user }))
})

test('only explicit requests from the sharing device update a hint, including withdrawal', async () => {
  const { request, host, config } = primary()
  const device = { id: randomUUID(), platform: 'Android' }
  const key = randomBytes(32).toString('hex')
  const fakeKey = randomBytes(32).toString('hex')
  const hint = { host: '192.0.2.3', username: 'mobile', port: 8022 }
  const own = { ...device, sshProof: key }
  const impostor = { ...device, sshProof: fakeKey }
  const payload = { device: own, hint }
  assert.equal((await request('index', { ...device, sshHint: hint })).ok, true)
  assert.equal(host.state().devices[0].sshHint, undefined)
  assert.equal((await request('ssh-hint/set', { device: impostor, hint })).ok, false)
  assert.equal((await request('state', own)).ok, true)
  assert.equal((await request('state', impostor)).ok, false)
  assert.equal((await request('ssh-hint/set', { device: impostor, hint })).ok, false)
  assert.deepEqual((await request('ssh-hint/set', payload)).value, hint)
  assert.deepEqual(host.state().devices[0], { ...device, online: true, sshHint: hint })
  assert.notEqual(config.devices[0].sshOwner, key)
  assert.equal((await request('ssh-hint/get', { device: impostor })).ok, false)
  assert.equal((await request('ssh-hint/set', { device: impostor, hint: null })).ok, false)
  assert.equal((await request('ssh-hint/set', { ...payload, hint: { ...hint, host: '' } })).ok, false)
  assert.deepEqual((await request('ssh-hint/get', { device: own })).value, hint)
  await request('state', { ...device, sshHint: null })
  assert.deepEqual(host.state().devices[0].sshHint, hint)
  assert.deepEqual((await request('index', device)).value, { categories: [], revisions: {}, locked: false })
  assert.equal((await request('ssh-hint/set', { ...payload, hint: null })).value, null)
  assert.equal(host.state().devices[0].sshHint, undefined)
  assert.equal((await request('ssh-hint/set', { device: impostor, hint })).ok, false)
})

test('sharing through the real follower client stays scoped to the paired host', async t => {
  const first = primary(), second = primary()
  const hosts = new Map([[first.room, first.host], [second.room, second.host]])
  const saved = new Map()
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: key => saved.get(key) ?? null, setItem: (key, value) => saved.set(key, value) } })
  t.after(() => {
    if (descriptor) Object.defineProperty(globalThis, 'localStorage', descriptor)
    else delete globalThis.localStorage
  })
  const { createServer } = await import('vite')
  const server = await createServer({ server: { middlewareMode: true, ws: false }, appType: 'custom' })
  t.after(() => server.close())
  const { mobileSync } = await server.ssrLoadModule('/src/sync-client.js')
  const client = mobileSync({ exchange: async (peer, wire) => ({ message: await hosts.get(peer.room).exchange(wire), via: 'test' }),
    loadCode: async () => '', saveCode() {}, records: {}, categories: () => [], setCategories() {}, activate() {}, change() {} })
  const hint = { host: '192.0.2.8', port: 8022, username: 'phone' }
  await client.init()
  await client.pairWith(first.host.code())
  assert.equal(client.state().sshHintScope, first.room)
  assert.equal(await client.sshHint(first.room), null)
  assert.deepEqual(await client.sshHint(first.room, hint), hint)
  await client.pairWith(second.host.code())
  await assert.rejects(client.sshHint(first.room, null), /当前已配对/)
  assert.equal(await client.sshHint(second.room), null)
  assert.deepEqual(first.host.state().devices[0].sshHint, hint)
  await client.pairWith(first.host.code())
  assert.deepEqual(await client.sshHint(first.room), hint)
  assert.equal(await client.sshHint(first.room, null), null)
  await client.unpair()
  await assert.rejects(client.sshHint(first.room, hint), /当前已配对/)
})
