const { session, safeStorage } = require('electron')
const { endpoint, modelPayload, modelAnswer } = require('../shared/ai.mjs')

async function answer(data, request) {
  const settings = data.settings
  const payload = modelPayload(data, request)
  const key = settings.key ? safeStorage.decryptString(Buffer.from(settings.key, 'base64')) : ''
  const api = session.fromPartition('momo-ai')
  const proxy = settings.proxyPort
  await api.setProxy(proxy
    ? { mode: 'fixed_servers', proxyRules: 'http://127.0.0.1:' + proxy, proxyBypassRules: '<-loopback>' }
    : { mode: 'direct' })
  await api.closeAllConnections()
  let response
  try {
    response = await api.fetch(endpoint(settings.baseUrl), {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(45000),
      headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: 'Bearer ' + key } : {}) },
      body: JSON.stringify(payload),
    })
  } catch (error) {
    throw new Error(error.name === 'TimeoutError' ? 'AI 请求超时，请稍后再试' : '连不上 AI API，请检查地址与代理设置')
  }
  if (!response.ok) throw new Error('AI API 返回 HTTP ' + response.status + '，请检查 API 设置')
  return modelAnswer(await response.json())
}

module.exports = { answer, endpoint }
