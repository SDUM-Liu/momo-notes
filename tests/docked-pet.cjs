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
    // Native window resizing can reach the compositor before the renderer receives the new pose.
    async function checkOpeningFrame() {
      const image = page.locator('#mascot-image')
      await image.evaluate(img => img.decode())
      const original = await image.boundingBox()
      const bounds = await app.evaluate(({ BrowserWindow }) => {
        const win = BrowserWindow.getAllWindows()[0]
        const initial = win.getBounds()
        win.setBounds({ ...initial, width: 520, height: 400 })
        return initial
      })
      try {
        await page.waitForFunction(() => innerWidth >= 500)
        assert(original.width > 0)
        assert.equal(await image.isVisible(), false)
        assert(await page.locator('#panel').isVisible())
        const perch = await page.locator('#mascot-perch').boundingBox()
        assert(perch.width <= 66.1 && perch.height <= 63.1 && perch.x > 400)
      } finally {
        await app.evaluate(({ BrowserWindow }, b) => BrowserWindow.getAllWindows()[0].setBounds(b), bounds)
        await page.waitForFunction(() => innerWidth < 200)
      }
    }
    await checkOpeningFrame()
    const appearance = await pet.evaluate(button => {
      const style = getComputedStyle(button)
      return { fill: style.backgroundColor, border: style.borderTopWidth }
    })
    assert.deepEqual(appearance, { fill: 'rgba(0, 0, 0, 0)', border: '0px' })
    await pet.dispatchEvent('pointerenter', { pointerType: 'mouse' })
    await mode('pet')
    await checkOpeningFrame()
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
