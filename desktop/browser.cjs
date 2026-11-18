const { WebContentsView, session } = require('electron')
const { linkOrNull } = require('../shared/links.mjs')

function createBrowser(win, onChange) {
  let view, viewport
  let state = { url: '', loading: false, canGoBack: false, error: '' }

  function send(changes) {
    const contents = view?.webContents
    state = {
      ...state, ...changes,
      canGoBack: Boolean(contents && !contents.isDestroyed() && contents.navigationHistory.canGoBack()),
    }
    onChange(state)
  }

  function setViewport(bounds) {
    const [width, height] = win.getContentSize()
    const x = Math.min(width, Math.max(0, Math.floor(bounds.x)))
    const y = Math.min(height, Math.max(0, Math.floor(bounds.y)))
    viewport = {
      x, y,
      width: Math.min(width - x, Math.max(0, Math.floor(bounds.width))),
      height: Math.min(height - y, Math.max(0, Math.floor(bounds.height))),
    }
    if (!view) return
    view.setBounds(viewport)
    view.setVisible(Boolean(viewport.width && viewport.height))
  }

  function createView() {
    const webSession = session.fromPartition('persist:momo-browser')
    webSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
    webSession.setPermissionCheckHandler(() => false)
    view = new WebContentsView({
      webPreferences: { session: webSession, sandbox: true, contextIsolation: true, nodeIntegration: false },
    })
    const { webContents } = view
    webContents.setWindowOpenHandler(({ url }) => {
      if (linkOrNull(url)) setImmediate(() => open(url))
      return { action: 'deny' }
    })
    for (const eventName of ['will-navigate', 'will-redirect']) {
      webContents.on(eventName, (event, url) => {
        if (!linkOrNull(event.url ?? url)) event.preventDefault()
      })
    }
    webContents.on('did-start-loading', () => send({ loading: true, error: '' }))
    webContents.on('did-stop-loading', () => send({ loading: false }))
    for (const eventName of ['did-navigate', 'did-navigate-in-page']) {
      webContents.on(eventName, (_event, url) => send({ url, error: '' }))
    }
    webContents.on('did-fail-load', (_event, code, _reason, url, mainFrame) => {
      if (mainFrame && code !== -3) send({ url, error: '网页加载失败，请检查链接和网络后重试。' })
    })
    win.contentView.addChildView(view)
    if (viewport) setViewport(viewport)
    else view.setVisible(false)
  }

  function open(value) {
    const url = linkOrNull(value)
    if (!url) throw new Error('请输入以 https:// 或 http:// 开头的链接')
    if (!view) createView()
    send({ url, loading: true, error: '' })
    void view.webContents.loadURL(url).catch(error => {
      if (error.code !== 'ERR_ABORTED') {
        send({ loading: false, error: '网页加载失败，请检查链接和网络后重试。' })
      }
    })
  }

  return {
    get state() { return state },
    open,
    setViewport,
    back: () => {
      if (state.canGoBack) view.webContents.navigationHistory.goBack()
    },
    hide: () => { viewport = undefined; view?.setVisible(false) },
    dispose: () => {
      const contents = view?.webContents
      if (contents && !contents.isDestroyed()) contents.close()
    },
  }
}

module.exports = { createBrowser }
