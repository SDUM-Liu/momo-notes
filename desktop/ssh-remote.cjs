const net = require('node:net')
const { once } = require('node:events')
const { randomUUID } = require('node:crypto')

const readLimit = 16 * 1024
const writeLimit = 64 * 1024
const hour = 60 * 60 * 1000

function socketPipe(socket) {
  const chunks = socket[Symbol.asyncIterator]()
  let tail = Buffer.alloc(0), reading = false, writing = false
  socket.on('error', () => {}) // A pending read/write receives the error. A socket can also fail between requests.
  return {
    async read() {
      if (reading) throw new Error('上一次 SSH 读取尚未结束')
      reading = true
      try {
        if (!tail.length) {
          const next = await chunks.next()
          if (next.done) return null
          tail = next.value
        }
        const bytes = tail.subarray(0, readLimit)
        tail = tail.subarray(bytes.length)
        return bytes
      } finally { reading = false }
    },
    async write(bytes) {
      if (!(bytes instanceof Uint8Array) || !bytes.length || bytes.length > writeLimit || writing || !socket.writable) {
        throw new Error('SSH 数据无效或连接已关闭')
      }
      writing = true
      try {
        await new Promise((resolve, reject) => socket.write(bytes, err => err ? reject(err) : resolve()))
      } finally { writing = false }
    },
    close() { socket.destroy() },
  }
}

async function readSSHBanner(pipe) {
  let prefix = Buffer.alloc(0)
  while (prefix.length < 255) {
    const bytes = await pipe.read()
    if (!bytes) break
    prefix = Buffer.concat([prefix, bytes])
    const end = prefix.indexOf(10)
    if (end < 0) continue
    if (end < 255 && /^SSH-(?:2\.0|1\.99)-[!-~]+(?: [ -~]*)?\r?\n$/.test(prefix.subarray(0, end + 1).toString('latin1'))) return prefix
    break
  }
  throw new Error('这个端口没有返回 SSH 服务标识，请检查从设备上的 SSH 服务和端口')
}

function createLocalSSHPipes({ isPaired }) {
  let active
  function stop() {
    if (!active) return
    clearTimeout(active.deadline)
    active.pipe.close()
    active = undefined
  }
  function requirePair() {
    if (!isPaired()) {
      stop()
      throw new Error('请先在本机配对主设备')
    }
  }
  function current(id) {
    requirePair()
    if (!active || active.id !== id || !active.verified) throw new Error('本次 SSH 连接已结束')
    return active
  }
  return {
    async open({ port } = {}) {
      requirePair()
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('SSH 端口应为 1 至 65535 的整数')
      if (active) throw new Error('已有 SSH 连接正在使用本机')
      const socket = net.createConnection({ host: '127.0.0.1', port })
      const pipe = socketPipe(socket)
      const item = { id: randomUUID(), pipe, verified: false }
      const expire = () => { if (active === item) stop() }
      active = item
      item.deadline = setTimeout(expire, 8000)
      try {
        item.prefix = await readSSHBanner(pipe)
        requirePair()
        if (active !== item) throw new Error('本次 SSH 连接已结束')
        clearTimeout(item.deadline)
        item.deadline = setTimeout(expire, hour)
        item.verified = true
        return { id: item.id }
      } catch (error) {
        expire()
        if (error.code || socket.destroyed && !error.message.includes('SSH')) throw new Error('无法连接本机 SSH 服务，请检查服务是否已启动、端口是否正确')
        throw error
      }
    },
    async read({ id } = {}) {
      const item = current(id)
      let bytes
      if (item.prefix.length) {
        bytes = item.prefix.subarray(0, readLimit)
        item.prefix = item.prefix.subarray(bytes.length)
      } else {
        try { bytes = await item.pipe.read() } catch (error) {
          if (active === item) stop()
          throw error
        }
      }
      current(id)
      if (!bytes) { stop(); return { data: null } }
      return { data: bytes.toString('base64') }
    },
    async write({ id, data } = {}) {
      const item = current(id)
      if (typeof data !== 'string' || !data.length || data.length > Math.ceil(writeLimit / 3) * 4) throw new Error('SSH 数据长度无效')
      const bytes = Buffer.from(data, 'base64')
      if (bytes.length > writeLimit || bytes.toString('base64') !== data) throw new Error('SSH 数据无效')
      await item.pipe.write(bytes)
    },
    close({ id } = {}) { if (active && active.id === id) stop() },
    stop,
  }
}

function createRemoteSSHHost({ takeOffer, join, launch }) {
  let current
  async function open(id) {
    if (current) throw new Error('请先关闭当前异地 SSH 终端')
    const controller = new AbortController()
    const { signal } = controller
    const accepted = Promise.withResolvers()
    const connected = Promise.withResolvers()
    // Both promises can be canceled before the relay starts waiting on them.
    accepted.promise.catch(() => {})
    connected.promise.catch(() => {})
    let client, relay
    const server = net.createServer(socket => {
      if (client || signal.aborted) { socket.destroy(); return }
      client = socketPipe(socket)
      server.close()
      accepted.resolve(client)
    })
    const timer = setTimeout(() => close(new Error('异地 SSH 未能建立，请检查从设备上的 SSH 服务后重试')), 65000)
    function close(reason) {
      if (signal.aborted) return
      const error = reason || new Error('本次异地 SSH 连接已结束')
      controller.abort(error)
      clearTimeout(timer)
      if (server.listening) server.close()
      client?.close()
      accepted.reject(error)
      connected.reject(error)
      relay?.close()
      if (current === close) current = undefined
    }
    current = close
    server.on('error', close)
    try {
      const grant = await takeOffer(id)
      signal.throwIfAborted()
      const handle = await join({ grant, signal, openPipe: () => accepted.promise, onClose: close,
        onConnected: () => connected.resolve() })
      if (signal.aborted) { handle.close(); signal.throwIfAborted() }
      relay = handle
      const listening = once(server, 'listening', { signal })
      server.listen({ port: 0, host: '127.0.0.1', backlog: 1, signal })
      await listening
      signal.throwIfAborted()
      await launch(id, grant.user, server.address().port)
      await connected.promise
      clearTimeout(timer)
      return true
    } catch (error) { close(error); throw signal.reason }
  }
  return { open, stop() { current?.() } }
}

module.exports = { createLocalSSHPipes, createRemoteSSHHost }
