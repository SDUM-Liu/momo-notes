import { Editor } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { TaskItem, TaskList } from '@tiptap/extension-list'
import { TableKit } from '@tiptap/extension-table'
import { Image } from '@tiptap/extension-image'
import { Placeholder } from '@tiptap/extension-placeholder'
import pet from './assets/pet.png'
import perch from './assets/perch.png'
import defaultEdge from './assets/edge.png'
import './style.css'

const api = window.momo
const $ = id => document.getElementById(id)
const iconFiles = import.meta.glob('/node_modules/lucide-static/icons/{calendar,sparkles,settings,bold,italic,underline,strikethrough,heading,list-checks,list,list-ordered,image,table-2}.svg', {
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
let view = 'note'
let saveQueue = Promise.resolve()
let pageRequest = 0
let previousSaveError = false
let followNewDay = false

function errorMessage(error) {
  return error.message.replace(/^Error invoking remote method '[^']+': Error: /, '')
}

function noteStatus(message, error = false) {
  $('status').textContent = message
  $('status').classList.toggle('error', error)
}

function showView(next) {
  view = next
  for (const name of ['note', 'history', 'settings', 'ai']) {
    $(name + '-view').hidden = name !== next
  }
  $('history').classList.toggle('active', next === 'history')
  $('settings').classList.toggle('active', next === 'settings')
  $('question').classList.toggle('active', next === 'ai')
  $('table-menu').hidden = true
  if (next === 'note' && followNewDay && !editor.view.composing) void loadNote()
}

function drawState(value) {
  const wasMode = state?.mode
  state = value
  today = state.today
  document.body.dataset.mode = state.mode
  document.body.dataset.edge = state.edge ?? ''
  $('panel').hidden = state.mode !== 'note'
  $('mascot-image').src = state.mode === 'note' ? perch : state.mode === 'edge' ? state.settings.edgeImage || defaultEdge : pet
  $('mascot-image').classList.toggle('custom', Boolean(state.settings.edgeImage))
  const label = state.mode === 'note' ? '收起便签' : '打开便签'
  $('mascot').setAttribute('aria-label', label)
  $('mascot').title = label + (state.mode === 'note' ? '' : ' · 可拖动')
  if (wasMode !== 'note' && state.mode === 'note') {
    showView('note')
    if (!editor || !currentDate) void loadNote()
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
  noteStatus('保存中…')
  saveQueue = saveQueue.then(() => api.saveNote(date, doc)).then(() => {
    previousSaveError = false
    if (date === currentDate) noteStatus('已保存')
  }).catch(error => {
    previousSaveError = true
    noteStatus(errorMessage(error), true)
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

async function loadNote(date) {
  followNewDay = false
  const request = ++pageRequest
  try {
    await saveBeforeSwitch()
    const page = await api.openNote(date)
    if (request !== pageRequest) return
    if (currentDate !== page.date) editor.commands.setContent(page.doc, { emitUpdate: false })
    currentDate = page.date
    today = page.today
    drawDate()
    drawProgress()
    noteStatus('已保存')
    showView('note')
  } catch (error) {
    if (request !== pageRequest) return
    noteStatus(errorMessage(error), true)
    showView('note')
  }
}

function wireDrag(element, click) {
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

wireDrag($('mascot'), () => api.toggle())
wireDrag($('title-drag'))
$('return-today').onclick = () => loadNote()
for (const back of document.querySelectorAll('.back')) back.onclick = () => showView('note')

$('history').onclick = async () => {
  if (view === 'history') return showView('note')
  showView('history')
  const list = $('dates')
  list.textContent = '正在读取…'
  try {
    await saveBeforeSwitch()
    const dates = await api.listDates()
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
  const date = currentDate
  for (const file of files) {
    try {
      if (!/^image\/(png|jpeg|webp|gif|bmp)$/.test(file.type)) throw new Error('请使用 PNG、JPG、WebP、GIF 或 BMP 图片')
      if (file.size > 8 * 1024 * 1024) throw new Error('请选择 8 MB 以内的图片')
      const src = await fileData(file)
      if (date !== currentDate) return
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

$('settings').onclick = () => {
  if (view === 'settings') return showView('note')
  const settings = state.settings
  $('pin').checked = settings.alwaysOnTop
  $('startup').checked = settings.openAtLogin
  $('snap').checked = settings.snap
  $('base-url').value = settings.baseUrl
  $('model').value = settings.model
  $('proxy').value = settings.proxyPort
  $('api-key').value = ''
  $('api-key').placeholder = settings.hasKey ? '已保存 · 留空保留' : '本地服务可留空'
  clearKey = false
  $('clear-key').hidden = !settings.hasKey
  edgeDraft = settings.edgeImage
  renderEdgePreview()
  $('settings-status').textContent = ''
  showView('settings')
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
    answer.textContent = await api.ask({ question, scope: $('scope').value, date: currentDate })
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
      StarterKit.configure({ link: { openOnClick: false } }),
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
