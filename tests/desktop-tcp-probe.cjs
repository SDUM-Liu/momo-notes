const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { PassThrough } = require('node:stream')
const childProcess = require('node:child_process')

function mockHelper(t) {
  const children = []
  t.mock.method(childProcess, 'spawn', () => {
    const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough() })
    child.kill = () => { child.killed = true; child.stdout.end() }
    children.push(child)
    return child
  })
  // Bind the spawn replacement only in this isolated test process.
  const modulePath = require.resolve('../desktop/tcp-probe.cjs')
  delete require.cache[modulePath]
  const probe = require(modulePath).createTcpProbe()
  t.after(() => probe.close())
  return { probe, children }
}

const mapped = { event: 'mapped', endpoint: '8.8.8.8:50123' }
const line = obj => JSON.stringify(obj) + '\n'

test('one child per attempt, terminal proof required, failed child cannot affect next session', async t => {
  const { probe, children } = mockHelper(t)
  const ready = probe.prepare('one')
  assert.equal(probe.prepare('one'), ready)
  await assert.rejects(probe.prepare('two'), { code: 'busy' })
  children[0].stdout.write(line(mapped))
  assert.deepEqual(await ready, { endpoint: mapped.endpoint })
  const endpoint = '1.1.1.1:44001', token = 'ab'.repeat(32)
  const result = probe.run('one', endpoint, token)
  assert.deepEqual(JSON.parse(children[0].stdin.read().toString()), { endpoint, token })
  children[0].stdout.write(line({ event: 'result', ok: true }))
  assert.deepEqual(await result, { ok: true })
  assert.ok(children[0].killed)
  const next = probe.prepare('two')
  children[0].emit('close', 0)
  children[1].stdout.write(line({ event: 'result', ok: false, stage: 'stun', reason: 'dns_failure' }))
  await assert.rejects(next, { code: 'observer_unavailable' })
})

test('cancel before mapping and reject private peer without writing to child', async t => {
  const { probe, children } = mockHelper(t)
  const abandoned = probe.prepare('one')
  probe.cancel('one')
  await assert.rejects(abandoned, { code: 'cancelled' })
  const ready = probe.prepare('two')
  children[1].stdout.write(line(mapped))
  await ready
  assert.deepEqual(await probe.run('two', '127.0.0.1:1234', 'ab'.repeat(32)), { ok: false, reason: 'invalid_peer' })
  assert.equal(children[1].stdin.read(), null)
  assert.ok(children[1].killed)
})
