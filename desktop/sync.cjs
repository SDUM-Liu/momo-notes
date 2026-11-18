const net = require('node:net')
const os = require('node:os')
const path = require('node:path')
const fs = require('node:fs')
const { randomBytes } = require('node:crypto')
const { seal, unseal, syncPort, wireLimit, pairingCode } = require('../shared/sync.mjs')
const { noteIdentity, validateCategory, hasContent } = require('../shared/notes.mjs')
const { revisionOf } = require('./data.cjs')

function createSync(directory, store, ask, notify) {
  const filename = path.join(directory, 'sync.json')
  const config = fs.existsSync(filename) ? JSON.parse(fs.readFileSync(filename, 'utf8')) : {}
  const replay = new Map()
  const sockets = new Set()
  let server, starting

  function persist() {
    fs.writeFileSync(filename + '.tmp', JSON.stringify(config), { mode: 0o600 })
    fs.renameSync(filename + '.tmp', filename)
  }

  function addresses() {
    return Object.entries(os.networkInterfaces()).filter(([name]) => !/vethernet|loopback/i.test(name))
      .flatMap(([, list]) => list.filter(item => item.family === 'IPv4' && !item.internal).map(item => item.address))
  }

  function state() {
    return { role: 'host', enabled: Boolean(server?.listening), addresses: addresses(), port: syncPort }
  }

  function put({ key, doc, base }, remote = true) {
    const { date, category } = noteIdentity(key)
    if (doc?.type !== 'doc' || !Array.isArray(doc.content)) throw new Error('便签数据格式有误')
    const current = store.data.notes[key]
    const revision = store.data.revisions[key] || null
    if (revision === revisionOf(doc)) return { key, doc: current, rev: revision }
    let result = doc
    if (current && revision !== base && hasContent(current)) {
      const heading = { type: 'heading', attrs: { level: 3 }, content: [{ type: 'text', text: '同步冲突副本' }] }
      const extra = [heading, ...doc.content]
      const tail = current.content.slice(-extra.length)
      if (JSON.stringify(tail) === JSON.stringify(extra)) return { key, doc: current, rev: revision }
      result = { type: 'doc', content: [...current.content, ...extra] }
    }
    const rev = store.saveNote(date, result, category)
    if (remote) notify({ key, doc: result, rev })
    return { key, doc: result, rev }
  }

  async function processRequest({ op, payload }) {
    if (op === 'index') {
      if (!Array.isArray(payload) || payload.length > 500) throw new Error('分类数量超出同步限制')
      const previous = store.data.categories
      for (const item of payload) store.addCategory(validateCategory(item))
      for (const item of store.data.categories) store.today(item.id)
      if (previous !== store.data.categories) notify({ categories: store.data.categories })
      return { categories: store.data.categories, revisions: store.data.revisions }
    }
    if (op === 'get') {
      noteIdentity(payload)
      return { key: payload, doc: store.data.notes[payload] ?? null, rev: store.data.revisions[payload] ?? null }
    }
    if (op === 'put') return put(payload)
    if (op === 'ask') return ask(payload)
    throw new Error('未知的同步请求')
  }

  function connection(socket) {
    if (sockets.size >= 12) return socket.destroy()
    sockets.add(socket)
    const chunks = []
    let size = 0
    socket.setTimeout(10000, () => socket.destroy())
    socket.on('error', () => {})
    socket.on('close', () => sockets.delete(socket))
    socket.on('data', async chunk => {
      size += chunk.length
      if (size > wireLimit + 1) return socket.destroy()
      chunks.push(chunk)
      if (!chunk.includes(10)) return
      socket.pause()
      const wire = Buffer.concat(chunks).toString('ascii').split('\n', 1)[0]
      let request
      try {
        request = unseal(config.key, 'request', wire)
        const now = Date.now()
        if (!/^[a-f0-9]{24}$/.test(request.id) || !Number.isFinite(request.time)
            || Math.abs(now - request.time) > 120000 || replay.has(request.id)) return socket.destroy()
        for (const [id, expires] of replay) if (expires <= now) replay.delete(id)
        if (replay.size >= 10000) return socket.destroy()
        replay.set(request.id, now + 240000)
        socket.setTimeout(65000)
      } catch {
        return socket.destroy()
      }
      let response
      try {
        response = { ok: true, value: await processRequest(request) }
      } catch (error) {
        response = { ok: false, error: error.message }
      }
      const message = seal(config.key, 'reply/' + request.id, response)
      if (message.length > wireLimit) {
        socket.end(seal(config.key, 'reply/' + request.id, { ok: false, error: '便签超出单页同步上限' }) + '\n')
      } else socket.end(message + '\n')
    })
  }

  async function enable() {
    if (server?.listening) return state()
    if (starting) return starting
    starting = new Promise((resolve, reject) => {
      const next = net.createServer(connection)
      next.once('error', reject)
      next.listen(syncPort, '0.0.0.0', () => {
        try {
          config.key ||= randomBytes(32).toString('hex')
          config.enabled = true
          persist()
          next.removeListener('error', reject)
          next.on('error', error => console.error('Sync server failed:', error.message))
          server = next
          resolve(state())
        } catch (error) {
          next.close()
          reject(error)
        }
      })
    })
    try {
      return await starting
    } finally {
      starting = null
    }
  }

  function stop() {
    server?.close()
    server = null
    for (const socket of sockets) socket.destroy()
  }

  async function setEnabled(enabled) {
    if (enabled) return enable()
    if (starting) await starting.catch(() => {})
    stop()
    config.enabled = false
    persist()
    return state()
  }

  return {
    state,
    write: put,
    setEnabled,
    restore: () => config.enabled ? enable() : Promise.resolve(state()),
    stop,
    code(host) {
      if (!server?.listening || !addresses().includes(host)) throw new Error('请先开启同步并选择主机地址')
      return pairingCode(host, config.key)
    },
    rotate() {
      config.key = randomBytes(32).toString('hex')
      persist()
      for (const socket of sockets) socket.destroy()
      return state()
    },
  }
}
module.exports = { createSync }
