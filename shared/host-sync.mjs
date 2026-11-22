import { digest, seal, unseal, wireLimit, pairingCode, relayOrigin, maxPairingLength, transferId } from './sync.mjs'
import { noteIdentity, noteKey, localDay, validateCategory, hasContent } from './notes.mjs'

const randomHex = () => transferId() + transferId()
const backupOwner = owner => digest('momo-sync-v3/backup/' + owner)
const revisionOf = doc => digest(JSON.stringify(doc))

export function createHostSync({ config = {}, store, ask, notify, codex, update, defaults, relayOverride, persist }) {
  const replay = new Map()
  const lastSeen = new Map()
  function recordDevice(value) {
    if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(value?.id) ||
        !['Android','iPhone','iPad','Windows','Mac','Linux','设备'].includes(value.platform)) return
    config.devices ??= []
    if (!config.devices.some(d => d.id === value.id)) {
      if (config.devices.length >= 100) return
      config.devices.push({ id: value.id, platform: value.platform })
      persist()
    }
    lastSeen.set(value.id, Date.now())
  }
  let lease, leaseTimer
  let queue = Promise.resolve()
  function enqueue(operation) {
    const next = queue.then(operation)
    queue = next.catch(() => {})
    return next
  }

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
    return { role: 'host', devices: (config.devices || []).map(d => ({ ...d,
      online: enabled() && Date.now() - (lastSeen.get(d.id) || 0) < 65000 })), enabled: enabled(), relay: relay(), fallback: backup(),
      onlineRelay: routes().find(url => statuses.get(url) === 'online'),
      status: enabled() ? status() : 'offline', locked: Boolean(lease) }
  }

  async function put({ key, doc, base }, remote = true) {
    const { date, category } = noteIdentity(key)
    if (doc?.type !== 'doc' || !Array.isArray(doc.content)) throw new Error('便签数据格式有误')
    const current = store.data.notes[key]
    const revision = store.data.revisions[key] || null
    if (revision === revisionOf(doc)) return { key, doc: current, rev: revision }
    if (current && revision !== base && hasContent(current)) {
      throw Object.assign(new Error('主机已有更新，当前修改暂未保存。请先复制草稿，再重新打开便签。'), { code: 'NOTE_STALE' })
    }
    const rev = await store.saveNote(date, doc, category)
    if (remote) notify({ key, doc, rev })
    return { key, doc, rev }
  }

  async function processRequest({ op, payload, token }) {
    if (op === 'state' || op === 'index') recordDevice(payload)
    if (op === 'state' || op === 'test') return { locked: Boolean(lease) }
    if (op === 'index') return { categories: store.data.categories, revisions: store.data.revisions, locked: Boolean(lease) }
    if (op === 'edit' || op === 'category') {
      requireWritable()
      if (op === 'edit') return put(payload)
      const categories = await store.addCategory(validateCategory(payload))
      notify({ categories })
      return categories
    }

    if (op === 'begin') {
      requireWritable()
      if (!Array.isArray(payload) || payload.length > 500) throw new Error('分类数量超出同步限制')
      const categories = payload.map(validateCategory)
      lease = randomHex()
      renew()
      notify({ locked: true })
      const previous = store.data.categories
      try {
        for (const item of categories) await store.addCategory(item)
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
        await store.today(item.id)
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
    try {
      let value
      if (request.op === 'ask' || request.op?.startsWith?.('codex/')) {
        if (request.op === 'ask' && ask) value = await ask(request.payload)
        else if (codex && request.op.startsWith('codex/')) value = await codex(request.op.slice(6), request.payload)
        else throw new Error('手机作为主设备时，桃桃 AI 不可用')
      } else if (request.op?.startsWith?.('update/') && update) value = await update(request.op.slice(7), request.payload)
      else value = await enqueue(() => {
        if (!enabled() || config.key !== key) throw new Error('主设备已停止同步')
        return processRequest(request)
      })
      response = { ok: true, value }
    }
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
      const owner = config.owner || randomHex()
      const key = config.key || randomHex()
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
      return enqueue(() => {
        requireWritable()
        return put(payload, false)
      })
    },
    category(item) {
      return enqueue(() => {
        requireWritable()
        return store.addCategory(item)
      })
    },
    setEnabled,
    retire() {
      delete config.key
      delete config.owner
      config.devices = []
      lastSeen.clear()
      replay.clear()
      return setEnabled(false)
    },
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
      config.devices = []
      lastSeen.clear()
      config.key = randomHex()
      config.owner = randomHex()
      persist()
      replay.clear()
      statuses.clear()
      unlock()
      return state()
    },
  }
}
