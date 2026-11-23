import { mobileSync } from './sync-client.js'
import { mobileSyncLink } from './rtc-sync.js'
import { defaultCategory, newCategory, noteKey } from '../shared/notes.mjs'

export function desktopFollower(api) {
  const records = Object.create(null)
  let receive = () => {}, receiveNotes = () => {}, profile, lastLock
  const lockState = value => profile ? { ...value, locked: sync.state().locked } : value
  const link = mobileSyncLink(connection => sync.disconnected(connection))
  const sync = mobileSync({
    follower: true,
    categories: () => [],
    editing: () => document.activeElement?.isContentEditable === true,
    exchange: link.exchange,
    loadCode: api.followerCode,
    saveCode: api.setFollower,
    records,
    async activate(connection) {
      profile = connection ? await api.followerSnapshot() : undefined
      lastLock = undefined
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
    keepDraft: (key, doc) => api.followerDraft(profile.id, key, doc),
    change(value) {
      if (value.enabled || value.syncing) receive(value)
      if (value.enabled && lastLock !== value.locked) {
        lastLock = value.locked
        receiveNotes({ locked: value.locked })
      }
    },
  })
  const initial = sync.init()
  api.onUpdateTransfer?.(async ({ id, op, data }) => {
    let reply
    try { await initial; reply = { ok: true, value: await sync.update(op, data) } }
    catch (error) { reply = { ok: false, error: error.message } }
    await api.updateTransferReply(id, reply)
  })
  const refresh = () => initial.then(() => sync.run(true)).catch(() => {})
  void refresh()
  setInterval(refresh, 20000)
  setInterval(() => { void initial.then(sync.probe).catch(() => {}) }, 2500)
  window.addEventListener('focus', refresh)
  return {
    ...api,
    supportsFollower: true,
    async getState() { await initial; return lockState(await api.getState()) },
    onState(callback) { api.onState(value => callback(lockState(value))) },
    onNotes(callback) { receiveNotes = callback; api.onNotes(callback) },
    editorIdle: refresh,
    async saveNote(date, doc, category = defaultCategory, base) {
      await initial
      const current = profile
      if (!current) return api.saveNote(date, doc, category, base)
      const key = noteKey(category, date)
      try {
        const result = await sync.edit({ key, doc, base: base === undefined ? records[key]?.rev ?? null : base })
        if (profile !== current) throw new Error('主设备已切换，请重新同步')
        await api.followerAccept(current.id, key, result)
        records[key] = { rev: result.rev }
        return result
      } catch (error) {
        if (error.code === 'NOTE_STALE' && current === profile) await sync.run().catch(() => {})
        else await api.followerDraft(current.id, key, doc).catch(() => {})
        throw error
      }
    },
    async addCategory(name) {
      await initial
      const current = profile
      if (!current) return api.addCategory(name)
      const categories = await sync.addCategory(newCategory(name))
      await api.followerCategories(current.id, categories)
      return categories
    },
    async syncDrafts() {
      await initial
      return profile ? api.followerDrafts(profile.id) : {}
    },
    async syncState() {
      await initial
      const follower = sync.state()
      return follower.enabled ? follower : api.syncState()
    },
    sshOffer: (...args) => sync.sshOffer(...args),
    sshRoutes: scope => sync.sshRoutes(scope),
    async sshHint(scope, value) { await initial; return sync.sshHint(scope, value) },
    onSync(callback) { receive = callback },
    testSync: async code => { await initial; return sync.test(code) },
    testUdpProbe: async code => {
      await initial
      return sync.testTcpProbe({ prepare: api.udpProbePrepare, run: api.udpProbeRun, cancel: api.udpProbeCancel }, code, 'udp')
    },
    testTcpProbe: async code => {
      await initial
      return sync.testTcpProbe({ prepare: api.tcpProbePrepare, run: api.tcpProbeRun, cancel: api.tcpProbeCancel }, code)
    },
    pairSync: async code => { await initial; return sync.pairWith(code) },
    runSync: async () => { await initial; return sync.run() },
    unpairSync: async () => { await initial; await sync.unpair(); return api.syncState() },
  }
}
