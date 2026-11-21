import { mobileSync } from './sync-client.js'
import { mobileSyncLink } from './rtc-sync.js'

export function desktopFollower(api) {
  const records = Object.create(null)
  let receive = () => {}, profile
  const link = mobileSyncLink(connection => sync.disconnected(connection))
  const sync = mobileSync({
    readOnly: true,
    exchange: link.exchange,
    loadCode: api.followerCode,
    saveCode: api.setFollower,
    records,
    async activate(connection) {
      profile = connection ? await api.followerSnapshot() : undefined
      for (const key of Object.keys(records)) delete records[key]
      for (const [key, rev] of Object.entries(profile?.revisions ?? {})) records[key] = { rev }
    },
    setCategories: categories => api.followerCategories(profile.id, categories),
    async accept(key, _previous, note) {
      await api.followerAccept(profile.id, key, note)
      records[key] = { rev: note.rev }
    },
    async reconcile(revisions) {
      await api.followerReconcile(profile.id, revisions)
      for (const key of Object.keys(records)) if (!Object.hasOwn(revisions, key)) delete records[key]
    },
    change(value) {
      if (value.enabled || value.syncing) receive(value)
    },
  })
  const initial = sync.init()
  api.onUpdateTransfer?.(async ({ id, op, data }) => {
    let reply
    try { await initial; reply = { ok: true, value: await sync.update(op, data) } }
    catch (error) { reply = { ok: false, error: error.message } }
    await api.updateTransferReply(id, reply)
  })
  const refresh = () => initial.then(sync.run).catch(() => {})
  void refresh()
  setInterval(refresh, 20000)
  window.addEventListener('focus', refresh)
  return {
    ...api,
    supportsFollower: true,
    async syncState() {
      await initial
      const follower = sync.state()
      return follower.enabled ? follower : api.syncState()
    },
    onSync(callback) { receive = callback },
    testSync: async code => { await initial; return sync.test(code) },
    pairSync: async code => { await initial; return sync.pairWith(code) },
    runSync: async () => { await initial; return sync.run() },
    unpairSync: async () => { await initial; await sync.unpair(); return api.syncState() },
  }
}
