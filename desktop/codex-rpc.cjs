const path = require('node:path')
const fs = require('node:fs')
const { spawn } = require('node:child_process')
const { createInterface } = require('node:readline')
const { EventEmitter } = require('node:events')
const { version } = require('../package.json')

function codexExecutable() {
  const directories = (process.env.PATH ?? '').split(path.delimiter)
  if (process.platform === 'win32') {
    if (process.env.APPDATA) directories.unshift(path.join(process.env.APPDATA, 'npm'))
    const tuple = process.arch === 'arm64' ? 'aarch64' : 'x86_64'
    for (const directory of directories) {
      if (!path.isAbsolute(directory)) continue
      const native = path.join(directory, 'node_modules', '@openai', 'codex', 'node_modules', '@openai',
        'codex-win32-' + process.arch, 'vendor', tuple + '-pc-windows-msvc', 'bin', 'codex.exe')
      if (fs.existsSync(native)) return native
      const executable = path.join(directory, 'codex.exe')
      if (fs.existsSync(executable)) return executable
    }
  } else {
    for (const directory of [...directories, '/opt/homebrew/bin', '/usr/local/bin']) {
      if (!path.isAbsolute(directory)) continue
      const executable = path.join(directory, 'codex')
      try { fs.accessSync(executable, fs.constants.X_OK); return executable } catch {}
    }
  }
  throw new Error('主机找不到 Codex CLI，请安装并登录后重试')
}

function appServer({ cwd, noteMode = false, onRequest = async () => undefined, launch = spawn }) {
  const args = ['app-server', '--listen', 'stdio://', '-c', 'forced_login_method="chatgpt"']
  if (noteMode) {
    args.push('--disable', 'shell_tool', '--disable', 'apps', '--disable', 'plugins', '--disable', 'memories',
      '--disable', 'multi_agent', '--disable', 'multi_agent_v2', '-c', 'web_search="disabled"', '-c', 'mcp_servers={}')
  }
  const env = { ...process.env }
  delete env.OPENAI_API_KEY
  delete env.CODEX_API_KEY
  // This process uses the standalone CLI and has no ChatGPT desktop package identity.
  delete env.CODEX_WINDOWS_REGISTERED_CORE
  delete env.CODEX_WINDOWS_SANDBOX_PACKAGE_FAMILY
  const child = launch(codexExecutable(), args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
  const events = new EventEmitter()
  const pending = new Map()
  let nextId = 0, closed = false
  const errorMessage = '主机的 Codex 服务已结束，请检查 CLI 安装和登录状态'
  function write(value) {
    if (!closed) child.stdin.write(JSON.stringify(value) + '\n')
  }
  function request(method, params, timeout = 35000) {
    if (closed) return Promise.reject(new Error(errorMessage))
    return new Promise((resolve, reject) => {
      const id = ++nextId
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error('Codex 请求超时：' + method))
      }, timeout)
      pending.set(id, { resolve, reject, timer })
      write({ id, method, params })
    })
  }
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity })
  lines.on('line', line => {
    let message
    try { message = JSON.parse(line) } catch { return }
    if (message.method && message.id !== undefined) {
      Promise.resolve().then(() => onRequest(message.method, message.params)).then(result => {
        if (result === undefined) write({ id: message.id, error: { code: -32601, message: 'Unsupported client request' } })
        else write({ id: message.id, result })
      }).catch(() => write({ id: message.id, error: { code: -32603, message: 'Client request failed' } }))
    } else if (message.method) {
      events.emit('notification', message.method, message.params ?? {})
    } else {
      const call = pending.get(message.id)
      if (!call) return
      clearTimeout(call.timer)
      pending.delete(message.id)
      if (message.error) call.reject(Object.assign(new Error(message.error.message), { code: message.error.code }))
      else call.resolve(message.result)
    }
  })
  const finish = error => {
    if (closed) return
    closed = true
    for (const call of pending.values()) { clearTimeout(call.timer); call.reject(error) }
    pending.clear()
    events.emit('closed', error)
  }
  child.stderr.resume()
  child.stdin.on('error', finish)
  child.on('error', finish)
  child.on('exit', () => finish(new Error(errorMessage)))
  const ready = request('initialize', {
    clientInfo: { name: 'momo_notes', title: '桃桃便签', version },
    capabilities: { experimentalApi: noteMode, requestAttestation: false },
  }).then(() => write({ method: 'initialized' }))
  return { request, ready, events, close() { child.kill(); finish(new Error(errorMessage)) } }
}

module.exports = { appServer, codexExecutable }
