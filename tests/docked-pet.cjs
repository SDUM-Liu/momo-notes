const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { _electron } = require(process.env.MOMO_PLAYWRIGHT || 'playwright')
const { openStore } = require('../desktop/data.cjs')
const { face, position, dock, nearestEdge } = require('../desktop/window.cjs')

async function test() {
  const area = { x: -1600, y: 0, width: 1600, height: 900 }
  const anchor = { x: -500, y: 250 }
  for (const mode of ['pet', 'edge', 'note']) assert.deepEqual(face(mode, position(mode, area, anchor)), anchor)
  for (const side of ['left', 'right', 'top', 'bottom']) {
    const hidden = position('edge', area, anchor, side)
    const shown = position('pet', area, face('edge', hidden), side)
    assert.equal(nearestEdge(shown, area), side)
    assert(shown.x <= hidden.x && shown.y <= hidden.y)
    assert(shown.x + shown.width >= hidden.x + hidden.width && shown.y + shown.height >= hidden.y + hidden.height)
  }
  const near = { x: area.x + 12, y: 200, width: 74, height: 148 }
  assert.equal(dock(near, area, nearestEdge(near, area)).x, area.x)

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'momo-docked-pet-'))
  openStore(profile).update({ position: { anchor: { x: 1, y: 180 }, edge: 'left', faceAnchor: true } })
  const app = await _electron.launch({ executablePath: require('electron'), args: [path.resolve(__dirname, '..')],
    env: { ...process.env, MOMO_DATA_DIR: profile } })
  try {
    const page = await app.firstWindow()
    const mode = value => page.waitForSelector('body[data-mode=' + value + ']')
    await mode('edge')
    await app.evaluate(({ BrowserWindow, screen }) => {
      const b = BrowserWindow.getAllWindows()[0].getBounds()
      globalThis.cursor = { x: b.x + 15, y: b.y + 30 }
      screen.getCursorScreenPoint = () => globalThis.cursor
    })
    const pet = page.locator('#mascot')
    await pet.dispatchEvent('pointerenter', { pointerType: 'mouse' })
    await mode('pet')
    await app.evaluate(() => { globalThis.cursor.x += 150 })
    await mode('edge')
    await app.evaluate(() => { globalThis.cursor.x -= 150 })
    await pet.dispatchEvent('pointerenter', { pointerType: 'mouse' })
    await mode('pet')
    await pet.click()
    await mode('note')
    await pet.click()
    await mode('edge')
    console.log('PASS docking on four edges, face alignment, hover reveal, pointer exit and click')
  } finally {
    await app.close()
  }
}

test().catch(error => { console.error(error); process.exitCode = 1 })
