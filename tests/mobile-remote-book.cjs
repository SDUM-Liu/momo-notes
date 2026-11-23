const assert = require('node:assert/strict')
const fs = require('node:fs')
const http = require('node:http')
const net = require('node:net')
const os = require('node:os')
const path = require('node:path')
const { randomBytes, randomUUID, createCipheriv, createDecipheriv } = require('node:crypto')
const { spawn } = require('node:child_process')
const { setTimeout: delay } = require('node:timers/promises')
const { chromium, _electron } = require(process.env.MOMO_PLAYWRIGHT || 'playwright')
const { derive, encrypt, decrypt } = require('../desktop/sealed.cjs')
const { token } = require('../desktop/private-book.cjs')
const { localDay, openStore } = require('../desktop/data.cjs')

const root = path.resolve(__dirname, '..')
const dist = path.join(root, 'dist')
const mime = { '.html':'text/html', '.js':'application/javascript', '.css':'text/css', '.png':'image/png' }
const doc = text => ({ type:'doc', content:[{ type:'paragraph', content:[{ type:'text', text }] }] })
const ordinary = 'ordinary note ' + randomUUID()
const original = 'private note ' + randomUUID()
const edited = 'phone edit ' + randomUUID()
const password = 'fixture password ' + randomUUID()
const secret = randomBytes(20).toString('base64')
const purpose = 'momo/private-book/v1'

function seed(profile) {
  const day = localDay()
  openStore(profile).saveNote(day, doc(ordinary))
  const entries = [{
    kind:'fixed-pages-v1', categories:[{id:'todo',name:'密码本'}, {id:'finds',name:'多媒体'}, {id:'stories',name:'话题'}],
    homes:{ todo:day }, notes:{ [day]:doc(original) }, files:[],
  }]
  const salt = randomBytes(16), key = derive(password, salt)
  try {
    const box = encrypt(key, salt, { entries, last:-1, secret }, purpose)
    fs.writeFileSync(path.join(profile,'private-book.enc'), JSON.stringify(box))
  } finally { key.fill(0) }
}

async function listen(server) {
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve))
  return server.address().port
}

async function startRelay() {
  const temporary = net.createServer(), port = await listen(temporary)
  await new Promise(resolve => temporary.close(resolve))
  const relay = spawn(process.execPath, [path.join(root, 'relay/server.mjs')], {
    env:{ ...process.env, PORT:String(port) }, windowsHide:true, stdio:['ignore','pipe','ignore'],
  })
  await new Promise((resolve, reject) => {
    relay.stdout.once('data', resolve)
    relay.once('error', reject)
    relay.once('exit', () => reject(new Error('Temporary relay did not start')))
  })
  return { relay, url:'http://127.0.0.1:' + port }
}

async function pairHost(app, url) {
  const page = await app.firstWindow()
  await page.locator('body[data-mode=pet] #mascot').click()
  await page.locator('#settings').click()
  await page.locator('#settings-sync').click()
  await page.locator('#sync-relay-settings summary').click()
  await page.locator('#sync-relay').fill(url)
  await page.locator('#sync-fallback').fill('')
  await page.locator('#sync-enable').click()
  await page.waitForFunction(() => document.getElementById('sync-code').value.startsWith('momo2:'))
  return page.locator('#sync-code').inputValue()
}

async function configurePhone(page, secure) {
  const deviceKey = randomBytes(32)
  await page.exposeFunction('fixtureNative', (plugin, method, options) => {
    if (plugin === 'App' && method === 'getLaunchUrl' || plugin === 'MomoSync' && method === 'updateWidget') return {}
    if (plugin === 'MomoUpdates' && method === 'pending') return { status:'ready', target:'' }
    if (plugin === 'SecureStorage') {
      if (method === 'internalGetItem') {
        const value = secure.get(options.prefixedKey)
        if (!value) return { data:null }
        const decipher = createDecipheriv('aes-256-gcm', deviceKey, value.iv)
        decipher.setAuthTag(value.tag)
        return { data:Buffer.concat([decipher.update(value.data), decipher.final()]).toString('utf8') }
      }
      if (method === 'internalSetItem') {
        const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', deviceKey, iv)
        const data = Buffer.concat([cipher.update(options.data), cipher.final()])
        secure.set(options.prefixedKey, { iv, data, tag:cipher.getAuthTag() })
        return {}
      }
      if (method === 'internalRemoveItem') { secure.delete(options.prefixedKey); return {} }
    }
    throw new Error('Unexpected Android call ' + plugin + '.' + method)
  })
  await page.addInitScript(() => {
    // Force the encrypted relay route so cutting the temporary relay is deterministic.
    window.RTCPeerConnection = undefined
    window.androidBridge = {}
    const methods = names => names.map(name => ({ name, rtype:name === 'addListener' ? 'callback' : 'promise' }))
    const events = new Map()
    window.fixtureForeground = isActive => events.get('App.appStateChange')({ isActive })
    window.Capacitor = {
      PluginHeaders:[
        { name:'App', methods:methods(['getLaunchUrl','addListener']) },
        { name:'SecureStorage', methods:methods(['internalGetItem','internalSetItem','internalRemoveItem']) },
        { name:'MomoSync', methods:methods(['updateWidget']) },
        { name:'MomoUpdates', methods:methods(['pending','addListener']) },
        { name:'InAppBrowser', methods:methods(['addListener']) },
      ],
      nativePromise:window.fixtureNative,
      async nativeCallback(plugin, method, args, callback) {
        if (method !== 'addListener') throw new Error('Unexpected callback ' + method)
        events.set(plugin + '.' + args.eventName, callback)
        return args.eventName
      },
    }
  })
}

async function unlock(page, secretStep, remembered = false) {
  await page.locator('#settings').click()
  const from = page.locator('#project-issues'), to = page.locator('#project-repo')
  await from.scrollIntoViewIfNeeded()
  await to.scrollIntoViewIfNeeded()
  const center = box => ({ x:box.x + box.width / 2, y:box.y + box.height / 2 })
  const start = center(await from.boundingBox()), end = center(await to.boundingBox())
  const session = await page.context().newCDPSession(page)
  try {
    for (const [type, points] of [['touchStart',[start]], ['touchMove',[end]], ['touchEnd',[]]]) {
      await session.send('Input.dispatchTouchEvent', { type, touchPoints:points })
    }
  } finally { await session.detach() }
  await page.locator('#book-code:enabled').waitFor()
  assert(await page.locator('#book-qr').isHidden(), 'A follower should use the existing enrollment')
  if (remembered) assert(await page.locator('#book-password').isHidden())
  else await page.locator('#book-password').fill(password)
  const step = Math.max(Math.floor(Date.now() / 30000), secretStep ?? 0)
  await page.locator('#book-code').fill(token(secret, step))
  await page.locator('#book-auth button[type="submit"]').click()
  await page.locator('#book-return').waitFor()
  await page.locator('#book-dialog').waitFor({state:'hidden'})
  return step
}

async function checkStorage(page, secure) {
  const markers = [original, edited, password]
  const result = await page.evaluate(async markers => {
    const found = text => markers.some(marker => text.includes(marker))
    const request = req => new Promise((ok, fail) => {
      req.onsuccess = () => ok(req.result); req.onerror = () => fail(req.error)
    })
    async function contains(value) {
      if (typeof value === 'string') return found(value)
      if (value instanceof Blob) return found(await value.text())
      if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return found(new TextDecoder().decode(value))
      if (!value || typeof value !== 'object') return false
      for (const [key, child] of Object.entries(value)) if (found(key) || await contains(child)) return true
      return false
    }
    const scanned = [], leaks = []
    for (const {name} of await indexedDB.databases()) {
      const db = await request(indexedDB.open(name))
      try {
        for (const storeName of db.objectStoreNames) {
          const store = db.transaction(storeName).objectStore(storeName)
          const contents = await Promise.all([request(store.getAllKeys()), request(store.getAll())])
          const label = db.name + '/' + storeName
          scanned.push(label)
          if (await contains(contents)) leaks.push(label)
        }
      } finally { db.close() }
    }
    for (const [name, storage] of [['localStorage', localStorage],['sessionStorage', sessionStorage]]) {
      if (await contains({...storage})) leaks.push(name)
    }
    return { scanned, leaks }
  }, markers)
  assert(result.scanned.includes('momo-notes/notes') && result.scanned.includes('momo-notes/settings'))
  assert.deepEqual(result.leaks, [])
  assert(!markers.some(marker => JSON.stringify([...secure]).includes(marker)), 'Private data entered mobile secure preferences')
}

async function lockedScreen(page) {
  await page.locator('#book-return').waitFor({state:'hidden'})
  assert(await page.locator('#book-dialog').isHidden())
  assert.equal(await page.locator('#book-password').inputValue(), '')
  assert.equal(await page.locator('#book-code').inputValue(), '')
  assert(await page.evaluate(markers => !markers.some(marker => document.body.textContent.includes(marker)), [original, edited]))
}

async function main() {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'momo-remote-e2e-')), secure = new Map()
  const web = http.createServer((req, res) => {
    const route = new URL(req.url, 'http://localhost').pathname
    const file = path.resolve(dist, '.' + (route === '/' ? '/index.html' : route))
    if (!file.startsWith(dist + path.sep) || !fs.existsSync(file)) return res.writeHead(404).end()
    res.writeHead(200, { 'Content-Type':mime[path.extname(file)] || 'application/octet-stream' })
    fs.createReadStream(file).pipe(res)
  })
  let relay, host, browser
  try {
    seed(profile)
    const port = await listen(web)
    const service = await startRelay()
    relay = service.relay
    host = await _electron.launch({ executablePath:require('electron'), args:[root], env:{ ...process.env, MOMO_DATA_DIR:profile } })
    const code = await pairHost(host, service.url)
    browser = await chromium.launch({ channel:process.env.MOMO_BROWSER_CHANNEL || (process.platform === 'win32' ? 'msedge' : undefined) })
    const page = await browser.newPage({ viewport:{ width:392, height:850 }, hasTouch:true, isMobile:true })
    await configurePhone(page, secure)
    await page.goto('http://127.0.0.1:' + port)
    await page.locator('#settings').click()
    await page.locator('#settings-sync').click()
    await page.locator('#sync-pair-code').fill(code)
    await page.locator('#sync-pair').click()
    await page.waitForFunction(() => document.getElementById('sync-status').textContent.includes('加密中继'))
    await page.locator('#sync-back').click()
    await page.locator('#settings-view .back').click()
    const editor = page.locator('.tiptap')
    await editor.getByText(ordinary, {exact:true}).waitFor()
    const step = await unlock(page)
    await editor.getByText(original, {exact:true}).waitFor()
    assert(await page.locator('#question').isDisabled())
    await editor.click()
    await page.keyboard.press('Control+End')
    await page.keyboard.press('Enter')
    await page.keyboard.insertText(edited)
    await editor.getByText(edited, {exact:true}).waitFor()
    // Authenticate and decrypt the temporary host file independently of both UIs.
    let saved = false
    const deadline = Date.now() + 10000, filename = path.join(profile, 'private-book.enc')
    while (!saved && Date.now() < deadline) {
      const box = fs.readFileSync(filename, 'utf8')
      assert(!box.includes(original) && !box.includes(edited))
      const plain = decrypt(password, JSON.parse(box), purpose)
      try {
        const notes = JSON.stringify(plain.value.entries[0].notes)
        saved = notes.includes(original) && notes.includes(edited)
      } finally { plain.key.fill(0) }
      if (!saved) await delay(150)
    }
    assert(saved, 'The follower edit was not committed to the encrypted primary file')
    await checkStorage(page, secure)
    await page.evaluate(() => window.fixtureForeground(false))
    await lockedScreen(page)
    await editor.getByText(ordinary, {exact:true}).waitFor()
    await page.evaluate(() => window.fixtureForeground(true))
    // Leave the host's independent 1.5 s authentication throttle intact.
    await delay(1600)
    await unlock(page, step + 1, true)
    await editor.getByText(edited, {exact:true}).waitFor()
    relay.kill()
    await lockedScreen(page)
    await checkStorage(page, secure)
    console.log('PASS Android follower touch unlock, encrypted host edit, background and disconnect lock, no private data in mobile storage')
  } finally {
    if (browser) await browser.close()
    if (host) await host.close()
    relay?.kill()
    web.closeAllConnections()
    if (web.listening) await new Promise(resolve => web.close(resolve))
    fs.rmSync(profile, {recursive:true, force:true, maxRetries:8, retryDelay:100})
  }
}

main().catch(error => { console.error(error); process.exitCode = 1 })
