import { DurableObject } from 'cloudflare:workers'
import { protocol, ownerAuth, peerAuth, roomPath, peerId, health } from './protocol.mjs'
const encoder = new TextEncoder()
async function hash(value) {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value)))
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
}

export default {
  fetch(request, env) {
    const pathname = new URL(request.url).pathname
    if (request.method === 'GET' && pathname === '/health') return Response.json(health)
    const room = roomPath.exec(pathname)
    if (!room || request.method !== 'GET') return new Response(null, { status: 404 })
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return new Response(null, { status: 426 })
    return env.ROOMS.getByName(room[1]).fetch(request)
  },
}

function send(socket, value) {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(value))
}

export class Room extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env)
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'))
  }

  async fetch(request) {
    const room = new URL(request.url).pathname.split('/').at(-1)
    const [version, token, ...extra] = (request.headers.get('Sec-WebSocket-Protocol') || '').split(/,\s*/)
    if (version !== protocol || extra.length || !token) return new Response(null, { status: 403 })
    const owner = ownerAuth.exec(token)
    const join = peerAuth.exec(token)
    if (owner) {
      if (await hash(owner[1]) !== room) return new Response(null, { status: 403 })
      this.closePeers(1012, 'Host reconnected')
      for (const old of this.ctx.getWebSockets('host')) old.close(1012, 'Host replaced')
      return this.connect({ role: 'host', joinHash: owner[2] })
    }
    const host = this.host()
    if (!host) return new Response(null, { status: 503 })
    if (!join || await hash(join[1]) !== host.deserializeAttachment().joinHash) return new Response(null, { status: 403 })
    if (host !== this.host()) return new Response(null, { status: 503 })
    if (this.ctx.getWebSockets('peer').length >= 8) return new Response(null, { status: 429 })
    return this.connect({ role: 'peer', peer: crypto.randomUUID() })
  }

  connect(data) {
    const { 0: client, 1: server } = new WebSocketPair()
    const tags = data.role === 'host' ? ['host'] : ['peer', data.peer]
    this.ctx.acceptWebSocket(server, tags)
    server.serializeAttachment(data)
    send(server, { kind: 'ready', peer: data.peer })
    return new Response(null, { status: 101, webSocket: client, headers: { 'Sec-WebSocket-Protocol': protocol } })
  }

  host() {
    return this.ctx.getWebSockets('host').find(socket => socket.readyState === WebSocket.OPEN)
  }

  webSocketMessage(sender, message) {
    if (typeof message !== 'string' || message.length > 65536) {
      sender.close(1009, 'Packet too large')
      return
    }
    let frame
    try { frame = JSON.parse(message) } catch { sender.close(1003, 'Invalid packet'); return }
    if (!frame || !['signal', 'data'].includes(frame.kind) || typeof frame.packet !== 'string') {
      sender.close(1003, 'Invalid packet')
      return
    }
    const actor = sender.deserializeAttachment()
    const peer = actor.role === 'host' ? frame.peer : actor.peer
    if (typeof peer !== 'string' || !peerId.test(peer)) return
    const target = actor.role === 'host' ? this.ctx.getWebSockets(peer)[0] : this.host()
    send(target, { peer, kind: frame.kind, packet: frame.packet })
  }

  closePeers(code, reason) {
    for (const peer of this.ctx.getWebSockets('peer')) peer.close(code, reason)
  }

  webSocketClose(socket) {
    const actor = socket.deserializeAttachment()
    if (actor.role === 'peer') send(this.host(), { kind: 'leave', peer: actor.peer })
    else if (!this.host()) this.closePeers(1012, 'Host disconnected')
  }

  webSocketError(socket) {
    socket.close(1011, 'Connection lost')
  }
}
