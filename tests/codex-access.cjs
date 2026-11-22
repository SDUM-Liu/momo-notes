const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { test } = require('node:test')
const { setTimeout: sleep } = require('node:timers/promises')
const { createCodex } = require('../desktop/codex.cjs')
const { openStore, localDay } = require('../desktop/data.cjs')

test('default access applies to notes and new and resumed conversations, with a persistent opt-out', async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'momo-ai-access-'))
  const store = openStore(profile)
  const date = localDay()
  store.saveNote(date, { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'A note to test' }] }] })
  const outside = path.join(profile, 'other-project')
  fs.mkdirSync(outside)
  const existing = { id: 'existing', cwd: outside, status: { type: 'idle' } }
  fs.writeFileSync(path.join(profile, 'codex-integration.json'), JSON.stringify({ write: false }))
  const calls = []
  const launches = []
  let holdTurn, steered
  let nextId = 0
  let approvals = 0
  const approve = async () => { ++approvals; return 'accept' }
  const spawn = options => {
    const events = new EventEmitter()
    launches.push(options)
    return {
      events, ready: Promise.resolve(), close() {},
      async request(method, params) {
        switch (method) {
          case 'account/read': return { account: { type: 'chatgpt' } }
          case 'thread/list': return { data: params.archived ? [] : [existing] }
          case 'thread/read': return { thread: existing }
          case 'thread/turns/list': return { data: [] }
          case 'thread/start':
          case 'thread/resume':
            calls.push([method, params])
            return { thread: { id: params.threadId || 'thread-' + ++nextId } }
          case 'turn/steer': steered = params; return { turnId: params.expectedTurnId }
          case 'turn/start': {
            calls.push([method, params])
            if (!options.noteMode) {
              const response = await options.onRequest('item/commandExecution/requestApproval', { threadId: params.threadId })
              assert.equal(response.decision, params.approvalPolicy === 'never' ? 'decline' : 'accept')
            }
            const finish = () => events.emit('notification', 'turn/completed', {
              threadId: params.threadId, turnId: 'turn', turn: { status: 'completed' },
            })
            if (holdTurn) holdTurn = finish; else setImmediate(finish)
            return { turn: { id: 'turn' } }
          }
          default: throw new Error('Unexpected request ' + method)
        }
      },
    }
  }
  const codex = createCodex(profile, store, approve, spawn)
  const noteQuestion = { date, question: 'Summarize this note' }
  async function check(job, method, sandbox, approval, policy) {
    for (let attempt = 0; attempt < 200 && job.status === 'running'; ++attempt) {
      await sleep(10)
      job = codex.jobResult(job.id)
    }
    assert.equal(job.status, 'completed', job.error)
    assert.equal(calls.length, 2)
    const [start, turn] = calls.splice(0)
    assert.equal(start[0], method)
    assert.equal(start[1].sandbox, sandbox)
    assert.equal(start[1].approvalPolicy, approval)
    assert.equal(turn[0], 'turn/start')
    assert.equal(turn[1].approvalPolicy, approval)
    assert.equal(turn[1].sandboxPolicy.type, policy)
    return start[1]
  }

  try {
    assert.equal(codex.settings().fullAccess, true)
    assert.throws(() => codex.ask(noteQuestion, true), /允许已配对设备/)
    assert.throws(() => codex.send({ prompt: 'A task' }, true), /允许已配对设备/)
    codex.configure({ enabled: true, shareAll: true })
    const job = codex.ask(noteQuestion)
    assert.throws(() => codex.jobResult(job.id, true), /尚未在主机共享/)
    const note = await check(job, 'thread/start', 'danger-full-access', 'never', 'dangerFullAccess')
    assert.equal(note.ephemeral, true)
    assert.equal(launches.at(-1).fullAccess, true)
    await check(codex.ask(noteQuestion, true), 'thread/start', 'danger-full-access', 'never', 'dangerFullAccess')
    await check(codex.send({ prompt: 'A chat' }, false), 'thread/start', 'danger-full-access', 'never', 'dangerFullAccess')
    const resumed = await check(codex.send({ prompt: 'A task', taskMode: true, id: existing.id }, true),
      'thread/resume', 'danger-full-access', 'never', 'dangerFullAccess')
    assert.equal(resumed.cwd, fs.realpathSync(outside))
    assert.equal(approvals, 0)
    holdTurn = true
    const running = codex.send({ prompt: 'First' }, false)
    for (let i = 0; i < 100 && !codex.jobResult(running.id).turnId; i++) await sleep(10)
    await assert.rejects(codex.steer({ id: running.id, turnId: 'stale', prompt: 'Second' }, true))
    await codex.steer({ id: running.id, turnId: 'turn', prompt: 'Second' }, true)
    assert.equal(steered.expectedTurnId, 'turn')
    assert.equal(steered.input[0].text, 'Second')
    holdTurn(); holdTurn = false
    await check(running, 'thread/start', 'danger-full-access', 'never', 'dangerFullAccess')

    codex.configure({ fullAccess: false, write: true })
    assert.equal(createCodex(profile, store, approve, spawn).settings().fullAccess, false)
    await check(codex.ask(noteQuestion), 'thread/start', 'read-only', 'never', 'readOnly')
    assert.equal(launches.at(-1).fullAccess, false)
    await check(codex.send({ prompt: 'A restricted task' }, false), 'thread/start', 'workspace-write', 'on-request', 'workspaceWrite')
    assert.equal(approvals, 1)
  } finally {
    codex.close()
    fs.rmSync(profile, { recursive: true, force: true })
  }
})
