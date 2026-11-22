const { execFileSync } = require('node:child_process')
const { copyFileSync, mkdirSync } = require('node:fs')
const path = require('node:path')

function build(platform, arch, directory) {
  const goos = { win32: 'windows', darwin: 'darwin', linux: 'linux' }[platform]
  const goarch = { x64: 'amd64', arm64: 'arm64', ia32: '386', armv7l: 'arm' }[arch]
  if (!goos || !goarch) throw new Error(`Unsupported TCP probe platform: ${platform}-${arch}`)
  mkdirSync(directory, { recursive: true })
  const target = path.join(directory, platform === 'win32' ? 'momo-tcp-probe.exe' : 'momo-tcp-probe')
  const cwd = path.join(__dirname, '../native/tcp-probe')
  execFileSync('go', ['build', '-buildvcs=false', '-trimpath', '-ldflags=-s -w', '-o', target, '.'], {
    cwd,
    env: { ...process.env, CGO_ENABLED: '0', GOOS: goos, GOARCH: goarch },
    stdio: 'inherit',
  })
  const goRoot = execFileSync('go', ['env', 'GOROOT'], { cwd, encoding: 'utf8' }).trim()
  copyFileSync(path.join(goRoot, 'LICENSE'), path.join(directory, 'momo-tcp-probe-GO-LICENSE.txt'))
}

// Build for the package target (which may differ from the host) outside app.asar before signing.
module.exports = async ({ arch, electronPlatformName, packager, appOutDir }) => {
  build(electronPlatformName, require('builder-util').Arch[arch], packager.getResourcesDir(appOutDir))
}

if (require.main === module) build(process.platform, process.arch, path.join(__dirname, 'tcp-probe'))
