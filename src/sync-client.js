import { parsePairing, seal, unseal, wireLimit, tailscaleAddress, syncPort } from '../shared/sync.mjs'

function connectionError(host, error) {
  if (error.code === 'SYNC_LOCAL_NETWORK') return error
  const address = host + ':' + syncPort
  if (error.code === 'SYNC_AUTH') return new Error('已连到 ' + address + '，但主机未接受配对。请从当前主机重新复制完整配对码，并检查两端的系统时间。')
  const network = tailscaleAddress(host) ? '确认两端的 Tailscale 都在线、属于同一网络，且允许访问主机。'
    : '确认两端在同一局域网。若手机不在该网络，请使用主机生成的 Tailscale 配对码。'
  return new Error('无法连接 ' + address + '。请确认主机同步已开启、系统防火墙允许连接。' + network)
}

export function mobileSync({ exchange, loadCode, saveCode, records, categories, setCategories, accept, markForUpload, keepDraft, change }) {
  let pair, running, probing, peerLocked = true, last = '', error = ''
  const state = () => ({ role: 'mobile', enabled: Boolean(pair), host: pair?.host, last, error,
    locked: Boolean(pair && (running || peerLocked)) })
  async function request(connection, op, payload, token) {
    const bytes = crypto.getRandomValues(new Uint8Array(12))
    const id = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
    const message = seal(connection.key, 'request', { id, time: Date.now(), op, payload, token })
    if (message.length > wireLimit) throw new Error('便签超出单页同步上限')
    let reply
    try { reply = await exchange({ host: connection.host, message }) } catch (error) { throw connectionError(connection.host, error) }
    let response
    try { response = unseal(connection.key, 'reply/' + id, reply.message) } catch {
      throw connectionError(connection.host, { code: 'SYNC_AUTH' })
    }
    if (!response.ok) throw Object.assign(new Error(response.error), { code: response.code })
    return response.value
  }

  const index = connection => request(connection, 'index')

  async function probe() {
    const connection = pair
    if (!connection || running) return
    if (probing) return probing
    probing = (async () => {
      try {
        const result = await request(connection, 'state')
        if (connection !== pair || running) return
        peerLocked = result.locked
        if (!peerLocked) error = ''
      } catch (failure) {
        if (connection !== pair || running) return
        peerLocked = true
        error = failure.message
      } finally {
        probing = null
        change(state())
      }
    })()
    return probing
  }

  async function run() {
    if (!pair) return state()
    if (running) return running
    const connection = pair
    const snapshot = await index(connection).catch(failure => {
      if (connection === pair) {
        peerLocked = true
        error = failure.message
        change(state())
      }
      throw failure
    })
    if (connection !== pair) return state()
    if (running) return running
    peerLocked = snapshot.locked
    if (peerLocked) {
      change(state())
      return state()
    }
    const known = new Set(snapshot.categories.map(item => item.id))
    const extra = categories().filter(item => !known.has(item.id))
    const dirty = Object.values(records).some(record => record.dirty)
    const outdated = Object.entries(snapshot.revisions).some(([key, rev]) => records[key]?.rev !== rev)
    if (!extra.length && !dirty && !outdated) {
      last = new Date().toISOString()
      error = ''
      change(state())
      return state()
    }
    running = (async () => {
      let token
      try {
        const response = await request(connection, 'begin', extra)
        token = response.token
        await setCategories(response.categories)
        for (const [key, record] of Object.entries(records)) {
          if (!record.dirty) continue
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
        const remote = await request(connection, 'materialize', undefined, token)
        // Pull recent pages first so today's view refreshes quickly.
        for (const [key, rev] of Object.entries(remote).sort(([a], [b]) => b.slice(-10).localeCompare(a.slice(-10)))) {
          const current = records[key]
          if (current?.dirty || current?.rev === rev) continue
          const updated = await request(connection, 'get', key, token)
          if (updated.doc) await accept(key, current, updated, false)
        }
        last = new Date().toISOString()
        error = ''
      } catch (failure) {
        error = failure.message
        throw failure
      } finally {
        if (token) await request(connection, 'finish', undefined, token).catch(() => {})
        running = null
        await probe()
      }
      return state()
    })()
    change(state())
    return running
  }

  return {
    state,
    run,
    probe,
    async test(code) {
      const connection = String(code ?? '').trim() ? parsePairing(code) : pair
      if (!connection) throw new Error('请先输入主机配对码')
      await request(connection, 'state')
      return connection.host
    },
    async edit(payload) {
      if (state().locked) throw new Error('同步中或主机未连接，当前修改暂未保存')
      try {
        return await request(pair, 'edit', payload)
      } catch (failure) {
        if (failure.code === 'NOTE_STALE') await keepDraft(payload.key, payload.doc)
        else await probe()
        throw failure
      }
    },
    async addCategory(item) {
      if (state().locked) throw new Error('同步中或主机未连接，分类暂不可修改')
      return request(pair, 'category', item)
    },
    async init() {
      const code = await loadCode()
      if (code) {
        try { pair = parsePairing(code) } catch { error = '配对码失效，请重新配对' }
      }
    },
    async pairWith(code) {
      const next = parsePairing(code)
      if (running) await running.catch(() => {})
      const remote = await index(next)
      if (pair?.key !== next.key) await markForUpload(remote.revisions)
      await saveCode(String(code).trim())
      pair = next
      peerLocked = remote.locked
      change(state())
      return run()
    },
    async unpair() {
      if (running) await running.catch(() => {})
      await saveCode('')
      pair = undefined
      peerLocked = true
      last = error = ''
      change(state())
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
  }
}
