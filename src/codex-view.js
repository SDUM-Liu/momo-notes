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

function wireModelPicker(api, $, errorMessage) {
  const key = 'momo.model.codex-model'
  const effortKey = 'momo.effort.codex-effort'
  const labels = { none: '无', minimal: '极低', low: '低', medium: '中', high: '高', xhigh: '很高', max: '最高', ultra: '极高' }
  const dialog = $('codex-choice-dialog')
  let preferred = '', preferredEffort = '', catalog = [], loading, generation = 0
  let choosing = 'model', status = '', failed = false
  try {
    preferred = localStorage.getItem(key) || ''
    preferredEffort = localStorage.getItem(effortKey) || ''
  } catch {}
  const chosenModel = () => catalog.find(item => item.id === preferred)
  const activeModel = () => chosenModel() ?? catalog.find(item => item.isDefault)
  const efforts = () => activeModel()?.efforts ?? []
  const selectedEffort = () => efforts().includes(preferredEffort) ? preferredEffort : ''
  function draw() {
    $('codex-model').textContent = '模型 · ' + (chosenModel()?.label ?? '自动')
    $('codex-effort').textContent = '思考程度 · ' + ((labels[selectedEffort()] ?? selectedEffort()) || '自动')
    $('codex-model-status').textContent = status
    $('codex-model-status').hidden = !status
    if (!dialog.open) return
    const model = activeModel()
    const options = choosing === 'model' ? catalog : efforts().map(id => ({ id, label: labels[id] ?? id }))
    const selected = choosing === 'model' ? chosenModel()?.id ?? '' : selectedEffort()
    const automatic = choosing === 'model' ? catalog.find(item => item.isDefault)?.label
      : labels[model?.defaultEffort] ?? model?.defaultEffort
    const defaultLabel = automatic ? '自动 · ' + automatic : '自动'
    $('codex-choice-title').textContent = choosing === 'model' ? '选择模型' : '选择思考程度'
    $('codex-choice-status').textContent = status || (choosing === 'effort' && !options.length
      ? '当前模型没有可选的思考程度。' : '')
    $('codex-choice-retry').hidden = !failed
    $('codex-choice-options').replaceChildren(...[{ id: '', label: defaultLabel }, ...options].map(item => {
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'quiet'
      button.textContent = item.label
      button.setAttribute('aria-pressed', String(item.id === selected))
      button.onclick = () => {
        if (choosing === 'model') preferred = item.id
        else preferredEffort = item.id
        try { localStorage.setItem(choosing === 'model' ? key : effortKey, item.id) } catch {}
        dialog.close()
        if (catalog.length && !failed) status = ''
        draw()
      }
      return button
    }))
  }
  function load() {
    if (loading) return loading
    const before = generation
    failed = false
    status = '正在从电脑加载模型…'
    draw()
    loading = api.codex('models').then(models => {
      if (before !== generation) return
      if (!Array.isArray(models)) throw new Error('电脑返回的模型列表格式有误')
      catalog = models
      failed = !catalog.length
      status = failed ? '电脑未返回可用模型。' : preferred && !chosenModel() ? '上次选择的模型已不可用，现使用自动选项。' : ''
    }).catch(error => {
      if (before !== generation) return
      failed = true
      status = '模型加载失败。' + errorMessage(error)
    }).finally(() => {
      if (before !== generation) return
      loading = undefined
      draw()
    })
    return loading
  }
  for (const field of ['model', 'effort']) {
    $('codex-' + field).onclick = () => {
      choosing = field
      dialog.showModal()
      draw()
      if (!catalog.length && !failed) void load()
    }
  }
  $('codex-choice-retry').onclick = () => { void load() }
  return {
    load, options: () => ({ model: chosenModel()?.id ?? '', effort: selectedEffort() }),
    reset() {
      ++generation
      catalog = []; loading = undefined; status = ''; failed = false
      if (dialog.open) dialog.close()
      draw()
    },
  }
}

export function wireCodex(api, errorMessage, routeToNotes) {
  const $ = id => document.getElementById(id)
  const select = $('codex-thread')
  const model = wireModelPicker(api, $, errorMessage)
  let config, threads = [], cursor, history = [], currentJob, listCursor
  let steering = false
  let watching = false
  let request = 0
  let scope = 0
  let listRequest = 0
  let retryOlder = false
  let taskMode = false
  const scroll = $('codex-messages')
  const promptBox = $('codex-prompt')
  const bottom = () => { scroll.scrollTop = scroll.scrollHeight }

  function drawer(open) {
    $('codex-drawer').hidden = $('codex-scrim').hidden = !open
    $('codex-drawer-toggle').setAttribute('aria-expanded', String(open))
  }

  for (const id of ['codex-drawer-close', 'codex-scrim']) $(id).onclick = () => drawer(false)
  $('codex-drawer-toggle').onclick = () => drawer($('codex-drawer').hidden)

  async function action(work) {
    try { return await work() } catch (error) { $('codex-status').textContent = errorMessage(error) }
  }

  function drawConfig(value) {
    config = value
    $('codex-folder-label').textContent = (value.defaultFolder ? '默认工作目录 · ' : '') + value.folder
    $('codex-folder-reset').hidden = value.defaultFolder
    $('codex-remote').checked = value.enabled
    $('codex-all').checked = value.shareAll
    $('codex-full-access').checked = value.fullAccess !== false
    $('codex-write-setting').hidden = $('codex-full-access').checked
    $('codex-write').checked = value.write
    $('codex-share').hidden = !threads.some(item => item.id === select.value) || value.shareAll
  }

  function renderHistory() {
    $('codex-history').replaceChildren(...history.map(message => {
      const row = document.createElement('div')
      row.className = 'chat-message' + (message.role === '你' ? ' from-user' : '')
      const role = document.createElement('strong')
      role.textContent = message.role === 'Codex' ? '桃桃 AI' : message.role
      row.append(role, document.createTextNode(message.text))
      return row
    }))
    $('codex-older').hidden = !cursor
    $('codex-empty').hidden = Boolean(select.value || history.length || currentJob)
    $('codex-conversation-bar').hidden = !select.value
    const title = threads.find(item => item.id === select.value)?.title || (select.value ? '当前会话' : '')
    $('codex-conversation-title').textContent = $('codex-conversation-title').title = title
  }

  function renderThreads() {
    $('codex-thread-list').replaceChildren(...threads.map(item => {
      const button = document.createElement('button')
      button.type = 'button'
      button.disabled = watching
      button.setAttribute('aria-pressed', String(item.id === select.value))
      const title = document.createElement('strong')
      title.textContent = item.title
      const details = document.createElement('small')
      details.textContent = [item.cwd?.split(/[\\/]/).filter(Boolean).at(-1),
        item.archived && '已归档', item.shared && !api.mobile && '已共享'].filter(Boolean).join(' · ')
      button.title = [item.title, details.textContent].filter(Boolean).join('\n')
      button.append(title, details)
      button.onclick = () => {
        select.value = item.id
        drawer(false)
        $('codex-status').textContent = ''
        void action(() => read())
      }
      return button
    }))
  }

  function clearOutput() {
    currentJob = undefined
    $('codex-pending').hidden = $('codex-output').hidden = $('codex-log').hidden = true
    $('codex-activity').hidden = true
  }

  async function read(older = false) {
    const id = select.value
    const version = ++request
    const previousHeight = scroll.scrollHeight
    if (!older) { clearOutput(); cursor = undefined; history = []; renderHistory(); renderThreads() }
    const selected = threads.find(item => item.id === id)
    const status = $('codex-history-status')
    status.textContent = ''
    $('codex-history-retry').hidden = true
    $('codex-share').hidden = api.mobile || !selected || config?.shareAll
    if (selected) $('codex-share').textContent = selected.shared ? '取消共享' : '共享给已配对设备'
    if (!id) return
    status.textContent = older ? '正在加载更早的消息…' : '正在读取主机上的历史消息…'
    $('codex-older').disabled = true
    try {
      const result = await api.codex('read', { id, cursor })
      if (version !== request) return
      cursor = result.cursor
      history = [...result.messages, ...history]
      renderHistory()
      status.textContent = !history.length ? (cursor ? '本页没有聊天消息，可以继续向前查看。' : '这条会话还没有聊天消息。') : ''
      if (older) scroll.scrollTop += scroll.scrollHeight - previousHeight
      else bottom()
    } catch (error) {
      if (version !== request) return
      status.textContent = errorMessage(error)
      retryOlder = older
      $('codex-history-retry').hidden = false
    } finally {
      if (version === request) $('codex-older').disabled = false
    }
  }

  async function load(preferred = select.value, more = false, refresh = false) {
    const before = ++listRequest
    const status = $('codex-list-status')
    const search = $('codex-search').value.trim()
    status.textContent = '正在读取主机上的会话…'
    $('codex-more').disabled = true
    let result
    try {
      result = await api.codex('list', { search, cursor: more ? listCursor : null, refresh })
    } catch (error) {
      if (before === listRequest) status.textContent = errorMessage(error)
      return
    } finally {
      if (before === listRequest) $('codex-more').disabled = false
    }
    if (before !== listRequest) return
    if (result.sharing === 'none') preferred = ''
    threads = more && result.sharing !== 'none'
      ? [...new Map([...threads, ...result.threads].map(item => [item.id, item])).values()] : result.threads
    listCursor = result.cursor
    $('codex-more').hidden = listCursor == null
    status.textContent = result.sharing === 'none'
      ? '主机还没有共享会话。请在电脑的「设置 → 桃桃 AI」开启「向已配对设备共享当前账号的所有会话」，或单独共享一条会话。'
      : threads.length ? (result.sharing === 'selected' ? '仅显示主机单独共享的会话。' : '')
        : search ? '没有找到匹配的会话。' : '目前没有可查看的会话。'
    select.replaceChildren(new Option('新会话', ''), ...threads.map(item => {
      const folder = item.cwd?.split(/[\\/]/).filter(Boolean).at(-1)
      const details = [folder, item.archived ? '已归档' : '', item.shared && !api.mobile ? '已共享' : ''].filter(Boolean)
      return new Option([item.title, ...details].join(' · '), item.id)
    }))
    if (preferred && !threads.some(item => item.id === preferred)) select.add(new Option('当前会话', preferred))
    select.value = preferred
    renderThreads()
    if (!more || result.sharing === 'none') await read()
  }

  async function observe(started) {
    const before = scope
    watching = true
    $('codex-send').disabled = true
    $('codex-new').disabled = true
    select.disabled = true
    renderThreads()
    try {
      const job = await started()
      if (!job || before !== scope) return
      if (job.threadId && job.threadId !== select.value) {
        if (!Array.from(select.options).some(option => option.value === job.threadId)) {
          select.add(new Option('当前会话', job.threadId))
        }
        select.value = job.threadId
        await read()
        if (before !== scope) return
      }
      const result = await followCodex(api, job, draw, () => before === scope)
      if (!result || before !== scope) return
      if (result.status === 'completed') {
        await load(result.threadId)
        if (before !== scope) return
        if (result.output && !history.some(item => item.role === 'Codex' && item.text.includes(result.output))) draw(result)
        else {
          drawActivity(result)
          $('codex-log').querySelector('pre').textContent = result.log
          $('codex-log').hidden = !result.log
        }
      }
      return result
    } finally {
      if (before === scope) {
        watching = false
        $('codex-send').disabled = false
        $('codex-new').disabled = false
        select.disabled = false
        $('codex-stop').hidden = true
        renderThreads()
      }
    }
  }

  async function refresh() {
    if (watching) return model.load()
    $('codex-status').textContent = ''
    await Promise.all([load(select.value, false, true), model.load()])
    if (!watching) await observe(() => api.codex('active'))
  }

  function open(showSettings = false) {
    if (showSettings && !api.mobile) {
      drawer(true)
      $('codex-host-config').open = true
      $('codex-drawer').scrollTop = 0
    }
    void action(async () => {
      await Promise.all([refresh(), !api.mobile && api.codexSettings().then(drawConfig)])
    })
  }
  $('codex-new').onclick = () => {
    select.value = ''
    promptBox.value = ''
    $('codex-status').textContent = ''
    drawer(false)
    void action(() => read())
    promptBox.focus()
  }
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
    for (const [field, setting] of Object.entries({
      'codex-remote': 'enabled', 'codex-full-access': 'fullAccess', 'codex-write': 'write', 'codex-all': 'shareAll',
    })) {
      $(field).onchange = () => action(async () => {
        try {
          drawConfig(await api.codexConfigure({ [setting]: $(field).checked }))
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
  $('codex-more').onclick = () => { if (!watching) void action(() => load(select.value, true)) }
  $('codex-search-form').onsubmit = event => {
    event.preventDefault()
    if (!watching) void action(() => load(select.value))
  }
  $('codex-search').onchange = () => { if (!watching) void action(() => load(select.value)) }
  $('codex-older').onclick = () => action(() => read(true))
  $('codex-history-retry').onclick = () => action(() => read(retryOlder))
  select.onchange = () => action(() => read())
  $('codex-stop').onclick = () => action(async () => {
    if (currentJob?.turnId) await api.codex('interrupt', currentJob.id)
  })

  $('codex-display-check').onclick = () => {
    const before = scope
    const button = $('codex-display-check')
    const report = $('codex-display-report')
    button.disabled = true
    report.textContent = '正在读取电脑的显示设备和系统事件…'
    report.hidden = !taskMode
    bottom()
    void api.codex('display-check').then(result => {
      if (before === scope) report.textContent = result
    }).catch(error => {
      if (before === scope) report.textContent = errorMessage(error)
    }).finally(() => {
      if (before !== scope) return
      button.disabled = false
      if (taskMode) bottom()
    })
  }

  function drawActivity(job) {
    const activity = $('codex-activity')
    activity.hidden = !job.taskMode
    activity.textContent = job.awaitingApproval ? '等待电脑端确认权限'
      : job.runningCommand && job.status === 'running' ? '正在电脑上运行命令'
        : job.commandsRun ? '电脑已运行 ' + job.commandsRun + ' 条命令'
          : job.commandDeclined ? '命令未获授权' : job.status === 'running' ? '正在等待电脑端工具'
            : '这次没有命令执行记录'
  }

  function draw(job) {
    currentJob = job
    $('codex-send').disabled = steering || (watching && (job.status !== 'running' || !job.turnId))
    $('codex-output').textContent = job.output
    $('codex-output').hidden = !job.output
    $('codex-pending').textContent = job.prompt || ''
    $('codex-pending').hidden = !job.prompt
    $('codex-empty').hidden = true
    $('codex-log').querySelector('pre').textContent = job.log
    $('codex-log').hidden = !job.log
    $('codex-stop').hidden = job.status !== 'running' || !job.turnId
    drawActivity(job)
    $('codex-status').textContent = job.status === 'running'
      ? job.awaitingApproval ? '请在电脑上确认这次权限请求。' : job.retrying ? '电脑正在重试请求…' : '电脑正在处理…'
      : job.status === 'interrupted' ? '已停止' : job.status === 'failed' ? job.error : '已完成'
    bottom()
  }

  $('codex-form').onsubmit = event => {
    event.preventDefault()
    const prompt = promptBox.value.trim()
    if (watching) {
      if (steering || !prompt || !currentJob?.turnId || currentJob.status !== 'running') return
      const before = scope
      steering = true
      $('codex-send').disabled = true
      void action(async () => {
        try {
          await api.codex('steer', { id: currentJob.id, turnId: currentJob.turnId, prompt })
          if (scope === before && promptBox.value.trim() === prompt) promptBox.value = ''
        } finally {
          steering = false
          if (scope === before) $('codex-send').disabled = watching && !currentJob?.turnId
        }
      })
      return
    }
    if (!prompt || (!taskMode && !select.value && routeToNotes(prompt))) {
      if (prompt) promptBox.value = ''
      return
    }
    const before = scope
    void action(async () => {
      $('codex-status').textContent = '正在连接主机…'
      try {
        const result = await observe(async () => {
          const job = await api.codex('send', { id: select.value || null, prompt, taskMode, ...model.options() })
          if (before === scope && promptBox.value.trim() === prompt) promptBox.value = ''
          return job
        })
        if (result?.status === 'failed' && before === scope && !promptBox.value) promptBox.value = prompt
      } catch (error) {
        if (before !== scope) return
        if (!promptBox.value) promptBox.value = prompt
        throw error
      }
    })
  }
  promptBox.onkeydown = event => {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.isComposing) {
      event.preventDefault()
      $('codex-form').requestSubmit()
    }
  }
  return {
    open, model, drawer,
    work(enabled) {
      taskMode = enabled
      $('codex-task-tools').hidden = !enabled
      $('codex-display-report').hidden = !enabled || !$('codex-display-report').textContent
      promptBox.placeholder = enabled ? '让电脑执行或检查什么？' : '给桃桃 AI 发消息'
    },
    reset() {
      ++scope
      ++request
      ++listRequest
      threads = []
      history = []
      cursor = listCursor = currentJob = undefined
      watching = false
      model.reset()
      $('codex-display-check').disabled = false
      $('codex-display-report').textContent = ''
      $('codex-display-report').hidden = $('codex-activity').hidden = true
      select.replaceChildren(new Option('新会话', ''))
      select.disabled = false
      $('codex-send').disabled = false
      $('codex-new').disabled = false
      $('codex-stop').hidden = $('codex-output').hidden = $('codex-log').hidden = $('codex-more').hidden = true
      $('codex-history-retry').hidden = true
      $('codex-more').disabled = $('codex-older').disabled = false
      $('codex-list-status').textContent = $('codex-history-status').textContent = ''
      $('codex-search').value = $('codex-prompt').value = ''
      $('codex-status').textContent = $('codex-output').textContent = $('codex-log').querySelector('pre').textContent = ''
      renderHistory()
      clearOutput()
      renderThreads()
      drawer(false)
    },
  }
}
