const { session } = require('electron')
const { validateProxyPort } = require('../shared/ai.mjs')
const { createUpdateSource, updateBlockSize } = require('../shared/update-transfer.mjs')

function desktopUpdateSource(getProxyPort) {
  let proxySession, configuring = Promise.resolve(), configured
  return createUpdateSource(async (url, range) => {
    const port = getProxyPort()
    let network = session.defaultSession
    if (port) {
      validateProxyPort(port)
      proxySession ??= session.fromPartition('momo-update-proxy')
      network = proxySession
      configuring = configuring.catch(() => {}).then(async () => {
        if (configured === port) return
        await network.setProxy({ mode: 'fixed_servers', proxyRules: 'http://127.0.0.1:' + port })
        await network.closeAllConnections()
        configured = port
      })
      await configuring
    }
    const response = await network.fetch(url, {
      headers: range ? { Range: range, 'Accept-Encoding': 'identity' } : { Accept: 'application/vnd.github+json, text/plain' },
      signal: AbortSignal.timeout(45000), credentials: 'omit',
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
  })
}

module.exports = { desktopUpdateSource }
