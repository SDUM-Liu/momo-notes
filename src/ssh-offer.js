import { offerSSHRelay } from '../shared/ssh-session.mjs'
import { normalizeSSHEndpoint } from '../shared/ssh-endpoint.mjs'

async function localSSH(api, port) {
  const { id } = await api.sshLocalOpen({ port })
  let closed = false
  return {
    async read() {
      while (!closed) {
        const { data } = await api.sshLocalRead({ id })
        if (data === null) return null
        if (data) return Uint8Array.from(atob(data), ch => ch.charCodeAt(0))
      }
      return null
    },
    write(bytes) { return api.sshLocalWrite({ id, data: btoa(String.fromCharCode(...bytes)) }) },
    async close() {
      if (!closed) { closed = true; await api.sshLocalClose({ id }) }
    },
  }
}

export function wireRemoteSSH(api, errorMessage) {
  const $ = id => document.getElementById(id)
  const panel = $('remote-ssh'), form = $('remote-ssh-form'), user = $('remote-ssh-user'), port = $('remote-ssh-port')
  const status = $('remote-ssh-status'), start = $('remote-ssh-start'), end = $('remote-ssh-stop')
  const android = api.platform === 'android'
  const setup = $('termux-setup'), setupStatus = $('termux-setup-status')
  const install = $('termux-setup-install'), configure = $('termux-setup-open'), check = $('termux-setup-check')
  setup.hidden = !api.termuxStatus || !api.openTermuxSetup
  $('remote-ssh-guide').textContent = android
    ? '使用 Termux 时，运行 pkg install openssh，然后用 passwd 设置登录密码。运行 sshd 启动服务，最后用 whoami 查看用户名，端口默认是 8022。回到桃桃后保持应用在前台。'
    : api.mobile ? '先启用能在后台运行的本机 SSH 服务，填写它提供的用户名和监听端口，使用时保持桃桃在前台。'
    : '请先在这台从设备上开启 OpenSSH 服务。Mac 可在「系统设置 → 通用 → 共享」中开启「远程登录」。'
  $('remote-ssh-termux').hidden = !android
  $('remote-ssh-termux').onclick = () => api.openProject('termux').catch(error => { status.textContent = errorMessage(error) })
  let scope, active
  let detection = 0

  async function detectTermux() {
    if (setup.hidden || !scope || active) return
    const revision = ++detection
    check.disabled = true
    try {
      const termux = await api.termuxStatus()
      if (revision !== detection) return
      install.hidden = termux.installed
      configure.hidden = !termux.installed || termux.ready
      if (termux.ready && termux.username) {
        if (!user.value || !user.dataset.custom) {
          user.value = termux.username
          port.value = termux.port
        }
        setupStatus.textContent = '已检测到 Termux 本机 SSH。可以允许电脑连接一次。'
      } else {
        setupStatus.textContent = termux.installed
          ? '复制配置命令并打开 Termux，粘贴后按回车，按提示设置 SSH 密码。完成后返回桃桃。'
          : '首次使用请安装官方 Termux。安装后返回桃桃继续配置。'
      }
    } catch (error) {
      if (revision === detection) setupStatus.textContent = errorMessage(error)
    } finally {
      if (revision === detection) check.disabled = false
    }
  }
  install.onclick = () => api.openProject('termux').catch(error => { setupStatus.textContent = errorMessage(error) })
  configure.onclick = () => api.openTermuxSetup().catch(error => { setupStatus.textContent = errorMessage(error) })
  check.onclick = () => void detectTermux()
  user.oninput = port.oninput = () => { user.dataset.custom = 'true' }

  function render(message) {
    start.hidden = Boolean(active)
    end.hidden = !active
    port.disabled = user.disabled = Boolean(active)
    status.textContent = message
  }

  function discard(session, message) {
    if (active !== session) return
    active = null
    session.controller.abort()
    session.link?.close()
    if (session.link) void api.sshOffer(session.scope, null, session.link.grant.room).catch(() => {})
    render(message)
  }

  async function begin() {
    if (!scope || active || !form.reportValidity()) return
    let endpoint
    try { endpoint = normalizeSSHEndpoint({ host: '127.0.0.1', user: user.value, port: port.value }) }
    catch (error) { render(errorMessage(error)); return }
    const session = { scope, controller: new AbortController() }
    active = session
    render('正在连接异地同步服务…')
    try {
      const routes = await api.sshRoutes(scope)
      for (const relay of routes) {
        if (active !== session) return
        // Failed registration can fall back. Once published, an invitation is bound to one room.
        let registered = false
        try {
          session.link = await offerSSHRelay({ relay, signal: session.controller.signal,
            openPipe: async () => {
              if (active !== session) throw new Error('邀请已取消')
              return localSSH(api, endpoint.port)
            },
            onConnected: () => {
              session.connected = true
              if (active === session) render('异地 SSH 已连接，可随时结束本次会话。')
            },
            onClose: error => { if (registered) discard(session, error ? errorMessage(error) : '本次连接已结束。') },
          })
          registered = true
          break
        } catch (error) { if (relay === routes.at(-1)) throw error }
      }
      if (active !== session) { session.link?.close(); return }
      const grant = { ...session.link.grant, user: endpoint.user }
      await api.sshOffer(session.scope, grant)
      if (active !== session) {
        await api.sshOffer(session.scope, null, grant.room).catch(() => {})
        return
      }
      try { localStorage.setItem('ssh-remote/' + scope, JSON.stringify({ user: endpoint.user, port: endpoint.port })) } catch {}
      if (!session.connected) render('请在两分钟内到电脑的「设置 → 设备同步 → 绑定设备」点「异地连接」。' + (api.mobile ? '请保持桃桃在前台。' : ''))
    } catch (error) { discard(session, errorMessage(error)) }
  }

  form.onsubmit = event => { event.preventDefault(); void begin() }
  end.onclick = () => { if (active) discard(active, '本次连接已取消。') }
  window.addEventListener('pagehide', () => { if (active) discard(active, '') })
  if (api.mobile) document.addEventListener('visibilitychange', () => {
    if (document.hidden && active) discard(active, '应用已切到后台。如需连接，请重新允许。')
    if (!document.hidden) void detectTermux()
  })
  return state => {
    const next = Boolean(api.sshLocalOpen && api.sshOffer && state.enabled && ['mobile', 'follower'].includes(state.role)) && state.sshHintScope
    panel.hidden = !next
    if (scope === next) return
    if (active) discard(active, '')
    scope = next
    ++detection
    check.disabled = false
    let saved
    try { if (scope) saved = JSON.parse(localStorage.getItem('ssh-remote/' + scope)) } catch {}
    user.value = saved?.user || ''
    port.value = saved?.port || (android ? 8022 : 22)
    user.dataset.custom = saved ? 'true' : ''
    render('')
    void detectTermux()
  }
}
