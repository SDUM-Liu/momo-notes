import { transferId } from './sync.mjs'

// Only a public mapped TCP endpoint supplied by the paired device can be tested.
export function isPublicProbeEndpoint(value) {
  if (typeof value !== 'string' || value.length > 21) return false
  const parts = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3}):(\d{1,5})$/.exec(value)
  if (!parts || parts.slice(1).some(part => String(Number(part)) !== part)) return false
  const [a,b,c,d,port] = parts.slice(1).map(Number)
  if ([a,b,c,d].some(octet => octet > 255) || port < 1024 || port > 65535) return false
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false
  if (a === 100 && b >= 64 && b <= 127 || a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31) return false
  if (a === 192 && (b === 168 || b === 0 && (c === 0 || c === 2) || b === 88 && c === 99)) return false
  return !(a === 198 && (b === 18 || b === 19 || b === 51 && c === 100) || a === 203 && b === 0 && c === 113)
}

export const isUdpEndpoints = value => Array.isArray(value) && value.length >= 1 && value.length <= 4 && value.every(isPublicProbeEndpoint)

function predictable(values) {
  if (values.length < 3) return false
  const [[ipA,a],[ipB,b],[ipC,c]] = values.slice(-3).map(value => value.split(':'))
  const step = Number(c) - Number(b)
  const next = Number(c) + step
  return ipA === ipC && ipB === ipC && step !== 0 && Math.abs(step) <= 16 &&
    step === Number(b) - Number(a) && next >= 1024 && next <= 65535
}

const reasons = new Map([
  ['observer_unavailable', 'observer_unavailable'], ['invalid_mapping', 'observer_unavailable'],
  ['helper_unavailable', 'unavailable'], ['unsupported', 'unsupported'], ['UNIMPLEMENTED', 'unsupported'],
  ['expired', 'timeout'], ['timeout', 'timeout'], ['busy', 'busy'], ['cancelled', 'cancelled'],
  ['no_authenticated_peer', 'failed'], ['peer_handshake_failed', 'failed'], ['failed', 'failed'],
])
function statusFor(error) {
  const reason = error?.reason ?? error?.code
  if (reasons.has(reason)) return reasons.get(reason)
  // Some Electron releases strip custom error codes from IPC exceptions.
  const message = typeof error?.message === 'string' ? error.message : ''
  if (/无法通过公网观测服务器获取 TCP 映射|公网观测服务器未返回可用的 IPv4 映射/.test(message)) return 'observer_unavailable'
  if (message.includes('已有直连测试正在进行')) return 'busy'
  if (message.includes('直连测试已取消')) return 'cancelled'
  if (message.includes('直连测试已过期')) return 'timeout'
  // Old hosts dispatch unknown operations to their sync-lock handler.
  if (/未知的同步请求|同步锁已失效|is not implemented|not implemented on/i.test(message)) return 'unsupported'
  return 'unavailable'
}

function fail(status) { throw { reason: status } }

// Cancel the UI wait independently of an outstanding sync exchange (transport deadline: 65 s).
function bounded(promise, signal, ms) {
  let timer, aborted
  return new Promise((resolve, reject) => {
    aborted = () => reject({ reason: signal.reason === 'unavailable' ? 'unavailable' : 'cancelled' })
    timer = setTimeout(() => reject({ reason: 'timeout' }), ms)
    signal.addEventListener('abort', aborted, { once: true })
    if (signal.aborted) aborted()
    Promise.resolve(promise).then(resolve, reject)
  }).finally(() => {
    clearTimeout(timer)
    signal.removeEventListener('abort', aborted)
  })
}

export async function pairedTcpProbe(local, request, device, signal, transport = "tcp") {
  if (!local?.prepare || !local.run || !local.cancel) return { status: 'unsupported' }
  const id = transferId()
  const valid = transport === 'tcp' ? isPublicProbeEndpoint : isUdpEndpoints
  const remote = (op, data = {}) => request(transport + '-probe-' + op, { id, device, ...data })
  const cleanup = fn => { void Promise.resolve().then(fn).catch(() => {}) }
  let preparing = false, finished = false, prediction
  async function endpoint(prepare, cancel) {
    const result = await prepare()
    if (finished || signal.aborted) { cleanup(cancel); fail('cancelled') }
    if (result?.ok === false) throw result
    if (!valid(result?.endpoint)) fail('observer_unavailable')
    return result.endpoint
  }
  async function run(start) {
    const result = await start()
    if (result?.ok === true) return
    if (result?.ok === false) throw { reason: result.reason || 'failed' }
    fail('unavailable')
  }
  try {
    if (signal.aborted) fail('cancelled')
    await bounded(request('state', device), signal, 15000)
    if (signal.aborted) fail('cancelled')
    preparing = true
    const [own, peer] = await bounded(Promise.all([
      endpoint(() => local.prepare(id), () => local.cancel(id)),
      endpoint(() => remote('prepare'), () => remote('cancel')),
    ]), signal, 30000)
    if (signal.aborted) fail('cancelled')
    if (transport === 'udp-predict') prediction = { local: predictable(own), primary: predictable(peer) }
    const token = transferId() + transferId()
    await bounded(Promise.all([
      run(() => local.run(id, peer, token)),
      run(() => remote('run', { endpoint: own, token })),
    ]), signal, 45000)
    return { status: 'direct', ...(prediction && { prediction }) }
  } catch (failure) {
    return { status: statusFor(failure), ...(prediction && { prediction }) }
  } finally {
    finished = true
    if (preparing) {
      cleanup(() => local.cancel(id))
      cleanup(() => remote('cancel'))
    }
  }
}
