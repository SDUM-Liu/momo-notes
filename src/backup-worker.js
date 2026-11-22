let output, offset = 0
self.onmessage = async ({ data }) => {
  try {
    if (data.handle) output = await data.handle.createSyncAccessHandle()
    else if (data.end) { output.flush(); output.close(); output = undefined }
    else {
      let written = 0
      while (written < data.bytes.length) {
        const count = output.write(data.bytes.subarray(written), {at:offset})
        if (!count) throw new Error('设备空间不足')
        offset += count; written += count
      }
    }
    self.postMessage({})
  } catch (error) { output?.close(); self.postMessage({ error:error.message }) }
}
