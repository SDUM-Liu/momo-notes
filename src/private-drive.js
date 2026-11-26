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
  webp: 'image/webp', bmp: 'image/bmp', heic: 'image/heic', heif: 'image/heif', avif: 'image/avif',
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

function waitForMedia(node, event, signal, limit = 4200) {
  return new Promise((resolve, reject) => {
    const finish = error => {
      clearTimeout(timer)
      node.removeEventListener(event, ready)
      node.removeEventListener('error', fail)
      signal?.removeEventListener('abort', fail)
      if (error) reject(error)
      else resolve()
    }
    const ready = () => finish()
    const fail = () => finish(new Error('无法读取缩略图'))
    const timer = setTimeout(fail, limit)
    node.addEventListener(event, ready, { once: true })
    node.addEventListener('error', fail, { once: true })
    signal?.addEventListener('abort', fail, { once: true })
    if (signal?.aborted) fail()
  })
}

function frame(node, width, height) {
  if (!width || !height) return
  const scale = Math.min(1, 180 / Math.max(width, height))
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(width * scale))
  canvas.height = Math.max(1, Math.round(height * scale))
  canvas.getContext('2d').drawImage(node, 0, 0, canvas.width, canvas.height)
  const src = canvas.toDataURL('image/webp', 0.72)
  if (src.length <= 65536) return src
}

async function thumbnail(source, mime, signal) {
  const image = mime.startsWith('image/')
  if (signal?.aborted || (!image && !mime.startsWith('video/'))) return
  const node = element(image ? 'img' : 'video')
  const objectUrl = typeof source !== 'string'
  const url = objectUrl ? URL.createObjectURL(source.type === mime ? source : source.slice(0, source.size, mime)) : source
  try {
    if (!image) { node.preload = 'auto'; node.muted = true; node.playsInline = true }
    const loaded = waitForMedia(node, image ? 'load' : 'loadeddata', signal)
    node.src = url
    await loaded
    if (image) return frame(node, node.naturalWidth, node.naturalHeight)
    const first = frame(node, node.videoWidth, node.videoHeight)
    const seek = Math.min(1.5, node.duration * .16)
    if (Number.isFinite(seek) && seek > .08) {
      const moved = waitForMedia(node, 'seeked', signal, 1800).then(() => true, () => false)
      try {
        node.currentTime = seek
        if (await moved && !signal?.aborted) return frame(node, node.videoWidth, node.videoHeight) || first
      }
      catch {}
    }
    if (!signal?.aborted) return first
  } catch { /* A decode failure leaves the file available to open. */ }
  finally {
    node.removeAttribute('src')
    if (!image) node.load()
    if (objectUrl) URL.revokeObjectURL(url)
  }
}

export function privateMediaType(file) {
  const type = file.type.toLowerCase().split(';')[0]
  if (/^(image|video|audio)\/[a-z\d.+-]+$/.test(type)) return type
  const extension = /\.([a-z\d]+)$/i.exec(file.name)?.[1]?.toLowerCase()
  if ((!type || type.startsWith('application/')) && Object.hasOwn(formats, extension)) return formats[extension]
  throw new Error('请选择图片、视频或音频文件（' + file.name + '）')
}

export function wirePrivateDrive(container, { save, picker, media }) {
  let files = [], root, input, uploadButton, list, count, status, dialog, previewMedia, observer
  let generation = 0, upload, cancelUpload, pending, previewId, picking = false
  const generated = new Map(), waiting = new Set(), attempted = new Set()
  let thumbnailTask

  function rememberThumbnail(file, src) {
    if (!src || !files.includes(file)) return
    generated.set(file.id, src)
    const tile = list.children[files.indexOf(file)]?.querySelector('.drive-thumb img')
    if (tile) tile.src = src
  }

  function stopThumbnail() {
    if (!thumbnailTask) return Promise.resolve()
    const task = thumbnailTask
    task.controller.abort()
    if (task.file.storage === 'chunks-v1') void media('mediaRelease', { id: task.file.id }).catch(() => {})
    return task.promise
  }

  function nextThumbnail() {
    if (thumbnailTask || dialog || !root || !waiting.size) return
    const file = waiting.values().next().value
    waiting.delete(file)
    if (!files.includes(file)) { nextThumbnail(); return }
    const task = { file, controller: new AbortController() }
    const signal = task.controller.signal
    const epoch = generation
    thumbnailTask = task
    task.promise = (async () => {
      try {
        const url = file.storage === 'chunks-v1' ? await media('mediaPreview', { id: file.id }) : file.src
        if (signal.aborted) return
        const mime = file.mime || /^data:([^;,]+)/.exec(url)?.[1] || ''
        const src = await thumbnail(url, mime, signal)
        if (epoch === generation && !signal.aborted) rememberThumbnail(file, src)
      } catch {} finally {
        if (file.storage === 'chunks-v1') await media('mediaRelease', { id: file.id }).catch(() => {})
        if (thumbnailTask === task) thumbnailTask = undefined
        nextThumbnail()
      }
    })()
  }

  function fillThumb(img, file) {
    const { thumb } = describe(file)
    const src = generated.get(file.id) || thumb
    if (src) { img.src = src; return }
    // For legacy files, avoid opening very large encrypted attachments just to display a tile.
    if ((file.storage === 'chunks-v1' ? file.size > 12 * chunkSize : file.src.length > 16 * chunkSize) ||
        attempted.has(file.id)) return
    attempted.add(file.id)
    waiting.add(file)
    nextThumbnail()
  }

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
    queueMicrotask(nextThumbnail)
  }

  function hide() {
    generation++
    waiting.clear()
    attempted.clear()
    generated.clear()
    void stopThumbnail()
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
    const idleThumbnails = stopThumbnail()
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
        player.preload = kind === 'video' ? 'auto' : 'metadata'
        if (kind === 'video') player.playsInline = true
      }
      player.onerror = () => { player.hidden = true; fallback.hidden = false }
      if (!describe(file).thumb && !generated.has(file.id) && kind !== 'audio') {
        player.addEventListener(kind === 'video' ? 'loadeddata' : 'load', () => {
          if (dialog !== item) return
          try {
            rememberThumbnail(file, kind === 'image'
              ? frame(player, player.naturalWidth, player.naturalHeight)
              : frame(player, player.videoWidth, player.videoHeight))
          } catch {}
        }, { once: true })
      }
      if (kind === 'audio') stage.append(icon(audioIcon))
      stage.append(player)
      if (file.storage === 'chunks-v1') {
        previewId = file.id
        player.hidden = true
        fallback.textContent = '正在打开…'
        void idleThumbnails.then(() => {
          if (dialog === item && item.open) return media('mediaPreview', { id: file.id }, (done, total) => {
            if (dialog === item && item.open && total) fallback.textContent = '正在打开… ' + Math.floor(100 * done / total) + '%'
          })
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
      const { kind, info } = describe(file)
      const card = action('', 'drive-file')
      card.setAttribute('aria-label', '预览 ' + file.name)
      card.title = file.name
      const tile = element('span', 'drive-thumb drive-' + (kind || 'image'))
      tile.append(icon(displays[kind]?.icon || imageIcon))
      if (kind === 'image' || kind === 'video') {
        const img = element('img')
        img.alt = ''
        img.decoding = 'async'
        img.loading = 'lazy'
        img.onerror = () => img.removeAttribute('src')
        tile.append(img)
        if (observer) {
          // Keep offscreen image payloads out of the DOM until the card scrolls into view.
          tile.dataset.index = String(list.childElementCount)
          observer.observe(tile)
        } else fillThumb(img, file)
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
          const thumb = await thumbnail(file, mime, controller.signal)
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
          const img = target.querySelector('img')
          if (file && img) fillThumb(img, file)
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
