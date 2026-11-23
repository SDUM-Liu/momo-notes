const assert = require('node:assert/strict')
const { createHash, randomBytes } = require('node:crypto')
const { test } = require('node:test')
const { createUpdateFeed } = require('../desktop/update-feed.cjs')
const { desktopUpdateSource } = require('../desktop/update-source.cjs')
const { updateBlockSize } = require('../shared/update-transfer.mjs')
const { createHostSync } = require('../shared/host-sync.mjs')
const { releasePage, releasesApi } = require('../shared/installers.mjs')
const { seal, unseal } = require('../shared/sync.mjs')

test('paired desktop updates use the primary device for the manifest and all installer data', async () => {
  const bytes = Buffer.alloc(updateBlockSize * 3 + 3)
  for (let index = 0; index < bytes.length; index++) bytes[index] = index % 251
  const version = '0.8.0'
  const name = 'Momo-Notes-' + version + '-Setup-x64.exe'
  const base = releasePage + '/download/v' + version + '/'
  const sha512 = createHash('sha512').update(bytes).digest('base64')
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  const asset = { id: 1, state: 'uploaded', name, size: bytes.length, digest: 'sha256:' + sha256, browser_download_url: base + name }
  const read = []
  const routed = { proxy: 0, system: 0, direct: 0 }
  const sessions = {
    defaultSession: { async fetch() { ++routed.system; throw new Error('net::ERR_CONNECTION_RESET') } },
    fromPartition(name) {
      if (name === 'momo-update-proxy') return {
        async setProxy(options) {
          assert.deepEqual(options, { mode: 'fixed_servers', proxyRules: 'http://127.0.0.1:7890' })
        },
        async closeAllConnections() {},
        async fetch() { ++routed.proxy; throw new Error('net::ERR_CONNECTION_RESET') },
      }
      assert.equal(name, 'momo-update-direct')
      return {
        async setProxy(options) { assert.deepEqual(options, { mode: 'direct' }) },
        async fetch(url, { headers }) {
          ++routed.direct
          return upstream(url, headers.Range)
        },
      }
    },
  }
  const update = desktopUpdateSource(() => '7890', sessions)

  function upstream(url, range) {
    if (url === releasesApi + '/latest') {
      return Response.json({ tag_name: 'v' + version, draft: false, prerelease: false, assets: [asset] })
    }
    if (url === base + 'latest.yml') {
      return new Response(`version: ${version}\nfiles:\n  - url: ${name}\n    sha512: ${sha512}\n`)
    }
    assert.equal(url, base + name)
    const [, start, end] = /^bytes=(\d+)-(\d+)$/.exec(range).map(Number)
    read.push(start)
    return new Response(bytes.subarray(start, end + 1), { status: 206, headers: { 'Content-Range': `bytes ${start}-${end}/${bytes.length}` } })
  }

  const config = {}
  const host = createHostSync({ config, defaults: { url: 'https://relay.example.com' }, update,
    notify() {}, persist() {} })
  host.setEnabled(true)
  async function request(op, data) {
    const id = randomBytes(12).toString('hex')
    const wire = seal(config.key, 'request', { id, time: Date.now(), op, payload: data })
    return unseal(config.key, 'reply/' + id, await host.exchange(wire))
  }
  const feed = createUpdateFeed(async ({ id, op, data }) => {
    try { feed.reply(id, await request('update/' + op, data)) }
    catch (error) { feed.reply(id, { ok: false, error: error.message }) }
  }, 'win')
  try {
    const origin = await feed.open()
    const manifest = await (await fetch(origin + 'latest.yml')).json()
    assert.equal(manifest.version, version)
    assert.equal(manifest.files[0].sha512, sha512)
    assert.equal((await fetch(origin + 'unlisted.exe')).status, 404)
    const download = await fetch(origin + name)
    assert.equal(download.status, 200)
    assert.deepEqual(Buffer.from(await download.arrayBuffer()), bytes)
    assert.deepEqual(read.sort((a, b) => a - b), [0, updateBlockSize, 2 * updateBlockSize, 3 * updateBlockSize])
    assert.deepEqual(routed, { proxy: 1, system: 1, direct: 6 })
    assert.equal((await request('update/block', { channel: 'win', version, offset: 1 })).ok, false)
    assert.equal((await request('update/info', { channel: 'unlisted' })).ok, false)
    assert.match((await request('codex/history')).error, /手机作为主设备时/)
    assert.match((await request('ask')).error, /手机作为主设备时/)
  } finally {
    feed.close()
    host.stop()
  }
})

test('a failed upstream gives the paired device an actionable primary-device error', async () => {
  const down = {
    async setProxy() {},
    async fetch() { throw new Error('net::ERR_CONNECTION_RESET') },
  }
  const source = desktopUpdateSource(() => '', { defaultSession: down, fromPartition: () => down })
  await assert.rejects(source('info', { channel: 'android' }), /请检查主设备网络或代理/)
})
