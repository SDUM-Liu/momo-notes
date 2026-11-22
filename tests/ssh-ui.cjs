const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { _electron } = require(process.env.MOMO_PLAYWRIGHT || 'playwright')

const root = path.resolve(__dirname, '..')
const phone = {
  id: 'bdc7e791-3476-42c9-9497-af314dd46a88', platform: 'Android', online: true,
  sshHint: { host: '192.0.2.8', username: 'phone', port: 8022 },
}
const origin = 'http://127.0.0.1:51594'

async function mount(page, mobile) {
  await page.goto(origin)
  await page.evaluate(async mobile => {
    document.querySelector('#panel').hidden = false
    document.querySelector('#sync-view').hidden = false
    for (const section of document.querySelectorAll('#panel > section:not(#sync-view)')) section.hidden = true
    const profiles = new Map()
    window.launches = []
    const api = {
      mobile,
      async deviceSSHProfile(id, profile) {
        if (profile) profiles.set(id, profile)
        return profiles.get(id) || null
      },
      async deviceSSHConnect(id, profile) {
        if (profile) profiles.set(id, profile)
        const target = profiles.get(id)
        if (!target) throw new Error('没有连接信息')
        window.launches.push({ id, profile: target })
        return target
      },
      async deviceSSHRemote(id) { window.launches.push({ id, remote: true }) },
      async deviceSSHPermission() { return false },
    }
    const { wireSSHDevices } = await import('/src/ssh-devices.js')
    window.drawDevices = wireSSHDevices(api, error => error.message)
  }, mobile)
}

async function test() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'momo-ssh-ui-'))
  const harness = path.join(temp, 'window.cjs')
  fs.writeFileSync(harness, `const { app, BrowserWindow } = require('electron')
    app.setPath('userData', __dirname)
    app.whenReady().then(() => {
      global.window = new BrowserWindow({ show: false, webPreferences: { backgroundThrottling: false } })
      global.window.loadURL('about:blank')
    })`)
  let app
  try {
    app = await _electron.launch({ executablePath: require('electron'), args: [harness] })
    const page = await app.firstWindow({ timeout: 15000 })
    page.setDefaultTimeout(12000)
    // Only the real sync markup and device controls run. No app startup, SSH process or network.
    await page.route(origin + '/**', route => {
      const resource = new URL(route.request().url()).pathname
      if (resource === '/') {
        return route.fulfill({ path: path.join(root, 'index.html'), contentType: 'text/html' })
      }
      if (resource === '/src/ssh-devices.js') {
        return route.fulfill({ path: path.join(root, resource.slice(1)), contentType: 'text/javascript' })
      }
      return route.fulfill({ body: '', contentType: 'text/javascript' })
    })
    await mount(page, false)
    const draw = devices => page.evaluate(devices => window.drawDevices(devices), devices)
    const expectAddress = async (host, user, port) => {
      assert.equal(await page.inputValue('#ssh-host'), host)
      assert.equal(await page.inputValue('#ssh-user'), user)
      assert.equal(await page.inputValue('#ssh-port'), String(port))
    }
    const list = page.locator('#sync-device-list')
    const connect = list.getByRole('button', { name: '连接', exact: true })
    const adopt = page.locator('#ssh-use-hint')
    const unshared = { ...phone, sshHint: undefined }
    await draw([])
    assert.equal(await list.getByRole('button').count(), 0)
    await draw([unshared])
    await list.getByRole('button', { name: '设置连接' }).click()
    await expectAddress('', '', 8022)
    await draw([phone])
    await expectAddress(phone.sshHint.host, phone.sshHint.username, phone.sshHint.port)
    assert(await adopt.isHidden())
    await draw([unshared])
    await expectAddress('', '', 8022)
    assert(await adopt.isHidden())
    await page.click('#ssh-close')
    await draw([phone])
    await list.getByRole('button', { name: '设置连接' }).click()
    await expectAddress(phone.sshHint.host, phone.sshHint.username, phone.sshHint.port)
    assert(await page.locator('#ssh-ai').isHidden())

    const chosen = { host: 'phone.example', user: 'operator', port: 2202 }
    await page.fill('#ssh-host', chosen.host)
    await page.fill('#ssh-user', chosen.user)
    await page.fill('#ssh-port', String(chosen.port))
    const latest = { host: '192.0.2.20', username: 'next-user', port: 2203 }
    await draw([{ ...phone, online: false, sshHint: latest }])
    await expectAddress(chosen.host, chosen.user, chosen.port)
    assert(await adopt.isVisible())
    await draw([unshared])
    await expectAddress(chosen.host, chosen.user, chosen.port)
    assert(await adopt.isHidden())
    await draw([{ ...phone, sshHint: latest }])
    await adopt.click()
    await expectAddress(latest.host, latest.username, latest.port)
    assert(await adopt.isHidden())
    await draw([unshared])
    await expectAddress(latest.host, latest.username, latest.port)
    await page.fill('#ssh-host', chosen.host)
    await page.fill('#ssh-user', chosen.user)
    await page.fill('#ssh-port', String(chosen.port))
    await page.click('#ssh-save')
    await page.locator('#ssh-dialog').waitFor({ state: 'hidden' })
    assert.deepEqual(await page.evaluate(() => window.launches), [])
    await connect.click()
    await page.waitForFunction(() => window.launches.length === 1)
    assert.deepEqual(await page.evaluate(() => window.launches[0]), { id: phone.id, profile: chosen })
    assert(await page.locator('#ssh-dialog').isHidden())

    await draw([phone])
    await list.getByRole('button', { name: '连接设置' }).click()
    assert.equal(await page.inputValue('#ssh-host'), chosen.host)
    await page.click('#ssh-use-hint')
    assert.equal(await page.inputValue('#ssh-host'), phone.sshHint.host)
    await page.click('#ssh-close')
    await connect.click()
    assert.deepEqual(await page.evaluate(() => window.launches[1]), { id: phone.id, profile: chosen })

    await draw([{ ...phone, sshRemoteReady: true }])
    await list.getByRole('button', { name: '异地连接' }).click()
    assert.deepEqual(await page.evaluate(() => window.launches.at(-1)), { id: phone.id, remote: true })
    await mount(page, true)
    await draw([phone])
    assert((await list.innerText()).includes('Android'))
    assert.equal(await list.getByRole('button').count(), 0)
    assert.deepEqual(await page.evaluate(() => window.launches), [])
    console.log('PASS SSH setup, retained drafts, saved direct connections, shared hints and mobile controls')
  } finally {
    if (app) await app.close()
    fs.rmSync(temp, { recursive: true, force: true })
  }
}

test().catch(error => { console.error(error); process.exitCode = 1 })
