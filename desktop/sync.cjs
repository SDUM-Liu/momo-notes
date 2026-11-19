const path = require('node:path')
const fs = require('node:fs')
const { randomBytes, createHash } = require('node:crypto')
const { seal, unseal, wireLimit, pairingCode, relayOrigin } = require('../shared/sync.mjs')
const { noteIdentity, noteKey, localDay, validateCategory, hasContent } = require('../shared/notes.mjs')
const { revisionOf } = require('./data.cjs')

function createSync(directory, store, ask, notify, codex) {
  const filename = path.join(directory, 'sync.json')
  const config = fs.existsSync(filename) ? JSON.parse(fs.readFileSync(filename, 'utf8')) : {}
  const replay = new Map()
  let lease, leaseTimer

  function unlock() {
    if (!lease) return
    clearTimeout(leaseTimer)
    lease = undefined
    notify({ locked: false })
  }

  function renew() {
    clearTimeout(leaseTimer)
    leaseTimer = setTimeout(unlock, 25000)
  }

  function requireWritable() {
    if (lease) throw Object.assign(new Error('同步中，便签暂时只读'), { code: 'SYNC_BUSY' })
  }

  function persist() {
    fs.writeFileSync(filename + '.tmp', JSON.stringify(config), { mode: 0o600 })
    fs.renameSync(filename + '.tmp', filename)
  }

  const defaultRelay = process.env.MOMO_RELAY_URL || require('../shared/relay.json').url
  const relay = () => config.relay || defaultRelay
  const enabled = () => Boolean(config.enabled && config.owner && config.key && relay())
  const room = () => createHash('sha256').update(config.owner).digest('hex')
  let status = 'offline'

  function state() {
    return { role: 'host', enabled: enabled(), relay: relay(), status, locked: Boolean(lease) }
  }

  function put({ key, doc, base }, remote = true) {
    const { date, category } = noteIdentity(key)
    if (doc?.type !== 'doc' || !Array.isArray(doc.content)) throw new Error('便签数据格式有误')
    const current = store.data.notes[key]
    const revision = store.data.revisions[key] || null
    if (revision === revisionOf(doc)) return { key, doc: current, rev: revision }
    if (current && revision !== base && hasContent(current)) {
      throw Object.assign(new Error('主机已有更新，当前修改暂未保存。请先复制草稿，再重新打开便签。'), { code: 'NOTE_STALE' })
    }
    const rev = store.saveNote(date, doc, category)
    if (remote) notify({ key, doc, rev })
    return { key, doc, rev }
  }

  async function processRequest({ op, payload, token }) {
    if (op === 'state' || op === 'test') return { locked: Boolean(lease) }
    if (op === 'index') return { categories: store.data.categories, revisions: store.data.revisions, locked: Boolean(lease) }
    if (op === 'edit' || op === 'category') {
      requireWritable()
      if (op === 'edit') return put(payload)
      const categories = store.addCategory(validateCategory(payload))
      notify({ categories })
      return categories
    }
    if (op === 'ask') return ask(payload)
    if (typeof op === 'string' && op.startsWith('codex/') && codex) return codex(op.slice(6), payload)
    if (op === 'begin') {
      requireWritable()
      if (!Array.isArray(payload) || payload.length > 500) throw new Error('分类数量超出同步限制')
      const categories = payload.map(validateCategory)
      lease = randomBytes(24).toString('hex')
      renew()
      notify({ locked: true })
      const previous = store.data.categories
      try {
        for (const item of categories) store.addCategory(item)
        if (previous !== store.data.categories) notify({ categories: store.data.categories })
        return { token: lease, categories: store.data.categories, revisions: store.data.revisions }
      } catch (error) {
        unlock()
        throw error
      }
    }
    if (!lease || token !== lease) throw Object.assign(new Error('同步锁已失效，请重试'), { code: 'SYNC_BUSY' })
    renew()
    if (op === 'finish') { unlock(); return null }
    if (op === 'materialize') {
      for (const item of store.data.categories) {
        const key = noteKey(item.id, localDay())
        const existed = store.data.notes[key]
        store.today(item.id)
        if (!existed) notify({ key, doc: store.data.notes[key], rev: store.data.revisions[key] })
      }
      return store.data.revisions
    }
    if (op === 'get') {
      noteIdentity(payload)
      return { key: payload, doc: store.data.notes[payload] ?? null, rev: store.data.revisions[payload] ?? null }
    }
    if (op === 'put') return put(payload)
    throw new Error('未知的同步请求')
  }

  async function exchange(wire) {
    if (!enabled() || typeof wire !== 'string' || wire.length > wireLimit) return null
    const key = config.key
    let request
    try { request = unseal(key, 'request', wire) } catch { return null }
    const now = Date.now()
    if (!/^[a-f0-9]{24}$/.test(request?.id) || !Number.isFinite(request.time) || replay.has(request.id)) return null
    if (Math.abs(now - request.time) > 120000) {
      const error = '主机与手机的时钟相差超过两分钟，请开启系统自动设置时间后重试'
      return seal(key, 'reply/' + request.id, { ok: false, code: 'SYNC_CLOCK', error })
    }
    for (const [id, expires] of replay) if (expires <= now) replay.delete(id)
    if (replay.size >= 10000) return null
    replay.set(request.id, now + 240000)
    let response
    try { response = { ok: true, value: await processRequest(request) } }
    catch (error) { response = { ok: false, error: error.message, code: error.code } }
    if (key !== config.key || !enabled()) return null
    const message = seal(key, 'reply/' + request.id, response)
    if (message.length <= wireLimit) return message
    return seal(key, 'reply/' + request.id, { ok: false, error: '便签超出单页同步上限' })
  }

  function setEnabled(value, endpoint) {
    if (value) {
      const url = String(endpoint || relay()).trim()
      if (!url) throw new Error('请先填写异地同步服务地址')
      config.relay = relayOrigin(url)
      config.key ||= randomBytes(32).toString('hex')
      config.owner ||= randomBytes(32).toString('hex')
      status = 'connecting'
    } else {
      unlock()
      status = 'offline'
    }
    config.enabled = Boolean(value)
    persist()
    return state()
  }

  return {
    state,
    requireWritable,
    write(payload) {
      requireWritable()
      return put(payload, false)
    },
    setEnabled,
    exchange,
    link() {
      if (!enabled() || !config.key || !config.owner) return null
      return { relay: relay(), room: room(), key: config.key, owner: config.owner }
    },
    status(value, roomId) {
      if (enabled() && config.owner && roomId === room() && ['online', 'offline', 'connecting'].includes(value)) status = value
      return state()
    },
    stop: unlock,
    code() {
      if (!enabled() || status !== 'online') throw new Error('请先等待主机连上异地同步服务')
      return pairingCode(relay(), room(), config.key)
    },
    rotate() {
      if (!enabled()) throw new Error('请先开启主机同步')
      config.key = randomBytes(32).toString('hex')
      config.owner = randomBytes(32).toString('hex')
      persist()
      replay.clear()
      status = 'connecting'
      unlock()
      return state()
    },
  }
}
module.exports = { createSync }
