import { digest, joinToken, relayOrigin, relayProtocol, roomPattern, seal, transferId, unseal } from './sync.mjs'

const peerPattern = /^[a-f0-9-]{36}$/
const chunkSize = 16 * 1024
const windowSize = 4
const waitLimit = 120000
const error = message => new Error(message)
const badFrame = () => error('SSH 会话数据验证失败')
const deferred = () => {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

const cancelled = () => new DOMException('SSH 连接已取消', 'AbortError')

async function connect({ grant, owner, openPipe, onClose, onConnected, signal }) {
  if (signal?.aborted) throw cancelled()
  if (!roomPattern.test(grant.room) || !roomPattern.test(grant.key)) throw badFrame()
  const url = new URL('/v1/' + grant.room, relayOrigin(grant.relay))
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  const ticket = joinToken(grant.key)
  const auth = owner ? 'host.' + owner + '.' + digest(ticket) : 'join.' + ticket
  const socket = new WebSocket(url, [relayProtocol, auth])
  const established = deferred()
  const outgoing = owner ? 'service' : 'terminal'
  const incoming = owner ? 'terminal' : 'service'
  let peer, pipe, closed = false, registered = false, authorized = false, remoteReady = false, started = false
  let sent = 0, received = 0, chunksSent = 0, chunksAcked = 0, chunksReceived = 0, chunksWritten = 0
  let writes = Promise.resolve(), credit, lastSeen = Date.now()
  let deadline = setTimeout(() => stop(error('连接 SSH 中继超时')), 12000)
  const heartbeat = setInterval(() => {
    if (Date.now() - lastSeen > 80000) stop(error('SSH 中继连接中断'))
    else if (socket.readyState === 1) socket.send('ping')
  }, 25000)

  function abort() { stop(cancelled()) }

  function stop(reason) {
    if (closed) return
    closed = true
    signal?.removeEventListener('abort', abort)
    clearTimeout(deadline)
    clearInterval(heartbeat)
    if (credit) credit.resolve()
    established.reject(reason || error('SSH 会话已结束'))
    try { socket.close() } catch {}
    if (pipe) void Promise.resolve(pipe.close()).catch(() => {})
    onClose?.(reason)
  }

  function context(direction, id) {
    return 'manual-ssh/v1/' + grant.room + '/' + id + '/' + direction
  }

  function send(kind, fields = {}) {
    if (closed || socket.readyState !== 1) throw error('SSH 中继已断开')
    const packet = seal(grant.key, context(outgoing, peer), { seq: sent++, kind, ...fields })
    socket.send(JSON.stringify({ kind: 'data', peer, packet }))
  }

  function finish(reason) {
    if (!closed && authorized && socket.readyState === 1) {
      try { send('end', { failed: Boolean(reason) }) } catch {}
    }
    stop(reason)
  }

  async function waitForCredit(limit) {
    while (!closed && chunksSent - chunksAcked >= limit) {
      credit = deferred()
      await credit.promise
    }
  }

  async function pump() {
    while (!closed) {
      await waitForCredit(windowSize)
      if (closed) return
      const data = await pipe.read()
      if (closed) return
      if (data === null) {
        await waitForCredit(1)
        finish()
        return
      }
      if (!(data instanceof Uint8Array) || data.length === 0 || data.length > 65536) throw badFrame()
      for (let start = 0; start < data.length; start += chunkSize) {
        await waitForCredit(windowSize)
        if (closed) return
        const bytes = data.subarray(start, start + chunkSize)
        send('bytes', { data: btoa(String.fromCharCode(...bytes)) })
        chunksSent++
      }
    }
  }

  function startIfReady() {
    if (closed || started || !remoteReady || !pipe) return
    started = true
    clearTimeout(deadline)
    deadline = setTimeout(() => finish(error('本次 SSH 会话已达到一小时时限')), 3600000)
    onConnected?.()
    void pump().catch(finish)
  }

  async function open() {
    const pendingPipe = await openPipe()
    if (closed) { await pendingPipe.close(); return }
    pipe = pendingPipe
    send('ready')
    startIfReady()
  }

  function processFrame(frame) {
    if (closed) return
    if (frame.kind === 'ready' && !registered) {
      registered = true
      clearTimeout(deadline)
      deadline = setTimeout(() => finish(error('本次 SSH 连接邀请已超时')), waitLimit)
      if (owner) established.resolve()
      else {
        if (!peerPattern.test(frame.peer)) throw badFrame()
        peer = frame.peer
        send('hello')
      }
      return
    }
    if (frame.kind === 'leave' && peer && frame.peer === peer) { stop(error('SSH 对端已断开')); return }
    if (!registered || frame.kind !== 'data' || !peerPattern.test(frame.peer)) return
    if (peer && peer !== frame.peer) {
      // Another guest cannot replace the peer that consumed this invitation.
      if (owner && typeof frame.packet === 'string' && frame.packet.length < 1024) {
        let hello
        try { hello = unseal(grant.key, context(incoming, frame.peer), frame.packet) } catch { return }
        if (hello?.kind === 'hello' && hello.seq === 0) {
          const packet = seal(grant.key, context(outgoing, frame.peer), { seq: 0, kind: 'busy' })
          socket.send(JSON.stringify({ kind: 'data', peer: frame.peer, packet }))
        }
      }
      return
    }
    if (typeof frame.packet !== 'string' || frame.packet.length > 40000) {
      if (peer) throw badFrame()
      return
    }
    let message
    try { message = unseal(grant.key, context(incoming, frame.peer), frame.packet) } catch {
      if (peer) throw badFrame()
      return
    }
    if (!peer && (message?.kind !== 'hello' || message.seq !== 0)) return
    peer = frame.peer
    if (message?.seq !== received++) throw badFrame()
    if (!authorized) {
      if (message.kind === 'busy') throw error('本次 SSH 邀请已使用，请在从设备重新开启')
      if (message.kind !== (owner ? 'hello' : 'accept')) throw badFrame()
      authorized = true
      if (owner) send('accept')
      else established.resolve()
      void open().catch(finish)
    } else if (message.kind === 'end') {
      stop(message.failed ? error('对端 SSH 服务不可用或连接已中断，请检查从设备上的 SSH 服务') : undefined)
    } else if (message.kind === 'ready' && !remoteReady) {
      remoteReady = true
      startIfReady()
    } else if (message.kind === 'ack' && started) {
      if (message.count !== chunksAcked + 1 || message.count > chunksSent) throw badFrame()
      chunksAcked = message.count
      credit?.resolve()
    } else if (message.kind === 'bytes' && started) {
      if (typeof message.data !== 'string' || !message.data.length || message.data.length > Math.ceil(chunkSize / 3) * 4) throw badFrame()
      const bytes = Uint8Array.from(atob(message.data), char => char.charCodeAt(0))
      if (bytes.length > chunkSize || ++chunksReceived - chunksWritten > windowSize) throw badFrame()
      writes = writes.then(async () => {
        if (closed) return
        await pipe.write(bytes)
        if (!closed) send('ack', { count: ++chunksWritten })
      }).catch(finish)
    } else throw badFrame()
  }

  socket.onmessage = ({ data }) => {
    lastSeen = Date.now()
    if (data === 'pong') return
    try {
      if (typeof data !== 'string' || data.length > 65536) throw badFrame()
      processFrame(JSON.parse(data))
    } catch (reason) { stop(reason) }
  }
  socket.onerror = () => stop(error('无法连接 SSH 中继，请检查当前网络并重试'))
  socket.onclose = () => stop(error('SSH 中继连接已关闭'))
  signal?.addEventListener('abort', abort, { once: true })
  if (signal?.aborted) abort()
  await established.promise
  return { close: () => finish() }
}

export async function offerSSHRelay({ relay, openPipe, onClose, onConnected, signal }) {
  const owner = transferId() + transferId()
  const grant = { relay: relayOrigin(relay), room: digest(owner), key: transferId() + transferId() }
  const session = await connect({ grant, owner, openPipe, onClose, onConnected, signal })
  return { ...session, grant }
}

export function joinSSHRelay({ grant, openPipe, onClose, onConnected, signal }) {
  return connect({ grant, openPipe, onClose, onConnected, signal })
}
