const { execFile } = require('node:child_process')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { promisify } = require('node:util')

const run = promisify(execFile)
const script = `
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$ErrorActionPreference = 'Stop'
$since = (Get-Date).AddHours(-8)
$logsAvailable = $true
try {
  $events = @(Get-WinEvent -FilterHashtable @{LogName='System';StartTime=$since;Id=1,14,41,42,107,153,1001,4101,6008} -MaxEvents 120 |
    Where-Object { $_.ProviderName -match 'Display|nvlddmkm|amdwddmg|igfx|Power-Troubleshooter|Kernel-Power|BugCheck|WER-SystemErrorReporting|^EventLog$' } |
    Select-Object -First 16 @{n='time';e={$_.TimeCreated.ToString('yyyy-MM-dd HH:mm:ss')}}, Id, ProviderName)
} catch {
  $events = @()
  $logsAvailable = $_.FullyQualifiedErrorId -like 'NoMatchingEventsFound*'
}
$adapters = @(Get-CimInstance -ClassName Win32_VideoController | Select-Object Name, DriverVersion, Status)
$boot = (Get-CimInstance -ClassName Win32_OperatingSystem).LastBootUpTime
@{checkedAt=(Get-Date).ToString('yyyy-MM-dd HH:mm:ss'); boot=$boot.ToString('yyyy-MM-dd HH:mm:ss');
  adapters=$adapters; events=$events; logsAvailable=$logsAvailable} | ConvertTo-Json -Depth 4 -Compress
`

async function checkWindowsDisplay() {
  try {
    const { stdout } = await run('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64'),
    ], { windowsHide: true, timeout: 15000, maxBuffer: 128 * 1024, encoding: 'utf8' })
    const result = JSON.parse(stdout.trim())
    return [
      '电脑检查时间 · ' + result.checkedAt,
      '上次启动 · ' + result.boot,
      ...result.adapters.map(item => [item.Name, item.DriverVersion, item.Status].filter(Boolean).join(' · ')),
      '',
      '最近 8 小时的显示、睡眠和异常关机事件',
      ...(result.logsAvailable
        ? result.events.length ? result.events.map(item => item.time + ' · ' + item.ProviderName + ' · ' + item.Id)
          : ['未找到匹配事件。仅凭这次检查还无法确定黑屏原因。']
        : ['系统事件日志读取失败。']),
    ].join('\n')
  } catch {
    throw new Error('电脑未能读取显示设备或系统信息，请稍后重试')
  }
}

async function checkLinuxDisplay() {
  const root = '/sys/class/drm'
  const cards = (await fs.readdir(root).catch(() => [])).filter(name => /^card\d+$/.test(name))
  const adapters = await Promise.all(cards.map(async name => {
    const device = path.join(root, name, 'device')
    const [vendor, model, driver] = await Promise.all([
      fs.readFile(path.join(device, 'vendor'), 'utf8').catch(() => ''),
      fs.readFile(path.join(device, 'device'), 'utf8').catch(() => ''),
      fs.readlink(path.join(device, 'driver')).catch(() => ''),
    ])
    return [name, vendor.trim() && model.trim() ? vendor.trim() + ':' + model.trim() : '', path.basename(driver)]
      .filter(Boolean).join(' · ')
  }))
  let events
  try {
    const options = ['--no-pager', '--dmesg', '--since', '8 hours ago', '--output', 'short-iso',
      '--lines', '16', '--grep', 'drm.*(error|fail|timeout)|gpu.*(hang|reset|timeout|fault)|nvrm.*xid|amdgpu.*(error|reset)|PM:.*(suspend|resume)|systemd-shutdown',
      '--case-sensitive=no']
    const { stdout } = await run('journalctl', options, { timeout: 12000, maxBuffer: 128 * 1024 })
    events = stdout.trim()
  } catch (error) {
    if (error.code === 1 && !String(error.stderr).trim()) events = ''
  }
  const format = value => new Date(value).toLocaleString()
  return [
    '电脑检查时间 · ' + format(Date.now()),
    '上次启动 · ' + format(Date.now() - os.uptime() * 1000),
    ...adapters,
    '',
    '最近 8 小时的显示和电源事件（当前账号可读）',
    events === undefined ? '系统事件日志不可用，请检查当前账号的日志读取权限。'
      : events || '未找到匹配事件。仅凭这次检查还无法确定黑屏原因。',
  ].join('\n')
}

async function checkDisplay() {
  if (process.platform === 'win32') return checkWindowsDisplay()
  if (process.platform === 'linux') return checkLinuxDisplay()
  throw new Error('黑屏记录检查支持 Windows 和 Linux 电脑')
}

module.exports = { checkDisplay }
