import { Editor } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { TaskItem, TaskList } from '@tiptap/extension-list'
import { TableKit } from '@tiptap/extension-table'
import { Image } from '@tiptap/extension-image'
import { Placeholder } from '@tiptap/extension-placeholder'
import { linkOrNull, webUrl } from '../shared/links.mjs'
import { defaultCategory, nodeText, noteKey } from '../shared/notes.mjs'
import { parsePairing } from '../shared/sync.mjs'
import { hostSyncLink } from './rtc-sync.js'
import { followCodex, wireCodex } from './codex-view.js'
import { wireInstallerDownloads } from './installers-view.js'
import pet from './assets/pet.png'
import perch from './assets/perch.png'
import defaultEdge from './assets/edge.png'
import './style.css'

const api = window.momo ?? (await import('./mobile-bridge.js')).createMobileBridge()
if (api.mobile) {
  document.body.dataset.platform = 'mobile'
  document.body.dataset.mobileOs = api.platform
}
const $ = id => document.getElementById(id)
const iconFiles = import.meta.glob('/node_modules/lucide-static/icons/{calendar,globe,sparkles,settings,bold,italic,underline,strikethrough,heading,list-checks,list,list-ordered,link,image,table-2,panel-left,square-pen,x,arrow-up,square,refresh-cw,message-circle}.svg', {
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
  if (next !== 'ai') {
    for (const dialog of document.querySelectorAll('#ai-view dialog[open]')) dialog.close()
  }
  if (view === 'browser' && next !== 'browser') void api.hideBrowser()
  if (view === 'sync' && next !== 'sync') {
    ++qrRequest
    $('sync-qr').hidden = true
    $('sync-qr').removeAttribute('src')
    $('sync-code').value = ''
    $('sync-pair-code').value = ''
  }
  view = next
  for (const name of ['note', 'history', 'settings', 'ai', 'browser', 'sync', 'installers']) {
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
  if (api.mobile) {
    $('mobile-dismiss').hidden = state.mode !== 'note'
    $('mobile-open').hidden = state.mode === 'note'
  }
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
  $('categories').replaceChildren(...values.map(({ id, name }) => {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'quiet'
    button.setAttribute('role', 'tab')
    button.dataset.category = id
    button.textContent = name
    button.title = name
    return button
  }))
  markCategory()
}

function markCategory() {
  for (const tab of $('categories').children) {
    const selected = tab.dataset.category === category
    tab.setAttribute('aria-selected', String(selected))
    tab.tabIndex = selected ? 0 : -1
  }
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
    retryOnUnlock = /同步中|正在同步|主机未连接/.test(message)
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

async function loadNote(date, selected = category, navigate = true) {
  followNewDay = false
  const request = ++pageRequest
  try {
    await saveBeforeSwitch()
    const page = await api.openNote(date, selected)
    if (request !== pageRequest) return
    if (currentDate !== page.date || category !== page.category) editor.commands.setContent(page.doc, { emitUpdate: false })
    category = page.category
    markCategory()
    currentDate = page.date
    today = page.today
    revisions.set(noteKey(category, currentDate), page.rev)
    visited.set(category, currentDate === today ? null : currentDate)
    drawDate()
    drawProgress()
    noteStatus('已保存')
    if (navigate) showView('note')
  } catch (error) {
    if (request !== pageRequest) return
    noteStatus(errorMessage(error), true)
    markCategory()
    if (navigate) showView('note')
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
  else if (api.mobile) void dismissMobile()
  else void api.toggle()
})
async function dismissMobile() {
  try {
    await saveBeforeSwitch()
    if (view !== 'note') showView('note')
    await api.toggle()
  } catch (error) {
    noteStatus(errorMessage(error), true)
  }
}
$('mobile-dismiss').onclick = dismissMobile
$('mobile-open').onclick = () => api.toggle()
for (const event of ['momo-floating-open', 'momo-launcher-open']) {
  window.addEventListener(event, () => { if (state?.mode === 'note') showView('note') })
}
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
$('categories').onclick = event => {
  const selected = event.target.closest('[role=tab]')?.dataset.category
  if (!selected || selected === category) return
  void loadNote(visited.get(selected), selected)
}
$('categories').onkeydown = event => {
  const tabs = [...$('categories').children]
  const index = tabs.indexOf(event.target)
  const jump = { ArrowRight: index + 1, ArrowLeft: index - 1, Home: 0, End: tabs.length - 1 }[event.key]
  if (index < 0 || jump === undefined) return
  event.preventDefault()
  const next = tabs[(jump + tabs.length) % tabs.length]
  next.focus()
  next.click()
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
  const { status, target, progress, error } = update
  const messages = {
    idle: '',
    unavailable: '请使用对应平台的安装包更新',
    checking: '正在检查更新…',
    current: '已是最新版本',
    available: '可更新至 v' + target,
    downloading: progress === undefined ? '正在准备下载…' : '正在下载 · ' + progress + '%',
    ready: 'v' + target + ' 已下载',
    'permission-required': '请允许桃桃便签安装应用，返回后会打开安装界面',
    'installer-open': 'v' + target + ' 已下载，请在系统安装界面确认',
    'distribution-unavailable': '发现 v' + target + '，当前构建没有可安装的更新包',
    installing: api.mobile ? '正在打开系统安装界面…' : '正在退出并安装…',
    'check-error': '检查失败，请确认可访问 GitHub',
    'download-error': '下载失败，请重试',
    'install-error': '无法启动安装，请重试',
  }
  const actionLabels = {
    available: '下载更新', downloading: '下载中', ready: api.mobile ? '打开安装包' : '安装并重启',
    'permission-required': '授予安装权限', 'installer-open': '打开安装包',
    installing: '安装中', 'download-error': '重新下载', 'install-error': '重试安装',
  }
  $('app-version').textContent = '当前版本 v' + update.version
  $('update-status').textContent = error || messages[status]
  $('update-status').classList.toggle('error', status.endsWith('-error'))
  $('settings').toggleAttribute('data-update', ['available', 'ready', 'downloading', 'download-error', 'install-error',
    'permission-required', 'installer-open'].includes(status))
  $('update-action').textContent = actionLabels[status] ?? '检查更新'
  $('update-action').disabled = ['unavailable', 'checking', 'downloading', 'installing'].includes(status)
  $('automatic-update-row').hidden = api.mobile || status === 'unavailable'
  $('update-progress').hidden = status !== 'downloading'
  if (progress === undefined) $('update-progress').removeAttribute('value')
  else $('update-progress').value = progress
}

$('update-action').onclick = async () => {
  const { status } = updateState
  $('update-action').disabled = true
  try {
    if (['ready', 'install-error', 'permission-required', 'installer-open'].includes(status)) {
      await saveBeforeSwitch()
      await api.installUpdate()
    } else if (['available', 'download-error'].includes(status)) {
      if (api.mobile) await saveBeforeSwitch()
      await api.downloadUpdate()
    } else {
      if (api.mobile) await saveBeforeSwitch()
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
  void refreshMobilePet()
  void Promise.resolve(api.syncState()).then(drawSync).catch(() => {})
}

async function refreshMobilePet(wanted) {
  if (!api.floatingPet) return
  const region = $('mobile-pet-settings')
  const description = $('mobile-pet-status')
  region.hidden = false
  try {
    let pet = await api.petState()
    for (let attempt = 0; attempt < 12 && pet.permission && !pet.error && wanted !== undefined && pet.running !== wanted; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 200))
      pet = await api.petState()
    }
    $('mobile-pet-enable').checked = pet.enabled
    $('mobile-pet-permission').hidden = pet.permission || !pet.enabled
    description.textContent = pet.error || (pet.permission
      ? (pet.running ? '点悬浮桌宠打开便签，拖动便签顶部可移动小窗。'
        : wanted ? '系统已授予悬浮窗权限，但桌宠服务还未启动。请重新开启。' : '开启后可拖动桌宠，点它打开便签。')
      : '请在系统列表中选择桃桃便签，允许「显示在其他应用上层」后返回。')
  } catch (error) {
    description.textContent = errorMessage(error)
  }
}
$('mobile-pet-enable').onchange = async event => {
  const input = event.currentTarget
  input.disabled = true
  const wanted = input.checked
  try {
    await api.setPet(wanted)
    await refreshMobilePet(wanted)
  } catch (error) {
    input.checked = !wanted
    $('mobile-pet-status').textContent = errorMessage(error)
  } finally {
    input.disabled = false
  }
}
$('mobile-pet-permission').onclick = () => api.setPet(true).catch(error => {
  $('mobile-pet-status').textContent = errorMessage(error)
})
if (api.floatingPet) {
  void api.onPetPermissionReturn?.(({ starting }) => refreshMobilePet(starting || undefined))
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && view === 'settings') void refreshMobilePet()
  })
}

let syncState, qrRequest = 0, stopHostLink, hostLinkRevision = 0
const syncPathLabel = via => via === 'direct' ? '点对点直连' : via === 'relay' ? '加密中继' : ''

async function connectHostLink() {
  const revision = ++hostLinkRevision
  stopHostLink?.()
  const config = await api.syncLink()
  if (!config || revision !== hostLinkRevision) return
  const routes = [{ relay: config.relay, room: config.room, owner: config.owner }]
  if (config.fallback) routes.push({ relay: config.fallback, room: config.backupRoom, owner: config.backupOwner })
  const links = routes.map(({ relay, room, owner }) => {
    return hostSyncLink({ relay, room, owner, key: config.key }, api.syncExchange, status => {
      if (revision !== hostLinkRevision) return
      void api.syncLinkStatus(status, room, relay).then(value => {
        if (revision !== hostLinkRevision) return
        drawSync(value)
        if (view === 'sync') return showPairing()
      }).catch(error => { $('sync-status').textContent = errorMessage(error) })
    })
  })
  stopHostLink = () => links.forEach(stop => stop())
}

function drawSync(value) {
  syncState = value
  const mobile = value.role === 'mobile'
  $('sync-host').hidden = mobile
  $('sync-mobile').hidden = !mobile
  $('api-settings').hidden = mobile && value.enabled
  $('mobile-ai-host').hidden = !mobile || !value.enabled
  if (mobile) {
    $('note-locked').textContent = !value.enabled ? '正在同步 · 请先配对主机'
      : value.error ? '正在同步 · 等待主机重新连接' : '正在同步，完成后可编辑便签。'
    $('sync-now').hidden = !value.enabled
    $('sync-unpair').hidden = !value.enabled
    $('sync-status').textContent = value.error || (value.locked ? '设备同步中，便签只读' : value.enabled
      ? [syncPathLabel(value.via) || '已配对', value.last ? new Date(value.last).toLocaleTimeString() : '等待首次同步'].join(' · ')
      : '从桌面主机获取配对码或二维码。')
    return
  }
  $('sync-enable').textContent = value.enabled ? '停止主机同步' : '开启主机同步'
  $('sync-host-details').hidden = value.status !== 'online' || !value.enabled
  $('sync-relay').disabled = value.enabled
  $('sync-fallback').disabled = value.enabled
  if (value.enabled || !$('sync-relay').value) $('sync-relay').value = value.relay || ''
  if (value.enabled || !$('sync-fallback').value) $('sync-fallback').value = value.fallback || ''
  $('sync-status').textContent = value.enabled
    ? { online: value.fallback && value.onlineRelay === value.fallback
          ? '主机已通过备用服务上线，可以扫码配对。' : '主机已在线，可以扫码配对。',
        connecting: '正在连接异地同步服务…', offline: '电脑无法连接同步服务，正在重试。' }[value.status]
    : '将这台电脑设为便签和 AI 的主机。'
}

async function showPairing() {
  const request = ++qrRequest
  $('sync-qr').hidden = true
  $('sync-qr').removeAttribute('src')
  $('sync-code').value = ''
  if (view !== 'sync' || syncState?.status !== 'online' || !syncState.enabled) return
  const code = await api.syncCode()
  if (view !== 'sync' || request !== qrRequest) return
  $('sync-code').value = code
  const qr = await import('qrcode')
  const png = await (qr.default ?? qr).toDataURL(code, { width: 384, margin: 4 })
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
  $('sync-test-status').textContent = ''
  void syncAction(async () => {
    const result = await api.syncState()
    if (!api.mobile) $('sync-relay-settings').open = !result.relay
    return result
  })
}
$('sync-back').onclick = () => showView('settings')
$('sync-enable').onclick = () => syncAction(async () => {
  await api.enableSync(!syncState.enabled, $('sync-relay').value, $('sync-fallback').value)
  await connectHostLink()
  return api.syncState()
}, $('sync-enable'))
$('sync-code').onclick = event => event.currentTarget.select()
$('sync-rotate').onclick = () => syncAction(async () => {
  await api.rotateSync()
  await connectHostLink()
  return api.syncState()
}, $('sync-rotate'))
$('sync-now').onclick = () => syncAction(() => api.runSync(), $('sync-now'))
$('sync-test').onclick = async event => {
  const button = event.currentTarget
  const status = $('sync-test-status')
  button.disabled = true
  status.textContent = '正在验证主机连接…'
  try {
    const path = await api.testSync($('sync-pair-code').value)
    status.textContent = '已通过' + syncPathLabel(path) + '连通主机，配对码可用。'
  } catch (error) {
    status.textContent = errorMessage(error)
  } finally {
    button.disabled = false
  }
}
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

function fillScannedPairing(data) {
  try { parsePairing(data) } catch { throw new Error('这张二维码不是可用的桃桃主机配对码') }
  $('sync-pair-code').value = data.trim()
  $('sync-test-status').textContent = '已识别配对码，可以测试连接或开始同步。'
}

$('sync-camera').hidden = !api.liveScan
$('sync-camera').onclick = async event => {
  const button = event.currentTarget
  button.disabled = true
  try {
    const data = await api.scanSyncCode()
    if (view === 'sync' && data) fillScannedPairing(data)
  } catch (error) {
    if (view !== 'sync' || error?.code === 'OS-PLUG-BARC-0006') return
    $('sync-test-status').textContent = error?.code === 'OS-PLUG-BARC-0007'
      ? '请在系统设置中允许桃桃便签使用相机，再重试。' : errorMessage(error)
  } finally {
    button.disabled = false
  }
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
    fillScannedPairing(result.data)
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

let chatBack = 'note'
function chatMode(notes, work = false) {
  $('ai-mode-codex').setAttribute('aria-pressed', String(!notes && !work))
  $('ai-mode-work').setAttribute('aria-pressed', String(work))
  $('ai-mode-notes').setAttribute('aria-pressed', String(notes))
  $('codex-pane').hidden = notes
  $('note-ai-pane').hidden = !notes
  $('codex-drawer-toggle').hidden = $('codex-new').hidden = notes
  $('chat-model-bar').hidden = notes && $('ai-provider').value === 'api'
  codexView.work(work)
  if (notes) codexView.drawer(false)
}
function openChat(back) {
  chatBack = back
  chatMode(false)
  codexView.drawer(false)
  showView('ai')
  codexView.open(back === 'settings')
}
$('question').onclick = () => view === 'ai' ? showView('note') : openChat('note')
$('settings-codex').onclick = () => openChat('settings')
$('ai-back').onclick = () => showView(chatBack)
for (const id of ['ai-setup', 'ai-setup-from-settings']) {
  $(id).onclick = () => {
    $('ai-setup-status').textContent = ''
    $('ai-setup-dialog').showModal()
  }
}
$('ai-setup-docs').onclick = async () => {
  try {
    $('ai-setup-status').textContent = ''
    await api.openProject('codexSetup')
  } catch (error) {
    $('ai-setup-status').textContent = errorMessage(error)
  }
}
$('ai-mode-codex').onclick = () => chatMode(false)
$('ai-mode-work').onclick = () => chatMode(false, true)
$('ai-mode-notes').onclick = $('ai-provider').onchange = () => chatMode(true)
const questionRequest = () => ({
  question: $('prompt').value.trim(), scope: $('scope').value, date: currentDate,
  category, categoryScope: $('category-scope').value,
})
for (const [button, target] of [['project-repo', 'repo'], ['project-issues', 'issues']]) {
  $(button).onclick = () => api.openProject(target).catch(error => noteStatus(errorMessage(error), true))
}
const codexView = wireCodex(api, errorMessage, prompt => {
  const explicit = prompt.startsWith('$momo-notes-query')
  const noteLookup = /我的便签|便签[里中上]|所有便签|全部便签|(?:今天|昨天|前天|本周|上周)的?待办/.test(prompt)
    && /什么|哪些|多少|有没有|还有|总结|汇总|列出|查找|查看|告诉我|是否/.test(prompt)
  if (!explicit && !noteLookup) return false
  const question = prompt.replace(/^\$momo-notes-query\s*/, '').trim()
  if (!question || question.length > 4000 || $('send-question').disabled) return false
  $('ai-provider').value = 'codex'
  $('scope').value = $('category-scope').value = 'auto'
  $('prompt').value = question
  chatMode(true)
  $('ai-form').requestSubmit()
  return true
})
if (!api.mobile) wireInstallerDownloads(api, showView, errorMessage)
let noteJob
let profileRevision = 0
$('ai-cancel').onclick = () => {
  if (noteJob?.turnId) void api.codex('interrupt', noteJob.id).catch(error => {
    $('answer').textContent = errorMessage(error)
  })
}
$('ai-form').onsubmit = async event => {
  event.preventDefault()
  const question = $('prompt').value.trim()
  if (!question) return
  const answer = $('answer')
  const send = $('send-question')
  const profile = profileRevision
  send.disabled = true
  $('note-question').textContent = question
  $('note-question').hidden = false
  answer.hidden = false
  answer.classList.remove('error')
  answer.textContent = '正在读取便签并生成回答…'
  try {
    await saveBeforeSwitch()
    if ($('ai-provider').value === 'api') {
      const response = await api.ask(questionRequest())
      if (profile === profileRevision) answer.textContent = response
    }
    else {
      const started = await api.codex('notes', { ...questionRequest(), ...codexView.model.options() })
      if (profile !== profileRevision) return
      const completed = await followCodex(api, started, job => {
        noteJob = job
        $('ai-cancel').hidden = !job.turnId || job.status !== 'running'
        const detail = job.retrying && job.status === 'running' ? '电脑正在重试请求…' : ''
        answer.textContent = job.label + '\n\n' + ([job.output, detail].filter(Boolean).join('\n\n') || '正在主机上读取便签并回答…')
      }, () => profile === profileRevision)
      if (!completed || profile !== profileRevision) return
      if (completed.status === 'failed') throw new Error(completed.error)
      if (completed.status === 'interrupted') answer.textContent += '\n\n已停止'
    }
  } catch (error) {
    if (profile !== profileRevision) return
    answer.classList.add('error')
    answer.textContent = errorMessage(error)
  } finally {
    if (profile === profileRevision) {
      $('ai-cancel').hidden = true
      send.disabled = false
    }
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
    if (change.profileChanged) {
      ++profileRevision
      ++editGeneration
      currentDate = undefined
      category = defaultCategory
      revisions.clear()
      visited.clear()
      previousSaveError = retryOnUnlock = false
      noteJob = undefined
      $('prompt').value = ''
      $('note-question').textContent = ''
      $('note-question').hidden = true
      $('answer').textContent = ''
      $('answer').hidden = $('ai-cancel').hidden = true
      $('send-question').disabled = false
      $('saved-editor-draft').value = $('sync-draft-text').value = ''
      $('saved-editor-draft').hidden = $('sync-draft-text').hidden = $('reload-shared-note').hidden = true
      codexView.reset()
      editor.commands.clearContent(false)
      state.categories = change.categories
      drawCategories(change.categories)
      void loadNote(undefined, defaultCategory, false)
      return
    }
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
  if (!api.mobile) void connectHostLink().catch(error => { $('sync-status').textContent = errorMessage(error) })
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
