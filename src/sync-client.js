import { parsePairing, seal, unseal, wireLimit } from '../shared/sync.mjs'

export function mobileSync({ exchange, loadCode, saveCode, records, categories, setCategories, accept, markForUpload, change }) {
  let pair, running, last = '', error = ''
  const state = () => ({ role: 'mobile', enabled: Boolean(pair), host: pair?.host, last, error })
  async function request(connection, op, payload) {
    const bytes = crypto.getRandomValues(new Uint8Array(12))
    const id = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
    const message = seal(connection.key, 'request', { id, time: Date.now(), op, payload })
    if (message.length > wireLimit) throw new Error('便签超出单页同步上限')
    const reply = await exchange({ host: connection.host, message })
    const response = unseal(connection.key, 'reply/' + id, reply.message)
    if (!response.ok) throw new Error(response.error)
    return response.value
  }

  const index = connection => request(connection, 'index', categories().filter(item => item.id.startsWith('cat-')))

  async function run() {
    if (!pair) return state()
    if (running) return running
    const connection = pair
    running = (async () => {
      try {
        const response = await index(connection)
        await setCategories(response.categories)
        const remote = response.revisions
        for (const [key, record] of Object.entries(records)) {
          if (!record.dirty) continue
          const updated = await request(connection, 'put', { key, doc: record.doc, base: record.rev })
          await accept(key, record, updated, true)
          remote[key] = updated.rev
        }
        // Pull recent pages first so today's view refreshes quickly.
        for (const [key, rev] of Object.entries(remote).sort(([a], [b]) => b.slice(-10).localeCompare(a.slice(-10)))) {
          const current = records[key]
          if (current?.dirty || current?.rev === rev) continue
          const updated = await request(connection, 'get', key)
          if (updated.doc) await accept(key, current, updated, false)
        }
        last = new Date().toISOString()
        error = ''
        return state()
      } catch (failure) {
        error = failure.message
        throw failure
      } finally {
        running = null
        change(state())
      }
    })()
    return running
  }

  return {
    state,
    run,
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
      change(state())
      return run()
    },
    async unpair() {
      if (running) await running.catch(() => {})
      await saveCode('')
      pair = undefined
      last = error = ''
      change(state())
      return state()
    },
    async ask(payload) {
      if (!pair) throw new Error('请先配对主机')
      await run()
      return request(pair, 'ask', payload)
    },
  }
}
