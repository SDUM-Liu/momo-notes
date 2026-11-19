export async function followCodex(api, job, draw, current = () => true) {
  let errors = 0
  draw(job)
  while (job.status === 'running') {
    await new Promise(resolve => setTimeout(resolve, 850))
    if (!current()) return null
    try {
      job = await api.codex('job', job.id)
      if (!current()) return null
      errors = 0
      draw(job)
    } catch (error) {
      if (++errors >= 3) throw error
    }
  }
  return job
}

export function wireModelPicker(api, select, status, errorMessage) {
  const label = select.options[0].text
  const key = 'momo.model.' + select.id
  let preferred = ''
  let loading
  try { preferred = localStorage.getItem(key) || '' } catch {}
  select.onchange = () => {
    preferred = select.value
    try { localStorage.setItem(key, preferred) } catch {}
  }
  function load() {
    if (!loading) {
      status.hidden = true
      loading = api.codex('models').then(models => {
        select.replaceChildren(new Option(label, ''), ...models.map(item => new Option(item.label, item.id)))
        if (models.some(item => item.id === preferred)) select.value = preferred
        else if (preferred) {
          status.textContent = '上次选择的模型目前不可用，已选用默认项。'
          status.hidden = false
        }
      }).catch(error => {
        status.textContent = '模型列表加载失败，可使用当前选项。' + errorMessage(error)
        status.hidden = false
      }).finally(() => { loading = undefined })
    }
    return loading
  }
  return { load, value: () => select.value }
}

export function wireCodex(api, showView, errorMessage) {
  const $ = id => document.getElementById(id)
  const select = $('codex-thread')
  const model = wireModelPicker(api, $('codex-model'), $('codex-model-status'), errorMessage)
  let config, threads = [], cursor, history = [], currentJob, listCursor
  let watching = false
  let request = 0
  let scope = 0

  async function action(work) {
    try { return await work() } catch (error) { $('codex-status').textContent = errorMessage(error) }
  }

  function drawConfig(value) {
    config = value
    $('codex-folder-label').textContent = (value.defaultFolder ? '默认工作目录 · ' : '') + value.folder
    $('codex-folder-reset').hidden = value.defaultFolder
    $('codex-remote').checked = value.enabled
    $('codex-all').checked = value.shareAll
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
    $('codex-share').hidden = api.mobile || !selected || config?.shareAll
    if (selected) $('codex-share').textContent = selected.shared ? '取消共享' : '共享给已配对设备'
    if (!id) return
    const result = await api.codex('read', { id, cursor })
    if (version !== request) return
    cursor = result.cursor
    history = [...result.messages, ...history]
    renderHistory()
  }

  async function load(preferred = select.value, more = false, refresh = false) {
    const before = scope
    const result = await api.codex('list', { search: $('codex-search').value, cursor: more ? listCursor : null, refresh })
    if (before !== scope) return
    threads = more ? [...threads, ...result.threads] : result.threads
    listCursor = result.cursor
    $('codex-more').hidden = listCursor === null
    select.replaceChildren(new Option('新会话', ''), ...threads.map(item => {
      const folder = item.cwd?.split(/[\\/]/).filter(Boolean).at(-1)
      const details = [folder, item.archived ? '已归档' : '', item.shared && !api.mobile ? '已共享' : ''].filter(Boolean)
      return new Option([item.title, ...details].join(' · '), item.id)
    }))
    if (threads.some(item => item.id === preferred)) select.value = preferred
    await read()
  }

  async function observe(started) {
    const before = scope
    watching = true
    $('codex-send').disabled = true
    select.disabled = true
    try {
      const job = await started()
      if (!job || before !== scope) return
      const result = await followCodex(api, job, draw, () => before === scope)
      if (!result || before !== scope) return
      if (result.status === 'completed') {
        $('codex-prompt').value = ''
        await load(result.threadId)
        $('codex-output').hidden = !result.output || history.some(item => item.role === 'Codex')
      }
    } finally {
      if (before === scope) {
        watching = false
        $('codex-send').disabled = false
        select.disabled = false
        $('codex-stop').hidden = true
      }
    }
  }

  async function refresh() {
    $('codex-status').textContent = ''
    await Promise.all([load(select.value, false, true), model.load()])
    if (!watching) await observe(() => api.codex('active'))
  }

  $('settings-codex').onclick = () => {
    showView('codex')
    void action(async () => {
      if (!api.mobile) drawConfig(await api.codexSettings())
      await refresh()
    })
  }
  $('codex-back').onclick = () => showView('settings')
  if (!api.mobile) {
    for (const [button, operation] of [
      ['codex-folder', 'choose'], ['codex-folder-reset', 'reset'], ['codex-folder-open', 'open'],
    ]) {
      $(button).onclick = () => action(async () => {
        const before = config?.folder
        drawConfig(await api.codexFolder(operation))
        if (before !== config.folder) {
          $('codex-status').textContent = ''
          await load('')
        }
      })
    }
    for (const field of ['codex-remote', 'codex-write', 'codex-all']) {
      $(field).onchange = () => action(async () => {
        try {
          drawConfig(await api.codexConfigure({
            enabled: $('codex-remote').checked, write: $('codex-write').checked, shareAll: $('codex-all').checked,
          }))
          if (field === 'codex-all') await load()
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
  $('codex-more').onclick = () => action(() => load(select.value, true))
  $('codex-search-form').onsubmit = event => {
    event.preventDefault()
    void action(() => load(''))
  }
  $('codex-search').onchange = () => action(() => load(''))
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
      return observe(() => api.codex('send', {
        id: select.value || null, prompt: $('codex-prompt').value, model: model.value(),
      }))
    })
  }
  return {
    reset() {
      ++scope
      ++request
      threads = []
      history = []
      cursor = listCursor = currentJob = undefined
      watching = false
      select.replaceChildren(new Option('新会话', ''))
      select.disabled = false
      $('codex-send').disabled = false
      $('codex-stop').hidden = $('codex-output').hidden = $('codex-log').hidden = $('codex-more').hidden = true
      $('codex-search').value = $('codex-prompt').value = ''
      $('codex-status').textContent = $('codex-output').textContent = $('codex-log').querySelector('pre').textContent = ''
      renderHistory()
    },
  }
}
