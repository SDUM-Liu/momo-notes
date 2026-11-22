const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { _electron } = require(process.env.MOMO_PLAYWRIGHT || 'playwright')
const { randomBytes } = require('node:crypto')
const { derive, encrypt, decrypt } = require('../desktop/sealed.cjs')
const { token } = require('../desktop/private-book.cjs')
const { localDay } = require('../shared/notes.mjs')

async function test() {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(),'momo-private-editor-'))
  const password = 'fixture-only-password', salt = randomBytes(16), secret = randomBytes(20).toString('base64')
  const filename = path.join(profile,'private-book.enc'), purpose = 'momo/private-book/v1'
  const legacy = [{ title:'旧标题', text:'旧内容', tab:0 }, { title:'旧录音', text:'', tab:1, media:'data:audio/wav;base64,UklGRg==' }]
  fs.writeFileSync(filename, JSON.stringify(encrypt(derive(password,salt),salt,{secret,last:-1,entries:legacy},purpose)))
  const app = await _electron.launch({executablePath:require('electron'), args:[path.resolve(__dirname,'..')],
    env:{...process.env,MOMO_DATA_DIR:profile}})
  try {
    const page = await app.firstWindow()
    await page.locator('body[data-mode=pet]').waitFor()
    await page.locator('#mascot').click()
    const editor = page.locator('.tiptap')
    await editor.click()
    await page.keyboard.insertText('ordinary-marker')
    await page.locator('#settings').click()
    await page.locator('#project-issues').dragTo(page.locator('#project-repo'))
    await page.locator('#book-password').fill(password)
    await page.locator('#book-code').fill(token(secret,Math.floor(Date.now()/30000)))
    await page.locator('#book-auth button').click()
    await page.getByRole('heading',{name:'旧标题'}).waitFor()
    assert(await page.locator('#question').isDisabled())
    await page.getByRole('tab',{name:'多媒体'}).click()
    await editor.locator('audio').waitFor()
    await page.getByRole('tab',{name:'话题'}).click()
    await editor.locator('input[type=checkbox]').waitFor()
    await editor.locator('p').first().click()
    await page.keyboard.insertText('private-marker')
    await page.locator('#table-tools').click()
    await page.locator('[data-table=insertTable]').click()
    await editor.locator('table').waitFor()
    await page.locator('#history').click()
    await page.locator('#dates button').first().click()
    await page.locator('#new-category').click()
    await page.locator('#category-name').fill('自定义')
    await page.locator('#category-form button[type=submit]').click()
    await page.getByRole('tab',{name:'自定义'}).waitFor()
    await page.locator('#book-return').click()
    await page.getByText('ordinary-marker',{exact:true}).waitFor()
    assert(!(await page.locator('#book-return').isVisible()))
    await editor.click()
    await page.keyboard.press('Control+z')
    assert(!(await editor.innerText()).includes('private-marker'))
    const stored = decrypt(password,JSON.parse(fs.readFileSync(filename,'utf8')),purpose).value.entries[0]
    assert(stored.categories.some(c=>c.name==='自定义'))
    const doc = stored.notes['stories__'+localDay()]
    assert(JSON.stringify(doc).includes('private-marker') && JSON.stringify(doc).includes('"type":"table"'))
    for (const name of fs.readdirSync(path.join(profile,'notes'))) {
      assert(!fs.readFileSync(path.join(profile,'notes',name),'utf8').includes('private-marker'))
    }
    console.log('PASS shared private editor, legacy entries and audio, tasks, tables, history, categories and isolated return')
  } finally { await app.close(); fs.rmSync(profile,{recursive:true,force:true}) }
}
test().catch(e=>{console.error(e);process.exitCode=1})
