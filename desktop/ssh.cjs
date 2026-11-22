const { spawn, execFile } = require('node:child_process')
const inspect = require('node:util').promisify(execFile)
function openTerminal(alias) {
  if (typeof alias !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(alias))
    throw new Error('请输入已配置的 SSH Host 别名')
  const args = ['-o', 'StrictHostKeyChecking=yes', alias]
  let program, options
  if (process.platform === 'win32') {
    program = 'powershell.exe'
    options = ['-NoProfile', '-NonInteractive', '-Command', "Start-Process ssh.exe -ArgumentList '-o','StrictHostKeyChecking=yes','" + alias + "'"]
  } else if (process.platform === 'darwin') {
    program = '/usr/bin/osascript'
    options = ['-e', 'tell application "Terminal" to do script "ssh -o StrictHostKeyChecking=yes ' + alias + '"']
  } else { program = 'x-terminal-emulator'; options = ['-e', 'ssh', ...args] }
  return new Promise((resolve, reject) => {
    const child = spawn(program, options, { stdio: 'ignore', windowsHide: true })
    child.once('error', () => reject(new Error('系统 SSH 客户端或终端不可用')))
    child.once('spawn', () => { child.unref(); resolve(true) })
  })
}
async function hostName(alias) {
  if (typeof alias !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(alias)) throw new Error('SSH 别名无效')
  try {
    const { stdout } = await inspect('ssh', ['-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
      '-o', 'ClearAllForwardings=yes', '-o', 'ConnectTimeout=6', alias, 'hostname'],
      { timeout: 10000, maxBuffer: 4096, windowsHide: true })
    return stdout.trim().slice(0, 255)
  } catch { throw new Error('SSH 登录失败，请先在主设备终端确认网络、主机指纹和密钥登录') }
}
module.exports = { openTerminal, hostName }
