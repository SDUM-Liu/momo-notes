export function normalizeSSHEndpoint(value) {
  let host = typeof value?.host === 'string' ? value.host.trim() : ''
  const user = typeof value?.user === 'string' ? value.user.trim() : ''
  const portText = String(value?.port ?? '').trim()
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1)
  if (host.includes(':')) {
    try {
      if (!/^[a-f\d:.]+$/i.test(host)) throw new Error()
      host = new URL('http://[' + host + ']').hostname.slice(1, -1)
    } catch { throw new Error('请输入有效的 IPv6 地址，并将端口填在端口栏') }
  } else {
    const absolute = host.endsWith('.') && !/^[\d.]+$/.test(host)
    const labels = (absolute ? host.slice(0, -1) : host).split('.')
    const numeric = /^[\d.]+$/.test(host)
    if (host.length > 253 || labels.some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label)) ||
        (numeric && (labels.length !== 4 || labels.some(part => String(Number(part)) !== part || Number(part) > 255)))) {
      throw new Error('请输入设备的 IP 地址或主机名')
    }
  }
  const account = /^[a-z0-9_][a-z0-9._-]*(?:[\\@][a-z0-9_][a-z0-9._-]*)?$/i
  if (user.length > 128 || !account.test(user)) throw new Error('请输入 SSH 服务使用的登录用户名')
  const port = Number(portText)
  if (!/^\d{1,5}$/.test(portText) || port < 1 || port > 65535) throw new Error('端口应为 1 至 65535 的整数')
  return { host, user, port }
}

export function normalizeSSHShareHint(value) {
  const { host, user, port } = normalizeSSHEndpoint({ host: value?.host, user: value?.username, port: value?.port })
  return { host, username: user, port }
}
