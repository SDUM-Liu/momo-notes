// Mobile Safari can share a File backed by its private filesystem without assembling the archive in memory.
let activeBackup
export async function releaseBackup(file) {
  if (activeBackup?.file !== file) return
  const { folder, name } = activeBackup
  activeBackup = undefined
  await folder.removeEntry(name)
}

export async function spoolBackup(parts) {
  const root = await navigator.storage.getDirectory()
  const folder = await root.getDirectoryHandle('momo-backup-export', {create:true})
  if (activeBackup) await releaseBackup(activeBackup.file)
  for await (const name of folder.keys()) await folder.removeEntry(name)
  const name = crypto.randomUUID() + '.tmp'
  const handle = await folder.getFileHandle(name, {create:true})
  const worker = new Worker(new URL('./backup-worker.js', import.meta.url), {type:'module'})
  const send = (message, transfer = []) => new Promise((resolve, reject) => {
    worker.onmessage = event => event.data?.error ? reject(new Error(event.data.error)) : resolve()
    worker.onerror = event => reject(new Error(event.message || '备份写入失败'))
    worker.postMessage(message, transfer)
  })
  try {
    await send({ handle })
    for await (const part of parts) {
      const bytes = part.slice()
      await send({ bytes }, [bytes.buffer])
    }
    await send({ end:true })
    const file = new File([await handle.getFile()], '桃桃便签.momobackup', {type:'application/octet-stream'})
    activeBackup = { file, folder, name }
    return file
  } catch (error) {
    worker.terminate()
    await folder.removeEntry(name).catch(() => {})
    throw error
  } finally { worker.terminate() }
}
