import { base64, bytes as decode64 } from './mobile-sealed.js'

const chunkSize = 1024 * 1024
const lifetime = 5 * 60 * 1000
const encoder = new TextEncoder()
const locked = () => Object.assign(new Error('私密便签已锁定，请重新验证'), { code: 'PRIVATE_LOCKED' })

function checkSize(size) {
  if (!Number.isSafeInteger(size) || size < 0) throw new Error('主设备返回的文件大小无效')
}
function readBytes(value, length) {
  if (typeof value !== 'string' || value.length !== 4 * Math.ceil(length / 3)) throw new Error('主设备返回的分块长度有误')
  const data = Uint8Array.fromBase64 ? Uint8Array.fromBase64(value) : decode64(value)
  if (data.length !== length) throw new Error('主设备返回的分块不完整')
  return data
}
function encodeBytes(data) {
  return data.toBase64 ? data.toBase64() : base64(data)
}

// Encode bounded spans without splitting a surrogate pair. The manifest may
// contain large inline attachments from older versions of the application.
function* utf8Spans(text) {
  let offset = 0
  while (offset < text.length) {
    let end = Math.min(offset + 65536, text.length)
    if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1])) end++
    yield encoder.encode(text.slice(offset, end))
    offset = end
  }
}
async function writeManifest(entries, invoke) {
  if (!Array.isArray(entries)) throw new Error('私密便签格式无效')
  const json = JSON.stringify(entries)
  let size = 0
  for (const span of utf8Spans(json)) { size += span.length; span.fill(0) }
  const buffer = new Uint8Array(Math.min(size, chunkSize))
  let used = 0, index = 0
  try {
    await invoke('saveBegin', { size })
    for (const span of utf8Spans(json)) {
      try {
        let offset = 0
        while (offset < span.length) {
          const count = Math.min(buffer.length - used, span.length - offset)
          buffer.set(span.subarray(offset, offset + count), used)
          offset += count; used += count
          if (used === buffer.length) {
            await invoke('saveWrite', { index: index++, bytes: encodeBytes(buffer) })
            used = 0
          }
        }
      } finally { span.fill(0) }
    }
    if (used) await invoke('saveWrite', { index, bytes: encodeBytes(buffer.subarray(0, used)) })
    await invoke('saveCommit', {})
  } catch (error) {
    await invoke('saveAbort', {}).catch(() => {})
    throw error
  } finally { buffer.fill(0) }
}

// The calling bridge owns pairing and foreground eligibility. All data here
// belongs only to the running screen. In particular, no follower media store
// or persistent preview sink is opened.
export function remoteBook(send, onExpired = () => {}) {
  let current, generation = 0, timer
  const previews = new Map()

  function release(id) {
    const preview = previews.get(id)
    if (!preview) return
    previews.delete(id)
    preview.abort.abort()
    preview.parts.length = 0
    if (preview.url) URL.revokeObjectURL(preview.url)
  }
  function close() {
    const previous = current
    current = undefined
    generation++
    previous?.abort.abort()
    clearTimeout(timer)
    for (const id of previews.keys()) release(id)
    return previous
  }
  async function tellHost(session) {
    if (session) try { await send('lock', { session }) } catch { /* The primary also expires idle sessions. */ }
  }
  function expire(s) {
    if (current !== s) return
    close()
    void tellHost(s.token)
    onExpired()
  }
  function touch(s) {
    clearTimeout(timer)
    s.until = Date.now() + lifetime
    timer = setTimeout(() => expire(s), lifetime)
  }
  function guard(s) {
    if (current !== s || !s) throw locked()
    if (Date.now() >= s.until) { expire(s); throw locked() }
  }
  async function invoke(s, op, args, signal = s.abort.signal) {
    guard(s)
    try {
      if (signal.aborted) throw new Error('操作已取消')
      const value = await new Promise((resolve, reject) => {
        const cancel = () => reject(new Error('操作已取消'))
        signal.addEventListener('abort', cancel, { once: true })
        Promise.resolve().then(() => {
          guard(s)
          if (signal.aborted) throw new Error('操作已取消')
          return send(op, { ...args, session: s.token })
        }).then(resolve, reject).finally(() => signal.removeEventListener('abort', cancel))
      })
      guard(s); touch(s)
      return value
    } catch (error) {
      if (error?.code === 'PRIVATE_LOCKED') expire(s)
      throw error
    }
  }

  async function unlock(args) {
    const previous = close()
    const version = generation
    await tellHost(previous?.token)
    if (generation !== version) throw locked()
    const opened = await send('unlock', { password: args.password, code: args.code, attempt: crypto.randomUUID() })
    if (!/^[a-f\d]{64}$/.test(opened?.session || '')) throw new Error('主设备验证回复无效')
    if (generation !== version) { void tellHost(opened.session); throw locked() }
    const s = { token: opened.session, saves: Promise.resolve(), abort: new AbortController() }
    current = s
    touch(s)
    const parts = []
    try {
      checkSize(opened.size)
      const decoder = new TextDecoder('utf-8', { fatal: true })
      for (let offset = 0, index = 0; offset < opened.size; offset += chunkSize, index++) {
        const reply = await invoke(s, 'manifestRead', { index })
        const bytes = readBytes(reply?.bytes, Math.min(chunkSize, opened.size - offset))
        try { parts.push(decoder.decode(bytes, { stream: true })) } finally { bytes.fill(0) }
      }
      parts.push(decoder.decode())
      guard(s)
      const entries = JSON.parse(parts.join(''))
      if (!Array.isArray(entries)) throw new Error('主设备返回的便签格式无效')
      return entries
    } catch (error) {
      if (current === s) { close(); void tellHost(s.token) }
      throw error
    } finally { parts.length = 0 }
  }

  function preview(s, id) {
    const existing = previews.get(id)
    if (existing) return existing.promise
    const task = { parts: [], abort: new AbortController() }
    previews.set(id, task)
    const check = () => {
      guard(s)
      if (previews.get(id) !== task) throw new Error('预览已关闭')
    }
    task.promise = (async () => {
      const parts = task.parts
      try {
        const meta = await invoke(s, 'mediaInfo', { id }, task.abort.signal)
        check(); checkSize(meta?.size)
        if (!/^(audio|video|image)\/[a-z\d.+_-]+(?:;|$)/i.test(meta.mime)) throw new Error('主设备返回的附件类型无效')
        for (let offset = 0, index = 0; offset < meta.size; offset += chunkSize, index++) {
          const reply = await invoke(s, 'mediaRead', { id, index }, task.abort.signal)
          check()
          const bytes = readBytes(reply?.bytes, Math.min(chunkSize, meta.size - offset))
          try { parts.push(new Blob([bytes])) } finally { bytes.fill(0) }
        }
        check()
        task.url = URL.createObjectURL(new Blob(parts, { type: meta.mime }))
        return task.url
      } catch (error) {
        if (previews.get(id) === task) release(id)
        throw error
      } finally { parts.length = 0 }
    })()
    return task.promise
  }

  return async (op, args = {}) => {
    if (op === 'lock' || op === 'background') {
      const active = close()
      const closing = tellHost(active?.token)
      // Let the UI erase immediately even when the phone just went offline.
      if (op === 'lock') await closing
      return
    }
    if (op === 'begin') {
      const previous = close()
      const version = generation
      await tellHost(previous?.token)
      if (generation !== version) throw locked()
      await send('begin', {})
      if (generation !== version) throw locked()
      // Authenticator enrollment is only performed on the primary.
      return {}
    }
    if (op === 'unlock') return unlock(args)
    if (op === 'mediaRelease') { release(args.id); return }
    const s = current
    guard(s)
    if (op === 'save') {
      const result = s.saves.then(() => {
        guard(s)
        return writeManifest(args.entries, (verb, data) => invoke(s, verb, data))
      })
      s.saves = result.catch(() => {})
      return result
    }
    if (op === 'mediaPreview') return preview(s, args.id)
    if (op === 'mediaWrite') {
      if (!(args.bytes instanceof Uint8Array) || args.bytes.length > chunkSize) throw new Error('附件分块无效')
      return invoke(s, op, { id: args.id, index: args.index, bytes: encodeBytes(args.bytes) })
    }
    if (op === 'mediaRemove') release(args.id)
    if (['mediaBegin','mediaFinish','mediaAbort','mediaRemove','mediaInfo'].includes(op)) return invoke(s, op, args)
    throw new Error('不支持的私密便签操作')
  }
}
