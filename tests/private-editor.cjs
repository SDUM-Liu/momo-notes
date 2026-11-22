const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { randomBytes } = require('node:crypto')
const { _electron } = require(process.env.MOMO_PLAYWRIGHT || 'playwright')
const { derive, encrypt, decrypt } = require('../desktop/sealed.cjs')
const { token } = require('../desktop/private-book.cjs')

// Two seconds of 16×16 VP8 video and a one-pixel PNG exercise native decoding.
const video = fs.readFileSync(path.join(__dirname, 'fixtures', 'private-preview.webm'))
const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jf1sAAAAASUVORK5CYII=', 'base64')
// Two seconds of silent, unsigned 8-bit PCM at 8 kHz.
const wavHeader = Buffer.from('UklGRiYAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQIAAAA=', 'base64')
const wavSamples = Buffer.alloc(16000, 128)
wavHeader.writeUInt32LE(36 + wavSamples.length, 4)
wavHeader.writeUInt32LE(wavSamples.length, 40)
const audioSource = 'data:audio/wav;base64,' + Buffer.concat([wavHeader, wavSamples]).toString('base64')

const paragraph = text => ({ type: 'paragraph', content: [{ type: 'text', text }] })
const doc = (...content) => ({ type: 'doc', content })

async function test() {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'momo-private-editor-'))
  const sourceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'momo-media-source-'))
  const largeFile = path.join(sourceDir, 'large.wav')
  const largeSize = 34 * 1024 * 1024 + 65
  const boundary = 30 * 1024 * 1024 - 3
  const marker = Buffer.from([17, 24, 82, 56, 13, 84, 33, 42])
  const largeHeader = Buffer.from(wavHeader)
  largeHeader.writeUInt32LE(largeSize - 8, 4)
  largeHeader.writeUInt32LE(largeSize - 44, 40)
  const audioFd = fs.openSync(largeFile, 'w')
  try {
    fs.writeSync(audioFd, largeHeader)
    fs.ftruncateSync(audioFd, largeSize)
    fs.writeSync(audioFd, marker, 0, marker.length, boundary)
    fs.writeSync(audioFd, marker, 0, marker.length, largeSize - marker.length)
  } finally { fs.closeSync(audioFd) }
  const password = 'fixture-only-password', salt = randomBytes(16), secret = randomBytes(20).toString('base64')
  const filename = path.join(profile, 'private-book.enc'), purpose = 'momo/private-book/v1'
  const legacy = {
    kind: 'daily-pages-v1',
    categories: [{ id: 'todo', name: '密码本' }, { id: 'finds', name: '多媒体' }, { id: 'stories', name: '话题' }],
    notes: {
      '2024-06-01': doc(paragraph('归档内容')),
      '2024-06-02': doc({ type: 'taskList', content: [
        { type: 'taskItem', attrs: { checked: true }, content: [paragraph('旧的已完成文字')] },
      ] }),
      'finds__2024-06-01': doc(paragraph('旧录音说明'), { type: 'noteMedia', attrs: { src: audioSource, alt: '旧录音.wav' } }),
    },
  }
  fs.writeFileSync(filename, JSON.stringify(encrypt(derive(password, salt), salt, { secret, last: -1, entries: [legacy] }, purpose)))
  const app = await _electron.launch({
    executablePath: require('electron'), args: [path.resolve(__dirname, '..')], env: { ...process.env, MOMO_DATA_DIR: profile },
  })
  try {
    const page = await app.firstWindow()
    page.setDefaultTimeout(12000)
    await page.locator('body[data-mode=pet]').waitFor()
    await page.locator('#mascot').click()
    const editor = page.locator('.tiptap')
    await editor.locator('input[type=checkbox]').waitFor()
    await editor.click()
    await page.keyboard.insertText('ordinary-marker')
    await page.locator('#settings').click()
    await page.locator('#project-issues').dragTo(page.locator('#project-repo'))
    await page.locator('#book-password').fill(password)
    await page.locator('#book-code').fill(token(secret, Math.floor(Date.now() / 30000)))
    await page.locator('#book-auth button').click()
    await editor.getByText('旧的已完成文字', { exact: true }).waitFor()
    assert(await page.locator('#question').isDisabled())
    assert(await page.locator('#note-date-line').isHidden())
    assert.equal(await editor.locator('input[type=checkbox], [data-checked], s, del').count(), 0)
    assert(await page.locator('[data-edit=taskList]').isHidden())

    await page.locator('#history').click()
    await page.locator('#dates button').filter({ hasText: '2024-06-01' }).click()
    await editor.getByText('归档内容', { exact: true }).waitFor()
    await page.locator('#return-today').click()
    await editor.getByText('旧的已完成文字', { exact: true }).waitFor()

    await page.getByRole('tab', { name: '多媒体', exact: true }).click()
    const drive = page.locator('#private-drive')
    await drive.waitFor()
    assert(await editor.isHidden())
    const preview = page.locator('dialog.drive-preview[open]')
    const openFile = name => drive.getByRole('button', { name: '预览 ' + name, exact: true }).click()
    const closePreview = () => preview.getByRole('button', { name: '关闭预览' }).click()
    async function checkPlayback(tag) {
      const player = preview.locator(tag + '[controls]')
      await player.waitFor()
      await player.evaluate(async media => {
        media.muted = true
        try { await media.play() } catch (error) {
          if (error.name !== 'AbortError' || !media.ended || media.error || media.currentTime < 0.03) throw error
        }
      })
      await page.waitForFunction(kind => {
        const media = document.querySelector('dialog.drive-preview[open] ' + kind)
        return media && !media.error && media.currentTime >= 0.03
      }, tag)
    }
    await openFile('旧录音.wav')
    await checkPlayback('audio')
    await page.waitForFunction(() => document.querySelector('dialog.drive-preview[open] audio')?.duration > 0)
    await closePreview()

    const chooser = page.waitForEvent('filechooser')
    await drive.getByRole('button', { name: '上传文件', exact: true }).click()
    await (await chooser).setFiles([
      { name: 'sample.png', mimeType: 'image/png', buffer: image },
      { name: 'sample.webm', mimeType: 'video/webm', buffer: video },
    ])
    await openFile('sample.png')
    await page.waitForFunction(() => document.querySelector('dialog.drive-preview[open] img')?.naturalWidth === 1)
    await closePreview()
    await openFile('sample.webm')
    await checkPlayback('video')
    await page.waitForFunction(() => document.querySelector('dialog.drive-preview[open] video')?.videoWidth === 16)
    await closePreview()
    await openFile('sample.png')
    await preview.getByRole('button', { name: '删除文件', exact: true }).click()
    await page.getByRole('button', { name: '确认删除', exact: true }).click()
    await drive.getByRole('button', { name: '预览 sample.png', exact: true }).waitFor({ state: 'hidden' })

    const partial = path.join(sourceDir, 'partial.webm')
    fs.writeFileSync(partial, video)
    const mediaDir = path.join(profile, 'private-media-v1')
    await page.waitForFunction(() => !document.querySelector('.drive-upload').disabled)
    const beforeFailure = fs.readdirSync(mediaDir).sort()
    const input = drive.locator('input[type=file]')
    // Pause while the second file is being read, after the first file finished.
    await page.evaluate(() => {
      const slice = File.prototype.slice
      File.prototype.slice = function(start, ...rest) {
        const blob = slice.call(this, start, ...rest)
        if (this.name === 'large.wav' && start === 1024 * 1024) {
          File.prototype.slice = slice
          const read = blob.arrayBuffer.bind(blob)
          blob.arrayBuffer = async () => {
            await new Promise(resolve => { window.resumeFileRead = resolve })
            return read()
          }
        }
        return blob
      }
    })
    await input.setInputFiles([partial, largeFile])
    await page.waitForFunction(() => typeof window.resumeFileRead === 'function')
    await drive.getByRole('button', { name: '取消上传' }).click()
    await page.evaluate(() => { window.resumeFileRead(); delete window.resumeFileRead })
    await drive.getByRole('status').filter({ hasText: '已取消上传' }).waitFor()
    assert.deepEqual(fs.readdirSync(mediaDir).sort(), beforeFailure)
    assert.equal(await drive.getByRole('button', { name: '预览 partial.webm' }).count(), 0)

    // Simulate ENOSPC at the last step, when the files exist but the new
    // manifest has not yet been published. Only affect this fixture's vault.
    await app.evaluate((_, filename) => {
      const fs = process.getBuiltinModule('node:fs'), rename = fs.renameSync
      fs.renameSync = function(from, to) {
        if (to === filename) {
          fs.renameSync = rename
          throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' })
        }
        return rename.apply(this, arguments)
      }
    }, filename)
    await input.setInputFiles(partial)
    await drive.getByRole('status').filter({ hasText: '存储空间不足' }).waitFor()
    assert.deepEqual(fs.readdirSync(mediaDir).sort(), beforeFailure)
    assert.equal(await drive.getByRole('button', { name: '预览 partial.webm' }).count(), 0)

    // A large attachment selected in a private text page uses the same drive,
    // while small files in the same selection stay inline.
    await page.getByRole('tab', { name: '话题', exact: true }).click()
    const prompt = page.getByRole('dialog', { name: '保存到私密多媒体？' })
    async function attachFromText(selection) {
      const chooser = page.waitForEvent('filechooser')
      await page.locator('#insert-image').click()
      await (await chooser).setFiles(selection)
    }
    await attachFromText(largeFile)
    await prompt.getByRole('button', { name: '取消', exact: true }).click()
    assert(await drive.isHidden())
    assert.deepEqual(fs.readdirSync(mediaDir).sort(), beforeFailure)
    await attachFromText([partial, largeFile])
    await prompt.waitFor()
    assert.equal(await editor.locator('video[src^="data:video/"]').count(), 1)
    await prompt.getByRole('button', { name: '上传到多媒体' }).click()
    await openFile('large.wav')
    await checkPlayback('audio')
    const largePlayer = preview.locator('audio')
    const url = await largePlayer.evaluate(m => m.currentSrc)
    for (const start of [boundary, largeSize - marker.length]) {
      const result = await app.evaluate(async ({ session }, { url, start, length }) => {
        const res = await session.defaultSession.fetch(url, { headers: { Range: 'bytes=' + start + '-' + (start + length - 1) } })
        return [res.status, Array.from(new Uint8Array(await res.arrayBuffer()))]
      }, { url, start, length: marker.length })
      assert.deepEqual(result, [206, [...marker]])
    }
    await largePlayer.evaluate(m => { m.currentTime = m.duration - 1 })
    await page.waitForFunction(() => {
      const m = document.querySelector('dialog[open] audio')
      return m && !m.seeking && m.currentTime > 4000
    })
    await closePreview()

    await page.getByRole('tab', { name: '话题', exact: true }).click()
    await editor.locator('p').first().waitFor()
    assert.equal(await editor.locator('input[type=checkbox], [data-checked]').count(), 0)
    await editor.locator('p').first().click()
    await page.keyboard.insertText('private-marker')
    await page.locator('#table-tools').click()
    await page.locator('[data-table=insertTable]').click()
    await editor.locator('table').waitFor()
    await page.locator('#new-category').click()
    await page.locator('#category-name').fill('自定义')
    await page.locator('#category-form button[type=submit]').click()
    await page.getByRole('tab', { name: '自定义' }).waitFor()
    await page.locator('#book-return').click()
    await editor.getByText('ordinary-marker', { exact: true }).waitFor()
    await editor.locator('input[type=checkbox]').waitFor()
    assert(await page.locator('#book-return').isHidden())
    assert.equal(await page.getByRole('button', { name: '预览 sample.webm' }).count(), 0)
    await editor.click()
    await page.keyboard.press('Control+z')
    assert(!(await editor.innerText()).includes('private-marker'))

    const stored = decrypt(password, JSON.parse(fs.readFileSync(filename, 'utf8')), purpose).value.entries[0]
    assert.equal(stored.kind, 'fixed-pages-v1')
    assert.equal(stored.homes.todo, '2024-06-02')
    assert.deepEqual(stored.files.map(file => file.name).sort(), ['sample.webm', 'large.wav', '旧录音.wav'].sort())
    assert(stored.files.some(file => file.name === '旧录音.wav' && file.src === audioSource))
    for (const [name, size] of [['sample.webm', video.length], ['large.wav', largeSize]]) {
      const file = stored.files.find(f => f.name === name)
      assert(file.id && file.mime && file.storage === 'chunks-v1' && file.size === size && !file.src)
    }
    assert(stored.categories.some(category => category.name === '自定义'))
    const topic = JSON.stringify(stored.notes['stories__' + stored.homes.stories])
    assert(topic.includes('private-marker') && topic.includes('"type":"table"'))
    assert(topic.includes('partial.webm') && topic.includes('"type":"noteMedia"'))
    assert(!topic.includes('large.wav'))
    assert(JSON.stringify(stored.notes).includes('旧录音说明'))
    for (const name of fs.readdirSync(path.join(profile, 'notes'))) {
      const ordinary = fs.readFileSync(path.join(profile, 'notes', name), 'utf8')
      assert(!ordinary.includes('private-marker') && !ordinary.includes('旧录音'))
    }
    console.log('PASS private home and archive, task conversion, native previews, 34 MiB upload with cross-chunk and tail byte ranges, cancellation, ENOSPC recovery, deletion and lock isolation')
  } finally {
    await app.close()
    fs.rmSync(profile, { recursive: true, force: true })
    fs.rmSync(sourceDir, { recursive: true, force: true })
  }
}

test().catch(error => { console.error(error); process.exitCode = 1 })
