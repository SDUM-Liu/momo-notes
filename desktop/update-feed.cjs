const { createServer } = require('node:http')
const { randomUUID } = require('node:crypto')
const { Readable } = require('node:stream')
const { pipeline } = require('node:stream/promises')
const { verifyUpdate, updateBlockSize, receiveUpdateBlocks } = require('../shared/update-transfer.mjs')

function createUpdateFeed(send, channel) {
  let server, starting, item, lastError
  const nonce = '/' + randomUUID() + '/'
  const pending = new Map()

  function request(op, data) {
    const id = randomUUID()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error('主设备的更新请求超时'))
      }, 70000)
      pending.set(id, { timer, resolve, reject })
      try { send({ id, op, data }) } catch (error) {
        clearTimeout(timer)
        pending.delete(id)
        reject(error)
      }
    })
  }

  async function serve(req, res) {
    try {
      const pathname = String(req.url).split('?')[0]
      if (req.method !== 'GET' || !pathname.startsWith(nonce)) { res.writeHead(404).end(); return }
      const name = pathname.slice(nonce.length)
      const manifest = channel === 'win' ? 'latest.yml' : 'latest-linux.yml'
      if (name === manifest) {
        lastError = undefined
        item = verifyUpdate(channel, await request('info', { channel }))
        const files = [{ url: item.name, sha512: item.sha512, size: item.size }]
        res.writeHead(200, { 'Content-Type': 'application/json' })
          .end(JSON.stringify({ version: item.version, files, path: item.name, sha512: item.sha512 }))
      } else if (item && name === item.name) {
        const current = item
        const blocks = receiveUpdateBlocks(request, channel, current)
        let received = 0
        await pipeline(Readable.from((async function* () {
          for await (const data of blocks) {
            const count = Math.min(updateBlockSize, current.size - received)
            if (typeof data !== 'string' || data.length !== 4 * Math.ceil(count / 3)) throw new Error('安装包分段大小无效')
            const part = Buffer.from(data, 'base64')
            if (part.length !== count) throw new Error('安装包分段校验失败')
            received += part.length
            yield part
          }
        })()), res.writeHead(200, { 'Content-Length': current.size }))
      } else res.writeHead(404).end()
    } catch (error) {
      if (server) lastError = error.message
      if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' }).end(error.message)
      else res.destroy()
    }
  }

  return {
    get error() { return lastError },
    open() {
      if (!starting) {
        const listener = createServer((req, res) => void serve(req, res))
        server = listener
        starting = new Promise((resolve, reject) => {
          listener.once('error', reject)
          listener.listen(0, '127.0.0.1', () => {
            if (server === listener) resolve('http://127.0.0.1:' + listener.address().port + nonce)
            else { listener.close(); reject(new Error('已切换更新来源')) }
          })
        })
      }
      return starting
    },
    reply(id, result) {
      const call = pending.get(id)
      if (!call) return
      pending.delete(id)
      clearTimeout(call.timer)
      if (result?.ok) call.resolve(result.value)
      else call.reject(new Error(String(result?.error || '主设备更新连接失败')))
    },
    close() {
      item = lastError = undefined
      const listener = server
      server = starting = undefined
      listener?.close()
      listener?.closeAllConnections()
      for (const [id, call] of pending) {
        pending.delete(id)
        clearTimeout(call.timer)
        call.reject(new Error('已切换更新来源'))
      }
    },
  }
}

module.exports = { createUpdateFeed }
