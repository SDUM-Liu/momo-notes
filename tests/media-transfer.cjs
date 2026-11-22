const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { randomBytes, randomUUID } = require('node:crypto')
const { openStore } = require('../desktop/data.cjs')
const { diskMedia, chunkSize } = require('../desktop/disk-media.cjs')
const { privateBook, token } = require('../desktop/private-book.cjs')
const { encrypt, derive } = require('../desktop/sealed.cjs')
const { createSync } = require('../desktop/sync.cjs')
const { handoff } = require('../desktop/handoff.cjs')
const migration = require('../desktop/migration.cjs')
const { seal, unseal, transferId } = require('../shared/sync.mjs')
const { backupBytes, restoreBackup, blockCount } = require('../shared/media-transfer.mjs')

const bookPass = 'private vault test only'
const backupPass = 'offline backup test only'

function tempDir(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'momo-transfer-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  return root
}

function setup(directory) {
  const store = openStore(directory)
  const disk = diskMedia(directory)
  const files = [
    { id:randomUUID(), mime:'audio/wav', size:0, name:'zero.wav', storage:'chunks-v1' },
    { id:randomUUID(), mime:'video/mp4', size:chunkSize + 111, name:'hidden filename.mp4', storage:'chunks-v1' },
  ]
  store.saveNote('2026-11-22', { type:'doc', content:[{type:'paragraph',content:[{type:'text',text:'private test marker'}]}] })
  const secret = randomBytes(20).toString('base64'), salt = randomBytes(16), key = derive(bookPass, salt)
  const box = encrypt(key, salt, { secret, last:-1, entries:[] }, 'momo/private-book/v1')
  key.fill(0)
  fs.writeFileSync(path.join(directory,'private-book.enc'), JSON.stringify(box))
  const book = privateBook(directory), counter = Math.floor(Date.now()/30000)
  book.call('unlock',{ password:bookPass, code:token(secret,counter) })
  const lastBlock = randomBytes(111)
  for (const file of files) {
    book.call('mediaBegin', file)
    for (let index=0; index<blockCount(file); index++) {
      const bytes = index ? lastBlock : randomBytes(chunkSize)
      book.call('mediaWrite', {id:file.id, index, bytes})
    }
    book.call('mediaFinish',{id:file.id})
  }
  book.call('save',{entries:[{kind:'fixed-pages-v1', files}]})
  book.lock()
  return { disk, store, files, lastBlock, secret, counter, snapshot:() => migration.snapshot(directory, store, {}) }
}

async function checkRestored(directory, source) {
  const copy = diskMedia(directory)
  assert.deepEqual(copy.list(), source.disk.list())
  for (const file of source.files) {
    for (let i=0; i<blockCount(file); i++) assert.deepEqual(copy.readRaw(file.id,i), source.disk.readRaw(file.id,i))
  }
  const book = privateBook(directory)
  try {
    const entries = book.call('unlock', {password:bookPass,code:token(source.secret,source.counter+1)})
    assert.deepEqual(entries[0].files, source.files)
    const file = source.files[1]
    const url = book.call('mediaPreview', {id:file.id})
    const response = book.mediaResponse(new Request(url, {headers:{ range:'bytes=-111' }}))
    assert.equal(response.status,206)
    assert.deepEqual(Buffer.from(await response.arrayBuffer()),source.lastBlock)
  } finally { book.lock() }
}

test('encrypted backup restores multi-block and empty media, rejects tampering and truncation, and reads legacy backups', async t => {
  const root = tempDir(t), a = path.join(root,'from'), b = path.join(root,'to')
  openStore(b)
  const source = setup(a)
  const encrypt = data => migration.pack(data,backupPass)
  const backup = async disk => {
    const pieces = []
    for await (const bytes of backupBytes(source.snapshot(),disk,encrypt)) pieces.push(bytes)
    return Buffer.concat(pieces)
  }
  async function restore(bytes, password = backupPass) {
    return restoreBackup(bytes.length,(offset,size)=>bytes.subarray(offset,offset+size),
      box => migration.unpack(box,password), data => migration.stage(b,data,{}),
      id => diskMedia(path.join(b,id)), id => migration.discard(b,id))
  }
  const bytes = await backup(source.disk)
  assert.equal(bytes.subarray(0,8).toString(),'MOMOBK2\n')
  assert(!bytes.includes('hidden filename.mp4'))
  assert(!bytes.includes('private test marker'))
  assert(!bytes.includes(source.files[1].id))
  const headerLength = bytes.readUInt32BE(8), header = bytes.subarray(12,12+headerLength)
  const unlocked = migration.unpack(header.toString(),backupPass)
  assert(unlocked.media.some(file => file.id === source.files[1].id && file.digest.length===64))
  assert.equal(headerLength < chunkSize,true)
  const before = fs.readdirSync(b)
  await assert.rejects(restore(bytes,'incorrect test passphrase'))
  const poisonedHeader = Buffer.from(bytes)
  const pos = 12 + header.indexOf('"data":"') + 8
  assert(pos > 20)
  poisonedHeader[pos] = poisonedHeader[pos]===65 ? 66 : 65
  await assert.rejects(restore(poisonedHeader))
  const poisonedMedia = Buffer.from(bytes)
  poisonedMedia[poisonedMedia.length-1] ^= 64
  await assert.rejects(restore(poisonedMedia),/校验/)
  await assert.rejects(restore(bytes.subarray(0,-1)),/长度|不完整/)
  assert.deepEqual(fs.readdirSync(b),before)
  const staged = await restore(bytes)
  assert.equal(migration.activePath(b), b)
  await checkRestored(path.join(b,staged),source)

  // Versions before chunked media produced a single encrypted JSON document.
  const old = source.snapshot()
  old.book = null
  const oldBytes = Buffer.from(migration.pack(old,backupPass))
  const restored = await restore(oldBytes)
  assert.deepEqual(openStore(path.join(b,restored)).data.notes, old.notes)
  assert.equal((await backup(diskMedia(path.join(root,'empty'))))[0], '{'.charCodeAt(0))
})

async function transfer(t, senderType, targetType, mobileHandoff) {
  const root = tempDir(t), a = path.join(root,'from'), b = path.join(root,'to')
  openStore(b)
  const source = setup(a)
  const sync = createSync(a,source.store,null,()=>{})
  sync.setEnabled(true,'http://localhost:3456','')
  sync.status('online',sync.link().room)
  const pair = sync.code()
  const follower = {code:'', setPair(value) {this.code=value;this.store=true}}
  const desktop = args => {
    const service = handoff({credentials:{},check(){},restart(){},...args})
    return (op,...data) => service[op](...data)
  }
  function mobile(isSource) {
    const values = new Map()
    const secure = {get:key=>structuredClone(values.get(key)), set:(key,value)=>values.set(key,structuredClone(value))}
    return mobileHandoff({
      get:key=>values.get(key),put:(key,value)=>values.set(key,value),secure,
      pair:()=>pair, snapshot:source.snapshot,current:()=>({pair,config:JSON.parse(fs.readFileSync(path.join(a,'sync.json')))}),
      stage:(data,config)=>{
        const id = migration.stage(b,data,{})
        fs.writeFileSync(path.join(b,id,'sync.json'),JSON.stringify(config))
        return id
      },
      discard:id=>migration.discard(b,id),activate:id=>migration.activate(b,id),
      demote:code=>follower.setPair(code),retireMedia:()=>source.disk.clear(),
      mediaFor:id=>diskMedia(isSource ? a : path.join(b,id)),
    })
  }
  const sender = senderType==='mobile' ? mobile(true) : desktop({root:a,directory:a,sync,follower,snapshot:source.snapshot})
  const target = targetType==='mobile' ? mobile(false) : desktop({root:b,directory:b,sync:{},follower:{code:pair}})
  const link = await target('ready')
  async function rpc(op,detail={}) {
    const id = transferId()
    const wire = seal(link.key,'handoff',{op,id,...detail})
    const result = unseal(link.key,'handoff/'+id,await target('receive',wire))
    if (result.error) throw new Error(result.error)
    return result.value
  }
  const hello = await rpc('hello')
  assert.equal(hello.mediaVersion,1)
  await assert.rejects(sender('prepare',link.code,hello.proof,0),/升级/)
  const { checksum,count,media } = await sender('prepare',link.code,hello.proof,hello.mediaVersion)
  for (let index=0;index<count;index++) await rpc('chunk',{checksum,index,chunk:await sender('chunk',index)})
  assert.equal((await rpc('stage',{checksum})).waitingForMedia,true)
  await assert.rejects(rpc('mediaFinish',{checksum}))
  await assert.rejects(rpc('activate',{checksum}))
  for (const [fileIndex,file] of media.entries()) {
    for (let index=0;index<blockCount(file);index++) {
      const bytes = await sender('mediaChunk',fileIndex,index)
      await rpc('mediaChunk',{checksum,fileId:file.id,index,bytes})
      if (index===0 && blockCount(file)>1) {
        await assert.rejects(rpc('mediaFinish',{checksum}))
        await assert.rejects(rpc('activate',{checksum}))
      }
    }
  }
  assert.equal((await rpc('mediaFinish',{checksum})).staged,checksum)
  assert.equal(migration.activePath(b),b)
  await sender('cutover',link.code,checksum)
  assert.equal((await sender('pending')).checksum,checksum)
  assert.equal(source.disk.list().length,2)
  await assert.rejects(rpc('activate',{checksum:'wrong'}))
  assert.equal(source.disk.list().length,2)
  const confirmed = await rpc('activate',{checksum})
  assert.deepEqual(confirmed,{done:true,checksum})
  assert.deepEqual(await rpc('activate',{checksum}),confirmed)
  assert.equal(source.disk.list().length,2)
  await checkRestored(migration.activePath(b),source)
  if (senderType==='mobile') {
    // The web client normally reloads after successful retirement.
    const timer = t.mock.method(globalThis,'setTimeout',()=>{})
    try { await sender('finish',confirmed.checksum) } finally { timer.mock.restore() }
  } else await sender('finish',confirmed.checksum)
  assert.equal(source.disk.list().length,0)
  assert.equal(await sender('pending'),null)
}

test('desktop handoff stages and verifies all files before activation and retains source until acknowledgement', t =>
  transfer(t,'desktop','desktop'))

test('desktop and mobile handoff protocols exchange chunked media in both directions', async t => {
  const { createServer } = await import('vite')
  const server = await createServer({ server:{middlewareMode:true}, appType:'custom', logLevel:'error' })
  try {
    const { mobileHandoff } = await server.ssrLoadModule('/src/mobile-handoff.js')
    await transfer(t,'desktop','mobile',mobileHandoff)
    await transfer(t,'mobile','desktop',mobileHandoff)
  } finally { await server.close() }
})
