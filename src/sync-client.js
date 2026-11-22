import { parsePairing, seal, unseal, wireLimit, transferId } from '../shared/sync.mjs'

export function mobileSync({ exchange, loadCode, saveCode, records, categories, setCategories, accept, activate, keepDraft, change,
  readOnly = false, reconcile = () => {}, editing = () => false }) {
  let pair, running, probing, switching, verified = false, peerLocked = true, last = '', error = ''
  let via
  let transferring = false
  let deferred = false
  const state = () => ({ role: readOnly ? 'follower' : 'mobile', enabled: Boolean(pair), sshHintScope: pair?.room, via, last, error,
    ...(readOnly && { syncing: Boolean(running || switching || (pair && !verified && !error)) }),
    locked: readOnly || !pair || !verified || Boolean(transferring || switching || peerLocked) })
  async function request(connection, op, payload, token) {
    const bytes = crypto.getRandomValues(new Uint8Array(12))
    const id = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
    const message = seal(connection.key, 'request', { id, time: Date.now(), op, payload, token })
    if (message.length > wireLimit) throw new Error('便签超出单页同步上限')
    const reply = await exchange(connection, message)
    let response
    try { response = unseal(connection.key, 'reply/' + id, reply.message) } catch {
      throw new Error('主机回复验证失败，请用主机重新生成的配对码重试')
    }
    if (connection === pair) via = reply.via
    if (!response.ok) throw Object.assign(new Error(response.error), { code: response.code })
    return op === 'test' ? reply.via : response.value
  }

  function identity(connection) {
    try {
      const key = 'momo-device/' + connection.room
      let id = localStorage.getItem(key)
      if (!id) { id = crypto.randomUUID(); localStorage.setItem(key, id) }
      const platform = ['Android','iPhone','iPad','Windows','Mac','Linux'].find(name => navigator.userAgent.includes(name)) || '设备'
      const proofName = 'momo-ssh-hint/' + connection.room + '/' + id
      let sshProof = localStorage.getItem(proofName)
      if (!sshProof) {
        sshProof = transferId() + transferId()
        localStorage.setItem(proofName, sshProof)
      }
      return { id, platform, sshProof }
    } catch { return undefined }
  }
  const index = connection => request(connection, 'index', identity(connection))

  async function probe() {
    const connection = pair
    if (!connection || running) return
    if (probing) return probing
    probing = (async () => {
      let recover = false
      try {
        const result = await request(connection, 'state', identity(connection))
        if (connection !== pair || running) return
        peerLocked = result.locked
        recover = !peerLocked && !verified
      } catch (failure) {
        if (connection !== pair || running) return
        peerLocked = true
        verified = false
        error = failure.message
      } finally {
        probing = null
        change(state())
      }
      if (recover) void run().catch(() => {})
    })()
    return probing
  }

  async function run(background = false) {
    if (!pair) return state()
    if (running) {
      await running
      if (deferred && (!background || !editing())) return run(background)
      return state()
    }
    if (switching) return state()
    const connection = pair
    deferred = false
    running = (async () => {
      let token
      try {
        const snapshot = await index(connection)
        peerLocked = snapshot.locked
        if (peerLocked) { verified = false; return }
        const known = new Set(snapshot.categories.map(item => item.id))
        const extra = readOnly ? [] : categories().filter(item => !known.has(item.id))
        const dirty = !readOnly && Object.values(records).some(record => record.dirty)
        const outdated = Object.entries(snapshot.revisions).some(([key, rev]) => records[key]?.rev !== rev)
        if (!extra.length && !dirty && !outdated) {
          await setCategories(snapshot.categories)
          if (readOnly) await reconcile(snapshot.revisions)
          verified = true
          last = new Date().toISOString()
          error = ''
          return
        }
        if (background && verified && editing()) { deferred = true; return }
        transferring = true
        change(state())
        const response = await request(connection, 'begin', extra)
        token = response.token
        await setCategories(response.categories)
        for (const [key, record] of Object.entries(records)) {
          if (readOnly || !record.dirty) continue
          try {
            const updated = await request(connection, 'put', { key, doc: record.doc, base: record.rev }, token)
            await accept(key, record, updated, true)
          } catch (failure) {
            if (failure.code !== 'NOTE_STALE') throw failure
            await keepDraft(key, record.doc)
            const updated = await request(connection, 'get', key, token)
            await accept(key, record, updated, false)
          }
        }
        const remote = readOnly ? response.revisions : await request(connection, 'materialize', undefined, token)
        // Pull recent pages first so today's view refreshes quickly.
        for (const [key, rev] of Object.entries(remote).sort(([a], [b]) => b.slice(-10).localeCompare(a.slice(-10)))) {
          const current = records[key]
          if (current?.dirty || current?.rev === rev) continue
          const updated = await request(connection, 'get', key, token)
          if (updated.doc) await accept(key, current, updated, false)
        }
        await request(connection, 'finish', undefined, token)
        token = undefined
        if (readOnly) await reconcile(remote)
        verified = true
        last = new Date().toISOString()
        error = ''
      } catch (failure) {
        verified = false
        peerLocked = true
        error = failure.message
        throw failure
      } finally {
        if (token) await request(connection, 'finish', undefined, token).catch(() => {})
        transferring = false
        running = null
        change(state())
      }
    })()
    change(state())
    await running
    return state()
  }

  return {
    state,
    run,
    probe,
    disconnected(connection) {
      if (!pair || pair.key !== connection.key || pair.room !== connection.room ||
          pair.relay !== connection.relay || pair.fallback !== connection.fallback || pair.backupRoom !== connection.backupRoom) return
      peerLocked = true
      verified = false
      error = '主机连接中断，等待重新同步'
      change(state())
    },
    async sshHint(scope, value) {
      const connection = pair
      if (!connection || switching || scope !== connection.room) throw new Error('请打开当前已配对主设备的共享设置')
      const device = identity(connection)
      if (!device) throw new Error('当前设备的本地存储不可用')
      try {
        const hint = await request(connection, value === undefined ? 'ssh-hint/get' : 'ssh-hint/set', { device, hint: value })
        if (pair !== connection || switching) throw new Error('主设备已切换，请重新打开共享设置')
        return hint
      } catch (error) {
        if (error.message === '未知的同步请求' || error.code === 'SYNC_BUSY' && error.message.includes('同步锁已失效')) {
          throw new Error('请将主设备更新到支持 SSH 地址共享的版本')
        }
        throw error
      }
    },
    async test(code) {
      const connection = String(code ?? '').trim() ? parsePairing(code) : pair
      if (!connection) throw new Error('请先输入主机配对码')
      return request(connection, 'test')
    },
    async edit(payload) {
      if (state().locked) throw new Error('正在同步，完成后可编辑便签')
      try {
        return await request(pair, 'edit', payload)
      } catch (failure) {
        if (failure.code === 'NOTE_STALE') await keepDraft(payload.key, payload.doc)
        else await probe()
        throw failure
      }
    },
    async addCategory(item) {
      if (state().locked) throw new Error('正在同步，完成后可新建分类')
      return request(pair, 'category', item)
    },
    async init() {
      const code = await loadCode()
      if (code) {
        try { pair = parsePairing(code) } catch (failure) { error = failure.message }
      }
      await activate(pair, code)
    },
    async pairWith(code) {
      const next = parsePairing(code)
      if (switching) throw new Error('正在切换设备，请稍候')
      switching = true
      change(state())
      try {
        if (running) await running.catch(() => {})
        await index(next)
        await saveCode(String(code).trim())
        await activate(next)
        pair = next
        via = undefined
        verified = false
        peerLocked = true
        last = ''
        error = ''
      } finally { switching = false; change(state()) }
      return run()
    },
    async unpair() {
      if (switching) throw new Error('正在切换设备，请稍候')
      switching = true
      change(state())
      try {
        if (running) await running.catch(() => {})
        await saveCode('')
        pair = undefined
        verified = false
        via = undefined
        peerLocked = true
        last = error = ''
        await activate(undefined)
      } finally { switching = false; change(state()) }
      return state()
    },
    async ask(payload) {
      if (!pair) throw new Error('请先配对主机')
      await run()
      return request(pair, 'ask', payload)
    },
    async codex(op, payload) {
      if (!pair) throw new Error('请先在「设备同步」配对主机')
      if (op === 'notes') await run()
      return request(pair, 'codex/' + op, payload)
    },
    async update(op, payload) {
      if (!pair || switching) throw new Error('请连接已配对的主设备后重试')
      const connection = pair
      try {
        const value = await request(connection, 'update/' + op, payload)
        if (pair !== connection || switching) throw new Error('主设备已切换，请重新检查更新')
        return value
      } catch (error) {
        if (error.message.includes('未知的同步请求')) throw new Error('请先更新主设备的桃桃便签')
        throw error
      }
    },
  }
}
