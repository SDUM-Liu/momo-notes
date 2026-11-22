import { privateMediaType, wirePrivateDrive } from './private-drive.js'
import { privatePages } from './private-pages.js'
import { Editor, Node } from '@tiptap/core'
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
import { desktopFollower } from './desktop-follower.js'
import pet from './assets/pet.png'
import perch from './assets/perch.png'
import defaultEdge from './assets/edge.png'
import { wireHandoff } from './handoff.js'
import { wirePrivateBook } from './private-book.js'
import { wireSSHSharing } from './ssh-sharing.js'
import { wireSSHDevices } from './ssh-devices.js'
import './style.css'

const api = window.momo ? desktopFollower(window.momo) : (await import('./mobile-bridge.js')).createMobileBridge()
if (api.mobile) {
  document.body.dataset.platform = 'mobile'
  document.body.dataset.mobileOs = api.platform
}
const $ = id => document.getElementById(id)
const iconFiles = import.meta.glob('/node_modules/lucide-static/icons/{calendar,globe,sparkles,settings,bold,italic,underline,strikethrough,heading,list-checks,list,list-ordered,link,image,table-2,panel-left,square-pen,x,arrow-up,square,refresh-cw,message-circle,lock-keyhole}.svg', {
  query: '?raw', import: 'default', eager: true,
})
for (const button of document.querySelectorAll('[data-icon]')) {
  button.innerHTML = iconFiles['/node_modules/lucide-static/icons/' + button.dataset.icon + '.svg'] ?? ''
}

void $('mascot-perch').decode().catch(() => {})
wirePrivateBook(api, enterPrivatePages)
wireHandoff(api, saveBeforeSwitch, connectHostLink)
for (const direction of ['export', 'import']) {
  const button = $('migration-' + direction)
  const file = $('migration-source')
  if (direction === 'import' && api.mobile) file.onchange = () => { if (file.files.length) button.click() }
  button.onclick = async () => {
    const input = $('migration-password')
    if (input.value.length < 12) { input.focus(); $('settings-status').textContent = '迁移包口令至少需要 12 个字符'; return }
    if (api.mobile && direction === 'import' && !file.files.length) { file.click(); return }
    button.disabled = true
    try {
      await saveBeforeSwitch()
      const result = api.mobile ? await api.migrationFile(direction,input.value,file.files[0]) : await api.migrationFile(direction,input.value)
      if (result instanceof File) {
        const save = $('migration-share')
        save.hidden = false
        save.onclick = async () => {
          try {
            if (api.saveBackup) await api.saveBackup(result)
            else if (navigator.canShare?.({files:[result]})) await navigator.share({files:[result]})
            else {
              const url = URL.createObjectURL(result), a = document.createElement('a')
              a.href = url; a.download = result.name; a.click(); setTimeout(() => URL.revokeObjectURL(url),60000)
            }
            await api.releaseBackup?.(result)
            save.hidden = true; save.onclick = null
          } catch (error) { $('settings-status').textContent = errorMessage(error) }
        }
        $('settings-status').textContent = '迁移包已生成'
      } else if (result) $('settings-status').textContent = '迁移包已保存'
    } catch (error) { $('settings-status').textContent = errorMessage(error) }
    finally { input.value = ''; file.value = ''; button.disabled = false }
  }
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
let composingEdit = false
let pendingNoteChange
let privateStore, ordinaryPage, privateTimer, drive, switchingBook = false
let privateArchive = false
let pendingDriveSave = Promise.resolve()
const noteStore = () => privateStore || api
const photoTypes = $('image-input').accept
const noteMedia = Node.create({
  name: 'noteMedia', group: 'block', atom: true, draggable: true,
  addAttributes() { return { src: { default: '' }, alt: { default: '' } } },
  parseHTML() { return [{ tag: 'audio[src^="data:audio/"]' }, { tag: 'video[src^="data:video/"]' }] },
  renderHTML({ node }) {
    const src = node.attrs.src || ''
    return [/^data:audio\//i.test(src) ? 'audio' : 'video', {
      controls: '', preload: 'metadata', 'aria-label': node.attrs.alt,
      src: /^data:(audio|video)\/[\w.+-]+;base64,/i.test(src) ? src : '',
    }]
  },
})

function showDrive(store) {
  if (!drive) {
    drive = wirePrivateDrive($('private-drive'), {
      async media(op, args) {
        if (store !== privateStore && !['mediaRelease','mediaAbort','mediaRemove'].includes(op)) throw new Error('已锁定')
        const result = await api.privateBook(op, args)
        if (op === 'mediaWrite' && store === privateStore) armPrivateLock()
        return result
      },
      save(files) {
        if (store !== privateStore) throw new Error('已锁定')
        const write = store.saveFiles(files)
        pendingDriveSave = write.catch(() => {})
        return write
      },
      picker: active => api.privatePicker?.(active),
    })
  }
  $('private-drive').hidden = false
  drive.show(store.files)
  $('note-toolbar').hidden = $('editor').hidden = $('note-footer').hidden = true
  $('note-date-line').hidden = $('history').hidden = true
}
function closeDrive() {
  drive?.dispose()
  drive = undefined
  $('private-drive').hidden = true
  $('note-toolbar').hidden = $('editor').hidden = $('note-footer').hidden = false
  $('history').hidden = false
}

function resetPageContext() {
  ++pageRequest; ++editGeneration
  closeDrive()
  if ($('drive-import').open) $('drive-import').close('cancel')
  $('drive-import-detail').textContent = ''
  privateArchive = false
  finishPicker()
  composingEdit = followNewDay = retryOnUnlock = previousSaveError = false
  pendingNoteChange = undefined; currentDate = undefined
  visited.clear(); revisions.clear()
  $('dates').replaceChildren()
  for (const id of ['link-url','link-label','category-name','image-input','saved-editor-draft']) $(id).value = ''
  $('saved-editor-draft').hidden = $('reload-shared-note').hidden = true
  editor.destroy()
  createEditor()
}
function syncBookControls() {
  const active = Boolean(privateStore)
  $('book-return').hidden = !active
  document.querySelector('[data-edit="taskList"]').hidden = active
  $('note-date-line').hidden = active
  $('return-today').textContent = active ? '返回主页' : '回到今天'
  $('note-title').textContent = active ? '私密便签' : '桃桃便签'
  $('settings-codex').disabled = $('question').disabled = active || Boolean(state.mobileHost)
  $('image-input').accept = active ? 'image/*,audio/*,video/*' : photoTypes
  const label = active ? '插入图片、视频或录音' : '插入图片'
  $('insert-image').title = label
  $('insert-image').setAttribute('aria-label', label)
}
function armPrivateLock() {
  clearTimeout(privateTimer)
  privateTimer = setTimeout(() => endPrivatePages(true), 285000)
}
async function enterPrivatePages(entries) {
  await saveBeforeSwitch()
  if (!$('book-dialog').open || state.mode !== 'note' || document.hidden) throw new Error('请重新解锁')
  const store = privatePages(entries, async data => {
    await api.privateBook('save', { entries: data })
    if (privateStore === store) armPrivateLock()
  })
  ordinaryPage = { date: currentDate, category, visited: new Map(visited) }
  privateStore = store
  resetPageContext()
  category = defaultCategory
  syncBookControls(); setReadOnly(false); drawCategories(store.categories)
  armPrivateLock(); showView('note')
  await loadNote()
}
async function endPrivatePages(forced = false) {
  const store = privateStore
  if (!store || (!forced && switchingBook)) return
  switchingBook = true
  try {
    if (!forced) await saveBeforeSwitch()
    if (privateStore !== store) return
    // A forced lock clears preview and file references immediately; explicit locks
    // wait for the active file operation in saveBeforeSwitch.
    const pendingSaves = Promise.all([saveQueue, pendingDriveSave])
    pendingDriveSave = Promise.resolve()
    clearTimeout(privateTimer)
    const profile = profileRevision
    const back = ordinaryPage
    privateStore = ordinaryPage = undefined
    resetPageContext()
    category = back.category
    for (const item of back.visited) visited.set(...item)
    syncBookControls(); drawCategories(state.categories); setReadOnly(state.locked)
    showView('note')
    await pendingSaves
    store.close()
    await api.privateBook('lock')
    if (!privateStore && profile === profileRevision) await loadNote(back.date, category)
  } catch (error) { noteStatus(errorMessage(error), true) }
  finally { switchingBook = false }
}
$('book-return').onclick = () => endPrivatePages()
api.onPrivateLock?.(() => {
  if ($('book-dialog').open) $('book-dialog').close()
  void endPrivatePages(true)
})
document.addEventListener('visibilitychange', () => {
  if (document.hidden && privateStore && !api.privatePickerActive?.()) void endPrivatePages(true)
})

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
    if ($('ssh-dialog').open) $('ssh-dialog').close()
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
  if (!privateStore && next === 'note' && followNewDay && !editor.view.composing) void loadNote()
}

function drawState(value) {
  if (value.mode !== 'note' && $('book-dialog').open) $('book-dialog').close()
  const wasMode = state?.mode
  state = value
  if (value.mode !== 'note' && privateStore) void endPrivatePages(true)
  today = state.today
  drawUpdate(state.update)
  drawBrowser(state.browser)
  drawCategories(privateStore?.categories || value.categories)
  setReadOnly(!privateStore && value.locked)
  document.body.dataset.mode = state.mode
  document.body.dataset.edge = state.edge ?? ''
  $('panel').hidden = state.mode !== 'note'
  if (api.mobile) {
    $('mobile-dismiss').hidden = state.mode !== 'note'
    $('mobile-open').hidden = state.mode === 'note'
  }
  const image = $('mascot-image')
  const pose = state.mode === 'note' ? perch : state.mode === 'edge' ? state.settings.edgeImage || defaultEdge : pet
  if (image.getAttribute('src') !== pose) image.setAttribute('src', pose)
  image.classList.toggle('custom', state.mode === 'edge' && Boolean(state.settings.edgeImage))

  if (wasMode === 'note' && state.mode !== 'note' && view !== 'note') showView('note')
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
  $('note-date-line').hidden = Boolean(privateStore && !privateArchive)
  if ($('note-date-line').hidden) return
  const date = noteDate(currentDate)
  const isToday = currentDate === today
  $('note-date').textContent = dayFormat.format(date)
  $('date-caption').textContent = (privateStore ? '历史页 · ' : isToday ? '今天 · ' : date.getFullYear() + ' 年 · ') + weekFormat.format(date)
  $('return-today').hidden = !privateStore && isToday
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
  const store = noteStore()
  saveQueue = saveQueue.then(() => store.saveNote(date, doc, selected, revisions.get(key) ?? null)).then(saved => {
    if (store !== noteStore()) return
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
    if (store !== noteStore()) return
    previousSaveError = true
    const message = errorMessage(error)
    retryOnUnlock = /同步中|正在同步|主机未连接/.test(message)
    $('reload-shared-note').hidden = !message.includes('主机已有更新')
    noteStatus(message, true)
  })
}

async function saveBeforeSwitch() {
  await drive?.flush()
  if (composingEdit && editor && currentDate) {
    composingEdit = false
    saveDocument(editor.getJSON())
  }
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
    if (request !== pageRequest) return
    if (privateStore && selected === 'finds') {
      category = selected
      currentDate = undefined
      privateArchive = false
      editor.commands.setContent({type:'doc',content:[{type:'paragraph'}]}, { emitUpdate: false })
      showDrive(privateStore)
      markCategory()
      if (navigate) showView('note')
      return
    }
    const page = await noteStore().openNote(date, selected)
    if (request !== pageRequest) return
    if (drive) closeDrive()
    if (currentDate !== page.date || category !== page.category) editor.commands.setContent(page.doc, { emitUpdate: false })
    category = page.category
    markCategory()
    currentDate = page.date
    today = page.today
    revisions.set(noteKey(category, currentDate), page.rev)
    privateArchive = Boolean(privateStore && page.isArchive)
    visited.set(category, (privateStore ? !privateArchive : currentDate === today) ? null : currentDate)
    $('history').hidden = Boolean(privateStore && privateStore.listDates(category).length < 2)
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
  let pointerToggle = false
  let pointer
  element.addEventListener('pointerdown', event => {
    if (event.button !== 0 || active) return
    pointerToggle = false
    if (element === $('mascot') && state.mode === 'note') return
    pointerToggle = true
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
      if (!pointerToggle || event.detail === 0) click()
    })
  }
}

if (!api.mobile) {
  const hover = event => {
    if (event.pointerType === 'mouse' && !event.buttons && state?.mode === 'edge') api.edgeHover()
  }
  $('mascot').addEventListener('pointerenter', hover)
  $('mascot').addEventListener('pointermove', hover)
}
wireDrag($('mascot'), async () => {
  if (privateStore) {
    try { await saveBeforeSwitch() } catch (error) { noteStatus(errorMessage(error), true); return }
  }
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
    const store = noteStore()
    await saveBeforeSwitch()
    if (store !== noteStore()) return
    const categories = await store.addCategory($('category-name').value)
    if (store !== noteStore()) return
    if (!privateStore) state.categories = categories
    $('category-name').value = ''
    drawCategories(categories)
    await loadNote(undefined, categories.at(-1).id)
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
    const store = noteStore()
    await saveBeforeSwitch()
    if (store !== noteStore()) return
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
    const store = noteStore()
    const dates = await store.listDates(category)
    if (store !== noteStore() || view !== 'history') return
    list.replaceChildren()
    for (const date of dates) {
      const button = document.createElement('button')
      const title = document.createElement('span')
      title.textContent = privateStore ? dayFormat.format(noteDate(date)) : date === today ? '今天' : dayFormat.format(noteDate(date))
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
  const store = noteStore()
  const date = currentDate
  const selected = category
  const onPage = () => store === noteStore() && !readOnly && date === currentDate && selected === category
  const toDrive = []
  for (const file of files) {
    if (!onPage()) return
    try {
      const mime = privateStore ? privateMediaType(file) : file.type
      const media = privateStore && /^(audio|video)\//.test(mime)
      const imageType = /^image\/(png|jpeg|webp|gif|bmp)$/.test(mime)
      if (privateStore && ((!imageType && !media) || file.size > (media ? 32 : 8) * 1024 * 1024)) {
        toDrive.push(file)
        continue
      }
      if (!media && !imageType) throw new Error('请使用 PNG、JPG、WebP、GIF 或 BMP 图片')
      if (!privateStore && file.size > 8 * 1024 * 1024) throw new Error('请选择 8 MB 以内的图片')
      const src = await fileData(mime === file.type ? file : file.slice(0, file.size, mime))
      if (!onPage()) return
      const image = { type: media ? 'noteMedia' : 'image', attrs: { src, alt: file.name } }
      if (position !== undefined) editor.chain().focus().insertContentAt(position, image).run()
      else editor.chain().focus().insertContent(image).run()
      position = undefined
    } catch (error) {
      if (onPage()) noteStatus(errorMessage(error), true)
    }
  }
  if (!toDrive.length || !onPage()) return
  const prompt = $('drive-import')
  if (prompt.open) return
  const subject = toDrive.length === 1 ? '「' + toDrive[0].name + '」' : '所选的 ' + toDrive.length + ' 个附件'
  $('drive-import-detail').textContent = subject + '可保存为独立文件。上传后，请在「多媒体」选项卡中预览。'
  prompt.returnValue = ''
  const decision = new Promise(resolve => prompt.addEventListener('close', () => resolve(prompt.returnValue), { once: true }))
  prompt.showModal()
  const choice = await decision
  $('drive-import-detail').textContent = ''
  if (choice !== 'upload' || !onPage() || store !== privateStore) return
  await loadNote(undefined, 'finds')
  if (store === privateStore && category === 'finds') drive?.add(toDrive)
}

$('insert-image').onmousedown = event => event.preventDefault()
let attachmentPage
function finishPicker() {
  attachmentPage = undefined
  api.privatePicker?.(false)
}
$('insert-image').onclick = () => {
  attachmentPage = { store: noteStore(), category, date: currentDate }
  if (privateStore) api.privatePicker?.(true)
  $('image-input').click()
}
$('image-input').oncancel = finishPicker
$('image-input').onchange = () => {
  if (attachmentPage?.store === noteStore() && attachmentPage.category === category && attachmentPage.date === currentDate) {
    void insertImages([...$('image-input').files])
  }
  $('image-input').value = ''
  finishPicker()
}

function renderEdgePreview() {
  $('edge-preview').src = edgeDraft || defaultEdge
  $('reset-edge').disabled = !edgeDraft
}

function drawUpdate(update) {
  updateState = update
  const { status, target, progress, error, viaHost } = update
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
  $('update-status').textContent = error || (viaHost && status !== 'unavailable'
    ? ['通过主设备更新', messages[status]].filter(Boolean).join(' · ') : messages[status])
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

let syncState, qrRequest = 0, stopHostLink, hostLinkRevision = 0, followerView = false
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

const drawSSHSharing = wireSSHSharing(api, errorMessage)
const drawDeviceList = wireSSHDevices(api, errorMessage)
setInterval(() => { if (view === 'sync') void api.syncState().then(drawSync).catch(() => {}) }, 10000)
function drawSync(value) {
  drawSSHSharing(value)
  drawDeviceList(value.devices || [])
  syncState = value
  const mobile = value.role === 'mobile'
  const phoneHost = api.mobile && value.role === 'host'
  const follower = value.role === 'follower' && value.enabled
  if (follower) followerView = true
  const follow = !mobile && followerView
  $('sync-role-choice').hidden = !api.supportsFollower
  $('sync-role-host').setAttribute('aria-pressed', String(!mobile && !follow))
  $('sync-role-host').disabled = follower || (mobile && value.enabled)
  $('sync-role-follower').setAttribute('aria-pressed', String(mobile || follow))
  $('sync-role-follower').disabled = value.role === 'host' && value.enabled
  $('sync-host').hidden = mobile || follow
  $('sync-mobile').hidden = !mobile && !follow
  $('sync-drafts').hidden = !mobile
  $('sync-photo-label').textContent = api.mobile ? '从相册识别' : '从二维码图片识别'
  $('api-settings').hidden = phoneHost || (mobile && value.enabled)
  $('api-heading').hidden = phoneHost
  $('settings-codex').disabled = $('question').disabled = phoneHost || Boolean(privateStore)
  $('mobile-ai-host').hidden = !phoneHost && (!mobile || !value.enabled)
  $('mobile-ai-host').textContent = phoneHost ? '手机作为主设备时，桃桃 AI 不可用。' : '配对电脑后，由电脑处理桃桃 AI 的请求。'
  if (mobile) {
    $('note-locked').textContent = !value.enabled ? '正在同步 · 请先配对主机'
      : value.error ? '正在同步 · 等待主机重新连接' : '正在同步，完成后可编辑便签。'
    $('sync-now').hidden = !value.enabled
    $('sync-unpair').hidden = !value.enabled
    $('sync-status').textContent = value.error || (value.locked ? '设备同步中，便签只读' : value.enabled
      ? [syncPathLabel(value.via) || '已配对', value.last ? new Date(value.last).toLocaleTimeString() : '等待首次同步'].join(' · ')
      : '从主设备获取配对码或二维码。')
    return
  }
  $('note-locked').textContent = follower ? '从设备 · 请在主设备编辑便签' : '正在同步，便签暂时只读。'
  if (follow) {
    $('sync-pair').hidden = follower
    $('sync-now').hidden = $('sync-unpair').hidden = !follower
    $('sync-status').textContent = value.error || (follower
      ? value.syncing ? '正在接收主设备便签…' : ['从设备 · 只读', syncPathLabel(value.via),
          value.last ? new Date(value.last).toLocaleTimeString() : ''].filter(Boolean).join(' · ')
      : '配对主设备，只读同步它的便签。本机便签和设置单独保留。')
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
        connecting: '正在连接异地同步服务…', offline: '主设备无法连接同步服务，正在重试。' }[value.status]
    : phoneHost ? '将这台手机设为便签主设备。同步时请保持应用在前台，桃桃 AI 在此角色下不可用。'
      : '将这台电脑设为便签和 AI 的主设备。'
}

async function showPairing() {
  const request = ++qrRequest
  $('sync-qr').hidden = true
  $('sync-qr').removeAttribute('src')
  $('sync-code').value = ''
  if (view !== 'sync' || followerView || syncState?.status !== 'online' || !syncState.enabled) return
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
    await showPairing()
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
    if (result.role === 'host') $('sync-relay-settings').open = !result.relay
    return result
  })
}
$('sync-back').onclick = () => showView('settings')
for (const [id, follow] of [['sync-role-host', false], ['sync-role-follower', true]]) {
  $(id).onclick = () => {
    if (api.selectSyncRole) {
      void syncAction(async () => {
        await saveBeforeSwitch()
        const value = await api.selectSyncRole(follow ? 'mobile' : 'host')
        await connectHostLink()
        return value
      }, $(id))
      return
    }
    followerView = follow
    $('sync-pair-code').value = $('sync-test-status').textContent = ''
    void syncAction(() => api.syncState())
  }
}
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
$('sync-unpair').onclick = () => syncAction(async () => {
  const result = await api.unpairSync()
  if (api.supportsFollower) followerView = false
  return result
}, $('sync-unpair'))
$('sync-drafts').onclick = async () => {
  const drafts = await api.syncDrafts()
  $('sync-draft-text').value = Object.entries(drafts).map(([key, doc]) => key + '\n' + nodeText(doc, true)).join('\n\n') || '没有待整理的草稿'
  $('sync-draft-text').hidden = false
}
$('sync-mobile').onsubmit = event => {
  event.preventDefault()
  void syncAction(async () => {
    if (api.supportsFollower) await saveBeforeSwitch()
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
  if (privateStore || (api.mobile && syncState?.role === 'host')) return
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
  return [...(transfer?.files ?? [])].filter(file => file.type.startsWith('image/') || (privateStore && /^(audio|video)\//.test(file.type)))
}

function createEditor() {
  editor = new Editor({
    element: $('editor'),
    extensions: [
      StarterKit.configure({ link: { openOnClick: false, defaultProtocol: 'https', isAllowedUri: url => Boolean(linkOrNull(url)) } }),
      ...(privateStore ? [] : [TaskList, TaskItem.configure({
        nested: true,
        a11y: { checkboxLabel: node => node.attrs.checked ? '恢复为待办' : '标记完成' },
      })]),
      Image.configure({ allowBase64: true, resize: { enabled: true, minWidth: 40, minHeight: 30 } }),
      ...(privateStore ? [noteMedia] : []),
      TableKit.configure({ table: { resizable: true } }),
      Placeholder.configure({ placeholder: privateStore ? '写下内容…' : '写下一件待办…', includeChildren: true }),
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
      if (!currentDate) return
      composingEdit = !privateStore && api.mobile && editor.view.composing
      if (!composingEdit) saveDocument(editor.getJSON())
    },
    onSelectionUpdate: () => { if (editor) drawProgress() },
  })
}
async function init() {
  createEditor()
  api.onState(drawState)
  if (api.editorIdle) $('editor').addEventListener('focusout', () => {
    setTimeout(() => { void saveQueue.then(() => api.editorIdle()) }, 0)
  })
  api.onUpdate(drawUpdate)
  api.onBrowser(drawBrowser)
  async function reflectChange(change) {
    if (!state) return
    if (privateStore && !change.profileChanged) {
      if (typeof change.locked === 'boolean') state.locked = change.locked
      if (change.categories) state.categories = change.categories
      return
    }
    if (change.profileChanged) {
      if (privateStore) void endPrivatePages(true)
      if ($('book-dialog').open) $('book-dialog').close()
      composingEdit = false
      pendingNoteChange = undefined
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
      if (typeof change.locked === 'boolean') {
        state.locked = change.locked
        setReadOnly(change.locked)
      }
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
    if (change.removed) {
      currentDate = undefined
      void loadNote(undefined, category, false)
      return
    }
    const generation = editGeneration
    const request = pageRequest
    if (editor.view.composing) { pendingNoteChange = change; return }
    await saveQueue
    if (privateStore) return
    const page = await api.openNote(currentDate, category).catch(() => null)
    if (privateStore || !page || previousSaveError || generation !== editGeneration || request !== pageRequest) return
    if (editor.view.composing) { pendingNoteChange = change; return }
    revisions.set(change.key, page.rev)
    if (JSON.stringify(editor.getJSON()) !== JSON.stringify(page.doc)) {
      editor.commands.setContent(page.doc, { emitUpdate: false })
      drawProgress()
    }
  }
  api.onNotes(reflectChange)
  $('editor').addEventListener('compositionend', () => {
    const date = currentDate, selected = category, profile = profileRevision, store = noteStore()
    setTimeout(() => {
      if (store !== noteStore() || editor.view.composing || profile !== profileRevision || date !== currentDate || selected !== category) return
      if (composingEdit && currentDate) {
        composingEdit = false
        saveDocument(editor.getJSON())
      }
      const change = pendingNoteChange
      pendingNoteChange = undefined
      if (change) void reflectChange(change)
    }, 0)
  })
  api.onSync?.(drawSync)
  if (api.syncLink) void connectHostLink().catch(error => { $('sync-status').textContent = errorMessage(error) })
  api.onDay(next => {
    if (privateStore) return
    followNewDay ||= currentDate === today
    today = next
    if (!followNewDay || view !== 'note') {
      if (currentDate) drawDate()
    } else if (editor.view.composing) {
      editor.view.dom.addEventListener('compositionend', () => {
        if (!privateStore && view === 'note' && followNewDay) void loadNote()
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
