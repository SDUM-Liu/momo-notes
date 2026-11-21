const assert = require('node:assert/strict')
const { createHash, randomBytes } = require('node:crypto')
const { test } = require('node:test')
const { createUpdateFeed } = require('../desktop/update-feed.cjs')
const { createUpdateSource, updateBlockSize } = require('../shared/update-transfer.mjs')
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
  const update = createUpdateSource(async (url, range) => {
    if (url === releasesApi + '/latest') {
      return { status: 200, data: JSON.stringify({ tag_name: 'v' + version, draft: false, prerelease: false, assets: [asset] }) }
    }
    if (url === base + 'latest.yml') {
      return { status: 200, data: `version: ${version}\nfiles:\n  - url: ${name}\n    sha512: ${sha512}\n` }
    }
    assert.equal(url, base + name)
    const [, start, end] = /^bytes=(\d+)-(\d+)$/.exec(range).map(Number)
    read.push(start)
    return { status: 206, range: `bytes ${start}-${end}/${bytes.length}`, data: bytes.subarray(start, end + 1).toString('base64') }
  })

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
    assert.equal((await request('update/block', { channel: 'win', version, offset: 1 })).ok, false)
    assert.equal((await request('update/info', { channel: 'unlisted' })).ok, false)
    assert.match((await request('codex/history')).error, /手机作为主设备时/)
    assert.match((await request('ask')).error, /手机作为主设备时/)
  } finally {
    feed.close()
    host.stop()
  }
})
