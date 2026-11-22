const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { test } = require('node:test')
const { normalizeProfile, deviceProfiles, sshArguments, windowsSessionScript } = require('../desktop/ssh.cjs')

test('interactive connection asks for a host key and preserves address, login user and port as distinct arguments', () => {
  const profile = normalizeProfile({ host: '[2001:db8::1]', user: 'u0_a12', port: '8022' })
  assert.deepEqual(profile, { host: '2001:db8::1', user: 'u0_a12', port: 8022 })
  const options = sshArguments(profile, 'terminal')
  assert(options.includes('StrictHostKeyChecking=ask'))
  assert.deepEqual(options.slice(-7), ['-F', 'none', '-p', '8022', '-l', 'u0_a12', '2001:db8::1'])
  assert(!options.includes('BatchMode=yes'))
  const readonly = sshArguments(profile, 'hostname')
  assert(readonly.includes('StrictHostKeyChecking=yes'))
  assert(readonly.includes('BatchMode=yes'))
  assert(readonly.includes('ClearAllForwardings=yes'))
  assert.equal(readonly.at(-1), 'hostname')
  const alias = sshArguments({ alias: 'redmi' }, 'known-terminal')
  assert.equal(alias.at(-1), 'redmi')
  assert(alias.includes('StrictHostKeyChecking=yes'))
  assert(!alias.includes('-F'))
  assert.equal(normalizeProfile({ host: 'notes.local', user: 'wei' }).port, 22)
})

test('invalid or ambiguous targets are rejected before the terminal is launched', () => {
  for (const alias of ['-V', 'redmi;calc', 'a$(id)', 'a\nid', 'a b']) assert.throws(() => normalizeProfile({ alias }))
  const target = { host: 'example.test', user: 'wei', port: 22 }
  for (const override of [{ alias: 'redmi' }, { host: '-option' }, { host: 'ssh://example.test' },
    { host: 'server;echo hi' }, { host: 'user@host' }, { user: 'a b' }, { user: '$(id)' }, { user: '-option' },
    { port: 0 }, { port: 65536 }, { port: '-v' }]) assert.throws(() => normalizeProfile({ ...target, ...override }))
})

test('Windows SSH terminal retains native errors and exits normally after success', {
  skip: process.platform !== 'win32' || spawnSync('ssh', ['-V'], { windowsHide: true }).status !== 0,
}, () => {
  const encoded = Buffer.from(windowsSessionScript, 'utf16le').toString('base64')
  function runSession(args) {
    const result = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-OutputFormat', 'Text', '-EncodedCommand', encoded], {
      env: { ...process.env, MOMO_SSH_ARGUMENTS: JSON.stringify(args) },
      encoding: 'utf8', windowsHide: true, timeout: 12000, input: '\r\n',
    })
    assert.ifError(result.error)
    return { status: result.status, output: result.stdout + result.stderr }
  }
  const success = runSession(['-V'])
  assert.equal(success.status, 0)
  assert.match(success.output, /OpenSSH/i)
  assert.doesNotMatch(success.output, /Enter/)
  const failure = runSession(['-Z'])
  assert.notEqual(failure.status, 0)
  assert.match(failure.output, /usage: ssh/i)
  assert.match(failure.output, /Enter/)
})

test('saved endpoints survive restart, migrate old authorized aliases and revoke permission when the target changes', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'momo-ssh-'))
  try {
    const id = 'a6eb788c-f50e-4c34-8a40-ed5bfba97dcd'
    const filename = path.join(directory, 'ssh-devices.json')
    fs.writeFileSync(filename, JSON.stringify({ [id]: 'old-host' }))
    const store = deviceProfiles(directory)
    assert.deepEqual(store.get(id), { profile: { alias: 'old-host' }, permitted: true })
    store.save(id, { alias: 'old-host' })
    assert.equal(store.get(id).permitted, true)
    const target = { host: '192.0.2.1', user: 'wei', port: 22 }
    store.save(id, { ...target, password: 'never-store-this' })
    assert.deepEqual(deviceProfiles(directory).get(id), { profile: target, permitted: false })
    assert(!fs.readFileSync(filename, 'utf8').includes('never-store-this'))
    store.permit(id, true)
    store.save(id, target)
    assert(store.get(id).permitted)
    store.save(id, { ...target, port: 8022 })
    assert.equal(store.get(id).permitted, false)
    assert.throws(() => store.permit('other-device', true))
    assert.throws(() => store.permit(id, 'true'))
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})
