const { spawn } = require('node:child_process')
const { createInterface } = require('node:readline')
const path = require('node:path')
const { isPublicProbeEndpoint, isUdpEndpoints } = require('../shared/tcp-probe.mjs')

function executable() {
  const name = process.platform === 'win32' ? 'momo-tcp-probe.exe' : 'momo-tcp-probe'
  const directory = require('electron').app?.isPackaged
    ? process.resourcesPath
    : path.join(__dirname, '../build/tcp-probe')
  return path.join(directory, name)
}

const messages = {
  invalid_id: '直连测试编号无效',
  busy: '已有直连测试正在进行',
  observer_unavailable: '无法通过公网观测服务器获取 TCP 映射',
  invalid_mapping: '公网观测服务器未返回可用的 IPv4 映射',
  helper_unavailable: '无法运行桌面 TCP 直连测试程序',
  expired: '直连测试已过期',
  cancelled: '直连测试已取消',
}

function probeError(code) {
  return Object.assign(new Error(messages[code] || 'TCP 直连测试失败'), { code })
}

function createTcpProbe(transport = "tcp") {
  const udp = transport === "udp"
  const valid = udp ? isUdpEndpoints : isPublicProbeEndpoint
  let active
  function finish(session, result) {
    if (active !== session) return
    active = undefined
    clearTimeout(session.timer)
    if (session.phase === 'preparing') session.ready.reject(probeError(result.reason))
    session.done.resolve(result)
    session.child.kill()
  }
  function expire(session, ms, reason) {
    clearTimeout(session.timer)
    session.timer = setTimeout(() => finish(session, { ok: false, reason }), ms)
  }
  function prepare(id) {
    if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(id)) return Promise.reject(probeError('invalid_id'))
    if (active?.id === id) return active.ready.promise
    if (active) return Promise.reject(probeError('busy'))
    const child = spawn(executable(), udp ? ['--udp'] : [], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true })
    const session = { id, child, phase: 'preparing', ready: Promise.withResolvers(), done: Promise.withResolvers() }
    active = session
    const fail = reason => finish(session, { ok: false, reason })
    expire(session, 18000, 'observer_unavailable')
    // close follows stdout EOF, so the final result line is processed before cleanup.
    child.once('error', () => fail('helper_unavailable'))
    child.once('close', () => fail('helper_unavailable'))
    child.stdin.on('error', () => fail('helper_unavailable'))
    const lines = createInterface({ input: child.stdout })
    lines.on('line', line => {
      if (active !== session) return
      let message
      try { message = JSON.parse(line) } catch { return fail('helper_unavailable') }
      if (message?.event === 'mapped' && session.phase === 'preparing' && valid(udp ? message.endpoints : message.endpoint)) {
        session.phase = 'prepared'
        session.ready.resolve({ endpoint: udp ? message.endpoints : message.endpoint })
        expire(session, 50000, 'expired')
      } else if (message?.event === 'result' && session.phase === 'running' && message.ok === true) {
        finish(session, { ok: true })
      } else if (message?.event === 'result' && message.ok === false) {
        if (session.phase === 'preparing') return fail(message.reason === 'invalid_mapping' ? 'invalid_mapping' : 'observer_unavailable')
        const allowed = ['invalid_peer', 'invalid_token', 'no_authenticated_peer', 'peer_handshake_failed']
        fail(allowed.includes(message.reason) ? message.reason : 'helper_unavailable')
      } else {
        fail('helper_unavailable')
      }
    })
    return session.ready.promise
  }
  async function run(id, endpoint, token) {
    const session = active
    if (!session || session.id !== id) return { ok: false, reason: 'expired' }
    if (session.phase === 'running') {
      if (session.endpoint !== endpoint || session.token !== token) return { ok: false, reason: 'busy' }
      return session.done.promise
    }
    if (session.phase !== 'prepared') return { ok: false, reason: 'not_prepared' }
    if (!valid(endpoint)) {
      finish(session, { ok: false, reason: 'invalid_peer' })
    } else if (typeof token !== 'string' || !/^[0-9a-f]{64}$/i.test(token)) {
      finish(session, { ok: false, reason: 'invalid_token' })
    } else {
      session.phase = 'running'
      session.endpoint = endpoint
      session.token = token
      expire(session, 26000, 'expired')
      session.child.stdin.end(JSON.stringify(udp ? { endpoints: endpoint, token } : { endpoint, token }) + '\n')
    }
    return session.done.promise
  }
  function cancel(id) {
    if (active && active.id === id) finish(active, { ok: false, reason: 'cancelled' })
  }
  return { prepare, run, cancel, close() { if (active) cancel(active.id) } }
}

module.exports = { createTcpProbe }
