const assert = require('node:assert/strict')
const fs = require('node:fs')
const http = require('node:http')
const { chromium } = require(process.env.MOMO_PLAYWRIGHT || 'playwright')

async function test() {
  const { build } = await import('vite')
  const modules = ['src/private-book.js','src/mobile-book.js','shared/authenticator.mjs']
  const bundle = await build({
    logLevel:'error', build:{write:false, lib:{
      entry:Object.fromEntries(modules.map(name=>[name,'./'+name])),
      formats:['es'], fileName:(_format,name)=>name,
    }},
  })
  const assets = new Map([].concat(bundle).flatMap(output=>output.output.map(asset=>
    ['/'+asset.fileName, asset.type==='chunk' ? asset.code : asset.source])))
  const dialog = fs.readFileSync('index.html','utf8').match(/<dialog id="book-dialog"[\s\S]*?<\/dialog>/)[0]
  const html = '<meta charset="utf-8"><button id="project-issues">反馈</button><button id="project-repo">仓库</button><button id="book-return" hidden></button>' + dialog
  const server = http.createServer((req,res)=>{
    if (req.url === '/') { res.writeHead(200,{'content-type':'text/html;charset=utf-8'}).end(html); return }
    const body = assets.get(req.url)
    res.writeHead(body ? 200 : 404, {'content-type':'application/javascript'}).end(body)
  })
  await new Promise(ok=>server.listen(0,'127.0.0.1',ok))
  let browser
  try {
    browser = await chromium.launch({ channel:process.env.MOMO_BROWSER_CHANNEL || (process.platform==='win32' ? 'msedge' : undefined) })
    const page = await browser.newPage({isMobile:true,hasTouch:true,viewport:{width:390,height:800}})
    await page.goto('http://127.0.0.1:'+server.address().port)
    await page.evaluate(async()=>{
      const { wirePrivateBook } = await import('/src/private-book.js')
      const { mobileBook } = await import('/src/mobile-book.js')
      const { totp } = await import('/shared/authenticator.mjs')
      // Keep the fixture's previous-step code within the accepted clock window on slow CI runners.
      const start = Math.floor(Date.now()/30000)*30000 + 10000 - performance.now()
      Date.now = () => Math.floor(start + performance.now())
      let eligibility = false, persisted, seed, pauseRead, codeCounter
      const state = { opened:0, reading:false }
      const handler = mobileBook(async()=>{
        if (pauseRead) { state.reading=true; await pauseRead.promise; pauseRead=undefined; state.reading=false }
        return persisted
      }, async value=>{ persisted=structuredClone(value) }, ()=>eligibility)
      async function book(op,args) {
        const value = await handler(op,args)
        if (op==='begin' && value.uri) {
          const secret = new URL(value.uri).searchParams.get('secret')
          const bits = Array.from(secret, char=>'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'.indexOf(char).toString(2).padStart(5,'0')).join('')
          seed = Uint8Array.from(bits.match(/.{8}/g), chunk=>parseInt(chunk,2))
        }
        return value
      }
      wirePrivateBook({privateBook:book},async()=>{ state.opened++ })
      Object.assign(state, {
        book, eligibility(value) { eligibility=value }, pause(){ pauseRead=Promise.withResolvers() },
        resume(){ pauseRead.resolve() },
        code(offset) { codeCounter ??= Math.floor(Date.now()/30000); return totp(seed,codeCounter + offset) },
      })
      window.fixture = state
    })
    const form=page.locator('#book-auth'), button=form.locator('button').first()
    const code=page.locator('#book-code'), password=page.locator('#book-password')
    const status=page.locator('#book-status'), image=page.locator('#book-qr')
    const opened=()=>page.locator('#project-issues').dragTo(page.locator('#project-repo'))
    const expectText=async(locator, text)=>{ await locator.filter({hasText:text}).waitFor() }
    await opened()
    await expectText(button,'重新检查')
    assert(await password.isDisabled() && await code.isDisabled() && await button.isEnabled())
    await expectText(status,'主设备')
    await page.evaluate(()=>{ fixture.eligibility(true); fixture.pause() })
    await button.click()
    await page.waitForFunction(()=>fixture.reading)
    await page.evaluate(async()=>{ await fixture.book('background'); fixture.resume() })
    await expectText(button,'重新检查')
    await expectText(status,'验证期间')
    await button.click()
    await image.waitFor()
    const original = await image.getAttribute('src')
    await page.evaluate(()=>fixture.book('background'))
    assert.equal(await image.getAttribute('src'), original)
    const digits = await page.evaluate(()=>fixture.code(-1))
    const secret = 'fixture-only-password'
    await password.fill(secret); await code.fill(digits); await button.click()
    await page.waitForFunction(()=>fixture.opened===1 && !document.getElementById('book-dialog').open)
    await page.evaluate(()=>fixture.book('save',{entries:[]}))
    await page.evaluate(()=>fixture.book('background'))
    await opened()
    await expectText(status,'请输入独立口令')
    assert(await image.isHidden()); assert(await button.isEnabled())
    // Avoid the real 1.5 s attempt throttle before checking the persisted replay counter.
    await page.waitForTimeout(1550)
    await password.fill(secret); await code.fill(digits); await button.click()
    await expectText(status,'已经使用')
    assert(await button.isEnabled())
    await page.waitForTimeout(1550)
    await code.fill(await page.evaluate(()=>fixture.code(0))); await button.click()
    await page.waitForFunction(()=>fixture.opened===2 && !document.getElementById('book-dialog').open)
    await page.evaluate(()=>fixture.book('lock'))
    console.log('PASS mobile eligibility, interrupted begin, foreground retry, enrollment, persistent replay protection and reopen')
  } finally {
    if (browser) await browser.close()
    server.closeAllConnections()
    await new Promise(ok=>server.close(ok))
  }
}

test().catch(error=>{ console.error(error); process.exitCode=1 })
