const $ = id => document.getElementById(id)
const platformNames = { android: 'Android', ios: 'iOS', darwin: 'macOS', macos: 'macOS', linux: 'Linux', win32: 'Windows', windows: 'Windows' }

function labelFor(device) {
  return (platformNames[device.platform.toLowerCase()] || device.platform) + ' · ' + device.id.slice(0, 8)
}

function addressText(profile) {
  if ('alias' in profile) return profile.alias
  const host = profile.host.includes(':') ? '[' + profile.host + ']' : profile.host
  return profile.user + '@' + host + ':' + profile.port
}

function sharedAddress(device) {
  const hint = device.sshHint
  return hint && { host: hint.host, user: hint.username, port: hint.port }
}

function platformHelp(device) {
  switch (device.platform.toLowerCase()) {
    case 'android': return '在手机上打开提供 SSH 服务的应用。使用 Termux 时，可依次运行 pkg install openssh、passwd 和 sshd，再用 whoami 查看用户名。Termux 默认端口为 8022。'
    case 'mac': case 'darwin': case 'macos': return '在目标 Mac 的「系统设置 → 通用 → 共享」开启「远程登录」，将系统显示的用户名和地址填入这里。'
    case 'win32': case 'windows': return '在目标电脑的 Windows「可选功能」安装 OpenSSH 服务器，再在「服务」启动 OpenSSH SSH Server。使用该电脑的登录用户名。'
    case 'iphone': case 'ipad': case 'ios': return '在 iPhone 或 iPad 上打开提供 SSH 服务的应用，保持服务运行，填写应用显示的地址、用户名和端口。'
    default: return '在目标电脑启动 OpenSSH 服务，使用该电脑的登录用户名。Ubuntu 可运行 whoami 查看用户名，运行 hostname -I 查看局域网地址。'
  }
}

function action(text, onClick, style) {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = style
  button.textContent = text
  button.onclick = onClick
  return button
}

export function wireSSHDevices(api, errorMessage) {
  const list = $('sync-device-list'), status = $('ssh-list-status'), dialog = $('ssh-dialog')
  const form = $('ssh-form'), mode = $('ssh-mode'), result = $('ssh-result')
  const host = $('ssh-host'), user = $('ssh-user'), port = $('ssh-port'), alias = $('ssh-alias')
  const permission = $('ssh-permission')
  const canConnect = !api.mobile && Boolean(api.deviceSSHProfile && api.deviceSSHConnect)
  const rows = new Map()
  let opened = null

  function updateRow(row) {
    const { device, profile } = row
    row.title.textContent = labelFor(device)
    const connection = profile ? addressText(profile) : device.sshHint ? '已分享 SSH 地址' : '待设置 SSH'
    row.caption.textContent = (device.online ? '同步在线' : '同步离线') + (canConnect ? ' · ' + connection : '')
    if (!canConnect) return
    row.connect.textContent = profile ? '连接' : '设置连接'
    row.connect.disabled = row.loading || row.connecting
    row.edit.hidden = !profile
  }

  function setMode() {
    const byAlias = mode.value === 'alias'
    $('ssh-alias-field').hidden = !byAlias
    $('ssh-address-fields').hidden = byAlias
    alias.disabled = !byAlias
    for (const field of [host, user, port]) field.disabled = byAlias
  }

  function fill(profile = {}) {
    mode.value = profile.alias ? 'alias' : 'address'
    host.value = profile.host || ''
    user.value = profile.user || ''
    port.value = profile.port || 22
    alias.value = profile.alias || ''
    setMode()
  }

  function draft() {
    return mode.value === 'alias' ? { alias: alias.value.trim() }
      : { host: host.value.trim(), user: user.value.trim(), port: Number(port.value) }
  }

  function updateControls(session) {
    const { row, busy, allowed } = session
    $('ssh-save').disabled = $('ssh-connect').disabled = busy
    $('ssh-ai').hidden = !api.deviceSSHPermission || !row.profile
    const changed = row.profile && addressText(draft()) !== addressText(row.profile)
    permission.disabled = busy || allowed === null || (!allowed && changed)
    permission.textContent = allowed ? '撤销 AI 主机名检查' : changed ? '保存新地址后可以授权' : '允许 AI 检查主机名'
  }

  async function loadPermission(session) {
    if (!session.row.profile || !api.deviceSSHPermission) return
    session.allowed = null
    updateControls(session)
    try {
      const allowed = await api.deviceSSHPermission(session.row.device.id)
      if (opened !== session) return
      session.allowed = allowed
      updateControls(session)
    } catch (error) {
      if (opened === session) result.textContent = errorMessage(error)
    }
  }

  function updateHint(session) {
    const { row } = session
    const hint = sharedAddress(row.device)
    const target = hint ? addressText(hint) : ''
    if (target === session.hintTarget) return
    session.hintTarget = target
    const canFill = !row.profile && !session.edited && !session.legacy
    if (canFill) fill(hint || { port: row.device.platform === 'Android' ? 8022 : 22 })
    $('ssh-hint').hidden = !hint && Boolean(row.profile || session.legacy)
    $('ssh-hint').textContent = hint
      ? canFill ? '已填入从设备分享的信息，核对后即可连接。' : '从设备分享了 ' + target
      : '可以手动填写，也可以先在从设备的「设置 → 设备同步」点「分享本设备的 SSH 地址」。'
    $('ssh-use-hint').hidden = !hint || addressText(draft()) === target
    updateControls(session)
  }

  function edit(row) {
    const { device, profile } = row
    const legacy = localStorage.getItem('ssh/' + device.id)
    const session = { row, busy: false, allowed: null, edited: false, legacy }
    opened = session
    fill(profile || (legacy ? { alias: legacy } : {}))
    $('ssh-title').textContent = profile ? '连接设置' : '连接设备'
    $('ssh-device-label').textContent = labelFor(device)
    $('ssh-platform-help').textContent = platformHelp(device)
    $('ssh-help').open = !profile && !device.sshHint && !legacy
    $('ssh-ai').open = false
    updateHint(session)
    $('ssh-use-hint').onclick = () => {
      const hint = sharedAddress(row.device)
      if (!hint) return
      fill(hint)
      session.edited = true
      $('ssh-use-hint').hidden = true
      result.textContent = '已填入分享的信息，保存后生效。'
      updateControls(session)
    }
    result.textContent = row.loadError || ''
    updateControls(session)
    dialog.showModal()
    void loadPermission(session)
  }

  async function launch(row) {
    if (!row.profile) { edit(row); return }
    row.connecting = true
    updateRow(row)
    try {
      await api.deviceSSHConnect(row.device.id, row.profile)
      status.textContent = '已为 ' + labelFor(row.device) + ' 打开系统终端，请在终端中查看连接结果。'
    } catch (error) {
      status.textContent = errorMessage(error) + '。可打开「连接设置」核对地址。'
    } finally {
      row.connecting = false
      updateRow(row)
    }
  }

  function createRow(device) {
    const element = document.createElement('div'), label = document.createElement('div')
    const title = document.createElement('strong'), caption = document.createElement('small')
    const row = { device, element, title, caption, profile: null, loading: canConnect }
    element.className = 'ssh-device'
    label.append(title, caption)
    element.append(label)
    if (canConnect) {
      row.connect = action('设置连接', () => void launch(row), 'primary')
      row.edit = action('连接设置', () => edit(row), 'quiet')
      element.append(row.connect, row.edit)
      void api.deviceSSHProfile(device.id).then(profile => { row.profile = profile })
        .catch(error => { row.loadError = errorMessage(error) })
        .finally(() => { row.loading = false; updateRow(row) })
    }
    return row
  }

  async function submit(connect) {
    const session = opened
    if (!session || session.busy || !form.reportValidity()) return
    const { row } = session
    session.busy = true
    updateControls(session)
    result.textContent = connect ? '正在打开系统终端…' : '正在保存…'
    try {
      const profile = draft()
      row.profile = connect ? await api.deviceSSHConnect(row.device.id, profile) : await api.deviceSSHProfile(row.device.id, profile)
      row.loadError = ''
      updateRow(row)
      if (opened !== session) return
      status.textContent = connect ? '已为 ' + labelFor(row.device) + ' 打开系统终端，请在终端中查看连接结果。' : '已保存 ' + labelFor(row.device) + ' 的连接设置。'
      dialog.close()
    } catch (error) {
      if (opened === session) result.textContent = errorMessage(error)
    } finally {
      session.busy = false
      if (opened === session) updateControls(session)
    }
  }

  mode.onchange = () => { setMode(); if (opened) updateControls(opened) }
  form.oninput = () => {
    if (!opened) return
    opened.edited = true
    updateControls(opened)
  }
  form.onsubmit = event => { event.preventDefault(); void submit(true) }
  $('ssh-save').onclick = () => void submit(false)
  $('ssh-close').onclick = () => dialog.close()
  dialog.addEventListener('close', () => { if (!dialog.open) opened = null })

  permission.onclick = async () => {
    const session = opened
    if (!session || session.busy || permission.disabled) return
    session.busy = true
    updateControls(session)
    try {
      session.allowed = await api.deviceSSHPermission(session.row.device.id, !session.allowed)
      if (opened === session) result.textContent = session.allowed
        ? '已允许。在桃桃 AI 中发送「检查设备 ' + session.row.device.id.slice(0, 8) + '」。' : '已撤销授权。'
    } catch (error) {
      if (opened === session) result.textContent = errorMessage(error)
    } finally {
      session.busy = false
      if (opened === session) updateControls(session)
    }
  }

  return function drawDeviceList(devices) {
    const ids = new Set(devices.map(device => device.id))
    for (const [id, row] of rows) {
      if (ids.has(id)) continue
      if (opened?.row === row && dialog.open) dialog.close()
      rows.delete(id)
      row.element.remove()
    }
    if (!devices.length) {
      list.textContent = '从设备配对并完成一次同步后，会出现在这里。'
      status.textContent = ''
      return
    }
    if (!rows.size) list.replaceChildren()
    for (const device of devices) {
      let row = rows.get(device.id)
      if (!row) {
        row = createRow(device)
        rows.set(device.id, row)
        list.append(row.element)
      }
      row.device = device
      updateRow(row)
      if (opened?.row === row && dialog.open) updateHint(opened)
    }
  }
}
