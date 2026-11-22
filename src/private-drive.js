import uploadIcon from 'lucide-static/icons/upload.svg?raw'
import folderIcon from 'lucide-static/icons/folder-open.svg?raw'
import imageIcon from 'lucide-static/icons/file-image.svg?raw'
import videoIcon from 'lucide-static/icons/film.svg?raw'
import audioIcon from 'lucide-static/icons/music-2.svg?raw'
import closeIcon from 'lucide-static/icons/x.svg?raw'
import deleteIcon from 'lucide-static/icons/trash-2.svg?raw'
import './private-drive.css'

const displays = {
  image: { name: '图片', icon: imageIcon },
  video: { name: '视频', icon: videoIcon },
  audio: { name: '录音', icon: audioIcon },
}
const formats = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif',
  webp: 'image/webp', bmp: 'image/bmp', heic: 'image/heic', avif: 'image/avif',
  mp4: 'video/mp4', mov: 'video/quicktime', m4v: 'video/mp4', webm: 'video/webm',
  mkv: 'video/x-matroska', avi: 'video/x-msvideo',
  mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', wav: 'audio/wav',
  ogg: 'audio/ogg', opus: 'audio/opus', flac: 'audio/flac', amr: 'audio/amr',
}
const fileLimit = 32 * 1024 * 1024
const bookLimit = 128 * 1024 * 1024
const accept = 'image/*,video/*,audio/*'

function element(tag, className, text) {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

function icon(svg) {
  const node = element('span', 'drive-icon')
  node.setAttribute('aria-hidden', 'true')
  node.innerHTML = svg
  return node
}

function action(label, className, svg) {
  const node = element('button', className)
  node.type = 'button'
  if (svg) node.append(icon(svg))
  node.append(label)
  return node
}

function describe(file) {
  const header = /^data:(image|video|audio)\/[a-z\d.+-]+(?:;[^,]*)?;base64,/i.exec(file.src.slice(0, 200))
  if (!header) return { info: '未知格式' }
  const kind = header[1].toLowerCase()
  const padding = file.src.endsWith('==') ? 2 : Number(file.src.endsWith('='))
  const size = Math.max(0, Math.floor((file.src.length - header[0].length) * 0.75) - padding)
  const sizeText = size >= 1048576 ? (size / 1048576).toFixed(1) + ' MB'
    : size >= 1024 ? Math.round(size / 1024) + ' KB' : size + ' B'
  return { kind, info: displays[kind].name + ' · ' + sizeText }
}

function fileMime(file) {
  if (file.size > fileLimit) throw new Error('单个文件不能超过 32 MB（' + file.name + '）')
  const type = file.type.toLowerCase().split(';')[0]
  if (/^(image|video|audio)\/[a-z\d.+-]+$/.test(type)) return type
  const extension = /\.([a-z\d]+)$/i.exec(file.name)?.[1]?.toLowerCase()
  if ((!type || type === 'application/octet-stream') && Object.hasOwn(formats, extension)) return formats[extension]
  throw new Error('请选择图片、视频或音频文件（' + file.name + '）')
}

export function wirePrivateDrive(container, { save, picker }) {
  let files = [], root, input, uploadButton, list, count, status, dialog, previewMedia, observer
  let generation = 0, reading, pending, picking = false

  function finishPicker() {
    if (picking) picker?.(false)
    picking = false
  }

  function clearPreview() {
    if (previewMedia instanceof HTMLMediaElement) {
      previewMedia.pause()
      previewMedia.removeAttribute('src')
      previewMedia.load()
    }
    previewMedia = undefined
    dialog?.remove()
    dialog = undefined
  }

  function hide() {
    generation++
    finishPicker()
    reading?.abort()
    reading = undefined
    observer?.disconnect()
    observer = undefined
    if (dialog?.open) dialog.close()
    clearPreview()
    if (input) { input.onchange = input.oncancel = null; input.value = '' }
    list?.replaceChildren()
    root?.remove()
    root = input = uploadButton = list = count = status = undefined
    files = []
    container.hidden = true
  }

  function perform(work) {
    if (!root || pending) return
    const epoch = generation
    const active = () => epoch === generation
    status.textContent = ''
    uploadButton.disabled = true
    pending = Promise.resolve().then(async () => {
      if (active()) await work(active)
    })
    const settled = error => {
      pending = undefined
      if (!active()) return
      uploadButton.disabled = false
      if (error) status.textContent = error.message || String(error)
    }
    pending.then(() => settled(), settled)
  }

  function openPreview(file) {
    const { kind, info } = describe(file)
    const item = element('dialog', 'drive-preview')
    item.setAttribute('aria-label', file.name)
    dialog = item
    const bar = element('header', 'drive-preview-bar')
    const title = element('h2', '', file.name)
    const close = action('', 'drive-close', closeIcon)
    close.setAttribute('aria-label', '关闭预览')
    close.autofocus = true
    close.onclick = () => item.close()
    bar.append(title, close)
    const stage = element('div', 'drive-stage')
    const fallback = element('p', 'drive-unsupported', '当前设备无法预览此文件。')
    if (kind) {
      const player = element(kind === 'image' ? 'img' : kind)
      previewMedia = player
      if (kind === 'image') player.alt = file.name
      else {
        player.controls = true
        player.preload = 'metadata'
        if (kind === 'video') player.playsInline = true
      }
      player.onerror = () => { player.hidden = true; fallback.hidden = false }
      if (kind === 'audio') stage.append(icon(audioIcon))
      player.src = file.src
      stage.append(player)
      fallback.hidden = true
    }
    stage.append(fallback)
    const foot = element('footer', 'drive-preview-foot')
    const detail = element('span', 'drive-detail', info)
    const remove = action('删除文件', 'drive-text-button', deleteIcon)
    const confirm = action('确认删除', 'drive-confirm')
    const cancel = action('取消', 'drive-text-button')
    confirm.hidden = cancel.hidden = true
    remove.onclick = () => {
      remove.hidden = true
      confirm.hidden = cancel.hidden = false
      cancel.focus()
    }
    cancel.onclick = () => {
      remove.hidden = false
      confirm.hidden = cancel.hidden = true
      remove.focus()
    }
    confirm.onclick = () => {
      if (pending) return
      item.close()
      perform(async active => {
        const next = files.filter(entry => entry.id !== file.id)
        await save(next)
        if (active()) { files = next; drawFiles(); uploadButton.focus() }
      })
    }
    foot.append(detail, remove, cancel, confirm)
    item.append(bar, stage, foot)
    item.onclose = () => { if (dialog === item) clearPreview() }
    root.append(item)
    item.showModal()
  }

  function drawFiles() {
    observer?.disconnect()
    list.replaceChildren()
    count.textContent = files.length + ' 个文件'
    for (const file of files) {
      const { kind, info } = describe(file)
      const card = action('', 'drive-file')
      card.setAttribute('aria-label', '预览 ' + file.name)
      card.title = file.name
      const tile = element('span', 'drive-thumb drive-' + (kind || 'image'))
      tile.append(icon(displays[kind]?.icon || imageIcon))
      if (kind === 'image') {
        const img = element('img')
        img.alt = ''
        img.decoding = 'async'
        img.loading = 'lazy'
        img.onerror = () => img.remove()
        tile.append(img)
        if (observer) {
          // Keep offscreen image payloads out of the DOM until the card scrolls into view.
          img.dataset.index = String(list.childElementCount)
          observer.observe(img)
        } else img.src = file.src
      }
      const name = element('span', 'drive-name', file.name)
      card.append(tile, name, element('span', 'drive-detail', info))
      card.onclick = () => { if (!pending) openPreview(file) }
      list.append(card)
    }
    if (!files.length) {
      const empty = element('div', 'drive-empty')
      empty.append(icon(folderIcon), element('strong', '', '还没有文件'),
        element('span', '', '上传图片、视频或录音，在这里预览。'))
      list.append(empty)
    }
  }

  function add(selection) {
    if (!selection.length) return
    perform(async active => {
      const types = selection.map(fileMime)
      const bytes = selection.reduce((sum, file) => sum + Math.ceil(file.size / 3) * 4, 0)
      if (files.reduce((sum, file) => sum + file.src.length, bytes) > bookLimit) throw new Error('私密便签容量上限为 128 MB')
      const next = [...files]
      for (let i = 0; i < selection.length; i++) {
        const file = selection[i]
        status.textContent = '正在读取文件 ' + (i + 1) + ' / ' + selection.length
        const src = await new Promise((resolve, reject) => {
          const reader = new FileReader()
          reading = reader
          reader.onload = () => resolve(reader.result)
          reader.onerror = () => reject(new Error('无法读取文件（' + file.name + '）'))
          reader.onabort = () => reject(new Error('读取已取消'))
          reader.readAsDataURL(file.slice(0, file.size, types[i]))
        })
        if (!active()) return
        reading = undefined
        next.push({ id: crypto.randomUUID(), name: file.name, src })
      }
      status.textContent = '正在加密保存…'
      await save(next)
      if (active()) { files = next; drawFiles(); status.textContent = '' }
    })
  }

  function show(items) {
    hide()
    files = [...items]
    container.hidden = false
    root = element('div', 'private-drive')
    const bar = element('div', 'drive-bar')
    const title = element('h2', '', '全部文件')
    count = element('span', 'drive-count')
    uploadButton = action('上传文件', 'drive-upload', uploadIcon)
    input = element('input')
    input.type = 'file'
    input.accept = accept
    input.multiple = true
    input.hidden = true
    uploadButton.onclick = () => {
      picking = true
      picker?.(true)
      try { input.click() } catch (e) { finishPicker(); status.textContent = e.message }
    }
    input.oncancel = finishPicker
    input.onchange = event => {
      if (event.target !== input) return
      const selection = Array.from(input.files)
      input.value = ''
      finishPicker()
      add(selection)
    }
    list = element('div', 'drive-list')
    list.setAttribute('role', 'group')
    list.setAttribute('aria-label', '文件列表')
    if (typeof IntersectionObserver === 'function') {
      observer = new IntersectionObserver(changes => {
        for (const { target, isIntersecting } of changes) {
          if (!root?.contains(target) || !isIntersecting) continue
          const file = files[Number(target.dataset.index)]
          if (file) target.src = file.src
          observer.unobserve(target)
        }
      }, { root: list, rootMargin: '70px' })
    }
    status = element('p', 'drive-status')
    status.setAttribute('role', 'status')
    bar.append(title, count, uploadButton)
    root.append(bar, input, list, status)
    root.ondragover = event => {
      if (!event.dataTransfer?.types.includes('Files')) return
      event.preventDefault()
      event.dataTransfer.dropEffect = pending ? 'none' : 'copy'
      root.classList.toggle('drive-dropping', !pending)
    }
    root.ondragleave = event => {
      if (!root.contains(event.relatedTarget)) root.classList.remove('drive-dropping')
    }
    root.ondrop = event => {
      event.preventDefault()
      root.classList.remove('drive-dropping')
      if (event.dataTransfer) add(Array.from(event.dataTransfer.files))
    }
    container.append(root)
    drawFiles()
  }

  return { show, hide, dispose: hide, flush: () => pending || Promise.resolve() }
}
