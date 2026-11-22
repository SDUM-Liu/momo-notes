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
const chunkSize = 1024 * 1024
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

function sizeLabel(size) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB']
  let unit = 0
  while (size >= 1024 && unit < units.length - 1) { size /= 1024; unit++ }
  return Number(size.toFixed(unit > 1 ? 1 : 0)) + ' ' + units[unit]
}

function describe(file) {
  if (file.storage === 'chunks-v1') {
    const kind = file.mime?.split('/')[0]
    if (!Object.hasOwn(displays, kind)) return { info: '未知格式' }
    const thumb = typeof file.thumb === 'string' && /^data:image\/(webp|jpeg|png);base64,/i.test(file.thumb) ? file.thumb : undefined
    return { kind, info: displays[kind].name + ' · ' + sizeLabel(file.size), thumb }
  }
  const header = /^data:(image|video|audio)\/[a-z\d.+-]+(?:;[^,]*)?;base64,/i.exec(file.src?.slice(0, 200) || '')
  if (!header) return { info: '未知格式' }
  const kind = header[1].toLowerCase()
  const padding = file.src.endsWith('==') ? 2 : Number(file.src.endsWith('='))
  const size = Math.max(0, Math.floor((file.src.length - header[0].length) * 0.75) - padding)
  return { kind, info: displays[kind].name + ' · ' + sizeLabel(size), thumb: kind === 'image' ? file.src : undefined }
}

// Read only the header of small PNG/JPEG images. Other formats and large photos
// remain previewable without allocating a full-size bitmap just for their tile.
function thumbnailDimensions(view, type) {
  if (type === 'image/png' && view.byteLength >= 24 && view.getUint32(0) === 0x89504e47 && view.getUint32(12) === 0x49484452)
    return [view.getUint32(16), view.getUint32(20)]
  if (type !== 'image/jpeg' || view.byteLength < 4 || view.getUint16(0) !== 0xffd8) return
  let offset = 2
  while (offset + 9 <= view.byteLength && view.getUint8(offset) === 0xff) {
    const marker = view.getUint8(offset + 1)
    if (marker === 0xff) { offset++; continue }
    if ([0xc0, 0xc1, 0xc2].includes(marker)) return [view.getUint16(offset + 7), view.getUint16(offset + 5)]
    const length = view.getUint16(offset + 2)
    if (length < 2 || marker === 0xda || marker === 0xd9) return
    offset += length + 2
  }
}

async function thumbnail(file, mime) {
  if (!['image/png','image/jpeg'].includes(mime) || file.size > 8 * chunkSize || typeof createImageBitmap !== 'function') return
  let bitmap
  try {
    const header = new DataView(await file.slice(0, 65536).arrayBuffer())
    const [width, height] = thumbnailDimensions(header, mime) || []
    if (!width || !height || width * height > 16000000) return
    const ratio = Math.min(1, 180 / Math.max(width, height))
    const options = width >= height ? { resizeWidth: Math.max(1, Math.round(width * ratio)) }
      : { resizeHeight: Math.max(1, Math.round(height * ratio)) }
    bitmap = await createImageBitmap(file, options)
    const canvas = document.createElement('canvas')
    const scale = Math.min(1, 180 / Math.max(bitmap.width, bitmap.height))
    canvas.width = Math.max(1, Math.round(bitmap.width * scale))
    canvas.height = Math.max(1, Math.round(bitmap.height * scale))
    canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height)
    const src = canvas.toDataURL('image/webp', 0.72)
    if (src.length <= 65536) return src
  } catch { /* A missing thumbnail does not affect the original file. */ }
  finally { bitmap?.close() }
}

export function privateMediaType(file) {
  const type = file.type.toLowerCase().split(';')[0]
  if (/^(image|video|audio)\/[a-z\d.+-]+$/.test(type)) return type
  const extension = /\.([a-z\d]+)$/i.exec(file.name)?.[1]?.toLowerCase()
  if ((!type || type === 'application/octet-stream') && Object.hasOwn(formats, extension)) return formats[extension]
  throw new Error('请选择图片、视频或音频文件（' + file.name + '）')
}

export function wirePrivateDrive(container, { save, picker, media }) {
  let files = [], root, input, uploadButton, list, count, status, dialog, previewMedia, observer
  let generation = 0, upload, cancelUpload, pending, previewId, picking = false

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
    previewMedia?.removeAttribute('src')
    previewMedia = undefined
    if (previewId) {
      const id = previewId
      previewId = undefined
      void media('mediaRelease', { id }).catch(() => {})
    }
    dialog?.remove()
    dialog = undefined
  }

  function hide() {
    generation++
    finishPicker()
    upload?.abort()
    upload = undefined
    observer?.disconnect()
    observer = undefined
    if (dialog?.open) dialog.close()
    clearPreview()
    if (input) { input.onchange = input.oncancel = null; input.value = '' }
    list?.replaceChildren()
    root?.remove()
    root = input = uploadButton = cancelUpload = list = count = status = undefined
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
      cancelUpload.hidden = true
      if (error) {
        const detail = error.message || String(error)
        status.textContent = /\b(ENOSPC|EDQUOT)\b|no space left|disk (is )?full|quota exceeded/i.test(detail) || error.name === 'QuotaExceededError'
          ? '存储空间不足，请清理空间后重新上传。' : detail
      }
    }
    pending.then(() => settled(), settled)
  }

  function openPreview(file) {
    clearPreview()
    const { kind, info } = describe(file)
    const item = element('dialog', 'drive-preview')
    item.setAttribute('aria-label', file.name)
    dialog = item
    const bar = element('header', 'drive-preview-bar')
    const title = element('h2', '', file.name)
    const close = action('', 'drive-close', closeIcon)
    close.setAttribute('aria-label', '关闭预览')
    close.autofocus = true
    const dismiss = () => {
      if (item.open) item.close()
      if (dialog === item) clearPreview()
    }
    close.onclick = dismiss
    item.oncancel = event => { event.preventDefault(); dismiss() }
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
      stage.append(player)
      if (file.storage === 'chunks-v1') {
        previewId = file.id
        player.hidden = true
        fallback.textContent = '正在打开…'
        void media('mediaPreview', { id: file.id }, (done, total) => {
          if (dialog === item && item.open && total) fallback.textContent = '正在打开… ' + Math.floor(100 * done / total) + '%'
        }).then(url => {
          if (dialog !== item || !item.open) return
          fallback.textContent = '当前设备无法预览此文件。'
          fallback.hidden = true
          player.src = url
          player.hidden = false
        }).catch(error => {
          if (dialog === item) fallback.textContent = error.message || '无法读取此文件'
        })
      } else {
        player.src = file.src
        fallback.hidden = true
      }
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
      dismiss()
      perform(async active => {
        const next = files.filter(entry => entry.id !== file.id)
        await save(next)
        if (active()) { files = next; drawFiles(); uploadButton.focus() }
        if (file.storage === 'chunks-v1') await media('mediaRemove', { id: file.id })
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
      const { kind, info, thumb } = describe(file)
      const card = action('', 'drive-file')
      card.setAttribute('aria-label', '预览 ' + file.name)
      card.title = file.name
      const tile = element('span', 'drive-thumb drive-' + (kind || 'image'))
      tile.append(icon(displays[kind]?.icon || imageIcon))
      if (kind === 'image' && thumb) {
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
        } else img.src = thumb
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
      const types = selection.map(privateMediaType)
      const finished = []
      const controller = new AbortController()
      let staging
      upload = controller
      cancelUpload.hidden = false
      const check = () => {
        if (controller.signal.aborted || !active()) throw new DOMException('已取消上传', 'AbortError')
      }
      try {
        for (let i = 0; i < selection.length; i++) {
          check()
          const file = selection[i], mime = types[i], id = crypto.randomUUID()
          const record = { id, name: file.name, size: file.size, mime, storage: 'chunks-v1' }
          const label = (i + 1) + ' / ' + selection.length + ' · ' + file.name
          status.textContent = '正在上传 ' + label
          staging = id
          await media('mediaBegin', { id, size: file.size, mime })
          for (let offset = 0, index = 0; offset < file.size; offset += chunkSize, index++) {
            check()
            const bytes = new Uint8Array(await file.slice(offset, offset + chunkSize).arrayBuffer())
            check()
            await media('mediaWrite', { id, index, bytes })
            if (active()) status.textContent = label + ' · ' + Math.floor((offset + bytes.length) / file.size * 100) + '%'
          }
          check()
          await media('mediaFinish', { id })
          finished.push(record)
          staging = undefined
          check()
          const thumb = await thumbnail(file, mime)
          if (thumb) record.thumb = thumb
        }
        check()
        // Only publish the new manifest after every file in this selection is durable.
        cancelUpload.hidden = true
        status.textContent = '正在保存文件列表…'
        const next = [...files, ...finished]
        await save(next)
        if (active()) { files = next; drawFiles(); status.textContent = '' }
      } catch (error) {
        // If locking has already closed the key, unlock-time recovery removes orphans.
        if (staging) await media('mediaAbort', { id: staging }).catch(() => {})
        for (const file of finished) await media('mediaRemove', { id: file.id }).catch(() => {})
        if (!controller.signal.aborted) throw error
        if (active()) status.textContent = '已取消上传'
      } finally {
        if (upload === controller) upload = undefined
      }
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
          if (file) target.src = describe(file).thumb
          observer.unobserve(target)
        }
      }, { root: list, rootMargin: '70px' })
    }
    status = element('p', 'drive-status')
    status.setAttribute('role', 'status')
    cancelUpload = action('取消上传', 'drive-text-button')
    cancelUpload.hidden = true
    cancelUpload.onclick = () => {
      upload?.abort()
      cancelUpload.hidden = true
      status.textContent = '正在取消…'
    }
    const foot = element('div', 'drive-operation')
    foot.append(status, cancelUpload)
    bar.append(title, count, uploadButton)
    root.append(bar, input, list, foot)
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

  return { show, hide, add, dispose: hide, flush: () => pending || Promise.resolve() }
}
