const assert = require('node:assert/strict')
const { randomBytes, randomUUID } = require('node:crypto')
const { test } = require('node:test')
const { createHostSync } = require('../shared/host-sync.mjs')
const { seal, unseal } = require('../shared/sync.mjs')

const clientEndpoint = '1.1.1.1:40001', hostEndpoint = '8.8.8.8:40002'
const origin = 'https://relay.example.com'
const tick = () => new Promise(resolve => setImmediate(resolve))
const sampleDevice = () => ({ id: randomUUID(), sshProof: randomBytes(32).toString('hex'), platform: 'Android' })

test('paired UDP uses its own native backend and exchanges both measured mappings', async t => {
  const hostMappings = [hostEndpoint, '8.8.8.8:40005'], clientMappings = [clientEndpoint, '1.1.1.1:40006']
  const { host } = await setup(t, {
    udpProbe: {
      prepare: () => ({ endpoint: hostMappings }),
      run(_id, targets, token) {
        assert.deepEqual(targets, clientMappings)
        assert.match(token, /^[a-f0-9]{64}$/)
        return { ok: true }
      },
      cancel() {},
    },
  })
  const follower = await followerFor(t, host)
  assert.deepEqual(await follower.testTcpProbe({
    prepare: () => ({ endpoint: clientMappings }),
    run(_id, endpoints) {
      assert.deepEqual(endpoints, hostMappings)
      return { ok: true }
    },
    cancel() {},
  }, '', 'udp'), { status: 'direct' })
  assert.equal(follower.state().via, 'relay')
})

async function setup(t, services) {
  const config = {}
  const host = createHostSync({
    config, defaults: { url: origin }, store: { data: { categories: [], notes: {}, revisions: {} } },
    ...services, notify() {}, persist() {},
  })
  host.setEnabled(true)
  host.status('online', host.link().room)
  t.after(() => host.stop())
  // Use only this mock installation's generated pairing. No real device state or relay is involved.
  const key = config.key
  async function request(op, payload) {
    const id = randomBytes(12).toString('hex')
    const wire = seal(key, 'request', { id, time: Date.now(), op, payload })
    const reply = await host.exchange(wire)
    return reply === null ? null : unseal(key, 'reply/' + id, reply)
  }
  return { host, key, request }
}

async function followerFor(t, host) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage'), storage = new Map()
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: k => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, v),
  } })
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, 'localStorage', previous)
    else delete globalThis.localStorage
  })
  const { createServer } = await import('vite')
  const server = await createServer({ logLevel: 'error', server: { middlewareMode: true }, appType: 'custom' })
  t.after(() => server.close())
  const { mobileSync } = await server.ssrLoadModule('/src/sync-client.js')
  const follower = mobileSync({
    readOnly: true, records: {}, setCategories() {}, change() {}, loadCode() {}, saveCode() {}, activate() {},
    exchange: async (_, wire) => ({ via: 'relay', message: await host.exchange(wire) }),
  })
  await follower.init()
  await follower.pairWith(host.code())
  return follower
}

test('an encrypted follower probe is bound to its device, leaves normal sync available, and preserves the actual route', {timeout: 6000}, async t => {
  const started = Promise.withResolvers(), allow = Promise.withResolvers(), cancelled = []
  t.after(() => allow.resolve({ ok: false }))
  const { host, request } = await setup(t, { tcpProbe: {
    prepare: async () => ({ endpoint: hostEndpoint }),
    run(id, endpoint, token) { started.resolve({ id, endpoint, token }); return allow.promise },
    cancel: id => cancelled.push(id),
  } })
  const follower = await followerFor(t, host)
  const localRuns = []
  const testResult = follower.testTcpProbe({
    prepare: async () => ({ endpoint: clientEndpoint }),
    run(id, endpoint, token) { localRuns.push({ id, endpoint, token }); return { ok: true } }, cancel() {},
  })
  const hostRun = await started.promise
  const first = host.state().devices[0], other = sampleDevice()
  assert.deepEqual(localRuns, [{ ...hostRun, endpoint: hostEndpoint }])
  assert.equal(hostRun.endpoint, clientEndpoint)
  assert.match(hostRun.token, /^[0-9a-f]{64}$/)
  // An ordinary sync request must finish before the long-running native probe is released.
  assert.deepEqual(await request('state', other), { ok: true, value: { locked: false } })
  assert.equal(await follower.test(), 'relay')
  assert.deepEqual((await request('tcp-probe-cancel', { id: hostRun.id, device: other })).value, { ok: false, reason: 'expired' })
  const impersonator = { ...other, id: first.id }
  assert.equal((await request('state', impersonator)).ok, false)
  assert.deepEqual((await request('tcp-probe-cancel', { id: hostRun.id, device: impersonator })).value, { ok: false, reason: 'unavailable' })
  assert.deepEqual(cancelled, [])
  allow.resolve({ ok: true })
  assert.deepEqual(await testResult, { status: 'direct' })
  assert.equal(follower.state().via, 'relay')
  await tick()
  assert.deepEqual(cancelled, [hostRun.id])
})

test('rotating a host pair cancels an in-flight native test and discards all former-key replies', {timeout: 5000}, async t => {
  const started = Promise.withResolvers(), allow = Promise.withResolvers(), cancelled = []
  t.after(() => allow.resolve({ endpoint: hostEndpoint }))
  const { host, key, request } = await setup(t, { tcpProbe: {
    prepare(id) { started.resolve(id); return allow.promise }, cancel: id => cancelled.push(id),
  } })
  const device = sampleDevice(), id = randomBytes(16).toString('hex')
  assert.equal((await request('state', device)).ok, true)
  const pending = request('tcp-probe-prepare', { id, device })
  assert.equal(await started.promise, id)
  host.rotate()
  await tick()
  assert.deepEqual(cancelled, [id])
  assert.notEqual(host.link().key, key)
  assert.deepEqual(host.state().devices, [])
  allow.resolve({ endpoint: hostEndpoint })
  assert.equal(await pending, null)
  assert.equal(await request('tcp-probe-run', { id, device, endpoint: clientEndpoint, token: 'a'.repeat(64) }), null)
})

test('encrypted book dispatch checks device proof and binds a live session to the authenticated follower', async t => {
  const { remoteBook } = require('../desktop/remote-book.cjs')
  const entries = [{ body: 'private test fixture' }]
  const local = {
    configured: true, unlocked: false,
    keepAlive() {}, lock() { this.unlocked = false },
    call(op, credentials) {
      assert.equal(op, 'unlock')
      assert.deepEqual(credentials, { password: 'fixture password only', code: '123456' })
      this.unlocked = true
      return entries
    },
  }
  const book = remoteBook(local)
  const { host, request } = await setup(t, { remoteBook: book })
  const follower = await followerFor(t, host)
  const first = host.state().devices[0], other = sampleDevice()
  await follower.remoteBook('begin')
  const { session } = await follower.remoteBook('unlock', { password: 'fixture password only', code: '123456', attempt: randomUUID() })
  const args = { session, index: 0 }
  await request('state', other)
  for (const op of ['lock', 'manifestRead']) {
    const result = await request('private-book/' + op, { ...args, device: other })
    assert.equal(result.code, 'PRIVATE_LOCKED')
    assert.equal(result.ok, false)
  }
  const forged = await request('private-book/manifestRead', { ...args, device: { ...other, id: first.id } })
  assert.equal(forged.ok, false)
  assert.match(forged.error, /无法验证本设备/)
  const { bytes } = await follower.remoteBook('manifestRead', args)
  assert.deepEqual(JSON.parse(Buffer.from(bytes, 'base64').toString()), entries)
  host.rotate()
  assert.equal(book.active, false)
  assert.equal(local.unlocked, false)
  await assert.rejects(follower.remoteBook('manifestRead', args), /验证失败/)
})

// Opt-in browser suite for environments with the project's Playwright QA dependency.
test('one click in the mobile settings shows the current sync route and a separate TCP verdict', {
  skip: !process.env.MOMO_PLAYWRIGHT, timeout: 60000,
}, async t => {
  const { chromium } = require(process.env.MOMO_PLAYWRIGHT)
  const { build } = await import('vite')
  const moduleId = '\0paired-network-fixture'
  const bundle = await build({ logLevel: 'error', build: { write: false }, plugins: [{
    name: 'paired-network-ui-fixture', enforce: 'pre',
    resolveId(source, importer) {
      if (source === './mobile-bridge.js' && importer?.endsWith('/src/app.js')) return moduleId
    },
    load(id) {
      if (id !== moduleId) return
      return `import { createMobileBridge as realBridge } from '/src/mobile-bridge.js'
        export function createMobileBridge() {
          const api = realBridge()
          window.probeCalls = []
          return { ...api,
            syncState: async () => ({ role:'mobile', enabled:true, via:'relay', locked:false }),
            testSync: async () => { window.probeCalls.push('route'); return 'relay' },
            testTcpProbe: async () => {
              window.probeCalls.push('probe')
              return new Promise(resolve => { window.completeProbe = status => resolve({ status }) })
            },
          }
        }`
    },
  }] })
  const files = new Map(bundle.output.map(entry => [entry.fileName, entry.code ?? entry.source]))
  const localUrl = 'http://127.0.0.1:51224'
  const browser = await chromium.launch({ channel: process.env.MOMO_BROWSER_CHANNEL || 'chrome', headless: true })
  t.after(() => browser.close())
  const page = await browser.newPage({ viewport: { width: 412, height: 880 }, isMobile: true })
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.route('**/*', route => {
    const url = new URL(route.request().url()), name = url.pathname.slice(1) || 'index.html'
    if (url.origin !== localUrl || !files.has(name)) return route.abort()
    const type = { html:'text/html', js:'text/javascript', css:'text/css', svg:'image/svg+xml', png:'image/png' }
    return route.fulfill({ body: files.get(name), contentType: type[name.split('.').pop()] || 'application/octet-stream' })
  })
  await page.goto(localUrl)
  await page.click('#settings')
  await page.click('#settings-sync')
  const button = page.locator('#sync-test'), status = page.locator('#sync-test-status')
  for (const [verdict, text] of [['direct', '双方已直接收发验证数据'], ['failed', '本次 TCP 直连未打通'], ['observer_unavailable', '本次无法判断是否能直连']]) {
    await button.click()
    await page.waitForFunction(() => typeof window.completeProbe === 'function')
    assert.ok(await button.isDisabled())
    assert.match(await status.textContent(), /当前同步使用加密中继。两端正在测试 TCP 直连/)
    await page.evaluate(value => { window.completeProbe(value); delete window.completeProbe }, verdict)
    await page.waitForFunction(() => !document.getElementById('sync-test').disabled)
    const message = await status.textContent()
    assert.ok(message.startsWith('当前同步使用加密中继。'))
    assert.ok(message.includes(text))
  }
  assert.deepEqual(await page.evaluate(() => window.probeCalls), ['route','probe','route','probe','route','probe'])
  assert.deepEqual(errors, [])
})
