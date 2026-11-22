const { createCipheriv, createDecipheriv, randomBytes } = require('node:crypto')
const { diskMedia, metadata, validId, chunkSize, chunkLength } = require('./disk-media.cjs')

function context(id, index) {
  return Buffer.from('momo/private-media/v1/' + id + '/' + index)
}
function encryptChunk(key, id, index, bytes) {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(context(id, index))
  return Buffer.concat([iv, cipher.update(bytes), cipher.final(), cipher.getAuthTag()])
}
function decryptChunk(key, id, index, raw) {
  const decipher = createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12), { authTagLength: 16 })
  decipher.setAAD(context(id, index))
  decipher.setAuthTag(raw.subarray(-16))
  const clear = decipher.update(raw.subarray(12, -16))
  try { decipher.final(); return clear } catch (error) { clear.fill(0); throw error }
}
function rangeFor(range, size) {
  if (range === null) return { start: 0, end: size - 1 }
  const match = /^bytes=(\d*)-(\d*)$/i.exec(range.trim())
  if (!match || !size || (!match[1] && !match[2])) return null
  if (!match[1]) {
    const trailing = Number(match[2])
    return trailing > 0 ? { start: Math.max(0, size - trailing), end: size - 1 } : null
  }
  const start = Number(match[1])
  const end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1
  return start < size && end >= start ? { start, end } : null
}

function privateMedia(directory, getSession) {
  const disk = diskMedia(directory)
  const uploads = new Map()
  const grants = new Map()
  const tokens = new Map()

  function files(entries) {
    const files = entries?.[0]?.files
    return Array.isArray(files) ? files.filter(f => f?.storage === 'chunks-v1') : []
  }
  function revoke(id) {
    const grant = grants.get(id)
    if (!grant) return
    grants.delete(id)
    tokens.delete(grant.token)
    for (const stop of grant.streams) stop()
  }
  function lock() {
    for (const id of grants.keys()) revoke(id)
    for (const id of uploads.keys()) {
      // A busy disk may defer this cleanup to the next unlock.
      try { disk.abort(id) } catch {}
    }
    uploads.clear()
  }

  function call(op, args, session) {
    const id = validId(args.id)
    switch (op) {
      case 'mediaBegin': {
        const meta = metadata(args)
        if (uploads.has(id)) throw new Error('附件正在上传')
        disk.begin(meta)
        uploads.set(id, { meta, next: 0 })
        return
      }
      case 'mediaWrite': {
        const upload = uploads.get(id)
        if (!upload || args.index !== upload.next) throw new Error('附件分块顺序有误，请重新上传')
        if (!(args.bytes instanceof Uint8Array) || args.bytes.byteLength !== chunkLength(upload.meta, args.index)) throw new Error('附件分块大小有误')
        const raw = encryptChunk(session.key, id, args.index, args.bytes)
        try { disk.writeRaw(upload.meta, args.index, raw) } catch (error) {
          if (error.code === 'ENOSPC' || error.code === 'EDQUOT') throw new Error('磁盘空间不足，请清理空间后重试')
          throw error
        }
        upload.next++
        return
      }
      case 'mediaFinish': {
        const upload = uploads.get(id)
        if (!upload || upload.next !== Math.ceil(upload.meta.size / chunkSize)) throw new Error('附件上传未完成')
        disk.finishRaw(upload.meta)
        uploads.delete(id)
        return
      }
      case 'mediaAbort':
        disk.abort(id)
        uploads.delete(id)
        return
      case 'mediaRemove':
        if (files(session.value.entries).some(f => f.id === id)) throw new Error('请先保存文件列表，再移除附件数据')
        revoke(id)
        disk.remove(id)
        return
      case 'mediaPreview': {
        const file = files(session.value.entries).find(f => f.id === id)
        if (!file) throw new Error('附件未在文件列表中')
        const meta = disk.readMeta(id)
        if (file.size !== meta.size || file.mime !== meta.mime) throw new Error('附件元数据不匹配')
        if (!grants.has(id)) {
          const token = randomBytes(24).toString('hex')
          const grant = { token, meta, streams: new Set() }
          grants.set(id, grant)
          tokens.set(token, grant)
        }
        return 'momo-media://preview/' + grants.get(id).token
      }
      case 'mediaRelease': revoke(id); return
      default: throw new Error('无效的附件操作')
    }
  }

  function respond(request) {
    const token = /^momo-media:\/\/preview\/([a-f0-9]{48})$/.exec(request.url)?.[1]
    const grant = tokens.get(token)
    const session = getSession()
    if (!session || !grant) return new Response(null, { status: 404 })
    if (!['GET', 'HEAD'].includes(request.method)) return new Response(null, { status: 405, headers: { Allow: 'GET, HEAD' } })
    const { id, size, mime } = grant.meta
    const range = request.headers.get('range')
    const bounds = rangeFor(range, size)
    const headers = { 'Accept-Ranges': 'bytes', 'Content-Type': mime, 'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "sandbox; default-src 'none'" }
    if (!bounds) return new Response(null, { status: 416, headers: { ...headers, 'Content-Range': 'bytes */' + size } })
    const { start, end } = bounds
    const status = range === null ? 200 : 206
    headers['Content-Length'] = String(end - start + 1)
    if (status === 206) headers['Content-Range'] = 'bytes ' + start + '-' + end + '/' + size
    if (!size || request.method === 'HEAD') return new Response(null, { status, headers })

    let offset = start, stop
    function detach() {
      grant.streams.delete(stop)
      request.signal.removeEventListener('abort', stop)
    }
    const body = new ReadableStream({
      start(controller) {
        stop = () => { detach(); controller.error(new Error('预览已结束')) }
        grant.streams.add(stop)
        request.signal.addEventListener('abort', stop, { once: true })
        if (request.signal.aborted) stop()
      },
      pull(controller) {
        try {
          if (getSession() !== session || !tokens.has(token)) throw new Error('已锁定')
          const index = Math.floor(offset / chunkSize)
          const clear = decryptChunk(session.key, id, index, disk.readRaw(id, index))
          const first = offset % chunkSize
          const count = Math.min(clear.length - first, end - offset + 1)
          controller.enqueue(clear.subarray(first, first + count))
          offset += count
          if (offset > end) { detach(); controller.close() }
        } catch (error) { detach(); controller.error(error) }
      },
      cancel: detach,
    }, { highWaterMark: 0 })
    return new Response(body, { status, headers })
  }
  return { call, respond, lock, recover: entries => disk.recover(new Set(files(entries).map(f => f.id))) }
}

module.exports = { privateMedia }
