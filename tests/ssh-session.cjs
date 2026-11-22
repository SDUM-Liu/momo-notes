const assert = require('node:assert/strict')
const net = require('node:net')
const path = require('node:path')
const { spawn } = require('node:child_process')
const { once } = require('node:events')
const { test } = require('node:test')
const { offerSSHRelay, joinSSHRelay } = require('../shared/ssh-session.mjs')
const { relayProtocol, joinToken, seal } = require('../shared/sync.mjs')

async function localRelay(t) {
  const reserve = net.createServer()
  reserve.listen(0, '127.0.0.1')
  await once(reserve, 'listening')
  const { port } = reserve.address()
  await new Promise(resolve => reserve.close(resolve))
  const server = spawn(process.execPath, [path.join(__dirname, '../relay/server.mjs')], {
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1' }, stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true,
  })
  t.after(() => server.kill())
  await Promise.race([once(server.stdout, 'data'), once(server, 'exit').then(() => { throw Error('relay exited') })])
  return 'http://127.0.0.1:' + port
}

function localPipe(write = async () => {}) {
  const queue = []
  let waiting
  const pipe = {
    count: 0, received: [], closed: false,
    async read() {
      if (pipe.closed) return null
      if (queue.length) return queue.shift()
      return new Promise(resolve => { waiting = resolve })
    },
    async write(bytes) {
      await write()
      pipe.received.push(Buffer.from(bytes))
      pipe.count += bytes.length
    },
    push(data) {
      if (waiting) { waiting(data); waiting = null }
      else queue.push(data)
    },
    close() { pipe.closed = true; if (waiting) waiting(null) },
  }
  return pipe
}

async function until(condition) {
  for (let count = 0; count < 300; count++) {
    if (condition()) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw Error('expected SSH state was not reached')
}

test('isolated relay connects once, transfers ordered encrypted traffic in both directions and closes both pipes', { timeout: 10000 }, async t => {
  const relay = await localRelay(t)
  const nativeSocket = WebSocket, frames = []
  globalThis.WebSocket = class extends nativeSocket {
    send(data) { if (data !== 'ping') frames.push(data); return super.send(data) }
  }
  t.after(() => { globalThis.WebSocket = nativeSocket })
  let opened = 0, releaseTerminal, ready = 0
  const phone = localPipe(), terminal = localPipe()
  const offer = await offerSSHRelay({ relay, openPipe() { opened++; return phone }, onConnected: () => ready++ })
  t.after(offer.close)
  assert.equal(opened, 0)
  const session = await joinSSHRelay({ grant: offer.grant,
    openPipe: () => new Promise(resolve => { releaseTerminal = () => resolve(terminal) }), onConnected: () => ready++ })
  t.after(session.close)
  assert.equal(ready, 0)
  assert.equal(opened, 1)
  await assert.rejects(joinSSHRelay({ grant: offer.grant, openPipe: () => assert.fail('cannot reuse an offer') }), /已使用/)
  releaseTerminal()
  await until(() => ready === 2)
  const greeting = Buffer.from('SSH-2.0-momo-test-only\r\n')
  const payload = Buffer.from(Array.from({ length: 65536 }, (_, index) => index % 251))
  phone.push(greeting)
  for (let repeat = 0; repeat < 4; repeat++) terminal.push(payload)
  await until(() => phone.count === payload.length * 4 && terminal.count === greeting.length)
  assert.deepEqual(Buffer.concat(terminal.received), greeting)
  assert.deepEqual(Buffer.concat(phone.received), Buffer.concat(Array(4).fill(payload)))
  for (const frame of frames) {
    assert.match(JSON.parse(frame).packet, /^[a-f0-9]{24}\.[A-Za-z0-9+/=]+$/)
    assert(!frame.includes(greeting.toString('base64')))
  }
  phone.push(null)
  await until(() => terminal.closed && phone.closed)
  await assert.rejects(joinSSHRelay({ grant: offer.grant, openPipe: () => assert.fail() }))
})

test('a repeated authenticated sequence ends the one-time session', { timeout: 8000 }, async t => {
  const relay = await localRelay(t)
  const phone = localPipe()
  const offer = await offerSSHRelay({ relay, openPipe: () => phone })
  t.after(offer.close)
  const grant = offer.grant
  const client = new WebSocket(relay.replace('http:', 'ws:') + '/v1/' + grant.room, [relayProtocol, 'join.' + joinToken(grant.key)])
  t.after(() => client.close())
  const received = []
  client.onmessage = ({ data }) => { if (data !== 'pong') received.push(JSON.parse(data)) }
  await until(() => received.some(message => message.kind === 'ready'))
  const peer = received[0].peer
  const packet = seal(grant.key, 'manual-ssh/v1/' + grant.room + '/' + peer + '/terminal', { seq: 0, kind: 'hello' })
  const hello = JSON.stringify({ kind: 'data', peer, packet })
  client.send(hello)
  await until(() => received.some(message => message.kind === 'data'))
  client.send(hello)
  await until(() => phone.closed)
  assert.equal(phone.count, 0)
})
test('relay waits for the receiver before reading more than four chunks', { timeout: 8000 }, async t => {
  const relay = await localRelay(t)
  let allowWrite, reads = 0
  const blocked = new Promise(resolve => { allowWrite = resolve })
  const phone = localPipe(() => blocked)
  const terminal = localPipe()
  const read = terminal.read
  terminal.read = async () => { const data = await read(); if (data) reads++; return data }
  const offer = await offerSSHRelay({ relay, openPipe: () => phone })
  t.after(offer.close)
  const session = await joinSSHRelay({ grant: offer.grant, openPipe: () => terminal })
  t.after(session.close)
  for (let i = 0; i < 16; i++) terminal.push(Buffer.alloc(16384, i))
  await until(() => reads >= 4)
  assert.equal(reads, 4)
  assert.equal(phone.count, 0)
  allowWrite()
  await until(() => phone.count === 16 * 16384)
  assert.equal(reads, 16)
})

test('abort cancels pending registration, pending authorization and an active invitation', { timeout: 8000 }, async t => {
  const relay = await localRelay(t)
  const noPipe = () => assert.fail('cancelled session cannot open a pipe')
  const registration = new AbortController()
  const pending = offerSSHRelay({ relay, openPipe: noPipe, signal: registration.signal })
  registration.abort()
  await assert.rejects(pending, { name: 'AbortError' })

  const accepting = new AbortController()
  const offering = await offerSSHRelay({ relay, openPipe: noPipe, signal: accepting.signal })
  t.after(offering.close)
  const nativeSocket = WebSocket
  let sentHello = false
  globalThis.WebSocket = class extends nativeSocket {
    send(message) {
      if (message === 'ping') return super.send(message)
      // Hold the authorization request in transit until the terminal is cancelled.
      sentHello = true
    }
  }
  t.after(() => { globalThis.WebSocket = nativeSocket })
  const dialing = new AbortController()
  const terminal = joinSSHRelay({ grant: offering.grant, openPipe: noPipe, signal: dialing.signal })
  await until(() => sentHello)
  dialing.abort()
  await assert.rejects(terminal, { name: 'AbortError' })
  accepting.abort()

  globalThis.WebSocket = nativeSocket
  await assert.rejects(joinSSHRelay({ grant: offering.grant, openPipe: noPipe }))
  await assert.rejects(offerSSHRelay({ relay, openPipe: noPipe, signal: accepting.signal }), { name: 'AbortError' })
})
