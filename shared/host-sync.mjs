import { digest, seal, unseal, wireLimit, pairingCode, relayOrigin, maxPairingLength, transferId,
  noteBatchSize, notesRevision } from './sync.mjs'
import { normalizeSSHShareHint } from './ssh-endpoint.mjs'
import { isPublicProbeEndpoint } from './tcp-probe.mjs'
import { noteIdentity, noteKey, localDay, validateCategory, hasContent } from './notes.mjs'

const randomHex = () => transferId() + transferId()
const backupOwner = owner => digest('momo-sync-v3/backup/' + owner)
const revisionOf = doc => digest(JSON.stringify(doc))
const sshOwner = proof => typeof proof === 'string' && /^[a-f0-9]{64}$/.test(proof)
  ? digest('momo/ssh-hint/' + proof) : null

export function createHostSync({ config = {}, store, ask, notify, codex, update, tcpProbe, remoteBook, defaults, relayOverride, persist }) {
  const replay = new Map()
  const lastSeen = new Map()
  const sshOffers = new Map()
  let pendingProbe
  function cancelProbe(probe = pendingProbe) {
    if (!probe || probe !== pendingProbe) return
    pendingProbe = undefined
    clearTimeout(probe.timer)
    void Promise.resolve().then(() => tcpProbe.cancel(probe.id)).catch(() => {})
  }
  async function testTcp(op, payload) {
    if (!tcpProbe) return { ok: false, reason: 'unsupported' }
    const owner = sshOwner(payload?.device?.sshProof)
    const device = config.devices?.find(d => d.id === payload?.device?.id)
    const id = payload?.id
    if (!owner || device?.sshOwner !== owner || typeof id !== 'string' || !/^[a-f0-9]{32}$/.test(id)) {
      return { ok: false, reason: 'unavailable' }
    }
    if (op === 'tcp-probe-prepare') {
      if (pendingProbe) return { ok: false, reason: 'busy' }
      const probe = { id, device: device.id, phase: 'preparing' }
      pendingProbe = probe
      probe.timer = setTimeout(() => cancelProbe(probe), 75000)
      try {
        const result = await tcpProbe.prepare(id)
        if (probe !== pendingProbe) return { ok: false, reason: 'cancelled' }
        if (!isPublicProbeEndpoint(result?.endpoint)) {
          cancelProbe(probe)
          return { ok: false, reason: result?.reason || 'observer_unavailable' }
        }
        probe.phase = 'ready'
        return { endpoint: result.endpoint }
      } catch (error) {
        cancelProbe(probe)
        return { ok: false, reason: error?.code || 'observer_unavailable' }
      }
    }
    const probe = pendingProbe
    if (!probe || probe.id !== id || probe.device !== device.id) return { ok: false, reason: 'expired' }
    if (op === 'tcp-probe-cancel') { cancelProbe(probe); return { ok: true } }
    if (op !== 'tcp-probe-run' || probe.phase !== 'ready' ||
        !isPublicProbeEndpoint(payload.endpoint) || typeof payload.token !== 'string' || !/^[a-f0-9]{64}$/.test(payload.token)) {
      return { ok: false, reason: 'unavailable' }
    }
    probe.phase = 'running'
    try {
      const result = await tcpProbe.run(id, payload.endpoint, payload.token)
      if (pendingProbe !== probe) return { ok: false, reason: 'cancelled' }
      return result?.ok === true ? { ok: true } : { ok: false, reason: result?.reason || 'unavailable' }
    } catch { return { ok: false, reason: 'unavailable' } }
    finally { cancelProbe(probe) }
  }
  function recordDevice(value) {
    if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(value?.id) ||
        !['Android','iPhone','iPad','Windows','Mac','Linux','设备'].includes(value.platform)) return
    config.devices ??= []
    let device = config.devices.find(d => d.id === value.id)
    let changed = false
    if (!device) {
      if (config.devices.length >= 100) return
      device = { id: value.id, platform: value.platform }
      config.devices.push(device)
      changed = true
    }
    const owner = sshOwner(value.sshProof)
    if (owner && device.sshOwner !== owner) {
      if (device.sshOwner) throw new Error('设备身份与此前配对时不一致')
      device.sshOwner = owner
      changed = true
    }
    if (changed) persist()
    lastSeen.set(value.id, Date.now())
    return device
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
    return { role: 'host', devices: (config.devices || []).map(d => ({ id: d.id, platform: d.platform,
      ...(d.sshHint && { sshHint: d.sshHint }),
      ...(sshOffers.get(d.id)?.until > Date.now() && { sshRemoteReady: true }),
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
    if (['ssh-hint/get', 'ssh-hint/set', 'ssh-offer/set', 'ssh-offer/end'].includes(op)) {
      const device = config.devices?.find(d => d.id === payload?.device?.id)
      const owner = sshOwner(payload?.device?.sshProof)
      if (!owner || device?.sshOwner !== owner) throw new Error('无法确认设备身份，请先在当前从设备完成同步')
      if (op === 'ssh-offer/end') {
        if (sshOffers.get(device.id)?.grant.room === payload.room) sshOffers.delete(device.id)
        return true
      }
      if (op === 'ssh-offer/set') {
        const grant = payload.grant
        if (!grant || !routes().includes(grant.relay) || ![grant.key, grant.room].every(v => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v))) {
          throw new Error('异地连接邀请无效')
        }
        const { username } = normalizeSSHShareHint({ host: '127.0.0.1', username: grant.user, port: 22 })
        sshOffers.set(device.id, { grant: { relay: grant.relay, room: grant.room, key: grant.key, user: username }, until: Date.now() + 120000 })
        return true
      }
      if (op === 'ssh-hint/set') {
        const hint = payload.hint === null ? null : normalizeSSHShareHint(payload.hint)
        if (hint) device.sshHint = hint
        else delete device.sshHint
        persist()
      }
      return device.sshHint || null
    }
    if (op === 'state' || op === 'index') recordDevice(payload)
    if (op === 'state' && payload?.watchNotes) {
      return { locked: Boolean(lease), revision: notesRevision(store.data.categories, store.data.revisions) }
    }
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
        return { token: lease, categories: store.data.categories, revisions: store.data.revisions, noteBatches: true }
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
    if (op === 'get-pages') {
      if (!Array.isArray(payload) || !payload.length || payload.length > noteBatchSize) throw new Error('便签批次数量无效')
      const pages = []
      let size = 0
      for (const key of payload) {
        noteIdentity(key)
        const doc = store.data.notes[key] ?? null
        const page = { key, doc, rev: store.data.revisions[key] ?? null }
        // Leave the existing single-page path available for pages with large embedded images.
        const pageSize = JSON.stringify(page).length
        if (pageSize > 512 * 1024) {
          if (pages.length) break
          pages.push({ key, separate: true })
          break
        }
        size += pageSize
        if (pages.length && size > 512 * 1024) break
        pages.push(page)
      }
      return pages
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
      } else if (request.op?.startsWith?.('private-book/')) {
        if (!remoteBook) throw new Error('请在保存私密便签的电脑上开启主设备同步')
        const payload = request.payload
        const owner = sshOwner(payload?.device?.sshProof)
        const device = config.devices?.find(d => d.id === payload?.device?.id)
        if (!owner || device?.sshOwner !== owner) throw new Error('无法验证本设备，请先完成一次同步')
        value = await remoteBook.call(device.id, request.op.slice(13), payload)
      } else if (request.op?.startsWith?.('tcp-probe-')) value = await testTcp(request.op, request.payload)
      else if (request.op?.startsWith?.('update/') && update) value = await update(request.op.slice(7), request.payload)
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
    sshOffers.clear()
    cancelProbe()
    remoteBook?.revoke()
    statuses.clear()
    config.enabled = Boolean(value)
    persist()
    return state()
  }

  return {
    state,
    takeSSHOffer(id) {
      const entry = sshOffers.get(id)
      sshOffers.delete(id)
      if (!enabled() || !entry || entry.until <= Date.now()) throw new Error('请先在从设备允许一次异地 SSH 连接')
      return entry.grant
    },
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
    stop() { unlock(); cancelProbe(); remoteBook?.revoke() },
    code() {
      if (!enabled() || status() !== 'online') throw new Error('请先等待主机连上异地同步服务')
      const fallback = backup()
      return pairingCode(relay(), credentials(relay()).room, config.key, fallback, fallback && credentials(fallback).room)
    },
    rotate() {
      if (!enabled()) throw new Error('请先开启主机同步')
      config.devices = []
      lastSeen.clear()
      sshOffers.clear()
      cancelProbe()
      remoteBook?.revoke()
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
