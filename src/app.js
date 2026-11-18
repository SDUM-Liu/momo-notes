import { Editor } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { TaskItem, TaskList } from '@tiptap/extension-list'
import { TableKit } from '@tiptap/extension-table'
import { Image } from '@tiptap/extension-image'
import { Placeholder } from '@tiptap/extension-placeholder'
import { linkOrNull, webUrl } from '../shared/links.mjs'
import { defaultCategory, nodeText, noteKey } from '../shared/notes.mjs'
import pet from './assets/pet.png'
import perch from './assets/perch.png'
import defaultEdge from './assets/edge.png'
import './style.css'

const api = window.momo ?? (await import('./mobile-bridge.js')).createMobileBridge()
if (api.mobile) document.body.dataset.platform = 'mobile'
const $ = id => document.getElementById(id)
const iconFiles = import.meta.glob('/node_modules/lucide-static/icons/{calendar,globe,sparkles,settings,bold,italic,underline,strikethrough,heading,list-checks,list,list-ordered,link,image,table-2}.svg', {
  query: '?raw', import: 'default', eager: true,
})
for (const button of document.querySelectorAll('[data-icon]')) {
  button.innerHTML = iconFiles['/node_modules/lucide-static/icons/' + button.dataset.icon + '.svg'] ?? ''
}

const dayFormat = new Intl.DateTimeFormat('zh-CN', { month: 'long', day: 'numeric' })
const weekFormat = new Intl.DateTimeFormat('zh-CN', { weekday: 'long' })
const noteDate = day => new Date(day + 'T12:00:00')
let state, currentDate, today, editor
let edgeDraft = ''
let clearKey = false
let updateState
let browserState
let view = 'note'
let saveQueue = Promise.resolve()
let pageRequest = 0
let previousSaveError = false
let followNewDay = false
let category = defaultCategory
const revisions = new Map()
const visited = new Map()
let editGeneration = 0
let readOnly = false
let retryOnUnlock = false

function errorMessage(error) {
  return String(error?.message || error).replace(/^Error invoking remote method '[^']+': Error: /, '')
}

function noteStatus(message, error = false) {
  $('status').textContent = message
  $('status').classList.toggle('error', error)
}

function showView(next) {
  if (view === 'browser' && next !== 'browser') void api.hideBrowser()
  if (view === 'sync' && next !== 'sync') {
    ++qrRequest
    $('sync-qr').hidden = true
    $('sync-qr').removeAttribute('src')
    $('sync-code').value = ''
    $('sync-pair-code').value = ''
  }
  view = next
  for (const name of ['note', 'history', 'settings', 'ai', 'browser', 'sync']) {
    $(name + '-view').hidden = name !== next
  }
  $('history').classList.toggle('active', next === 'history')
  $('browser').classList.toggle('active', next === 'browser')
  $('settings').classList.toggle('active', next === 'settings')
  $('question').classList.toggle('active', next === 'ai')
  $('table-menu').hidden = true
  $('link-form').hidden = true
  $('category-form').hidden = true
  mascotLabel()
  if (next === 'browser') sendBrowserViewport()
  if (next === 'note' && followNewDay && !editor.view.composing) void loadNote()
}

function drawState(value) {
  const wasMode = state?.mode
  state = value
  today = state.today
  drawUpdate(state.update)
  drawBrowser(state.browser)
  drawCategories(value.categories)
  setReadOnly(value.locked)
  document.body.dataset.mode = state.mode
  document.body.dataset.edge = state.edge ?? ''
  $('panel').hidden = state.mode !== 'note'
  $('mascot-image').src = state.mode === 'note' ? perch : state.mode === 'edge' ? state.settings.edgeImage || defaultEdge : pet
  $('mascot-image').classList.toggle('custom', Boolean(state.settings.edgeImage))
  mascotLabel()
  if (wasMode !== 'note' && state.mode === 'note') {
    showView('note')
    if (!editor || !currentDate) void loadNote()
  }
}

function mascotLabel() {
  const label = state?.mode !== 'note' ? '打开便签' : view === 'browser' ? '返回便签' : '收起便签'
  $('mascot').setAttribute('aria-label', label)
  $('mascot').title = label
}

function drawCategories(values) {
  $('categories').replaceChildren(...values.map(({ id, name }) => new Option(name, id)))
  $('categories').value = category
}

function setReadOnly(value) {
  const wasLocked = readOnly
  readOnly = Boolean(value)
  if (wasLocked === readOnly) return
  editor?.setEditable(!readOnly, false)
  $('note-locked').hidden = !readOnly
  for (const button of document.querySelectorAll('#new-category, #category-form button[type=submit], .toolbar button')) {
    button.disabled = readOnly
  }
  if (readOnly) {
    $('category-form').hidden = true
    $('link-form').hidden = true
    $('table-menu').hidden = true
  }
  if (wasLocked && !readOnly && retryOnUnlock && currentDate) {
    retryOnUnlock = false
    saveDocument(editor.getJSON())
  }
}

function drawDate() {
  const date = noteDate(currentDate)
  const isToday = currentDate === today
  $('note-date').textContent = dayFormat.format(date)
  $('date-caption').textContent = (isToday ? '今天 · ' : date.getFullYear() + ' 年 · ') + weekFormat.format(date)
  $('return-today').hidden = isToday
}

function drawProgress() {
  let done = 0
  let total = 0
  editor.state.doc.descendants(node => {
    if (node.type.name === 'taskItem') {
      total += 1
      if (node.attrs.checked) done += 1
    }
  })
  $('progress').textContent = total ? done + ' / ' + total + ' 项完成' : ''
  for (const button of document.querySelectorAll('[data-edit]')) {
    button.setAttribute('aria-pressed', String(editor.isActive(button.dataset.edit)))
  }
}

function saveDocument(doc) {
  const date = currentDate
  const selected = category
  const key = noteKey(selected, date)
  const generation = ++editGeneration
  noteStatus('保存中…')
  saveQueue = saveQueue.then(() => api.saveNote(date, doc, selected, revisions.get(key) ?? null)).then(saved => {
    const merged = JSON.stringify(saved.doc) !== JSON.stringify(doc)
    previousSaveError = false
    const active = date === currentDate && selected === category && generation === editGeneration
    if (!merged || (active && !editor.view.composing)) revisions.set(key, saved.rev)
    if (!active) return
    if (merged && !editor.view.composing) {
      editor.commands.setContent(saved.doc, { emitUpdate: false })
      drawProgress()
    }
    noteStatus('已保存')
  }).catch(error => {
    previousSaveError = true
    const message = errorMessage(error)
    retryOnUnlock = /同步中|主机未连接/.test(message)
    $('reload-shared-note').hidden = !message.includes('主机已有更新')
    noteStatus(message, true)
  })
}

async function saveBeforeSwitch() {
  await saveQueue
  if (previousSaveError && editor && currentDate) {
    saveDocument(editor.getJSON())
    await saveQueue
  }
  if (previousSaveError) throw new Error('请先解决当前便签的保存错误')
}

async function loadNote(date, selected = category) {
  followNewDay = false
  const request = ++pageRequest
  try {
    await saveBeforeSwitch()
    const page = await api.openNote(date, selected)
    if (request !== pageRequest) return
    if (currentDate !== page.date || category !== page.category) editor.commands.setContent(page.doc, { emitUpdate: false })
    category = page.category
    $('categories').value = category
    currentDate = page.date
    today = page.today
    revisions.set(noteKey(category, currentDate), page.rev)
    visited.set(category, currentDate === today ? null : currentDate)
    drawDate()
    drawProgress()
    noteStatus('已保存')
    showView('note')
  } catch (error) {
    if (request !== pageRequest) return
    noteStatus(errorMessage(error), true)
    $('categories').value = category
    showView('note')
  }
}

function wireDrag(element, click) {
  if (api.mobile) {
    if (click) element.addEventListener('click', click)
    return
  }
  let active = false
  let pointer
  element.addEventListener('pointerdown', event => {
    if (event.button !== 0 || active) return
    if (element === $('mascot') && state.mode === 'note') return
    active = true
    pointer = event.pointerId
    element.setPointerCapture(pointer)
    api.dragStart()
  })
  element.addEventListener('pointermove', event => {
    if (active && event.pointerId === pointer) api.dragMove()
  })
  element.addEventListener('pointerup', event => {
    if (!active || event.pointerId !== pointer) return
    active = false
    api.dragEnd()
  })
  element.addEventListener('lostpointercapture', () => {
    if (!active) return
    active = false
    api.cancelDrag()
  })
  if (click) {
    element.addEventListener('click', event => {
      if (state.mode === 'note' || event.detail === 0) click()
    })
  }
}

wireDrag($('mascot'), () => {
  if (state.mode === 'note' && view === 'browser') showView('note')
  else void api.toggle()
})
wireDrag($('title-drag'))
$('return-today').onclick = () => loadNote()
$('reload-shared-note').onclick = async () => {
  const page = await api.openNote(currentDate, category).catch(error => {
    noteStatus(errorMessage(error), true)
    return null
  })
  if (!page) return
  $('saved-editor-draft').value = nodeText(editor.getJSON(), true)
  $('saved-editor-draft').hidden = false
  $('reload-shared-note').hidden = true
  revisions.set(noteKey(category, currentDate), page.rev)
  previousSaveError = false
  editor.commands.setContent(page.doc, { emitUpdate: false })
  drawProgress()
  noteStatus('已加载主机内容，原稿可在下方复制。')
}
for (const back of document.querySelectorAll('.back')) back.onclick = () => showView('note')
$('categories').onchange = () => {
  const selected = $('categories').value
  void loadNote(visited.get(selected), selected)
}
$('new-category').onclick = () => {
  $('category-form').hidden = false
  $('category-name').focus()
}
$('category-cancel').onclick = () => { $('category-form').hidden = true }
$('category-form').onsubmit = async event => {
  event.preventDefault()
  try {
    await saveBeforeSwitch()
    state.categories = await api.addCategory($('category-name').value)
    $('category-name').value = ''
    drawCategories(state.categories)
    await loadNote(undefined, state.categories.at(-1).id)
  } catch (error) {
    noteStatus(errorMessage(error), true)
  }
}

function sendBrowserViewport() {
  if (view !== 'browser' || state?.mode !== 'note') return
  const { x, y, width, height } = $('browser-viewport').getBoundingClientRect()
  void api.browserViewport({ x, y, width, height })
}

function drawBrowser(value) {
  browserState = value
  if (document.activeElement !== $('browser-url')) $('browser-url').value = value.url
  $('browser-back').disabled = !value.canGoBack
  $('browser-empty').hidden = Boolean(value.url) && !api.mobile
  $('browser-status').textContent = value.error || (value.loading ? '正在加载…' : '')
  if (value.closed && view === 'browser') showView('note')
}

async function openPage(value) {
  try {
    const url = webUrl(value)
    $('browser-url').blur()
    await saveBeforeSwitch()
    showView('browser')
    $('browser-url').value = url
    await api.openBrowser(url)
  } catch (error) {
    if (view === 'browser') $('browser-status').textContent = errorMessage(error)
    else noteStatus(errorMessage(error), true)
  }
}

new ResizeObserver(sendBrowserViewport).observe($('browser-viewport'))
$('browser').onclick = () => {
  const next = view === 'browser' ? 'note' : 'browser'
  showView(next)
  if (next === 'browser' && !browserState?.url) $('browser-url').focus()
}
$('browser-back').onclick = () => api.browserBack()
$('browser-bar').onsubmit = event => {
  event.preventDefault()
  void openPage($('browser-url').value)
}

$('insert-link').onmousedown = event => event.preventDefault()
$('insert-link').onclick = () => {
  $('table-menu').hidden = true
  $('link-form').hidden = false
  $('link-url').value = editor.getAttributes('link').href ?? ''
  $('link-label').value = ''
  $('link-label-row').hidden = !editor.state.selection.empty || editor.isActive('link')
  $('link-error').textContent = ''
  $('link-url').focus()
}
$('link-cancel').onclick = () => {
  $('link-form').hidden = true
  editor.commands.focus()
}
$('link-form').onsubmit = event => {
  event.preventDefault()
  try {
    const href = webUrl($('link-url').value)
    const chain = editor.chain().focus()
    if ($('link-label-row').hidden) chain.extendMarkRange('link').setLink({ href }).run()
    else chain.insertContent({ type: 'text', text: $('link-label').value.trim() || href, marks: [{ type: 'link', attrs: { href } }] }).run()
    $('link-form').hidden = true
  } catch (error) {
    $('link-error').textContent = errorMessage(error)
  }
}

$('history').onclick = async () => {
  if (view === 'history') return showView('note')
  showView('history')
  const list = $('dates')
  list.textContent = '正在读取…'
  try {
    await saveBeforeSwitch()
    const dates = await api.listDates(category)
    list.replaceChildren()
    for (const date of dates) {
      const button = document.createElement('button')
      const title = document.createElement('span')
      title.textContent = date === today ? '今天' : dayFormat.format(noteDate(date))
      const stamp = document.createElement('time')
      stamp.dateTime = date
      stamp.textContent = date
      button.append(title, stamp)
      button.classList.toggle('selected', date === currentDate)
      button.onclick = () => loadNote(date)
      list.append(button)
    }
  } catch (error) {
    list.textContent = errorMessage(error)
  }
}

const editActions = {
  bold: chain => chain.toggleBold(), italic: chain => chain.toggleItalic(),
  underline: chain => chain.toggleUnderline(), strike: chain => chain.toggleStrike(),
  heading: chain => chain.toggleHeading({ level: 2 }),
  taskList: chain => chain.toggleTaskList(), bulletList: chain => chain.toggleBulletList(),
  orderedList: chain => chain.toggleOrderedList(),
}

for (const button of document.querySelectorAll('[data-edit]')) {
  button.onmousedown = event => event.preventDefault()
  button.onclick = () => editActions[button.dataset.edit](editor.chain().focus()).run()
}

$('table-tools').onmousedown = event => event.preventDefault()
$('table-tools').onclick = () => {
  $('link-form').hidden = true
  const inTable = editor.isActive('table')
  for (const button of $('table-menu').children) button.disabled = button.dataset.table !== 'insertTable' && !inTable
  $('table-menu').hidden = !$('table-menu').hidden
}
for (const button of $('table-menu').children) {
  button.onmousedown = event => event.preventDefault()
  button.onclick = () => {
    const command = button.dataset.table
    const chain = editor.chain().focus()
    if (command === 'insertTable') chain.insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()
    else chain[command]().run()
    $('table-menu').hidden = true
  }
}
$('editor').addEventListener('pointerdown', () => { $('table-menu').hidden = true })

function fileData(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result)
    reader.onerror = () => reject(new Error('图片读取失败'))
    reader.readAsDataURL(file)
  })
}

async function insertImages(files, position) {
  if (readOnly) return
  const date = currentDate
  const selected = category
  for (const file of files) {
    try {
      if (!/^image\/(png|jpeg|webp|gif|bmp)$/.test(file.type)) throw new Error('请使用 PNG、JPG、WebP、GIF 或 BMP 图片')
      if (file.size > 8 * 1024 * 1024) throw new Error('请选择 8 MB 以内的图片')
      const src = await fileData(file)
      if (readOnly || date !== currentDate || selected !== category) return
      const image = { type: 'image', attrs: { src, alt: file.name } }
      if (position !== undefined) editor.chain().focus().insertContentAt(position, image).run()
      else editor.chain().focus().setImage(image.attrs).run()
      position = undefined
    } catch (error) {
      noteStatus(errorMessage(error), true)
    }
  }
}

$('insert-image').onmousedown = event => event.preventDefault()
$('insert-image').onclick = () => $('image-input').click()
$('image-input').onchange = () => {
  void insertImages([...$('image-input').files])
  $('image-input').value = ''
}

function renderEdgePreview() {
  $('edge-preview').src = edgeDraft || defaultEdge
  $('reset-edge').disabled = !edgeDraft
}

function drawUpdate(update) {
  updateState = update
  const { status, target, progress } = update
  const messages = {
    idle: '',
    unavailable: '请使用对应平台的安装包更新',
    mobile: '通过该平台的安装渠道更新',
    checking: '正在检查更新…',
    current: '已是最新版本',
    available: '可更新至 v' + target,
    downloading: progress === undefined ? '正在准备下载…' : '正在下载 · ' + progress + '%',
    ready: 'v' + target + ' 已下载',
    installing: '正在退出并安装…',
    'check-error': '检查失败，请确认可访问 GitHub',
    'download-error': '下载失败，请重试',
    'install-error': '无法启动安装，请重试',
  }
  const actionLabels = {
    available: '下载更新', downloading: '下载中', ready: '安装并重启',
    installing: '安装中', 'download-error': '重新下载', 'install-error': '重试安装',
  }
  $('app-version').textContent = '当前版本 v' + update.version
  $('update-status').textContent = messages[status]
  $('update-status').classList.toggle('error', status.endsWith('-error'))
  $('settings').toggleAttribute('data-update', ['available', 'ready', 'downloading', 'download-error', 'install-error'].includes(status))
  $('update-action').textContent = actionLabels[status] ?? '检查更新'
  $('update-action').hidden = status === 'mobile'
  $('update-action').disabled = ['unavailable', 'mobile', 'checking', 'downloading', 'installing'].includes(status)
  $('automatic-update-row').hidden = ['unavailable', 'mobile'].includes(status)
  $('update-progress').hidden = status !== 'downloading'
  if (progress === undefined) $('update-progress').removeAttribute('value')
  else $('update-progress').value = progress
}

$('update-action').onclick = async () => {
  const { status } = updateState
  $('update-action').disabled = true
  try {
    if (['ready', 'install-error'].includes(status)) {
      await saveBeforeSwitch()
      await api.installUpdate()
    } else if (['available', 'download-error'].includes(status)) {
      await api.downloadUpdate()
    } else {
      await api.checkUpdate()
    }
  } catch (error) {
    $('update-status').textContent = errorMessage(error)
    $('update-status').classList.add('error')
    $('update-action').disabled = false
  }
}

$('settings').onclick = () => {
  if (view === 'settings') return showView('note')
  const settings = state.settings
  $('pin').checked = settings.alwaysOnTop
  $('startup').checked = settings.openAtLogin
  $('snap').checked = settings.snap
  $('automatic-update').checked = Boolean(settings.autoInstallUpdates)
  $('base-url').value = settings.baseUrl
  $('model').value = settings.model
  $('proxy').value = settings.proxyPort
  $('proxy').placeholder = api.mobile ? '留空使用系统网络' : '留空直连'
  $('api-key').value = ''
  $('api-key').placeholder = settings.hasKey ? '已保存 · 留空保留' : '本地服务可留空'
  clearKey = false
  $('clear-key').hidden = !settings.hasKey
  edgeDraft = settings.edgeImage
  renderEdgePreview()
  $('settings-status').textContent = ''
  showView('settings')
  void Promise.resolve(api.syncState()).then(drawSync).catch(() => {})
}

let syncState, qrRequest = 0
function drawSync(value) {
  syncState = value
  const mobile = value.role === 'mobile'
  $('sync-host').hidden = mobile
  $('sync-mobile').hidden = !mobile
  $('api-settings').hidden = mobile && value.enabled
  $('mobile-ai-host').hidden = !mobile || !value.enabled
  if (mobile) {
    $('sync-now').hidden = !value.enabled
    $('sync-unpair').hidden = !value.enabled
    $('sync-status').textContent = value.error || (value.locked ? '设备同步中，便签只读' : value.enabled
      ? '主机 ' + value.host + (value.last ? ' · ' + new Date(value.last).toLocaleTimeString() : ' · 等待首次同步')
      : '从桌面主机获取配对码或二维码。')
    return
  }
  $('sync-enable').textContent = value.enabled ? '停止主机同步' : '开启主机同步'
  $('sync-host-details').hidden = !value.enabled
  $('sync-status').textContent = value.enabled ? (value.addresses.length ? '主机正在运行' : '主机正在运行，等待可用网络地址') : '将这台电脑设为便签和 AI 的主机。'
  const previous = $('sync-address').value
  $('sync-address').replaceChildren(...value.addresses.map(address => new Option(address, address)))
  if (value.addresses.includes(previous)) $('sync-address').value = previous
}

async function showPairing() {
  const request = ++qrRequest
  const address = $('sync-address').value
  $('sync-qr').hidden = true
  $('sync-qr').removeAttribute('src')
  $('sync-code').value = ''
  if (view !== 'sync' || !address || !syncState?.enabled) return
  const code = await api.syncCode(address)
  if (view !== 'sync' || request !== qrRequest) return
  $('sync-code').value = code
  const qr = await import('qrcode')
  const png = await (qr.default ?? qr).toDataURL(code, { width: 256, margin: 3 })
  if (view !== 'sync' || request !== qrRequest) return
  $('sync-qr').src = png
  $('sync-qr').hidden = false
}

async function syncAction(operation, button) {
  if (button) button.disabled = true
  try {
    const value = await operation()
    if (value) drawSync(value)
    if (!api.mobile) await showPairing()
  } catch (error) {
    $('sync-status').textContent = errorMessage(error)
  } finally {
    if (button) button.disabled = false
  }
}

$('settings-sync').onclick = () => {
  showView('sync')
  void syncAction(() => api.syncState())
}
$('sync-back').onclick = () => showView('settings')
$('sync-enable').onclick = () => syncAction(() => api.enableSync(!syncState.enabled), $('sync-enable'))
$('sync-address').onchange = () => syncAction(() => showPairing())
$('sync-code').onclick = event => event.currentTarget.select()
$('sync-rotate').onclick = () => syncAction(() => api.rotateSync(), $('sync-rotate'))
$('sync-now').onclick = () => syncAction(() => api.runSync(), $('sync-now'))
$('sync-unpair').onclick = () => syncAction(() => api.unpairSync(), $('sync-unpair'))
$('sync-drafts').onclick = async () => {
  const drafts = await api.syncDrafts()
  $('sync-draft-text').value = Object.entries(drafts).map(([key, doc]) => key + '\n' + nodeText(doc, true)).join('\n\n') || '没有待整理的草稿'
  $('sync-draft-text').hidden = false
}
$('sync-mobile').onsubmit = event => {
  event.preventDefault()
  void syncAction(async () => {
    const result = await api.pairSync($('sync-pair-code').value)
    $('sync-pair-code').value = ''
    return result
  }, $('sync-pair'))
}
$('sync-photo').onchange = async event => {
  const [file] = event.target.files
  event.target.value = ''
  if (!file) return
  try {
    if (file.size > 20 * 1024 * 1024) throw new Error('请选择 20 MB 以内的二维码图片')
    const image = new window.Image()
    image.src = await fileData(file)
    await image.decode()
    const factor = Math.min(1, 1600 / Math.max(image.width, image.height))
    const canvas = document.createElement('canvas')
    canvas.width = Math.round(image.width * factor)
    canvas.height = Math.round(image.height * factor)
    const context = canvas.getContext('2d')
    context.drawImage(image, 0, 0, canvas.width, canvas.height)
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height)
    const { default: scan } = await import('jsqr')
    const result = scan(pixels.data, pixels.width, pixels.height)
    if (!result) throw new Error('未识别到二维码，请让二维码充满画面或粘贴配对码')
    $('sync-pair-code').value = result.data
  } catch (error) {
    $('sync-status').textContent = errorMessage(error)
  }
}

$('choose-edge').onclick = async () => {
  try {
    const image = await api.chooseEdgeImage()
    if (image) {
      edgeDraft = image
      renderEdgePreview()
    }
  } catch (error) {
    $('settings-status').textContent = errorMessage(error)
  }
}
$('reset-edge').onclick = () => {
  edgeDraft = ''
  renderEdgePreview()
}
$('clear-key').onclick = () => {
  clearKey = true
  $('api-key').value = ''
  $('api-key').placeholder = '保存设置后清除'
}

$('settings-form').onsubmit = async event => {
  event.preventDefault()
  $('settings-status').textContent = ''
  const key = $('api-key').value.trim()
  try {
    state.settings = await api.saveSettings({
      alwaysOnTop: $('pin').checked, openAtLogin: $('startup').checked, snap: $('snap').checked,
      autoInstallUpdates: $('automatic-update').checked,
      edgeImage: edgeDraft, baseUrl: $('base-url').value.trim(), model: $('model').value.trim(),
      proxyPort: $('proxy').value.trim(), newKey: key || (clearKey ? '' : null),
    })
    $('api-key').value = ''
    showView('note')
  } catch (error) {
    $('settings-status').textContent = errorMessage(error)
  }
}

$('question').onclick = () => showView(view === 'ai' ? 'note' : 'ai')
const questionRequest = () => ({ question: $('prompt').value.trim(), scope: $('scope').value, date: currentDate, category })
$('copy-chat').onclick = async () => {
  const answer = $('answer')
  answer.hidden = false
  try {
    await saveBeforeSwitch()
    const manual = await api.copyChat(questionRequest())
    $('chat-text').hidden = !manual
    $('chat-text').value = manual || ''
    answer.textContent = manual ? '请选择上方文字，复制后粘贴到 ChatGPT。' : '已复制。请粘贴到已打开的 ChatGPT 聊天并发送。'
  } catch (error) {
    answer.textContent = errorMessage(error)
  }
}
for (const [button, target] of [['project-repo', 'repo'], ['project-issues', 'issues'], ['open-chat', 'chat']]) {
  $(button).onclick = () => api.openProject(target).catch(error => noteStatus(errorMessage(error), true))
}
$('ai-form').onsubmit = async event => {
  event.preventDefault()
  const question = $('prompt').value.trim()
  if (!question) return
  const answer = $('answer')
  const send = $('send-question')
  send.disabled = true
  answer.hidden = false
  answer.classList.remove('error')
  answer.textContent = '正在读取便签并生成回答…'
  try {
    await saveBeforeSwitch()
    answer.textContent = await api.ask(questionRequest())
  } catch (error) {
    answer.classList.add('error')
    answer.textContent = errorMessage(error)
  } finally {
    send.disabled = false
  }
}

function imageFiles(transfer) {
  return [...(transfer?.files ?? [])].filter(file => file.type.startsWith('image/'))
}

async function init() {
  editor = new Editor({
    element: $('editor'),
    extensions: [
      StarterKit.configure({ link: { openOnClick: false, defaultProtocol: 'https', isAllowedUri: url => Boolean(linkOrNull(url)) } }),
      TaskList, TaskItem.configure({
        nested: true,
        a11y: { checkboxLabel: node => node.attrs.checked ? '恢复为待办' : '标记完成' },
      }),
      Image.configure({ allowBase64: true, resize: { enabled: true, minWidth: 40, minHeight: 30 } }),
      TableKit.configure({ table: { resizable: true } }),
      Placeholder.configure({ placeholder: '写下一件待办…', includeChildren: true }),
    ],
    editorProps: {
      attributes: { 'aria-label': '便签正文', spellcheck: 'false' },
      handleClick(_view, _pos, event) {
        const href = event.target.closest?.('a[href]')?.getAttribute('href')
        if (!href) return false
        event.preventDefault()
        void openPage(href)
        return true
      },
      handlePaste(_view, event) {
        const files = imageFiles(event.clipboardData)
        if (!files.length) return false
        void insertImages(files)
        return true
      },
      handleDrop(view, event, _slice, moved) {
        const files = imageFiles(event.dataTransfer)
        if (moved || !files.length) return false
        const point = view.posAtCoords({ left: event.clientX, top: event.clientY })
        void insertImages(files, point?.pos)
        return true
      },
    },
    onUpdate: ({ editor }) => {
      drawProgress()
      if (currentDate) saveDocument(editor.getJSON())
    },
    onSelectionUpdate: () => { if (editor) drawProgress() },
  })
  api.onState(drawState)
  api.onUpdate(drawUpdate)
  api.onBrowser(drawBrowser)
  api.onNotes(async change => {
    if (!state) return
    if (change.openToday) {
      void loadNote(undefined, defaultCategory)
      return
    }
    if (typeof change.locked === 'boolean') {
      state.locked = change.locked
      setReadOnly(change.locked)
      return
    }
    if (change.categories) {
      state.categories = change.categories
      drawCategories(state.categories)
      return
    }
    if (!currentDate || change.key !== noteKey(category, currentDate)) return
    const generation = editGeneration
    const request = pageRequest
    if (editor.view.composing) return
    await saveQueue
    const page = await api.openNote(currentDate, category).catch(() => null)
    if (!page || previousSaveError || generation !== editGeneration || request !== pageRequest || editor.view.composing) return
    revisions.set(change.key, page.rev)
    if (JSON.stringify(editor.getJSON()) !== JSON.stringify(page.doc)) {
      editor.commands.setContent(page.doc, { emitUpdate: false })
      drawProgress()
    }
  })
  api.onSync?.(drawSync)
  api.onDay(next => {
    followNewDay ||= currentDate === today
    today = next
    if (!followNewDay || view !== 'note') {
      if (currentDate) drawDate()
    } else if (editor.view.composing) {
      editor.view.dom.addEventListener('compositionend', () => {
        if (view === 'note' && followNewDay) void loadNote()
      }, { once: true })
    } else {
      void loadNote()
    }
  })
  drawState(await api.getState())
  if (!currentDate) await loadNote()
}

init().catch(error => {
  $('mascot-image').src = pet
  $('panel').hidden = false
  noteStatus(errorMessage(error), true)
})
