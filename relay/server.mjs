import { createHash, randomUUID } from 'node:crypto'
import { createServer, STATUS_CODES } from 'node:http'
import { WebSocket, WebSocketServer } from 'ws'
import { protocol, ownerAuth, peerAuth, roomPath, peerId, health } from './protocol.mjs'

const hash = value => createHash('sha256').update(value).digest('hex')
const rooms = new Map()
const relay = new WebSocketServer({
  noServer: true,
  maxPayload: 65536,
  handleProtocols: protocols => protocols.has(protocol) ? protocol : false,
})

const http = createServer((request, response) => {
  if (request.method === 'GET' && request.url === '/health') {
    response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(health))
    return
  }
  response.writeHead(roomPath.test(request.url) ? 426 : 404).end()
})

function deny(socket, status) {
  socket.end('HTTP/1.1 ' + status + ' ' + STATUS_CODES[status] + '\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
}

function send(socket, frame) {
  if (socket?.readyState !== WebSocket.OPEN) return
  if (socket.bufferedAmount > 8 * 1024 * 1024) { socket.terminate(); return }
  socket.send(JSON.stringify(frame))
}

http.on('upgrade', (request, socket, head) => {
  const id = roomPath.exec(request.url)?.[1]
  if (!id) return deny(socket, 404)
  const [version, token, ...extra] = (request.headers['sec-websocket-protocol'] ?? '').split(/,\s*/)
  if (version !== protocol || extra.length || !token) return deny(socket, 403)
  const owner = ownerAuth.exec(token)
  const join = peerAuth.exec(token)
  const room = rooms.get(id)
  if (owner && hash(owner[1]) !== id) return deny(socket, 403)
  if (!owner) {
    if (!join) return deny(socket, 403)
    if (!room || room.host.readyState !== WebSocket.OPEN) return deny(socket, 503)
    if (hash(join[1]) !== room.joinHash) return deny(socket, 403)
    if (room.peers.size >= 8) return deny(socket, 429)
  }
  if (relay.clients.size >= 1024 && !(owner && room)) return deny(socket, 429)

  relay.handleUpgrade(request, socket, head, client => {
    if (owner) {
      if (room) {
        for (const peer of room.peers.values()) peer.close(1012, 'Host reconnected')
        room.host.close(1012, 'Host replaced')
      }
      const active = { host: client, joinHash: owner[2], peers: new Map() }
      rooms.set(id, active)
      bind(client, undefined, active, () => {
        if (rooms.get(id) === active) rooms.delete(id)
        for (const peer of active.peers.values()) peer.close(1012, 'Host disconnected')
      })
    } else {
      const peer = randomUUID()
      room.peers.set(peer, client)
      bind(client, peer, room, () => {
        room.peers.delete(peer)
        send(room.host, { kind: 'leave', peer })
      })
    }
  })
})

function bind(socket, peer, room, close) {
  socket.once('close', close)
  socket.on('error', () => socket.terminate())
  socket.on('message', (raw, binary) => {
    if (binary) { socket.close(1003, 'Invalid packet'); return }
    const data = raw.toString()
    if (data === 'ping') { socket.send('pong'); return }
    let frame
    try { frame = JSON.parse(data) } catch { socket.close(1003, 'Invalid packet'); return }
    if (!frame || !['signal', 'data'].includes(frame.kind) || typeof frame.packet !== 'string') {
      socket.close(1003, 'Invalid packet')
      return
    }
    const id = peer ?? frame.peer
    if (typeof id !== 'string' || !peerId.test(id)) return
    send(peer ? room.host : room.peers.get(id), { peer: id, kind: frame.kind, packet: frame.packet })
  })
  socket.alive = true
  socket.on('pong', () => { socket.alive = true })
  send(socket, { kind: 'ready', peer })
}

// A broken connection cannot keep a host or a peer slot indefinitely.
setInterval(() => {
  for (const socket of relay.clients) {
    if (!socket.alive) { socket.terminate(); continue }
    socket.alive = false
    socket.ping()
  }
}, 30000).unref()

const host = process.env.HOST || '127.0.0.1'
const port = Number(process.env.PORT || 8787)
http.listen(port, host, () => console.log('Momo sync relay listening on ' + host + ':' + port))
