export function wirePrivateBook(api, enter) {
  if (!api.privateBook) return
  const $ = id => document.getElementById(id)
  const dialog = $('book-dialog'), issue = $('project-issues'), repo = $('project-repo')
  let generation = 0, timer, clockTimer, handedOff = false
  const authButton = $('book-auth').querySelector('button[type=submit], button:not([type])')
  const status = error => { $('book-status').textContent = error?.message || '' }
  $('book-code').oninput = event => {
    const input = event.target
    input.value = input.value.normalize('NFKC').replace(/\s/g,'')
  }
  function touch() { clearTimeout(timer); timer = setTimeout(() => dialog.close(), 295000) }
  function clear() {
    ++generation; clearTimeout(timer); clearInterval(clockTimer)
    $('book-auth').reset()
    $('book-qr').removeAttribute('src'); $('book-qr').hidden = true
    $('book-account').hidden = true; $('book-account').textContent = ''
    status()
    if (!handedOff) void api.privateBook('lock')
    handedOff = false
  }
  dialog.addEventListener('close', clear)
  $('book-close').onclick = () => dialog.close()
  async function open() {
    if (dialog.open || !$('book-return').hidden) return
    authButton.disabled = true
    dialog.showModal(); const version = ++generation
    const drawClock = () => { $('book-clock').textContent = '本机时间 ' + new Date().toLocaleString('zh-CN', { hour12: false }) + ' · 请与身份验证器手机核对' }
    drawClock(); clockTimer = setInterval(drawClock, 1000)
    try {
      const { uri, label, expires } = await api.privateBook('begin')
      if (uri) {
        const qr = await import('qrcode')
        const src = await qr.toDataURL(uri)
        if (generation !== version) return
        $('book-qr').src = src; $('book-qr').hidden = false
        $('book-account').textContent = '身份验证器条目：' + label + '。二维码有效至 ' + new Date(expires).toLocaleTimeString() + '。'
        $('book-account').hidden = false
        $('book-status').textContent = '请扫描本页二维码，选择上方编号的条目，并输入当前六位码完成绑定。'
      }
      if (version === generation) { touch(); authButton.disabled = false }
    } catch (error) { status(error) }
  }
  // Pointer capture also supports a pen or touchscreen on a desktop host.
  let start, dragged = false
  issue.style.touchAction = 'none'
  issue.addEventListener('pointerdown', e => {
    start = { x: e.clientX, y: e.clientY }; dragged = false; issue.setPointerCapture(e.pointerId)
  })
  issue.addEventListener('pointermove', e => {
    if (start && Math.hypot(start.x - e.clientX, start.y - e.clientY) > 6) dragged = true
  })
  issue.addEventListener('pointercancel', () => { start = null })
  issue.addEventListener('pointerup', e => {
    if (start && dragged && repo.contains(document.elementFromPoint(e.clientX, e.clientY))) void open()
    start = null
  })
  issue.addEventListener('click', e => { if (dragged) { e.stopImmediatePropagation(); dragged = false } }, true)
  $('book-auth').onsubmit = async e => {
    e.preventDefault()
    if (authButton.disabled) return
    authButton.disabled = true
    const version = generation
    try {
      const data = await api.privateBook('unlock', { password: $('book-password').value, code: $('book-code').value })
      if (generation !== version) return
      if (document.hidden) { dialog.close(); return }
      await enter(data)
      if (generation !== version) return
      handedOff = true
      dialog.close()
    } catch (error) {
      if (generation === version) status(error)
    } finally {
      if (generation === version) authButton.disabled = false
    }
  }
}
