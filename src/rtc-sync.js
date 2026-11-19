import { joinToken, digest, relayProtocol, seal, unseal, wireLimit, transferId } from '../shared/sync.mjs'

const chunkSize = 12 * 1024
const idPattern = /^[a-f0-9-]{36}$/
const transferPattern = /^[a-f0-9]{32}$/
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
const iceServers = [{ urls: 'stun:stun.cloudflare.com:3478' }]
const offline = () => new Error('无法连接同步服务或主机未在线，请确认主机已开启异地同步')

function socketLink(options, onFrame, onClose) {
  const url = new URL('/v1/' + options.room, options.relay)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  const socket = new WebSocket(url, [relayProtocol, options.token])
  let lastReply = Date.now()
  let readyTimer
  let resolveReady, rejectReady
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject })
  readyTimer = setTimeout(() => { rejectReady(offline()); socket.close() }, options.timeout ?? 12000)
  const heartbeat = setInterval(() => {
    if (socket.readyState !== WebSocket.OPEN) return
    if (Date.now() - lastReply > 80000) socket.close()
    else socket.send('ping')
  }, 25000)
  socket.onmessage = event => {
    lastReply = Date.now()
    if (event.data === 'pong') return
    let frame
    try { frame = JSON.parse(event.data) } catch { return }
    if (frame?.kind === 'ready') {
      clearTimeout(readyTimer)
      resolveReady(frame.peer)
    } else if (frame) onFrame(frame)
  }
  socket.onerror = () => rejectReady(offline())
  socket.onclose = () => {
    clearInterval(heartbeat)
    clearTimeout(readyTimer)
    rejectReady(offline())
    onClose()
  }
  return {
    ready, close: () => socket.close(),
    available: () => socket.readyState === WebSocket.OPEN,
    send(kind, packet, peer) {
      if (socket.readyState !== WebSocket.OPEN) throw offline()
      socket.send(JSON.stringify({ kind, packet, peer }))
    },
    buffered: () => socket.bufferedAmount,
  }
}

function chunks(onMessage) {
  const partial = new Map()
  return raw => {
    if (typeof raw !== 'string' || raw.length > chunkSize + 256) return
    let frame
    try { frame = JSON.parse(raw) } catch { return }
    if (!frame || !transferPattern.test(frame.id) || typeof frame.part !== 'string' || frame.part.length > chunkSize) return
    const now = Date.now()
    for (const [id, item] of partial) if (now - item.started > 70000) partial.delete(id)
    let item = partial.get(frame.id)
    if (!item) {
      if (partial.size >= 6 || frame.seq !== 0) return
      item = { parts: [], size: 0, started: now }
      partial.set(frame.id, item)
    }
    item.size += frame.part.length
    if (frame.seq !== item.parts.length || [...partial.values()].reduce((sum, part) => sum + part.size, 0) > wireLimit) {
      partial.delete(frame.id)
      return
    }
    item.parts.push(frame.part)
    if (frame.last === true) {
      partial.delete(frame.id)
      onMessage(frame.id, item.parts.join(''))
    }
  }
}

async function sendWire(id, wire, send, buffered) {
  if (wire.length > wireLimit) throw new Error('便签超出单页同步上限')
  const deadline = Date.now() + 30000
  for (let offset = 0, seq = 0; offset < wire.length; offset += chunkSize, seq++) {
    while (buffered() > 384 * 1024) {
      if (Date.now() > deadline) throw new Error('连接发送缓慢，请重试')
      await pause(20)
    }
    send(JSON.stringify({ id, seq, last: offset + chunkSize >= wire.length, part: wire.slice(offset, offset + chunkSize) }))
  }
}

async function gather(pc, type) {
  await pc.setLocalDescription(type === 'offer' ? await pc.createOffer() : await pc.createAnswer())
  let listener
  const complete = new Promise(resolve => {
    listener = () => { if (pc.iceGatheringState === 'complete') resolve() }
    pc.addEventListener('icegatheringstatechange', listener)
    listener()
  })
  await Promise.race([complete, pause(3200)])
  pc.removeEventListener('icegatheringstatechange', listener)
  return pc.localDescription.toJSON()
}

const signalContext = (type, peer) => 'rtc/' + type + '/' + peer

export function hostSyncLink(config, exchange, onStatus) {
  let socket, generation = 0, retry
  let status
  let closed = false
  const peers = new Map()
  function report(value) {
    if (status === value) return
    status = value
    onStatus(value)
  }
  function clearPeers() {
    for (const peer of peers.values()) peer.pc?.close()
    peers.clear()
  }
  function peerFor(id, link) {
    if (!peers.has(id) && peers.size < 8) {
      const receiveThrough = (send, buffered) => chunks((packetId, message) => {
        void exchange(message).then(reply => {
          if (reply) return sendWire(packetId, reply, send, buffered)
        }).catch(() => {})
      })
      peers.set(id, { receiveThrough, relay: receiveThrough(packet => link.send('data', packet, id), link.buffered) })
    }
    return peers.get(id)
  }
  async function handle(link, frame) {
    const id = frame.peer
    if (!idPattern.test(id) || socket !== link) return
    if (frame.kind === 'leave') {
      peers.get(id)?.pc?.close()
      peers.delete(id)
      return
    }
    if (frame.kind === 'data') {
      peerFor(id, link)?.relay(frame.packet)
      return
    }
    if (frame.kind !== 'signal' || !globalThis.RTCPeerConnection) return
    const offer = unseal(config.key, signalContext('offer', id), frame.packet)
    if (offer.type !== 'offer') return
    const peer = peerFor(id, link)
    if (!peer) return
    peer.pc?.close()
    const pc = new RTCPeerConnection({ iceServers })
    peer.pc = pc
    pc.ondatachannel = ({ channel }) => {
      if (channel.label !== 'momo-sync') { channel.close(); return }
      const receive = peer.receiveThrough(packet => channel.send(packet), () => channel.bufferedAmount)
      channel.onmessage = event => receive(event.data)
    }
    await pc.setRemoteDescription(offer)
    const answer = await gather(pc, 'answer')
    if (socket === link && peer.pc === pc) link.send('signal', seal(config.key, signalContext('answer', id), answer), id)
  }
  async function connect() {
    const attempt = ++generation
    try {
      const token = 'host.' + config.owner + '.' + digest(joinToken(config.key))
      if (closed || generation !== attempt) return
      const link = socketLink({ ...config, token }, frame => { void handle(link, frame).catch(() => {}) }, () => {
        if (socket !== link) return
        socket = undefined
        clearPeers()
        reconnect()
      })
      socket = link
      await link.ready
      if (socket === link) report('online')
    } catch {
      if (generation === attempt) {
        socket?.close()
        reconnect()
      }
    }
  }
  function reconnect() {
    if (closed) return
    report('offline')
    clearTimeout(retry)
    retry = setTimeout(connect, 3500)
  }
  report('connecting')
  void connect()
  return () => {
    closed = true
    clearTimeout(retry)
    clearPeers()
    socket?.close()
  }
}

async function clientLink(connection, route, disconnected) {
  const token = 'join.' + joinToken(connection.key)
  const pending = new Map()
  let peer, pc, channel, link, stopped = false
  function close() {
    if (stopped) return
    stopped = true
    pc?.close()
    link?.close()
    for (const request of pending.values()) request.reject(offline())
    if (peer) disconnected(connection)
  }
  function receiver(via) {
    return chunks((id, message) => pending.get(id)?.resolve({ message, via }))
  }
  const receiveRelay = receiver('relay')
  link = socketLink({ ...route, token, timeout: 6000 }, frame => {
    if (frame.kind === 'data') receiveRelay(frame.packet)
    if (frame.kind === 'signal' && pc && frame.peer === peer) {
      try {
        const answer = unseal(connection.key, signalContext('answer', peer), frame.packet)
        if (answer.type === 'answer') void pc.setRemoteDescription(answer).catch(() => {})
      } catch {}
    }
  }, close)
  try { peer = await link.ready } catch (error) { close(); throw error }
  if (globalThis.RTCPeerConnection) {
    void (async () => {
      pc = new RTCPeerConnection({ iceServers })
      channel = pc.createDataChannel('momo-sync')
      const receiveDirect = receiver('direct')
      channel.onmessage = event => receiveDirect(event.data)
      const offer = await gather(pc, 'offer')
      if (!stopped) link.send('signal', seal(connection.key, signalContext('offer', peer), offer))
    })().catch(() => {})
  }
  return {
    close,
    available: () => !stopped && link.available(),
    async exchange(message) {
      if (stopped) throw offline()
      const id = transferId()
      const useDirect = channel?.readyState === 'open'
      const send = useDirect ? packet => channel.send(packet) : packet => link.send('data', packet)
      const buffered = useDirect ? () => channel.bufferedAmount : link.buffered
      let timeout
      const response = new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject })
        timeout = setTimeout(() => reject(new Error('主机没有接受请求，请检查配对码或重试连接')), 65000)
      })
      try { return (await Promise.all([response, sendWire(id, message, send, buffered)]))[0] }
      finally { clearTimeout(timeout); pending.delete(id) }
    },
  }
}

const diagnosisMessage = {
  unauthorized: '配对码已失效，请从主机重新获取二维码',
  host_offline: '手机已连上同步服务，但主机未在线，请在电脑上打开桃桃并开启主机同步',
  room_full: '主机连接数已满，请稍后重试',
  service_unavailable: '手机无法访问同步服务，请检查当前网络或让主机配置可连通的同步服务',
  websocket_unavailable: '手机能访问同步服务，但同步连接未建立，请尝试切换手机网络',
}

export function mobileSyncLink(disconnected = () => {}, diagnose) {
  const links = new Map()
  async function connect(connection) {
    const routes = [{ relay: connection.relay, room: connection.room }]
    if (connection.fallback) routes.push({ relay: connection.fallback, room: connection.backupRoom })
    for (const route of routes) {
      try { return await clientLink(connection, route, disconnected) } catch {}
    }
    if (!diagnose) throw offline()
    const token = 'join.' + joinToken(connection.key)
    const results = await Promise.all(routes.map(route => diagnose({ ...route, token }).catch(() => null)))
    const message = Object.keys(diagnosisMessage).find(status => results.includes(status))
    throw message ? new Error(diagnosisMessage[message]) : offline()
  }
  return {
    async exchange(connection, message) {
      const id = JSON.stringify([connection.relay, connection.fallback, connection.room, connection.backupRoom, connection.key])
      let ready = links.get(id)
      if (!ready || !(await ready).available()) {
        ready = connect(connection)
        links.set(id, ready)
        void ready.catch(() => { if (links.get(id) === ready) links.delete(id) })
      }
      for (const [other, old] of links) {
        if (links.size <= 2) break
        if (other !== id) {
          links.delete(other)
          void old.then(link => link.close()).catch(() => {})
        }
      }
      return (await ready).exchange(message)
    },
    close() {
      for (const ready of links.values()) void ready.then(link => link.close()).catch(() => {})
      links.clear()
    },
  }
}
