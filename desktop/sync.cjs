const path = require('node:path')
const fs = require('node:fs')
const { randomBytes, createHash } = require('node:crypto')
const { seal, unseal, wireLimit, pairingCode, relayOrigin, maxPairingLength } = require('../shared/sync.mjs')
const { noteIdentity, noteKey, localDay, validateCategory, hasContent } = require('../shared/notes.mjs')
const { revisionOf } = require('./data.cjs')
const digest = value => createHash('sha256').update(value).digest('hex')
const backupOwner = owner => digest('momo-sync-v3/backup/' + owner)

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

  const defaults = require('../shared/relay.json')
  const relayOverride = process.env.MOMO_RELAY_URL
  if (!relayOverride && !config.fallback && !config.routesConfigured &&
      (config.relay === defaults.url || config.relay === defaults.fallback)) {
    // Keep earlier pairing codes working on whichever relay they originally used.
    const primaryUsesAlternateOwner = config.relay === defaults.fallback
    Object.assign(config, { relay: defaults.url, fallback: defaults.fallback, routesConfigured: true, primaryUsesAlternateOwner })
    persist()
  }
  const relay = () => config.relay || relayOverride || defaults.url
  const backup = () => config.relay ? config.fallback : relayOverride ? undefined : defaults.fallback
  const routes = () => [relay(), backup()].filter(Boolean)
  const enabled = () => Boolean(config.enabled && config.owner && config.key && relay())
  function usesAlternateOwner(url) {
    return (url === relay()) === Boolean(config.primaryUsesAlternateOwner)
  }
  function credentials(url) {
    const owner = usesAlternateOwner(url) ? backupOwner(config.owner) : config.owner
    return { owner, room: digest(owner) }
  }
  const statuses = new Map()
  const status = () => routes().some(url => statuses.get(url) === 'online') ? 'online'
    : routes().some(url => !statuses.has(url) || statuses.get(url) === 'connecting') ? 'connecting' : 'offline'

  function state() {
    return { role: 'host', enabled: enabled(), relay: relay(), fallback: backup(),
      onlineRelay: routes().find(url => statuses.get(url) === 'online'),
      status: enabled() ? status() : 'offline', locked: Boolean(lease) }
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

  function setEnabled(value, endpoint, secondary) {
    if (value) {
      const primary = relayOrigin(endpoint || relay())
      const fallback = secondary === undefined ? backup() : secondary.trim() ? relayOrigin(secondary) : undefined
      if (fallback === primary) throw new Error('备用同步服务需要使用不同的地址')
      const owner = config.owner || randomBytes(32).toString('hex')
      const key = config.key || randomBytes(32).toString('hex')
      if (pairingCode(primary, digest(owner), key, fallback, digest(backupOwner(owner))).length > maxPairingLength) {
        throw new Error('同步服务地址太长，无法生成配对码')
      }
      const existing = routes()
      const primaryUsesAlternateOwner = existing.includes(primary) ? usesAlternateOwner(primary)
        : existing.includes(fallback) ? !usesAlternateOwner(fallback) : false
      Object.assign(config, { relay: primary, fallback, owner, key, routesConfigured: true, primaryUsesAlternateOwner })
    } else {
      unlock()
    }
    statuses.clear()
    config.enabled = Boolean(value)
    persist()
    return state()
  }

  return {
    state,
    owns(key) { return config.key === key },
    requireWritable,
    write(payload) {
      requireWritable()
      return put(payload, false)
    },
    setEnabled,
    exchange,
    link() {
      if (!enabled() || !config.key || !config.owner) return null
      const fallback = backup()
      const alternate = fallback && credentials(fallback)
      return { relay: relay(), fallback, key: config.key, ...credentials(relay()),
        ...(alternate ? { backupRoom: alternate.room, backupOwner: alternate.owner } : {}) }
    },
    status(value, roomId, endpoint = relay()) {
      if (enabled() && routes().includes(endpoint) && roomId === credentials(endpoint).room &&
          ['online', 'offline', 'connecting'].includes(value)) {
        statuses.set(endpoint, value)
      }
      return state()
    },
    stop: unlock,
    code() {
      if (!enabled() || status() !== 'online') throw new Error('请先等待主机连上异地同步服务')
      const fallback = backup()
      return pairingCode(relay(), credentials(relay()).room, config.key, fallback, fallback && credentials(fallback).room)
    },
    rotate() {
      if (!enabled()) throw new Error('请先开启主机同步')
      config.key = randomBytes(32).toString('hex')
      config.owner = randomBytes(32).toString('hex')
      persist()
      replay.clear()
      statuses.clear()
      unlock()
      return state()
    },
  }
}
module.exports = { createSync }
