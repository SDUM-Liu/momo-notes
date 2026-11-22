const assert = require('node:assert/strict')
const { test } = require('node:test')
const { randomBytes, randomUUID } = require('node:crypto')
const { createHostSync } = require('../shared/host-sync.mjs')
const { seal, unseal } = require('../shared/sync.mjs')

test('only the registered follower can offer one live SSH session to its paired desktop', async () => {
  const config = {}
  const relay = 'https://relay.example', hex = () => randomBytes(32).toString('hex')
  const host = createHostSync({ config, defaults: { url: relay }, store: {}, persist() {}, notify() {} })
  host.setEnabled(true)
  const device = { id: randomUUID(), platform: 'Android', sshProof: hex() }
  const grant = { relay, room: hex(), key: hex(), user: 'phone' }
  async function request(op, payload) {
    const id = randomBytes(12).toString('hex')
    const wire = seal(config.key, 'request', { id, time: Date.now(), op, payload })
    return unseal(config.key, 'reply/' + id, await host.exchange(wire))
  }
  await request('state', device)
  assert.equal((await request('ssh-offer/set', { device: { ...device, sshProof: hex() }, grant })).ok, false)
  assert.equal((await request('ssh-offer/set', { device, grant: { ...grant, relay: 'https://unpaired.example' } })).ok, false)
  assert.equal((await request('ssh-offer/set', { device, grant })).ok, true)
  assert.equal(host.state().devices[0].sshRemoteReady, true)
  assert(!JSON.stringify(config).includes(grant.key))
  assert(!JSON.stringify(host.state()).includes(grant.key))
  assert.deepEqual(host.takeSSHOffer(device.id), grant)
  assert.throws(() => host.takeSSHOffer(device.id))
  await request('ssh-offer/set', { device, grant })
  await request('ssh-offer/end', { device, room: hex() })
  assert.equal(host.state().devices[0].sshRemoteReady, true)
  await request('ssh-offer/end', { device, room: grant.room })
  assert.throws(() => host.takeSSHOffer(device.id))
  await request('ssh-offer/set', { device, grant })
  host.setEnabled(false)
  host.setEnabled(true)
  assert.throws(() => host.takeSSHOffer(device.id))
})
