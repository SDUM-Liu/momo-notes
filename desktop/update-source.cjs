const { session } = require('electron')
const { validateProxyPort } = require('../shared/ai.mjs')
const { createUpdateSource, updateBlockSize } = require('../shared/update-transfer.mjs')

const retryableStatus = new Set([408, 502, 503, 504])
const retryableNetworkError = /ERR_(?:CONNECTION_|PROXY_|TUNNEL_|NETWORK_|INTERNET_|NAME_NOT_RESOLVED|TIMED_OUT|EMPTY_RESPONSE)/

function desktopUpdateSource(getProxyPort, sessions = session) {
  const retryAfter = new Map()
  let proxySession, configured, configuring = Promise.resolve(), direct

  async function networkFor(route, port) {
    if (route === 'system') return sessions.defaultSession
    if (route === 'direct') {
      if (!direct) {
        const network = sessions.fromPartition('momo-update-direct', { cache: false })
        direct = network.setProxy({ mode: 'direct' }).then(() => network).catch(error => {
          direct = undefined
          throw error
        })
      }
      return direct
    }
    proxySession ??= sessions.fromPartition('momo-update-proxy', { cache: false })
    configuring = configuring.catch(() => {}).then(async () => {
      if (configured === port) return
      await proxySession.setProxy({ mode: 'fixed_servers', proxyRules: 'http://127.0.0.1:' + port })
      await proxySession.closeAllConnections()
      configured = port
    })
    await configuring
    return proxySession
  }

  async function read(network, url, range) {
    const response = await network.fetch(url, {
      headers: range ? { Range: range, 'Accept-Encoding': 'identity' } : { Accept: 'application/vnd.github+json, text/plain' },
      signal: AbortSignal.timeout(range ? 12500 : 9000), credentials: 'omit',
    })
    if (response.status !== (range ? 206 : 200) || !response.body) {
      await response.body?.cancel().catch(() => {})
      return { status: response.status }
    }
    let total = 0
    const chunks = []
    for await (const chunk of response.body) {
      total += chunk.length
      if (total > (range ? updateBlockSize : 1024 * 1024)) throw new Error('主设备收到的更新数据超出限制')
      chunks.push(chunk)
    }
    return { status: response.status, range: response.headers.get('content-range'),
      data: Buffer.concat(chunks).toString(range ? 'base64' : 'utf8') }
  }

  return createUpdateSource(async (url, range) => {
    const port = getProxyPort()
    validateProxyPort(port)
    const routes = port ? ['proxy', 'system', 'direct'] : ['system', 'direct']
    const key = route => route === 'proxy' ? 'proxy:' + port : route
    // Keep a recently failed route behind the available ones during an installer transfer.
    const cooling = route => (retryAfter.get(key(route)) ?? 0) > Date.now()
    routes.sort((a, b) => Number(cooling(a)) - Number(cooling(b)))
    for (const route of routes) {
      const network = await networkFor(route, port)
      try {
        const result = await read(network, url, range)
        if (!retryableStatus.has(result.status)) {
          retryAfter.delete(key(route))
          return result
        }
      } catch (error) {
        if (error.name !== 'TimeoutError' && error.name !== 'AbortError' &&
            !retryableNetworkError.test(error.message)) throw error
      }
      retryAfter.set(key(route), Date.now() + 60000)
    }
    throw new Error('主设备连接 GitHub 失败，请检查主设备网络或代理后重试。')
  })
}

module.exports = { desktopUpdateSource }
