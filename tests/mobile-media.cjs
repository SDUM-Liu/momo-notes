const assert = require('node:assert/strict')
const http = require('node:http')
const { chromium } = require(process.env.MOMO_PLAYWRIGHT || 'playwright')

async function test() {
  const { build } = await import('vite')
  const modules = ['src/mobile-bridge.js','src/mobile-media.js','src/private-drive.js','src/mobile-sealed.js','shared/authenticator.mjs']
  const entry = Object.fromEntries(modules.map(name => [name, './' + name]))
  const bundle = await build({
    logLevel: 'error',
    build: { write: false, lib: { entry, formats: ['es'], fileName: (_format, name) => name } },
  })
  const assets = new Map([].concat(bundle).flatMap(output => output.output.map(asset =>
    ['/' + asset.fileName, asset.type === 'chunk' ? asset.code : asset.source])))
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost').pathname
    if (url === '/') { res.setHeader('Content-Type', 'text/html'); res.end('<meta charset=utf-8>'); return }
    if (!assets.has(url)) { res.writeHead(404).end(); return }
    res.setHeader('Content-Type', 'text/javascript'); res.end(assets.get(url))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  let browser
  try {
    browser = await chromium.launch({
      channel: process.env.MOMO_BROWSER_CHANNEL || (process.platform === 'win32' ? 'msedge' : undefined),
      args: ['--autoplay-policy=no-user-gesture-required'],
    })
    const page = await browser.newPage({ isMobile: true, hasTouch: true, viewport: { width: 390, height: 800 } })
    await page.goto('http://127.0.0.1:' + server.address().port)
    const outcome = await page.evaluate(async largeFile => {
      const { createMobileBridge } = await import('/src/mobile-bridge.js')
      const { mobileMedia, chunkSize } = await import('/src/mobile-media.js')
      const { wirePrivateDrive } = await import('/src/private-drive.js')
      const { totp } = await import('/shared/authenticator.mjs')
      const { bytes: fromBase64, openBox } = await import('/src/mobile-sealed.js')
      const expect = (ok, message) => { if (!ok) throw new Error(message) }
      const rejects = async (promise, message) => { try { await promise } catch { return }; throw new Error(message) }
      const api = createMobileBridge()
      await api.getState()
      const book = api.privateBook
      const raw = mobileMedia('')
      const size = chunkSize + 8000
      let id = crypto.randomUUID(), meta = { id, size, mime: 'audio/wav' }
      const wav = new Uint8Array(size).fill(128)
      wav.set(fromBase64('UklGRiYAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQIAAAA='))
      const view = new DataView(wav.buffer)
      view.setUint32(4, size - 8, true); view.setUint32(40, size - 44, true)
      await rejects(book('mediaPreview', { id }), 'replica could read media')
      await api.selectSyncRole('host')
      const enrollment = await book('begin')
      const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
      const encoded = new URL(enrollment.uri).searchParams.get('secret')
      const binary = Array.from(encoded, char => alphabet.indexOf(char).toString(2).padStart(5, '0')).join('')
      const seed = Uint8Array.from(binary.match(/.{8}/g), byte => parseInt(byte, 2))
      const password = 'mobile-media-integration-secret'
      const counter = Math.floor(Date.now() / 30000)
      await book('unlock', { password, code: totp(seed, counter) })
      await book('mediaBegin', meta)
      await book('mediaWrite', { id, index: 0, bytes: wav.subarray(0, chunkSize) })
      expect((await raw.list()).length === 0, 'incomplete upload visible to migration')
      await rejects(book('mediaFinish', { id }), 'accepted incomplete upload')
      await book('mediaWrite', { id, index: 1, bytes: wav.subarray(chunkSize) })
      await book('mediaFinish', { id })
      await rejects(book('mediaPreview', { id }), 'preview allowed before manifest commit')
      await book('mediaRemove', { id })

      const container = document.body.appendChild(document.createElement('section'))
      let files = []
      const drive = wirePrivateDrive(container, { media: book, save: async next => {
        await book('save', { entries: [{ kind: 'fixed-pages-v1', files: next }] }); files = next
      } })
      drive.show([])
      const selected = new DataTransfer()
      selected.items.add(new File([wav], '录音.wav', { type: 'audio/wav' }))
      const input = container.querySelector('input[type=file]')
      const reader = FileReader.prototype.readAsDataURL
      const readBuffer = FileReader.prototype.readAsArrayBuffer
      const forbid = function () { throw new Error('whole-file read') }
      Object.defineProperty(File.prototype, 'arrayBuffer', { value: forbid, configurable: true })
      FileReader.prototype.readAsDataURL = FileReader.prototype.readAsArrayBuffer = forbid
      try {
        input.files = selected.files; input.dispatchEvent(new Event('change')); await drive.flush()
        expect(files.length === 1 && files[0].storage === 'chunks-v1' && !files[0].src, 'picker failed to upload using chunked slices')
      } finally {
        delete File.prototype.arrayBuffer
        FileReader.prototype.readAsDataURL = reader; FileReader.prototype.readAsArrayBuffer = readBuffer
        drive.hide()
      }
      id = files[0].id; meta = { id, size, mime: 'audio/wav' }
      await rejects(book('mediaRemove', { id }), 'deleted attachment still in manifest')
      if (largeFile) {
        // A file-backed object composed from reused blocks avoids a 129 MiB JS fixture.
        const block = new Blob([wav.subarray(0, chunkSize)])
        const selection = new DataTransfer()
        selection.items.add(new File(Array(129).fill(block), 'large.webm', { type: 'video/webm' }))
        drive.show(files)
        const picker = container.querySelector('input[type=file]')
        Object.defineProperty(File.prototype, 'arrayBuffer', { value: forbid, configurable: true })
        FileReader.prototype.readAsDataURL = FileReader.prototype.readAsArrayBuffer = forbid
        try {
          picker.files = selection.files; picker.dispatchEvent(new Event('change')); await drive.flush()
          expect(files.length === 2 && files[1].size === 129 * chunkSize, 'large file missing from manifest')
          const large = files[1]
          const url = await book('mediaPreview', { id: large.id })
          const tail = await fetch(url, { headers: { Range: 'bytes=' + (large.size - 18) + '-' } })
          expect(tail.status === 206 && (await tail.arrayBuffer()).byteLength === 18, 'large-file range unavailable')
          await book('mediaRelease', { id: large.id })
          files = [files[0]]; await book('save', { entries: [{ kind: 'fixed-pages-v1', files }] })
          await book('mediaRemove', { id: large.id })
        } finally {
          delete File.prototype.arrayBuffer
          FileReader.prototype.readAsDataURL = reader; FileReader.prototype.readAsArrayBuffer = readBuffer
          drive.hide()
        }
      }
      expect((await raw.list())[0]?.size === size, 'missing media catalog entry')
      const staged = mobileMedia('test-promotion/')
      const db = await new Promise(resolve => { const r = indexedDB.open('momo-notes'); r.onsuccess = () => resolve(r.result) })
      const envelope = await new Promise(resolve => {
        const r = db.transaction('settings').objectStore('settings').get('private-book'); r.onsuccess = () => resolve(r.result)
      })
      const opened = await openBox(password, envelope, 'momo/private-book/v1')
      for (let i = 0; i < 2; i++) {
        const block = await raw.readRaw(id, i)
        const params = { name: 'AES-GCM', iv: block.subarray(0, 12), additionalData: new TextEncoder().encode('momo/private-media/v1/' + id + '/' + i) }
        const clear = new Uint8Array(await crypto.subtle.decrypt(params, opened.key, block.subarray(12)))
        expect(clear.length === block.length - 28 && clear.every((v, j) => v === wav[i * chunkSize + j]), 'incompatible chunk ciphertext')
        await staged.writeRaw(meta, i, block)
        await staged.writeRaw(meta, i, block)
        block[0] ^= 1
        await rejects(staged.writeRaw(meta, i, block), 'overwrote previously acknowledged chunk')
      }
      await staged.finishRaw(meta)
      const stagedTail = await staged.readRaw(id, 1), localTail = await raw.readRaw(id, 1)
      expect(stagedTail.length === localTail.length && stagedTail.every((byte, i) => byte === localTail[i]), 'staged attachment unreadable')
      await staged.clear()
      expect((await staged.list()).length === 0 && (await raw.list()).length === 1, 'staged and primary stores overlap')

      async function checkPlayback(url) {
        const response = await fetch(url, { headers: { Range: 'bytes=' + chunkSize + '-' + (chunkSize + 15) } })
        expect(response.status === 206 && (await response.arrayBuffer()).byteLength === 16, 'range seeking unavailable')
        const audio = document.createElement('audio')
        try {
          const event = name => new Promise((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('media event timed out: ' + name)), 7000)
            audio.addEventListener(name, () => { clearTimeout(timeout); resolve() }, { once: true })
          })
          const loaded = event('loadedmetadata')
          audio.src = url; document.body.append(audio); await loaded
          const target = (chunkSize - 44) / 8000 - 0.1
          const seeking = event('seeked'); audio.currentTime = target; await seeking
          await audio.play()
          const start = performance.now()
          while (audio.currentTime <= target + 0.13 && performance.now() - start < 5000) await new Promise(r => setTimeout(r, 50))
          expect(audio.currentTime > target + 0.13, 'playback stalled on chunk boundary')
        } finally { audio.pause(); audio.removeAttribute('src'); audio.load(); audio.remove() }
      }

      const first = await book('mediaPreview', { id })
      await checkPlayback(first)
      const root = await navigator.storage.getDirectory()
      const folder = await root.getDirectoryHandle('momo-private-preview-default')
      async function visibleFiles(dir) { const names = []; for await (const name of dir.keys()) names.push(name); return names.length }
      expect(await visibleFiles(folder) === 1, 'OPFS did not stage a single preview file')
      await book('mediaRelease', { id })
      await rejects(fetch(first), 'released preview remained readable')
      expect(await visibleFiles(folder) === 0, 'OPFS retained plaintext after release')
      const preview = book('mediaPreview', { id })
      const canceled = rejects(preview, 'preview survived immediate close')
      await Promise.all([book('mediaRelease', { id }), canceled])
      // Simulate a WebView without OPFS. IndexedDB is still the real browser implementation.
      Object.defineProperty(navigator.storage, 'getDirectory', { value: undefined, configurable: true })
      const fallback = await book('mediaPreview', { id })
      await checkPlayback(fallback)
      const mediaDb = await new Promise(resolve => { const r = indexedDB.open('momo-private-media-v1:'); r.onsuccess = () => resolve(r.result) })
      const temporaryBlobs = () => new Promise(resolve => {
        const r = mediaDb.transaction('preview').objectStore('preview').count(); r.onsuccess = () => resolve(r.result)
      })
      expect(await temporaryBlobs() === 2, 'fallback did not split preview into disk-backed Blobs')
      const abandoned = { ...meta, id: crypto.randomUUID() }
      await book('mediaBegin', abandoned)
      const writing = book('mediaWrite', { id: abandoned.id, index: 0, bytes: wav.subarray(0, chunkSize) })
      const interrupted = rejects(writing, 'write survived lock')
      await Promise.all([book('lock'), interrupted])
      expect(await temporaryBlobs() === 0, 'fallback retained plaintext after lock')
      await rejects(fetch(fallback), 'lock failed to revoke fallback preview')
      await rejects(book('mediaPreview', { id }), 'locked book could preview')
      delete navigator.storage.getDirectory
      await new Promise(r => setTimeout(r, 1510))
      const entries = await book('unlock', { password, code: totp(seed, counter + 1) })
      expect(entries[0]?.files[0]?.id === id, 'book lost metadata')
      await book('mediaBegin', abandoned) // proves interrupted partial was removed
      await book('mediaAbort', { id: abandoned.id })
      const last = await book('mediaPreview', { id })
      const message = await api.selectSyncRole('follower').then(() => '', error => error.message)
      expect(message.includes('请先迁移附件至新主设备'), 'manual demotion must preserve untransferred attachments')
      expect((await api.getState()).mobileHost && (await raw.info(id)).size === size, 'manual demotion lost primary data')
      // The migration path clears the source after successful promotion. A manually emptied
      // file area must also allow an ordinary role change.
      await book('save', { entries: [{ kind: 'fixed-pages-v1', files: [] }] })
      await book('mediaRemove', { id })
      await api.selectSyncRole('follower')
      await rejects(fetch(last), 'preview remained readable after removal/role change')
      await rejects(book('mediaRemove', { id }), 'replica could delete files')
      return { mobileHost: (await api.getState()).mobileHost, remaining: (await raw.list()).length }
    }, Boolean(process.env.MOMO_LARGE_MEDIA))
    assert.deepEqual(outcome, { mobileHost: false, remaining: 0 })
    console.log('Mobile attachment encryption, migration, OPFS/IndexedDB playback and lock isolation passed.')
  } finally { await browser?.close(); await new Promise(resolve => server.close(resolve)) }
}

test().catch(error => { console.error(error); process.exitCode = 1 })
