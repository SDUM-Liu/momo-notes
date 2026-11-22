// Ciphertext is scoped to one primary profile. Replicas never open this database.
export const chunkSize = 1024 * 1024
const databases = new Map()
const range = id => IDBKeyRange.bound([id, 0], [id, Number.MAX_SAFE_INTEGER])
const count = meta => Math.ceil(meta.size / chunkSize)
const fields = ({ id, size, mime }) => ({ id, size, mime })
const sameFile = (a, b) => a.size === b.size && a.mime === b.mime

function metadata(value) {
  if (!value || typeof value.id !== 'string' || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(value.id) ||
    !Number.isSafeInteger(value.size) || value.size < 0 || !Number.isSafeInteger(value.size + count(value) * 28) ||
    typeof value.mime !== 'string' || value.mime.length > 200 || !/^(?:image|audio|video)\/[a-z0-9.+_-]+(?:;[a-z0-9 ._,=";+:-]+)?$/i.test(value.mime))
    throw new Error('附件信息无效')
  return fields(value)
}

function lengthAt(meta, index) {
  if (!Number.isSafeInteger(index) || index < 0 || index >= count(meta)) throw new Error('附件分块序号无效')
  return Math.min(chunkSize, meta.size - index * chunkSize)
}

function ready(prefix) {
  if (!databases.has(prefix)) {
    const opened = new Promise((resolve, reject) => {
      const req = indexedDB.open('momo-private-media-v1:' + prefix, 1)
      req.onupgradeneeded = () => {
        const db = req.result
        db.createObjectStore('meta', { keyPath: 'id' })
        db.createObjectStore('chunks')
        db.createObjectStore('preview')
      }
      req.onerror = () => reject(req.error)
      req.onsuccess = () => resolve(req.result)
    })
    databases.set(prefix, opened)
    opened.catch(() => databases.delete(prefix))
  }
  return databases.get(prefix)
}

const result = req => new Promise((resolve, reject) => {
  req.onsuccess = () => resolve(req.result)
  req.onerror = () => reject(req.error)
})

const tempName = prefix => 'momo-private-preview-' + encodeURIComponent(prefix || 'default')
const missing = error => error?.name === 'NotFoundError'
const unsupported = error => ['SecurityError','NotAllowedError','NotSupportedError'].includes(error?.name)
async function opfs() {
  try { return await navigator.storage?.getDirectory?.() } catch (error) {
    if (!unsupported(error)) throw error
  }
}
async function removeEntry(dir, name) {
  try { await dir.removeEntry(name, { recursive: true }) } catch (error) { if (!missing(error)) throw error }
}

export function mobileMedia(prefix) {
  async function use(stores, mode, work) {
    const db = await ready(prefix), tx = db.transaction(stores, mode, { durability: 'strict' })
    const done = new Promise((resolve, reject) => {
      tx.oncomplete = resolve
      tx.onabort = () => reject(tx.error || new Error('附件存储事务已中断'))
    })
    // Observe an abort even if work rejects before awaiting the transaction.
    done.catch(() => {})
    try {
      const value = await work(...stores.map(name => tx.objectStore(name)))
      await done
      return value
    } catch (error) {
      try { tx.abort() } catch {}
      throw error
    }
  }
  const fresh = (m, upload = false) => ({ ...m, next: 0, complete: false, upload })
  const clearTemp = async () => {
    await use(['preview'], 'readwrite', s => result(s.clear()))
    const root = await opfs()
    if (root) await removeEntry(root, tempName(prefix))
  }
  return {
    list: () => use(['meta'], 'readonly', async s => (await result(s.getAll())).filter(m => m.complete).map(fields)),
    async info(id) {
      const m = await use(['meta'], 'readonly', s => result(s.get(id)))
      if (!m?.complete) throw new Error('附件不存在或尚未写完')
      return fields(m)
    },
    async begin(value) {
      const meta = metadata(value)
      await use(['meta'], 'readwrite', s => result(s.add(fresh(meta, true))))
      return meta
    },
    async writeRaw(value, index, bytes) {
      const meta = metadata(value)
      if (!(bytes instanceof Uint8Array) || bytes.byteLength !== lengthAt(meta, index) + 28) throw new Error('附件分块长度无效')
      await use(['meta','chunks'], 'readwrite', async (s, chunks) => {
        const record = await result(s.get(meta.id)) || fresh(meta)
        if (!sameFile(record, meta) || index > record.next) throw new Error('附件分块顺序错误')
        if (index < record.next) {
          const old = await result(chunks.get([meta.id, index]))
          if (old?.length !== bytes.length || !old.every((byte, i) => byte === bytes[i])) throw new Error('重复分块内容不一致')
          return
        }
        await result(chunks.add(bytes, [meta.id, index]))
        await result(s.put({ ...record, next: index + 1 }))
      })
    },
    async finishRaw(value) {
      const meta = metadata(value)
      await use(['meta'], 'readwrite', async s => {
        const record = await result(s.get(meta.id)) || fresh(meta)
        if (!sameFile(record, meta) || record.next !== count(meta)) throw new Error('附件分块不完整')
        await result(s.put({ ...record, complete: true }))
      })
    },
    readRaw(id, index) {
      return use(['meta','chunks'], 'readonly', async (s, chunks) => {
        const record = await result(s.get(id))
        if (!record?.complete) throw new Error('附件不存在或尚未写完')
        const length = lengthAt(record, index)
        const bytes = await result(chunks.get([id, index]))
        if (!(bytes instanceof Uint8Array) || bytes.length !== length + 28) throw new Error('附件分块损坏')
        return bytes
      })
    },
    remove(id) {
      return use(['meta','chunks'], 'readwrite', async (s, chunks) => {
        await result(chunks.delete(range(id)))
        await result(s.delete(id))
      })
    },
    async recover(keep) {
      await clearTemp()
      await use(['meta','chunks'], 'readwrite', async (s, chunks) => {
        for (const record of await result(s.getAll())) {
          if (record.complete ? !keep || keep.has(record.id) : !record.upload) continue
          await result(chunks.delete(range(record.id)))
          await result(s.delete(record.id))
        }
      })
    },
    async clear() {
      await clearTemp()
      await use(['meta','chunks'], 'readwrite', (s, chunks) => Promise.all([result(s.clear()), result(chunks.clear())]))
    },
    async previewSink(meta, token) {
      const root = await opfs()
      if (root) {
        const dir = await root.getDirectoryHandle(tempName(prefix), { create: true })
        const handle = await dir.getFileHandle(token, { create: true })
        let writer
        try { writer = await handle.createWritable?.() } catch (error) {
          if (!unsupported(error)) { await removeEntry(dir, token); throw error }
        }
        if (writer) {
          return {
            write: bytes => writer.write(bytes),
            async file() { await writer.close(); writer = null; return (await handle.getFile()).slice(0, meta.size, meta.mime) },
            async dispose() { if (writer) await writer.abort().catch(() => {}); await removeEntry(dir, token) },
          }
        }
        await removeEntry(dir, token)
      }
      // WebViews without writable OPFS can still return a seekable, browser-backed Blob.
      // Commit each piece to disk first; keep Blob references, never all plaintext buffers, in JS.
      let index = 0
      return {
        write: bytes => use(['preview'], 'readwrite', s => result(s.put(new Blob([bytes]), [token, index++]))),
        async file(check) {
          const pieces = []
          // Merge equal-sized runs; the WebView owns payloads and JS holds O(log n) Blob handles.
          for (let i = 0; i < index; i++) {
            check()
            let blob = await use(['preview'], 'readonly', s => result(s.get([token, i])))
            let level = 0
            while (pieces[level]) { blob = new Blob([pieces[level], blob]); pieces[level++] = undefined }
            pieces[level] = blob
          }
          return new Blob(pieces.reverse().filter(Boolean), { type: meta.mime })
        },
        dispose: () => use(['preview'], 'readwrite', s => result(s.delete(range(token)))),
      }
    },
  }
}

const encoder = new TextEncoder()
const params = (id, index, iv) => ({ name: 'AES-GCM', iv, additionalData: encoder.encode('momo/private-media/v1/' + id + '/' + index) })

export function sessionMedia(store, key, guard, touch, files) {
  const uploads = new Map(), previews = new Map()
  const retiring = new Set()
  function cleanup(promise) {
    retiring.add(promise)
    promise.then(() => retiring.delete(promise), () => retiring.delete(promise))
    return promise
  }
  const current = (map, id, task) => { guard(); if (map.get(id) !== task) throw new Error('附件操作已取消') }
  function after(task, fn) {
    const pending = task.pending.then(fn)
    task.pending = pending.catch(() => {})
    return pending
  }
  function release(id) {
    const task = previews.get(id)
    if (!task) return Promise.resolve()
    previews.delete(id)
    if (task.url) URL.revokeObjectURL(task.url)
    return cleanup(task.pending.then(() => task.sink?.dispose()))
  }
  function abort(id) {
    const task = uploads.get(id)
    if (!task) return Promise.resolve()
    uploads.delete(id)
    return cleanup(task.pending.then(() => task.owned && store.remove(id)))
  }
  async function run(op, args) {
    guard(); touch()
    const { id, index, bytes } = args
    if (op === 'mediaRelease') return release(id)
    if (op === 'mediaAbort') return abort(id)
    if (op === 'mediaRemove') {
      if (files().some(file => file.id === id)) throw new Error('请先保存文件列表，再移除附件数据')
      await Promise.all([release(id), abort(id)]); guard()
      return store.remove(id)
    }
    if (op === 'mediaPreview') {
      const entry = files().find(file => file.id === id)
      if (!entry) throw new Error('附件未在文件列表中')
      const previous = previews.get(id)
      if (previous) return previous.result
      const task = { pending: Promise.resolve() }
      previews.set(id, task)
      const check = () => current(previews, id, task)
      try {
        task.result = after(task, async () => {
          const meta = await store.info(id); check()
          if (!sameFile(meta, entry)) throw new Error('附件元数据不匹配')
          task.sink = await store.previewSink(meta, crypto.randomUUID()); check()
          for (let i = 0; i < count(meta); i++) {
            const raw = await store.readRaw(id, i); check()
            const plain = new Uint8Array(await crypto.subtle.decrypt(params(id, i, raw.subarray(0, 12)), key, raw.subarray(12)))
            try { check(); await task.sink.write(plain) } finally { plain.fill(0) }
            check(); touch(); args.progress?.(i + 1, count(meta))
          }
          const file = await task.sink.file(() => {
            check(); touch(); args.progress?.(count(meta), count(meta))
          }); check()
          task.url = URL.createObjectURL(file)
          return task.url
        })
        return await task.result
      } catch (error) {
        if (previews.get(id) === task) await release(id)
        throw error
      }
    }
    if (op === 'mediaBegin') {
      if (uploads.has(id)) throw new Error('附件正在上传')
      const task = { meta: metadata(args), pending: Promise.resolve(), owned: false }
      uploads.set(id, task)
      try {
        await after(task, async () => { current(uploads, id, task); await store.begin(task.meta); task.owned = true; current(uploads, id, task) })
      } catch (error) { if (uploads.get(id) === task) await abort(id); throw error }
      return
    }
    const task = uploads.get(id)
    if (!task) throw new Error('请重新上传附件')
    return after(task, async () => {
      current(uploads, id, task)
      if (op === 'mediaWrite') {
        if (!(bytes instanceof Uint8Array) || bytes.length !== lengthAt(task.meta, index)) throw new Error('附件分块长度无效')
        const iv = crypto.getRandomValues(new Uint8Array(12))
        const encrypted = await crypto.subtle.encrypt(params(id, index, iv), key, bytes)
        const raw = new Uint8Array(12 + encrypted.byteLength)
        raw.set(iv); raw.set(new Uint8Array(encrypted), 12); current(uploads, id, task)
        await store.writeRaw(task.meta, index, raw); current(uploads, id, task)
      } else if (op === 'mediaFinish') {
        await store.finishRaw(task.meta); current(uploads, id, task)
        uploads.delete(id)
      } else throw new Error('不支持的附件操作')
    })
  }
  return {
    run,
    close: () => Promise.all([...Array.from(previews.keys(), release), ...Array.from(uploads.keys(), abort), ...retiring]),
  }
}
