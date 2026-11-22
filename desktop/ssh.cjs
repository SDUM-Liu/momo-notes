const fs = require('node:fs')
const path = require('node:path')
const { normalizeSSHEndpoint } = require('../shared/ssh-endpoint.mjs')
const { spawn, execFile } = require('node:child_process')
const run = require('node:util').promisify(execFile)

function normalizeProfile(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('请填写 SSH 连接信息')
  if (Object.hasOwn(input, 'alias')) {
    const alias = typeof input.alias === 'string' ? input.alias.trim() : ''
    if (Object.hasOwn(input, 'host') || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(alias)) throw new Error('请输入有效的 SSH Host 别名')
    return { alias }
  }
  const port = input.port === undefined || input.port === '' ? 22 : input.port
  return normalizeSSHEndpoint({ host: input.host, user: input.user, port })
}

function sameTarget(a, b) {
  return JSON.stringify(a) === JSON.stringify(b)
}

function deviceProfiles(directory) {
  const filename = path.join(directory, 'ssh-devices.json')
  function read() {
    return fs.existsSync(filename) ? JSON.parse(fs.readFileSync(filename, 'utf8')) : {}
  }
  function entry(row) {
    // Older releases saved an alias only when the user explicitly allowed the AI check.
    if (typeof row === 'string' && row) return { profile: normalizeProfile({ alias: row }), permitted: true }
    if (row?.profile) return { profile: normalizeProfile(row.profile), permitted: row.permitted === true }
    return { profile: null, permitted: false }
  }
  function write(data) {
    fs.writeFileSync(filename + '.tmp', JSON.stringify(data), { mode: 0o600 })
    fs.renameSync(filename + '.tmp', filename)
  }
  return {
    get(id) { return entry(read()[id]) },
    save(id, value) {
      const profile = normalizeProfile(value), data = read()
      if (!sameTarget(entry(data[id]).profile, profile)) {
        data[id] = { profile, permitted: false }
        write(data)
      }
      return profile
    },
    permit(id, value) {
      if (typeof value !== 'boolean') throw new Error('无效的授权状态')
      const data = read(), current = entry(data[id])
      if (!current.profile && value) throw new Error('请先保存这台设备的 SSH 连接信息')
      if (current.permitted !== value) {
        data[id] = { profile: current.profile, permitted: value }
        write(data)
      }
      return value
    },
  }
}

function sshArguments(input, mode) {
  const profile = normalizeProfile(input)
  const strict = mode === 'terminal' ? 'ask' : 'yes'
  const args = ['-o', 'StrictHostKeyChecking=' + strict, '-o', 'ConnectTimeout=10']
  if (mode === 'hostname') args.push('-T', '-o', 'BatchMode=yes', '-o', 'ClearAllForwardings=yes')
  if (!profile.alias) args.push('-F', 'none', '-p', String(profile.port), '-l', profile.user)
  args.push(profile.alias || profile.host)
  if (mode === 'hostname') args.push('hostname')
  return args
}

const windowsSessionScript = [
  "$ErrorActionPreference = 'Stop'",
  'try {',
  '  $client = (Get-Command ssh.exe -CommandType Application).Source',
  '  [string[]]$sshArgs = ConvertFrom-Json $env:MOMO_SSH_ARGUMENTS',
  '  & $client @sshArgs',
  '  $status = $LASTEXITCODE',
  '} catch {',
  '  [Console]::Error.WriteLine($_.Exception.Message)',
  '  $status = 1',
  '}',
  'if ($status -ne 0) {',
  '  [Console]::Write("SSH 退出码 $status。按 Enter 关闭窗口")',
  '  [void][Console]::ReadLine()',
  '}',
  'exit $status',
].join('\n')

async function openTerminal(input, mode = 'terminal') {
  const args = sshArguments(input, mode)
  try {
    await run('ssh', ['-V'], { timeout: 4000, windowsHide: true })
  } catch {
    throw new Error(process.platform === 'win32' ? '请先在 Windows「可选功能」安装 OpenSSH 客户端' : '系统未找到 OpenSSH 客户端，请先安装 ssh')
  }
  try {
    if (process.platform === 'win32') {
      // Only fixed script text travels in the command line. SSH arguments stay separate in the child's environment.
      const encoded = Buffer.from(windowsSessionScript, 'utf16le').toString('base64')
      const script = `$ErrorActionPreference='Stop'; Start-Process -FilePath "$PSHOME/powershell.exe" -ArgumentList '-NoLogo','-NoProfile','-EncodedCommand','${encoded}' -WindowStyle Normal`
      await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
        env: { ...process.env, MOMO_SSH_ARGUMENTS: JSON.stringify(args) }, timeout: 12000, windowsHide: true,
      })
    } else if (process.platform === 'darwin') {
      const script = ['on run argv', 'set cmd to "/usr/bin/ssh"',
        'repeat with arg in argv', 'set cmd to cmd & " " & quoted form of (contents of arg)', 'end repeat',
        'tell application "Terminal"', 'activate', 'do script cmd', 'end tell', 'end run'].join('\n')
      await run('/usr/bin/osascript', ['-e', script, '--', ...args], { timeout: 30000 })
    } else {
      await new Promise((resolve, reject) => {
        const child = spawn('x-terminal-emulator', ['-e', 'ssh', ...args], { stdio: 'ignore' })
        child.once('error', reject)
        child.once('spawn', () => { child.unref(); resolve() })
      })
    }
    return true
  } catch {
    throw new Error('无法打开系统终端，请检查终端是否可用')
  }
}

async function hostName(profile) {
  const args = sshArguments(profile, 'hostname')
  let name
  try {
    const { stdout } = await run('ssh', args, { timeout: 12000, maxBuffer: 4096, windowsHide: true })
    name = stdout.trim()
  } catch { throw new Error('SSH 登录失败，请先在主设备终端确认网络、主机指纹和密钥登录') }
  if (!/^[\p{L}\p{N}_.-]{1,253}$/u.test(name)) throw new Error('设备返回的主机名无效')
  return name
}

module.exports = { normalizeProfile, sameTarget, deviceProfiles, sshArguments, openTerminal, hostName, windowsSessionScript }
