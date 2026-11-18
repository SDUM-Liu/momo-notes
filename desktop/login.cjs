const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { app } = require('electron')

function windowsOptions() {
  return app.isPackaged ? { path: process.execPath } : { path: process.execPath, args: [app.getAppPath()] }
}

function linuxEntry() {
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'autostart', 'io.github.sdumliu.momo-notes.desktop')
}

function quote(value) {
  const escaped = value.replace(/[\\`"$]/g, '\\$&').replace(/\\/g, '\\\\').replace(/%/g, '%%')
  return '"' + escaped + '"'
}

function opensAtLogin() {
  if (process.platform === 'linux') return fs.existsSync(linuxEntry())
  const options = process.platform === 'win32' ? windowsOptions() : {}
  return app.getLoginItemSettings(options).openAtLogin
}

function setOpenAtLogin(enabled) {
  if (process.platform !== 'linux') {
    const options = process.platform === 'win32' ? windowsOptions() : {}
    app.setLoginItemSettings({ ...options, openAtLogin: enabled })
    return
  }
  const entry = linuxEntry()
  if (!enabled) {
    fs.rmSync(entry, { force: true })
    return
  }
  const executable = process.env.APPIMAGE || process.execPath
  const command = app.isPackaged ? [executable] : [executable, app.getAppPath()]
  if (command.some(value => /[\r\n]/.test(value))) throw new Error('启动路径包含不支持的换行符')
  fs.mkdirSync(path.dirname(entry), { recursive: true })
  fs.writeFileSync(entry + '.tmp', [
    '[Desktop Entry]', 'Type=Application', 'Name=Momo Notes',
    'Exec=' + command.map(quote).join(' '), 'Terminal=false', '',
  ].join('\n'))
  fs.renameSync(entry + '.tmp', entry)
}

module.exports = { opensAtLogin, setOpenAtLogin }
