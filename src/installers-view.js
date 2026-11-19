export function wireInstallerDownloads(api, showView, errorMessage) {
  const $ = id => document.getElementById(id)
  const target = $('installer-platform')
  const version = $('installer-version')
  const progress = $('installer-progress')
  const status = $('installer-status')
  const download = $('installer-download')
  let catalog, busy = false

  function selected() {
    return catalog?.versions.find(item => item.tag === version.value)?.assets.find(item => item.platform === target.value)
  }

  function describePackage() {
    const asset = selected()
    $('installer-file').textContent = asset ? asset.name + ' · ' + (asset.size / 1048576).toFixed(1) + ' MB' : ''
    download.disabled = busy || !asset
  }

  function chooseVersions() {
    const versions = catalog.versions.filter(item => item.assets.some(asset => asset.platform === target.value))
    version.replaceChildren(...versions.map(item => new Option(
      item.tag + (item.tag === catalog.latest ? ' · 最新' : item.prerelease ? ' · 预览版' : ''), item.tag)))
    version.value = versions.find(item => item.tag === catalog.latest)?.tag
      ?? versions.find(item => !item.prerelease)?.tag ?? versions[0]?.tag ?? ''
    version.disabled = !versions.length || busy
    describePackage()
  }

  async function load() {
    if (busy) return
    status.textContent = '正在读取版本列表…'
    $('installer-refresh').hidden = true
    $('installer-fields').hidden = true
    $('installer-directory').hidden = true
    try {
      catalog = await api.installerCatalog()
      if (!catalog.targets.length) throw new Error('暂时没有可下载的安装包')
      target.replaceChildren(...catalog.targets.map(({ id, label }) => new Option(label, id)))
      if (!catalog.preferredPlatform) target.prepend(new Option('请选择安装包平台', ''))
      target.value = catalog.preferredPlatform
      $('installer-destination').textContent = catalog.directory
      $('installer-directory').hidden = false
      $('installer-fields').hidden = false
      chooseVersions()
      status.textContent = ''
    } catch (error) {
      status.textContent = errorMessage(error)
      $('installer-refresh').hidden = false
    }
  }

  $('installer-settings').onclick = () => {
    showView('installers')
    void load()
  }
  $('installer-back').onclick = () => showView('settings')
  $('installer-refresh').onclick = load
  target.onchange = chooseVersions
  version.onchange = describePackage
  api.onInstallerProgress(value => {
    if (!busy) return
    if (Number.isFinite(value)) progress.value = value
    else progress.removeAttribute('value')
  })

  $('installer-directory').onclick = async () => {
    try {
      if (!await api.openInstallerDirectory()) status.textContent = '无法打开系统下载目录'
    } catch (error) { status.textContent = errorMessage(error) }
  }

  $('installer-fields').onsubmit = async event => {
    event.preventDefault()
    const asset = selected()
    if (!asset || busy) return
    busy = target.disabled = version.disabled = download.disabled = true
    progress.hidden = false
    progress.removeAttribute('value')
    status.textContent = '正在下载安装包…'
    try {
      const result = await api.downloadInstaller(asset.id)
      status.textContent = '已下载 ' + result.name
        + (result.opened ? '，已打开下载目录。' : '。可点击「打开下载目录」查看。')
    } catch (error) {
      status.textContent = errorMessage(error)
    } finally {
      busy = target.disabled = version.disabled = download.disabled = false
      progress.hidden = true
    }
  }
}
