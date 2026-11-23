const assert = require('node:assert/strict')
const { spawn } = require('node:child_process')
const { once } = require('node:events')
const { createServer } = require('node:net')
const path = require('node:path')
const { test } = require('node:test')
const { setTimeout: delay } = require('node:timers/promises')
const { digest, transferId } = require('../shared/sync.mjs')

test('paired peers add ICE candidates found after their SDP was sent and keep relay available', { timeout: 12000 }, async t => {
  const { createServer: vite } = await import('vite')
  const modules = await vite({ logLevel: 'silent', server: { middlewareMode: true, ws: false }, appType: 'custom' })
  t.after(() => modules.close())
  const { hostSyncLink, mobileSyncLink } = await modules.ssrLoadModule('/src/rtc-sync.js')

  const portPicker = createServer()
  portPicker.listen(0, '127.0.0.1')
  await once(portPicker, 'listening')
  const { port } = portPicker.address()
  await new Promise(resolve => portPicker.close(resolve))
  const server = spawn(process.execPath, [path.join(__dirname, '../relay/server.mjs')], {
    env: { ...process.env, PORT: String(port) },
  })
  t.after(() => server.kill())
  await once(server.stdout, 'data')

  const pcs = []
  class Peer extends EventTarget {
    constructor(config) { super(); this.config = config; this.received = []; pcs.push(this) }
    createDataChannel() { return { readyState: 'connecting' } }
    async createOffer() { return { type: 'offer' } }
    async createAnswer() { return { type: 'answer' } }
    async setLocalDescription(value) {
      this.localDescription = { toJSON: () => value }
      this.iceGatheringState = 'complete'
    }
    async setRemoteDescription(value) { this.remoteDescription = value }
    async addIceCandidate(value) {
      assert(this.remoteDescription, 'SDP must precede extra candidates on the signaling socket')
      this.received.push(value)
    }
    emitCandidate(port) {
      const value = { candidate: 'candidate:1 1 udp 1 192.0.2.1 ' + port + ' typ host', sdpMid: '0' }
      this.dispatchEvent(Object.assign(new Event('icecandidate'), { candidate: { ...value, toJSON: () => value } }))
      return value
    }
    close() {}
  }
  const previous = globalThis.RTCPeerConnection
  globalThis.RTCPeerConnection = Peer
  t.after(() => { globalThis.RTCPeerConnection = previous })

  const owner = transferId() + transferId(), key = transferId() + transferId()
  const relay = 'http://127.0.0.1:' + port
  const config = { owner, key, relay, room: digest(owner) }
  const online = Promise.withResolvers()
  t.after(hostSyncLink(config, message => Promise.resolve('echo ' + message), status => {
    if (status === 'online') online.resolve()
  }))
  await online.promise
  const follower = mobileSyncLink()
  t.after(follower.close)
  assert.deepEqual(await follower.exchange(config, 'fixture'), { message: 'echo fixture', via: 'relay' })
  for (let i = 0; i < 80 && !pcs[0]?.remoteDescription; i++) await delay(25)
  assert.equal(pcs[0]?.remoteDescription?.type, 'answer')
  assert.equal(pcs[1]?.remoteDescription?.type, 'offer')
  assert.equal(pcs[0].config.iceServers.length, 2)
  const fromFollower = pcs[0].emitCandidate(40000)
  const fromHost = pcs[1].emitCandidate(40001)
  for (let i = 0; i < 80 && pcs.some(pc => !pc.received.length); i++) await delay(25)
  assert.deepEqual(pcs[0].received, [fromHost])
  assert.deepEqual(pcs[1].received, [fromFollower])
})
