const assert = require('node:assert/strict')
const { test } = require('node:test')
const net = require('node:net')
const { once } = require('node:events')
const { createLocalSSHPipes, createRemoteSSHHost } = require('../desktop/ssh-remote.cjs')
const { remoteSSHArguments } = require('../desktop/ssh.cjs')

const device = 'f8d91ff1-4d3a-428a-8b1b-da642fd3691e'

async function loopback(t) {
  const server = net.createServer()
  server.listen({ host: '127.0.0.1', port: 0 })
  await once(server, 'listening')
  t.after(() => { server.close() })
  return server
}

test('paired follower verifies a fragmented SSH banner and retains following protocol bytes', async t => {
  let paired = true
  const local = createLocalSSHPipes({ isPaired: () => paired })
  t.after(local.stop)
  const server = await loopback(t)
  const port = server.address().port
  const arrived = once(server, 'connection')
  const opening = local.open({ port })
  const [service] = await arrived
  t.after(() => service.destroy())
  await assert.rejects(local.open({ port }), /已有 SSH/)
  await assert.rejects(local.write({ id: device, data: 'YWJj' }), /已结束/)
  service.write('SS')
  setImmediate(() => service.write(Buffer.from('H-2.0-momo_fixture\r\n\x00\x03', 'latin1')))
  const { id } = await opening
  const prefix = await local.read({ id })
  assert.deepEqual(Buffer.from(prefix.data, 'base64'), Buffer.from('SSH-2.0-momo_fixture\r\n\x00\x03', 'latin1'))
  const request = once(service, 'data')
  await local.write({ id, data: Buffer.from('SSH-2.0-client\r\n').toString('base64') })
  assert.equal((await request)[0].toString(), 'SSH-2.0-client\r\n')
  await assert.rejects(local.write({ id, data: 'not base64' }), /数据无效/)
  await assert.rejects(local.write({ id, data: 'A'.repeat(100000) }), /长度无效/)
  const closed = once(service, 'close')
  paired = false
  await assert.rejects(local.read({ id }), /配对/)
  await closed
  await assert.rejects(local.open({ port }), /配对/)
})

test('follower refuses non-SSH services before any client bytes are written and can retry', async t => {
  const local = createLocalSSHPipes({ isPaired: () => true })
  t.after(local.stop)
  const server = await loopback(t)
  const port = server.address().port
  await assert.rejects(local.open({ port: 0 }), /端口/)
  for (const banner of ['HTTP/1.1 200 OK\r\n', 'SSH-2.0-' + 'X'.repeat(256) + '\n']) {
    const arrived = once(server, 'connection')
    const opening = local.open({ port })
    const [service] = await arrived
    const closed = once(service, 'close')
    let received = 0
    service.on('data', data => { received += data.length })
    service.write(banner)
    await assert.rejects(opening, /SSH 服务标识/)
    await closed
    assert.equal(received, 0)
  }
})

test('remote terminal uses a stable per-device fingerprint and exactly one loopback connection', async t => {
  const user = 'test_user'
  const grant = { user }
  let sessionPipe, terminal, closed = false, hostPort
  const remote = createRemoteSSHHost({
    takeOffer: id => { assert.equal(id, device); return grant },
    async join({ grant: actual, openPipe, onConnected }) {
      assert.equal(actual, grant)
      void openPipe().then(pipe => { sessionPipe = pipe; onConnected() })
      return { close() { closed = true } }
    },
    async launch(id, login, port) {
      assert.equal(login, user)
      assert.equal(id, device)
      hostPort = port
      terminal = net.createConnection({ host: '127.0.0.1', port })
      await once(terminal, 'connect')
    },
  })
  t.after(() => { remote.stop(); terminal?.destroy() })
  assert.equal(await remote.open(device), true)
  const args = remoteSSHArguments(device, user, hostPort)
  assert(args.includes('HostKeyAlias=momo-device-' + device))
  assert(remoteSSHArguments(device, user, 22).includes('HostKeyAlias=momo-device-' + device))
  assert(args.includes('StrictHostKeyChecking=ask') && args.includes('ClearAllForwardings=yes'))
  assert.deepEqual(args.slice(-5), ['-p', String(hostPort), '-l', user, '127.0.0.1'])
  assert.throws(() => remoteSSHArguments('other;arg', user, 22))
  assert.throws(() => remoteSSHArguments(device, '-bad', 22))
  const second = net.createConnection({ host: '127.0.0.1', port: hostPort })
  await assert.rejects(once(second, 'connect'), { code: 'ECONNREFUSED' })
  terminal.write('SSH-2.0-client\r\n')
  assert.equal((await sessionPipe.read()).toString(), 'SSH-2.0-client\r\n')
  const incoming = once(terminal, 'data')
  await sessionPipe.write(Buffer.from('SSH-2.0-server\r\n'))
  assert.equal((await incoming)[0].toString(), 'SSH-2.0-server\r\n')
  await assert.rejects(remote.open(device), /当前异地 SSH/)
  const terminalClosed = once(terminal, 'close')
  remote.stop()
  await terminalClosed
  assert(closed)
})

test('relay error is reported while starting and changing roles cancels a pending session', async () => {
  const entered = Promise.withResolvers()
  let tries = 0
  const remote = createRemoteSSHHost({
    takeOffer: () => ({ user: 'test' }),
    async join({ onClose, signal }) {
      if (!tries++) {
        onClose(new Error('对端 SSH 服务不可用'))
        return { close() {} }
      }
      entered.resolve()
      await once(signal, 'abort')
      throw signal.reason
    },
    launch() { throw new Error('terminal must not start') },
  })
  await assert.rejects(remote.open(device), /对端 SSH 服务不可用/)
  const pending = remote.open(device)
  await entered.promise
  remote.stop()
  await assert.rejects(pending, /已结束/)
})
