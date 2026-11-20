const assert = require('node:assert/strict')
const fs = require('node:fs')
const net = require('node:net')
const os = require('node:os')
const path = require('node:path')
const { spawn } = require('node:child_process')
const { _electron } = require(process.env.MOMO_PLAYWRIGHT || 'playwright')
const { openStore, localDay } = require('../desktop/data.cjs')
const { checkDisplay } = require('../desktop/display-check.cjs')

const root = path.resolve(__dirname, '..')
const day = localDay()
const historyDay = '2025-02-01'
const custom = { id: 'cat-' + 'd'.repeat(32), name: '测试分类' }
const doc = text => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] })
const localText = 'Local follower notes are kept separately'
const hostText = 'First note from the main computer'
const refreshedText = 'Updated note from the main computer'
const hostLabel = '主机已在线，可以扫码配对。'

async function freePort() {
  const listener = net.createServer()
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve))
  const { port } = listener.address()
  await new Promise(resolve => listener.close(resolve))
  return port
}

async function launch(profile) {
  const app = await _electron.launch({
    executablePath: require('electron'), args: [root],
    env: { ...process.env, MOMO_DATA_DIR: profile },
  })
  try {
    const page = await app.firstWindow()
    await page.waitForSelector('body[data-mode=pet]')
    await page.locator('#mascot').click()
    await page.waitForSelector('body[data-mode=note]')
    return { app, page }
  } catch (error) {
    await app.close()
    throw error
  }
}

async function openSync(page) {
  await page.locator('#settings').click()
  await page.locator('#settings-sync').click()
}

async function waitText(page, selector, text) {
  await page.waitForFunction(({ selector, text }) => document.querySelector(selector).textContent.includes(text),
    { selector, text })
}

async function main() {
  const mainProfile = fs.mkdtempSync(path.join(os.tmpdir(), 'momo-sync-main-'))
  const followerProfile = fs.mkdtempSync(path.join(os.tmpdir(), 'momo-sync-follower-'))
  const mainStore = openStore(mainProfile)
  mainStore.saveNote(day, doc(hostText))
  mainStore.addCategory(custom)
  mainStore.saveNote(historyDay, doc('Earlier content in a shared category'), custom.id)
  openStore(followerProfile).saveNote(day, doc(localText))
  const port = await freePort()
  const relay = spawn(process.execPath, [path.join(root, 'relay/server.mjs')], {
    env: { ...process.env, PORT: String(port) },
  })
  let host, client
  try {
    await new Promise((resolve, reject) => {
      relay.stdout.once('data', resolve)
      relay.once('error', reject)
      relay.once('exit', () => reject(new Error('Relay did not start')))
    })
    host = await launch(mainProfile)
    client = await launch(followerProfile)
    await openSync(host.page)
    await host.page.locator('#sync-relay-settings summary').click()
    await host.page.locator('#sync-relay').fill('http://127.0.0.1:' + port)
    await host.page.locator('#sync-fallback').fill('')
    await host.page.locator('#sync-enable').click()
    await waitText(host.page, '#sync-status', hostLabel)
    await host.page.waitForFunction(() => document.getElementById('sync-code').value.startsWith('momo2:'))
    const code = await host.page.locator('#sync-code').inputValue()
    await openSync(client.page)
    await client.page.locator('#sync-role-follower').click()
    await client.page.locator('#sync-pair-code').fill(code)
    await client.page.locator('#sync-test').click()
    await waitText(client.page, '#sync-test-status', '配对码可用')
    await client.page.locator('#sync-pair').click()
    await waitText(client.page, '#sync-status', '从设备 · 只读')
    await client.page.locator('#sync-back').click()
    await client.page.locator('#settings-view .back').click()
    await waitText(client.page, '.tiptap', hostText)
    await waitText(client.page, '#categories', custom.name)
    assert.equal(await client.page.evaluate(async ({ date, id }) => {
      const page = await window.momo.openNote(date, id)
      return page.doc.content[0].content[0].text
    }, { date: historyDay, id: custom.id }), 'Earlier content in a shared category')
    assert.equal(await client.page.locator('.tiptap').getAttribute('contenteditable'), 'false')
    assert.match(await client.page.evaluate(async day => {
      try { await window.momo.saveNote(day, { type: 'doc', content: [] }, 'todo') } catch (error) { return error.message }
    }, day), /从设备只读/)
    assert.match(await client.page.evaluate(async () => {
      try { await window.momo.enableSync(true) } catch (error) { return error.message }
    }), /请先取消从设备配对/)
    await host.page.evaluate(({ day, doc }) => window.momo.saveNote(day, doc), { day, doc: doc(refreshedText) })
    await openSync(client.page)
    await client.page.locator('#sync-now').click()
    await waitText(client.page, '.tiptap', refreshedText)
    await host.page.locator('#sync-enable').click()
    await client.app.close()
    client = await launch(followerProfile)
    await waitText(client.page, '.tiptap', refreshedText)
    assert.equal(await client.page.locator('.tiptap').getAttribute('contenteditable'), 'false')
    await openSync(client.page)
    await client.page.locator('#sync-unpair').click()
    await client.page.locator('#sync-back').click()
    await client.page.locator('#settings-view .back').click()
    await waitText(client.page, '.tiptap', localText)
    assert.equal(await client.page.locator('.tiptap').getAttribute('contenteditable'), 'true')
    await openSync(client.page)
    await client.page.locator('#sync-relay-settings summary').click()
    await client.page.locator('#sync-relay').fill('http://127.0.0.1:' + port)
    await client.page.locator('#sync-fallback').fill('')
    await client.page.locator('#sync-enable').click()
    await waitText(client.page, '#sync-status', hostLabel)
    assert.match(await checkDisplay(), /电脑检查时间/)
    console.log('PASS desktop host, encrypted read-only follower, refresh, restart and restoration of local notes')
  } finally {
    if (client) await client.app.close().catch(() => {})
    if (host) await host.app.close().catch(() => {})
    relay.kill()
  }
}

main().catch(error => { console.error(error); process.exitCode = 1 })
