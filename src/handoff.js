import { hostSyncLink, mobileSyncLink } from './rtc-sync.js'
import { blockCount } from '../shared/media-transfer.mjs'
import { seal, unseal, parsePairing, transferId } from '../shared/sync.mjs'
export function wireHandoff(api, flush, refreshHost) {
  if (!api.handoff) return
  const $ = id => document.getElementById('handoff-' + id)
  const status = text => { $('status').textContent = text }
  let stop, sending = false
  function listen(link) {
    stop?.()
    if (link) stop = hostSyncLink(link, wire => api.handoff('receive', wire), value => {
      if (value === 'online') status('接收已就绪')
    })
  }
  $('ready').onclick = async () => {
    try { const link = await api.handoff('ready'); listen(link); $('code').value = link.code; $('code').select() }
    catch (e) { status(e.message) }
  }
  async function send(resume) {
    if (sending) return
    sending = true; $('send').disabled = true
    const channel = mobileSyncLink()
    let abortTransfer
    try {
      const code = resume?.code || $('code').value.trim(), dest = parsePairing(code)
      const request = async (op, data = {}) => {
        const id = transferId()
        const body = seal(dest.key, 'handoff', { id, op, ...data })
        const reply = await channel.exchange(dest, body)
        const result = unseal(dest.key, 'handoff/' + id, reply.message)
        if (result.error) throw new Error(result.error)
        return result.value
      }
      let checksum = resume?.checksum
      if (!resume) {
        await flush()
        const hello = await request('hello')
        const info = await api.handoff('prepare', code, hello.proof, hello.mediaVersion)
        checksum = info.checksum
        abortTransfer = () => request('abort', {checksum})
        for (let index = 0; index < info.count; index++) {
          status('正在传输 ' + (index + 1) + ' / ' + info.count)
          await request('chunk', { index, checksum, chunk: await api.handoff('chunk', index) })
        }
        let staged = await request('stage', { checksum })
        if (info.media?.length) {
          if (!staged.waitingForMedia) throw new Error('接收设备未准备好接收附件')
          for (const [f, file] of info.media.entries()) {
            const total = blockCount(file)
            for (let index = 0; index < total; index++) {
              status('正在传输附件 ' + (f + 1) + ' / ' + info.media.length + '（' + (index + 1) + ' / ' + total + '）')
              const bytes = await api.handoff('mediaChunk', f, index)
              await request('mediaChunk', { checksum, fileId: file.id, index, bytes })
            }
          }
          staged = await request('mediaFinish', { checksum })
        }
        if (staged.staged !== checksum) throw new Error('目标设备校验失败')
        await flush()
        abortTransfer = undefined
        await api.handoff('cutover', code, checksum)
        await refreshHost()
      }
      const applied = await request('activate', { checksum })
      if (!applied.done || applied.checksum !== checksum) throw new Error('新主设备尚未确认')
      status('新主设备已接管，正在重启')
      await api.handoff('finish', checksum)
    } catch (error) {
      status(error.message)
      if (abortTransfer) await abortTransfer().catch(() => {})
    } finally { channel.close(); sending = false; $('send').disabled = false }
  }
  $('send').onclick = async () => send(await api.handoff('pending'))
  void api.handoff('target').then(listen).catch(e => status(e.message))
  void api.handoff('pending').then(p => { if (p) return send(p) }).catch(e => status(e.message))
}
