const { execFile } = require('node:child_process')
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

async function checkDisplay() {
  if (process.platform !== 'win32') throw new Error('黑屏记录检查目前支持 Windows 电脑')
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

module.exports = { checkDisplay }
