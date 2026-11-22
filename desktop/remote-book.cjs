const { createHmac, randomBytes, timingSafeEqual } = require('node:crypto')
const { constants } = require('node:buffer')
const { chunkLength, chunkSize } = require('./disk-media.cjs')

const idleMs = 5 * 60 * 1000
const retryMs = 20 * 1000
const maxEncoded = 4 * Math.ceil(chunkSize / 3)
function locked() {
  return Object.assign(new Error('私密便签已锁定，请重新验证'), { code:'PRIVATE_LOCKED' })
}
function unavailable(message) {
  return Object.assign(new Error(message), { code:'BOOK_UNAVAILABLE' })
}
function readBlock(text) {
  if (typeof text !== 'string' || !text.length || text.length > maxEncoded) throw new Error('无效的数据块')
  const bytes = Buffer.from(text, 'base64')
  if (bytes.length <= chunkSize && bytes.toString('base64') === text) return bytes
  bytes.fill(0)
  throw new Error('无效的数据块')
}

// The transport authenticates owner before calling this module. Neither a pairing
// identity nor a previously unlocked desktop UI substitutes for vault authentication.
function remoteBook(book, { isBusy = () => false, now = Date.now } = {}) {
  let active, timer, localUntil = 0
  let failures = 0, nextAttempt = 0
  const retryKey = randomBytes(32)

  function discardSave() {
    if (!active?.writing) return
    for (const block of active.writing.blocks) block.fill(0)
    delete active.writing
  }
  function revoke(owner) {
    if (!active || (owner !== undefined && owner !== active.owner)) return
    clearTimeout(timer)
    discardSave()
    active.manifest.fill(0)
    active.retry?.fill(0)
    active = undefined
    book.lock()
  }
  function expire() {
    if (active && (!book.unlocked || now() >= active.until)) revoke()
  }
  function renew() {
    active.until = now() + idleMs
    clearTimeout(timer)
    timer = setTimeout(revoke, idleMs)
    timer.unref()
    book.keepAlive()
  }
  function localLock() {
    expire()
    localUntil = 0
    if (!active) book.lock()
  }
  function local(op, args) {
    if (op === 'lock') return localLock()
    expire()
    if (active) throw unavailable('已配对的设备正在使用私密便签，请先在该设备锁定')
    const result = book.call(op, args)
    if (op === 'begin') localUntil = now() + idleMs
    if (op === 'unlock') localUntil = 0
    return result
  }
  function checkAvailability() {
    if (!book.configured) throw unavailable('请先在主设备上打开私密便签并绑定身份验证器')
    if (active || book.unlocked || now() < localUntil) throw unavailable('主设备或其他已配对设备正在使用私密便签')
    if (isBusy()) throw unavailable('请先在主设备结束正在执行的 AI 任务')
  }
  function retryTag(args) {
    if (typeof args.attempt !== 'string' || !/^[\da-f-]{36}$/i.test(args.attempt) ||
        typeof args.password !== 'string' || args.password.length > 512 ||
        typeof args.code !== 'string' || args.code.length > 32) return
    return createHmac('sha256',retryKey).update(JSON.stringify([args.attempt,args.password,args.code])).digest()
  }
  function info() { return { session:active.token, size:active.manifest.length } }
  function unlock(owner, args) {
    const tag = retryTag(args)
    // An acknowledgement lost in transit may be retried briefly with the exact
    // same attempt and credentials; another owner cannot replay that attempt.
    if (active && active.owner === owner && now() < active.retryUntil && tag && active.retry && timingSafeEqual(tag, active.retry)) {
      tag.fill(0)
      return info()
    }
    try {
      checkAvailability()
      if (now() < nextAttempt) throw new Error('验证尝试过于频繁，请稍后再试')
      let entries
      try { entries = book.call('unlock',{password:args.password,code:args.code}) }
      catch (error) {
        failures = Math.min(failures+1,7)
        nextAttempt = now() + Math.min(60_000,1500 * 2 ** (failures-1))
        throw error
      }
      try {
        active = { owner, token:randomBytes(32).toString('hex'), retry:tag && Buffer.from(tag),
          retryUntil:now()+retryMs, manifest:Buffer.from(JSON.stringify(entries)) }
        renew()
        failures = nextAttempt = 0
        return info()
      } catch (error) { if (active) revoke(); else book.lock(); throw error }
    } finally { tag?.fill(0) }
  }
  function saveWrite(args) {
    const writing = active.writing
    if (!writing || args.index !== writing.blocks.length) throw new Error('请按顺序重新传输便签')
    const length = chunkLength(writing,args.index)
    const bytes = readBlock(args.bytes)
    if (bytes.length !== length) { bytes.fill(0); throw new Error('便签分块大小不符') }
    writing.blocks.push(bytes)
  }
  function commit() {
    const writing = active.writing
    if (!writing || writing.blocks.length !== Math.ceil(writing.size/chunkSize)) throw new Error('便签传输尚未完成')
    const next = Buffer.concat(writing.blocks,writing.size)
    discardSave()
    try {
      const entries = JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(next))
      book.call('save',{entries})
    } catch (error) { next.fill(0); throw error }
    active.manifest.fill(0)
    active.manifest = next
  }
  function call(owner, op, args = {}) {
    if (typeof owner !== 'string' || !owner || !args || typeof args !== 'object') throw locked()
    expire()
    if (op === 'begin') { checkAvailability(); return {} }
    if (op === 'unlock') return unlock(owner,args)
    if (!active || active.owner !== owner || args.session !== active.token) throw locked()
    let result
    switch (op) {
      case 'lock': revoke(owner); return
      case 'manifestRead': {
        const length = chunkLength({size:active.manifest.length},args.index), start = args.index * chunkSize
        result = {bytes:active.manifest.toString('base64',start,start+length)}
        break
      }
      case 'saveBegin':
        if (!Number.isSafeInteger(args.size) || args.size < 2 || args.size > constants.MAX_STRING_LENGTH * 4) throw new Error('便签数据大小无效')
        discardSave()
        active.writing = {size:args.size,blocks:[]}
        break
      case 'saveWrite': saveWrite(args); break
      case 'saveCommit': commit(); break
      case 'saveAbort': discardSave(); break
      case 'mediaInfo': case 'mediaBegin': case 'mediaFinish': case 'mediaRemove': case 'mediaAbort':
        result = book.call(op,args)
        break
      case 'mediaWrite': {
        const bytes = readBlock(args.bytes)
        try { book.call(op,{id:args.id,index:args.index,bytes}) } finally { bytes.fill(0) }
        break
      }
      case 'mediaRead': {
        const bytes = book.call(op,{id:args.id,index:args.index})
        try { result = {bytes:bytes.toString('base64')} } finally { bytes.fill(0) }
        break
      }
      default: throw new Error('未知的远程便签操作')
    }
    renew()
    return result
  }
  return { call, local, localLock, revoke,
    forceLock() {
      localUntil = 0
      if (active) revoke()
      else book.lock()
    },
    get active() { expire(); return Boolean(active) },
  }
}
module.exports = { remoteBook }
