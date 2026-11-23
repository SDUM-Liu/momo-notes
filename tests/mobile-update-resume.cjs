const assert = require('node:assert/strict')
const { test } = require('node:test')
const { updateBlockSize: block } = require('../shared/update-transfer.mjs')

async function moduleForTest() {
  const { build } = await import('vite')
  const [bundle] = await build({ configFile: false, logLevel: 'silent',
    define: { __APP_VERSION__: JSON.stringify('0.8.16') },
    plugins: [{ name: 'mock-update-bridge', enforce: 'pre',
      resolveId(id) { if (id === '@capacitor/core') return '\0update-bridge' },
      load(id) {
        if (id === '\0update-bridge') return `
          export const Capacitor = {getPlatform:()=>'android', isPluginAvailable:()=>true}
          export const CapacitorHttp = {get: (...args) => globalThis.updateFixture.check(...args)}
          export const registerPlugin = () => new Proxy({}, {get: (_,key) => async (...args) => globalThis.updateFixture[key](...args)})
        `
      },
    }],
    build: { write: false, lib: { entry: 'src/mobile-updates.js', formats: ['es'] } },
  })
  const code = Buffer.from(bundle.output.find(file => file.type === 'chunk').code).toString('base64')
  return import('data:text/javascript;base64,' + code)
}

test('Android resumes a saved download after restart and switches to direct without forgetting host blocks', async t => {
  const { mobileUpdates } = await moduleForTest()
  const asset = { version: '0.8.17', size: 4 * block, sha256: 'a'.repeat(64), name: 'Momo-Notes-0.8.17-Android.apk' }
  const calls = []
  let bytes = block, install = false
  globalThis.updateFixture = {
    pending: () => ({ target: '', partial: asset, progress: 25 }),
    addListener() {},
    beginRelay(meta) {
      assert.deepEqual(meta, { version: asset.version, size: asset.size, sha256: asset.sha256 })
      return { offset: bytes, status: 'downloading', target: asset.version, progress: 25 }
    },
    appendRelay() { bytes += block; return { status: 'downloading', target: asset.version, progress: 50 } },
    cancelRelay() { calls.push('pause relay') },
    check() { assert.fail('A saved download should not require fresh metadata') },
    download() { assert.equal(bytes, 2 * block); calls.push('direct') },
    open() { install = true; return { status: 'installer-open', target: asset.version } },
  }
  t.after(() => { delete globalThis.updateFixture })
  const updates = mobileUpdates(true, async () => {}, () => (op, { offset }) => {
    assert.equal(op, 'block')
    calls.push(offset)
    if (offset === 2 * block) throw new Error('primary disconnected')
    return 'fixture'
  })
  await updates.checkUpdate()
  assert.deepEqual(calls, [block, 2 * block, 3 * block, 'pause relay', 'direct'])
  assert(install)
})
