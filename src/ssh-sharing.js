import { normalizeSSHShareHint } from '../shared/ssh-endpoint.mjs'

export function wireSSHSharing(api, errorMessage) {
  const $ = id => document.getElementById(id)
  const panel = $('ssh-share')
  const form = $('ssh-share-form')
  const fields = form.querySelector('fieldset')
  const host = $('ssh-share-host')
  const user = $('ssh-share-user')
  const port = $('ssh-share-port')
  const wifi = $('ssh-share-wifi')
  const revoke = $('ssh-share-revoke')
  const status = $('ssh-share-status')
  const android = api.platform === 'android'
  const defaultPort = android ? 8022 : 22
  $('ssh-share-port-label').textContent = android ? '端口（Termux 默认为 8022）' : '端口'
  $('ssh-share-termux').hidden = !android
  $('ssh-get-termux').onclick = () => api.openProject('termux').catch(error => { status.textContent = errorMessage(error) })
  $('ssh-share-device-help').textContent = api.mobile
    ? '在手机的 Wi-Fi 设置中点开已连接的网络，查看 IP 地址。用户名和端口以本设备 SSH 服务的配置为准。'
    : '在本机网络设置中查看当前局域网 IP，填写 SSH 服务允许登录的账号和监听端口。OpenSSH 默认端口为 22。'
  let scope, sequence = 0, loaded = false

  function fill(value) {
    host.value = value?.host || ''
    user.value = value?.username || ''
    port.value = value?.port ?? defaultPort
    revoke.hidden = !value
  }

  async function exchange(value) {
    if (!scope || fields.disabled) return
    const request = ++sequence
    fields.disabled = true
    status.textContent = value === undefined ? '正在读取共享状态…' : '正在等待主设备确认…'
    try {
      const hint = await api.sshHint(scope, value)
      if (request !== sequence) return
      loaded = true
      fill(hint)
      status.textContent = hint ? '已分享给当前主设备，可在「设备同步 → 绑定设备」查看。'
        : value === null ? '已撤回地址。主设备上手动保存的连接会保留。' : '尚未向当前主设备分享地址。'
    } catch (error) {
      if (request !== sequence) return
      status.textContent = errorMessage(error)
    } finally {
      if (request === sequence) fields.disabled = false
    }
  }

  panel.ontoggle = () => { if (panel.open && !loaded) void exchange(undefined) }
  form.onsubmit = event => {
    event.preventDefault()
    try {
      void exchange(normalizeSSHShareHint({ host: host.value, username: user.value, port: port.value }))
    } catch (error) { status.textContent = errorMessage(error) }
  }
  revoke.onclick = () => { void exchange(null) }
  wifi.hidden = !api.wifiAddress
  wifi.onclick = async () => {
    if (!scope || fields.disabled) return
    const request = ++sequence
    fields.disabled = true
    try {
      const address = await api.wifiAddress()
      if (request !== sequence) return
      host.value = address
      status.textContent = '已填入本机 Wi-Fi 地址。核对用户名和端口后，点击「分享给主设备」。'
    } catch {
      if (request === sequence) status.textContent = '未获取到当前 Wi-Fi 的 IPv4 地址。请在网络详情中查看并手动填写。'
    } finally {
      if (request === sequence) fields.disabled = false
    }
  }

  return state => {
    const follower = state.role === 'mobile' || state.role === 'follower'
    const next = (follower && state.enabled && api.sshHint && state.sshHintScope) || undefined
    panel.hidden = !next
    if (scope === next) return
    scope = next
    ++sequence
    loaded = false
    panel.open = false
    fields.disabled = false
    fill(null)
    status.textContent = ''
  }
}
