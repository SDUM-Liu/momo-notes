export function wirePrivateBook(api, enter) {
  if (!api.privateBook) return
  const $ = id => document.getElementById(id)
  const dialog = $('book-dialog'), issue = $('project-issues'), repo = $('project-repo')
  let generation = 0, timer, clockTimer, handedOff = false, phase = 'closed'
  const form = $('book-auth'), password = $('book-password'), code = $('book-code')
  const passwordField = $('book-password-field'), usePassword = $('book-use-password')
  let otpOnly = false
  const authButton = form.querySelector('button[type=submit], button:not([type])')
  const status = text => { $('book-status').textContent = text }
  function formState(next) {
    phase = next
    passwordField.hidden = otpOnly
    password.disabled = otpOnly || next !== 'ready'
    code.disabled = next !== 'ready'
    usePassword.hidden = !otpOnly || next !== 'ready'
    authButton.disabled = next !== 'ready' && next !== 'retry'
    authButton.formNoValidate = next === 'retry'
    authButton.textContent = next === 'retry' ? '重新检查' : next === 'unlocking' ? '正在验证…' : '解锁'
  }
  usePassword.onclick = () => {
    otpOnly = false
    formState('ready')
    status('请输入独立口令和身份验证器当前显示的六位码。')
    password.focus()
  }
  $('book-code').oninput = event => {
    const input = event.target
    input.value = input.value.normalize('NFKC').replace(/\s/g,'')
  }
  function touch() { clearTimeout(timer); timer = setTimeout(() => dialog.close(), 295000) }
  function clear() {
    ++generation; clearTimeout(timer); clearInterval(clockTimer)
    otpOnly = false
    formState('closed')
    form.reset()
    $('book-qr').removeAttribute('src'); $('book-qr').hidden = true
    $('book-account').hidden = true; $('book-account').textContent = ''
    status('')
    if (!handedOff) void api.privateBook('lock').catch(() => {})
    handedOff = false
  }
  dialog.addEventListener('close', clear)
  $('book-close').onclick = () => dialog.close()
  async function open() {
    if (phase !== 'closed' || dialog.open || !$('book-return').hidden) return
    dialog.showModal()
    const drawClock = () => { $('book-clock').textContent = '本机时间 ' + new Date().toLocaleString('zh-CN', { hour12: false }) + ' · 请与身份验证器手机核对' }
    drawClock(); clockTimer = setInterval(drawClock, 1000)
    await prepare()
  }
  async function prepare() {
    const version = ++generation
    formState('preparing'); touch()
    status('正在检查验证状态…')
    $('book-qr').removeAttribute('src'); $('book-qr').hidden = true
    $('book-account').textContent = ''; $('book-account').hidden = true
    try {
      const { uri, label, expires, remembered } = await api.privateBook('begin')
      if (!dialog.open || generation !== version) return
      otpOnly = !uri && remembered === true
      if (uri) {
        const qr = await import('qrcode')
        const src = await qr.toDataURL(uri)
        if (!dialog.open || generation !== version) return
        $('book-qr').src = src; $('book-qr').hidden = false
        $('book-account').textContent = '身份验证器条目：' + label + '。二维码有效至 ' + new Date(expires).toLocaleTimeString() + '。'
        $('book-account').hidden = false
        status('请扫描本页二维码，选择上方编号的条目，并输入当前六位码完成绑定。')
      } else status(otpOnly ? '请输入身份验证器当前显示的六位码。' : '请输入独立口令和身份验证器当前显示的六位码。')
      formState('ready'); touch()
    } catch (error) {
      if (dialog.open && generation === version) {
        status(error?.message || '暂时无法开始验证，请重试。')
        formState('retry')
      }
    }
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
  form.onsubmit = async e => {
    e.preventDefault()
    if (phase === 'retry') { await prepare(); return }
    if (phase !== 'ready') return
    formState('unlocking'); touch()
    status('正在验证…')
    const version = generation
    let unlocked = false
    try {
      const data = await api.privateBook('unlock', { ...(otpOnly ? {} : { password: password.value }), code: code.value })
      unlocked = true
      if (!dialog.open || generation !== version) return
      if (document.hidden) { dialog.close(); return }
      await enter(data)
      if (generation !== version) return
      handedOff = true
      dialog.close()
    } catch (error) {
      if (unlocked && dialog.open && generation === version) await api.privateBook('lock').catch(() => {})
      if (dialog.open && generation === version) {
        code.value = ''
        status(error?.message || '验证失败，请重试。')
        if (otpOnly && (error?.code === 'BOOK_PASSWORD_REQUIRED' || /请重新输入独立口令/.test(error?.message || ''))) otpOnly = false
        const restart = unlocked || ['BOOK_UNAVAILABLE','BOOK_STALE'].includes(error?.code) || /二维码已过期/.test(error?.message || '')
        formState(restart ? 'retry' : 'ready')
      }
    }
  }
}
