export async function followCodex(api, job, draw) {
  let errors = 0
  draw(job)
  while (job.status === 'running') {
    await new Promise(resolve => setTimeout(resolve, 850))
    try {
      job = await api.codex('job', job.id)
      errors = 0
      draw(job)
    } catch (error) {
      if (++errors >= 3) throw error
    }
  }
  return job
}

export function wireCodex(api, showView, errorMessage) {
  const $ = id => document.getElementById(id)
  const select = $('codex-thread')
  let config, threads = [], cursor, history = [], currentJob
  let watching = false
  let request = 0

  async function action(work) {
    try { return await work() } catch (error) { $('codex-status').textContent = errorMessage(error) }
  }

  function drawConfig(value) {
    config = value
    $('codex-folder-label').textContent = value.folder || '尚未选择工作目录'
    $('codex-remote').checked = value.enabled
    $('codex-write').checked = value.write
  }

  function renderHistory() {
    $('codex-history').replaceChildren(...history.map(message => {
      const row = document.createElement('div')
      row.className = 'answer'
      const role = document.createElement('strong')
      role.textContent = message.role
      row.append(role, document.createTextNode(message.text))
      return row
    }))
    $('codex-older').hidden = !cursor
  }

  async function read(older = false) {
    const id = select.value
    const version = ++request
    if (!older) { cursor = undefined; history = []; renderHistory() }
    const selected = threads.find(item => item.id === id)
    $('codex-share').hidden = api.mobile || !selected
    if (selected) $('codex-share').textContent = selected.shared ? '取消共享' : '共享给已配对设备'
    if (!id) return
    const result = await api.codex('read', { id, cursor })
    if (version !== request) return
    cursor = result.cursor
    history = [...result.messages, ...history]
    renderHistory()
  }

  async function load(preferred = select.value) {
    threads = await api.codex('list')
    select.replaceChildren(new Option('新会话', ''), ...threads.map(item => new Option(item.title + (item.shared && !api.mobile ? ' · 已共享' : ''), item.id)))
    if (threads.some(item => item.id === preferred)) select.value = preferred
    await read()
  }

  async function observe(started) {
    watching = true
    $('codex-send').disabled = true
    select.disabled = true
    try {
      const job = await started()
      if (!job) return
      const result = await followCodex(api, job, draw)
      if (result.status === 'completed') {
        $('codex-prompt').value = ''
        await load(result.threadId)
        $('codex-output').hidden = !result.output || history.some(item => item.role === 'Codex')
      }
    } finally {
      watching = false
      $('codex-send').disabled = false
      select.disabled = false
      $('codex-stop').hidden = true
    }
  }

  async function refresh() {
    $('codex-status').textContent = ''
    await load()
    if (!watching) await observe(() => api.codex('active'))
  }

  $('settings-codex').onclick = () => {
    showView('codex')
    void action(async () => {
      if (!api.mobile) drawConfig(await api.codexSettings())
      if (api.mobile || config.folder) await refresh()
    })
  }
  $('codex-back').onclick = () => showView('settings')
  if (!api.mobile) {
    $('codex-folder').onclick = () => action(async () => {
      const before = config?.folder
      drawConfig(await api.codexFolder())
      if (config.folder && before !== config.folder) {
        $('codex-status').textContent = ''
        await load('')
      }
    })
    for (const field of ['codex-remote', 'codex-write']) {
      $(field).onchange = () => action(async () => {
        try {
          drawConfig(await api.codexConfigure({ enabled: $('codex-remote').checked, write: $('codex-write').checked }))
        } catch (error) {
          drawConfig(await api.codexSettings())
          throw error
        }
      })
    }
    $('codex-share').onclick = () => action(async () => {
      const selected = threads.find(item => item.id === select.value)
      if (selected) {
        await api.codexShare(selected.id, !selected.shared)
        await load(selected.id)
      }
    })
  }

  $('codex-refresh').onclick = () => action(refresh)
  $('codex-older').onclick = () => action(() => read(true))
  select.onchange = () => action(() => read())
  $('codex-stop').onclick = () => action(async () => {
    if (currentJob?.turnId) await api.codex('interrupt', currentJob.id)
  })

  function draw(job) {
    currentJob = job
    $('codex-output').textContent = job.output
    $('codex-output').hidden = !job.output
    $('codex-log').querySelector('pre').textContent = job.log
    $('codex-log').hidden = !job.log
    $('codex-stop').hidden = job.status !== 'running' || !job.turnId
    $('codex-status').textContent = job.status === 'running'
      ? job.retrying ? '主机正在重新连接 Codex…' : '主机正在处理。若需要额外权限，请在主机确认。'
      : job.status === 'interrupted' ? '已停止' : job.status === 'failed' ? job.error : '已完成'
  }

  $('codex-form').onsubmit = event => {
    event.preventDefault()
    if (watching) return
    void action(() => {
      $('codex-status').textContent = '正在连接主机…'
      return observe(() => api.codex('send', { id: select.value || null, prompt: $('codex-prompt').value }))
    })
  }
}
