export function wirePrivateBook(api) {
  if (!api.privateBook) return
  const $ = id => document.getElementById(id)
  const dialog = $('book-dialog'), issue = $('project-issues'), repo = $('project-repo')
  let editing, entries = [], tab = 0, generation = 0, timer, clockTimer, unlock = false, saving = false
  const authButton = $('book-auth').querySelector('button[type=submit], button:not([type])')
  const names = ['密码本', '多媒体', '话题']
  const status = error => { $('book-status').textContent = error?.message || '' }
  $('book-code').oninput = event => {
    const input = event.target
    input.value = input.value.normalize('NFKC').replace(/\s/g,'')
  }
  function touch() { clearTimeout(timer); timer = setTimeout(() => dialog.close(), 295000) }
  function clear() {
    ++generation; clearTimeout(timer); clearInterval(clockTimer); unlock = false; entries = []; tab = 0; editing = undefined
    $('book-list').replaceChildren(); $('book-content').hidden = true; $('book-auth').hidden = false
    $('book-add').reset(); $('book-auth').reset()
    $('book-qr').removeAttribute('src'); $('book-qr').hidden = true
    $('book-account').hidden = true; $('book-account').textContent = ''
    status(); void api.privateBook('lock')
  }
  dialog.addEventListener('close', clear)
  document.addEventListener('visibilitychange', () => { if (document.hidden && dialog.open && unlock) dialog.close() })
  $('book-close').onclick = () => dialog.close()
  api.onPrivateLock?.(() => { if (dialog.open) dialog.close() })
  async function open() {
    if (dialog.open) return
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
  function render() {
    $('book-tabs').replaceChildren(...names.map((label, i) => {
      const b = document.createElement('button'); b.textContent = label; b.disabled = tab === i
      b.onclick = () => { tab = i; editing = undefined; $('book-add').reset(); render() }; return b
    }))
    const list = $('book-list')
    list.replaceChildren()
    for (const entry of entries.filter(e => e.tab === tab)) {
      const row = document.createElement('details'), title = document.createElement('summary')
      title.textContent = entry.title; row.append(title)
      const value = document.createElement('p'); value.textContent = entry.text; row.append(value)
      if (entry.media) {
        const tag = entry.media.startsWith('data:image/') ? 'img' : entry.media.startsWith('data:audio/') ? 'audio' : 'video'
        const media = document.createElement(tag); media.controls = true; media.src = entry.media; row.append(media)
      }
      const edit = document.createElement('button'); edit.textContent = '编辑'
      edit.onclick = () => {
        editing = entry; $('book-title').value = entry.title; $('book-text').value = entry.text
        $('book-file').value = ''; $('book-file').required = false; $('book-title').focus()
      }
      row.append(edit)
      const del = document.createElement('button'); del.textContent = '删除'
      del.onclick = () => void save(entries.filter(item => item !== entry)); row.append(del); list.append(row)
    }
    $('book-file').hidden = tab !== 1; $('book-file').required = tab === 1
  }
  $('book-auth').onsubmit = async e => {
    e.preventDefault()
    if (authButton.disabled) return
    authButton.disabled = true
    const version = generation
    try {
      const data = await api.privateBook('unlock', { password: $('book-password').value, code: $('book-code').value })
      if (generation !== version) return
      if (document.hidden) { dialog.close(); return }
      entries = data; unlock = true; clearInterval(clockTimer); touch(); status(); $('book-auth').reset()
      $('book-qr').removeAttribute('src'); $('book-qr').hidden = true
      $('book-auth').hidden = true; $('book-content').hidden = false; render()
    } catch (error) {
      if (generation === version) status(error)
    } finally {
      if (generation === version) authButton.disabled = false
    }
  }
  async function save(next) {
    if (!unlock || saving) return
    const version = generation; saving = true
    try {
      await api.privateBook('save', { entries: next })
      if (version !== generation) return
      entries = next; editing = undefined; touch(); status(); $('book-add').reset(); render()
    } catch (error) { status(error) } finally { saving = false }
  }
  $('book-add').onsubmit = async e => {
    e.preventDefault(); const version = generation
    const entry = { tab, title: $('book-title').value.trim(), text: $('book-text').value }
    if (!entry.title) return
    try {
      if (tab === 1 && editing) entry.media = editing.media
      if (tab === 1 && (!editing || $('book-file').files.length)) {
        const file = $('book-file').files[0]
        if (!file || file.size > 32 * 1024 * 1024 || !/^(image|video|audio)\//.test(file.type)) throw new Error('请选择 32 MB 以内的图片、视频或音频')
        entry.media = await new Promise((resolve, reject) => {
          const reader = new FileReader(); reader.onload = () => resolve(reader.result)
          reader.onerror = () => reject(reader.error); reader.readAsDataURL(file)
        })
      }
      if (version === generation) await save(editing ? entries.map(item => item === editing ? entry : item) : [...entries, entry])
    } catch (error) { status(error) }
  }
}
