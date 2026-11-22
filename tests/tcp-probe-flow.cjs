const assert = require('node:assert/strict')
const { test } = require('node:test')
const { pairedTcpProbe, isPublicProbeEndpoint } = require('../shared/tcp-probe.mjs')

const device = { id: 'fixture-device' }
const own = '1.1.1.1:40006', peer = '8.8.8.8:40008'
const tick = () => new Promise(resolve => setImmediate(resolve))
function fixture() {
  const calls = [], localReady = Promise.withResolvers(), remoteReady = Promise.withResolvers()
  const controller = new AbortController()
  const local = {
    prepare(id) { calls.push(['localPrepare', id]); return localReady.promise },
    run(id, endpoint, token) { calls.push(['localRun', {id, endpoint, token}]); return {ok:true} },
    cancel(id) { calls.push(['localCancel', id]) },
  }
  const host = {
    state: () => ({locked:false}),
    'tcp-probe-prepare': () => remoteReady.promise,
    'tcp-probe-run': () => ({ok:true}),
    'tcp-probe-cancel': () => ({}),
  }
  const request = async (op, data) => { calls.push([op, data]); return host[op](data) }
  const start = () => pairedTcpProbe(local, request, device, controller.signal)
  function prepared() { localReady.resolve({endpoint:own}); remoteReady.resolve({endpoint:peer}) }
  return { calls, local, host, start, prepared, remoteReady, localReady, controller }
}

test('paired probe prepares both sockets before running with one fresh challenge, returning only a verdict', async () => {
  const used = new Set()
  for (let n = 0; n < 2; n++) {
    const f = fixture(), result = f.start()
    await tick()
    assert.deepEqual(f.calls.map(c => c[0]), ['state','localPrepare','tcp-probe-prepare'])
    f.prepared()
    assert.deepEqual(await result, {status:'direct'})
    const call = op => f.calls.find(c => c[0] === op)[1]
    assert.deepEqual(call('state'), device)
    const {id, token} = call('localRun')
    assert.match(id, /^[a-f0-9]{32}$/)
    assert.match(token, /^[a-f0-9]{64}$/)
    assert(!used.has(id) && !used.has(token)); used.add(id); used.add(token)
    assert.deepEqual(call('localRun'), {id, token, endpoint:peer})
    assert.deepEqual(call('tcp-probe-run'), {id, token, endpoint:own, device})
    assert.deepEqual(call('tcp-probe-prepare'), {id, device})
    assert.deepEqual(call('tcp-probe-cancel'), {id, device})
    assert.equal(call('localCancel'), id)
  }
})

test('private and reserved addresses never reach a dialer; simple peer failures and legacy hosts get distinct verdicts', async () => {
  for (const ip of ['127.0.0.1','10.1.2.3','172.31.4.2','192.168.1.2','169.254.1.1','100.127.255.255',
    '198.19.8.7','224.0.0.1','192.0.2.1','203.0.113.1','8.8.8.008','1.2.3.400','example.com']) {
    assert.equal(isPublicProbeEndpoint(ip+':40006'), false)
  }
  assert.equal(isPublicProbeEndpoint('8.8.8.8:80'), false)
  const invalid = fixture()
  invalid.localReady.resolve({endpoint:own}); invalid.remoteReady.resolve({endpoint:'192.168.1.1:5000'})
  assert.deepEqual(await invalid.start(), {status:'observer_unavailable'})
  assert(!invalid.calls.some(([op]) => op === 'localRun' || op === 'tcp-probe-run'))
  const old = fixture()
  old.host['tcp-probe-prepare'] = () => {throw new Error('同步锁已失效，请重试')}
  const legacyResult = old.start()
  assert.deepEqual(await legacyResult, {status:'unsupported'})
  old.localReady.resolve({endpoint:own}); await tick()
  assert(old.calls.filter(c=>c[0]==='localCancel').length >= 1)
  const unilateral = fixture()
  unilateral.host['tcp-probe-run'] = () => ({ok:false, reason:'no_authenticated_peer'})
  unilateral.prepared()
  assert.deepEqual(await unilateral.start(), {status:'failed'})
})

test('a disappearing pair or timed-out control channel releases a prepared socket without requiring cancel acknowledgement', async t => {
  const f = fixture()
  f.host['tcp-probe-cancel'] = () => new Promise(() => {})
  const first = f.start()
  await tick()
  f.controller.abort()
  assert.deepEqual(await first, {status:'cancelled'})
  f.prepared(); await tick()
  assert(!f.calls.some(([op])=>op==='localRun'))
  t.mock.timers.enable({apis:['setTimeout']})
  const slow = fixture()
  const result = slow.start()
  await tick()
  t.mock.timers.tick(30001)
  assert.deepEqual(await result, {status:'timeout'})
  assert(slow.calls.some(([op])=>op==='localCancel'))
  slow.prepared()
})

test('sync client uses its stored pairing, registers the device and authenticates every probe message', async t => {
  const { createServer } = await import('vite')
  const { seal, unseal, pairingCode } = require('../shared/sync.mjs')
  const server = await createServer({logLevel:'error', server:{middlewareMode:true}, appType:'custom'})
  t.after(() => server.close())
  const { mobileSync } = await server.ssrLoadModule('/src/sync-client.js')
  const key = '1'.repeat(64), room = '2'.repeat(64), origin = 'https://relay.invalid'
  const pairing = pairingCode(origin, room, key)
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage'), saved = new Map()
  Object.defineProperty(globalThis, 'localStorage', {configurable:true, value:{
    getItem:k=>saved.get(k), setItem:(k,v)=>saved.set(k,v),
  }})
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, 'localStorage', previous)
    else delete globalThis.localStorage
  })
  const wireRequests = []
  const sync = mobileSync({
    loadCode:async()=>pairing, saveCode:async()=>{}, activate:async()=>{}, change(){},
    exchange:async(connection, wire)=>{
      assert.equal(connection.key, key)
      const {id,op,payload} = unseal(key, 'request', wire)
      wireRequests.push({op,payload})
      const value = op === 'tcp-probe-prepare' ? {endpoint:peer} : {ok:true}
      return {via:'relay', message:seal(key,'reply/'+id,{ok:true,value})}
    },
  })
  const f = fixture()
  assert.deepEqual(await sync.testTcpProbe(f.local), {status:'unpaired'})
  await sync.init()
  assert.deepEqual(await sync.testTcpProbe(f.local, pairingCode(origin, room, '3'.repeat(64))), {status:'unpaired'})
  const result = sync.testTcpProbe(f.local, pairing)
  await tick()
  assert.deepEqual(await sync.testTcpProbe(f.local), {status:'busy'})
  f.localReady.resolve({endpoint:own})
  assert.deepEqual(await result, {status:'direct'})
  assert.deepEqual(wireRequests.map(r=>r.op), ['state','tcp-probe-prepare','tcp-probe-run','tcp-probe-cancel'])
  const registered = wireRequests[0].payload
  assert.match(registered.id, /^[a-f0-9-]{36}$/)
  for (const {payload} of wireRequests.slice(1)) assert.deepEqual(payload.device, registered)
  assert.equal(sync.state().via, 'relay')
  const second = fixture(), unfinished = sync.testTcpProbe(second.local)
  await tick(); await sync.unpair()
  assert.deepEqual(await unfinished, {status:'cancelled'})
  second.prepared()
  await tick()
  assert.equal(sync.state().via, undefined)
})
