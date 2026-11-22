const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { randomBytes, randomUUID, webcrypto } = require('node:crypto')
const { diskMedia, chunkSize } = require('../desktop/disk-media.cjs')
const { privateBook, token } = require('../desktop/private-book.cjs')
const { derive, encrypt } = require('../desktop/sealed.cjs')

function vault(directory) {
  const password = 'fixture password only', secret = randomBytes(20).toString('base64'), salt = randomBytes(16)
  const key = derive(password, salt)
  const entries = [{ kind:'fixed-pages-v1', files:[], categories:[], homes:{}, notes:{} }]
  fs.writeFileSync(path.join(directory, 'private-book.enc'), JSON.stringify(encrypt(key, salt, {last:-1,secret,entries}, 'momo/private-book/v1')))
  const book = privateBook(directory), now = Math.floor(Date.now() / 30000)
  const unlock = n => book.call('unlock', {password, code:token(secret, n)})
  return { key, book, entries, unlock, now, secret, password }
}

test('disk-backed media exceeds 128 MiB, seeks across blocks and revokes streaming on lock', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'momo-media-'))
  const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'momo-media-copy-'))
  try {
    const { book, key, entries, unlock, now } = vault(root)
    const source = diskMedia(root), target = diskMedia(copy)
    const id = randomUUID(), size = 128 * chunkSize + 64, meta = { id, size, mime:'video/mp4' }
    assert.throws(() => book.call('mediaBegin', meta), /锁定/)
    unlock(now)
    book.call('mediaBegin', meta)
    assert.throws(() => book.call('mediaBegin', meta))
    assert.throws(() => book.call('mediaFinish', {id}), /未完成/)
    const block = randomBytes(chunkSize)
    assert.throws(() => book.call('mediaWrite', {id,index:1,bytes:block}), /顺序/)
    assert.throws(() => book.call('mediaWrite', {id,index:0,bytes:block.subarray(1)}), /大小/)
    for (let index = 0; index < Math.ceil(size / chunkSize); index++) {
      block[0] = index
      book.call('mediaWrite', { id,index,bytes:block.subarray(0,Math.min(chunkSize,size - index * chunkSize)) })
    }
    book.call('mediaFinish', {id})
    assert.throws(() => book.call('mediaPreview', {id}), /文件列表/)
    entries[0].files = [{...meta,storage:'chunks-v1',name:'private filename.mp4'}]
    book.call('save', {entries})
    assert.deepEqual(source.list(), [meta])
    assert.throws(() => book.call('mediaRemove', {id}), /先保存/)
    const raw = source.readRaw(id, 2)
    assert.equal(raw.length, chunkSize + 28)
    assert(!raw.includes(block.subarray(1024, 1088)))
    const gcm = await webcrypto.subtle.importKey('raw', key, 'AES-GCM', false, ['decrypt'])
    const decrypt = index => webcrypto.subtle.decrypt({name:'AES-GCM',iv:raw.subarray(0,12),
      additionalData:Buffer.from('momo/private-media/v1/' + id + '/' + index)}, gcm, raw.subarray(12))
    assert.equal(new Uint8Array(await decrypt(2))[0], 2)
    await assert.rejects(decrypt(1))

    const empty = {id:randomUUID(), mime:'audio/ogg', size:0}
    target.finishRaw(empty)
    assert.deepEqual(target.list(), [empty])
    for (let i = 0; i < Math.ceil(size / chunkSize); i++) {
      const encrypted = source.readRaw(id, i)
      target.writeRaw(meta, i, encrypted)
      if (i === 0) target.writeRaw(meta, i, encrypted)
    }
    target.finishRaw(meta)
    target.finishRaw(meta)
    assert.deepEqual(target.readRaw(id, 128), source.readRaw(id, 128))
    assert.throws(() => target.remove('../notes'))
    target.clear()
    assert.deepEqual(target.list(), [])

    const url = book.call('mediaPreview', {id})
    const request = range => book.mediaResponse(new Request(url, {headers:range ? {range} : {}}))
    let result = request('bytes=' + (chunkSize - 2) + '-' + (chunkSize + 1))
    assert.equal(result.status, 206)
    assert.equal(result.headers.get('content-range'), 'bytes ' + (chunkSize-2) + '-' + (chunkSize+1) + '/' + size)
    assert.deepEqual(Buffer.from(await result.arrayBuffer()), Buffer.from([block.at(-2),block.at(-1),1,block[1]]))
    result = request('bytes=-64')
    assert.deepEqual(Buffer.from(await result.arrayBuffer()), block.subarray(0,64))
    assert.equal(request('bytes=' + size + '-').status, 416)
    assert.equal(request('bytes=1-2,5-6').status, 416)
    assert.equal(book.mediaResponse(new Request(url,{method:'HEAD'})).headers.get('content-length'), String(size))
    const reader = request().body.getReader()
    assert.equal((await reader.read()).value.length, chunkSize)
    book.call('mediaRelease',{id})
    await assert.rejects(reader.read())
    assert.equal(request().status,404)

    const second = book.call('mediaPreview',{id})
    const live = book.mediaResponse(new Request(second)).body.getReader()
    await live.read()
    book.lock()
    await assert.rejects(live.read())
    assert.equal(book.mediaResponse(new Request(second)).status,404)
    assert.equal(source.list().length,1)
  } finally {
    fs.rmSync(root, {recursive:true,force:true})
    fs.rmSync(copy, {recursive:true,force:true})
  }
})

test('failed or interrupted saves leave only referenced complete media after authenticated recovery', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'momo-media-recovery-'))
  try {
    const { book, entries, now, unlock, secret, password } = vault(root)
    const disk = diskMedia(root)
    unlock(now)
    const referenced = {id:randomUUID(),mime:'image/png',size:0}
    const orphan = {...referenced,id:randomUUID()}
    const partial = {...orphan,id:randomUUID(),size:chunkSize+1}
    for (const meta of [referenced,orphan]) {
      book.call('mediaBegin',meta); book.call('mediaFinish',{id:meta.id})
    }
    entries[0].files = [{...referenced,name:'kept',storage:'chunks-v1'}]
    book.call('save',{entries})
    book.call('mediaBegin',partial)
    book.call('mediaWrite',{id:partial.id,index:0,bytes:Buffer.alloc(chunkSize)})
    // Simulate a different process starting on the same profile after a crash.
    const reopened = privateBook(root)
    assert.throws(() => reopened.call('unlock',{password:'wrong fixture pass',code:'000000'}))
    assert.equal(disk.list().length,2)
    const after = privateBook(root)
    // Reuse another valid timestep with a fresh book object (no time mocking).
    after.call('unlock',{password,code:token(secret,now+1)})
    assert.deepEqual(disk.list(),[referenced])
    after.call('mediaBegin',partial); after.call('mediaAbort',{id:partial.id})
    after.call('save',{entries:[]})
    after.call('mediaRemove',{id:referenced.id})
    assert.deepEqual(disk.list(),[])
    after.lock(); book.lock()
  } finally { fs.rmSync(root,{recursive:true,force:true}) }
})
