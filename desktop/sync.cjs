const path = require('node:path')
const fs = require('node:fs')
const { createHostSync } = require('../shared/host-sync.mjs')

function createSync(directory, store, ask, notify, codex, update) {
  const filename = path.join(directory, 'sync.json')
  const config = fs.existsSync(filename) ? JSON.parse(fs.readFileSync(filename, 'utf8')) : {}
  return createHostSync({ config, store, ask, notify, codex, update,
    defaults: require('../shared/relay.json'), relayOverride: process.env.MOMO_RELAY_URL,
    persist() {
      fs.writeFileSync(filename + '.tmp', JSON.stringify(config), { mode: 0o600 })
      fs.renameSync(filename + '.tmp', filename)
    },
  })
}

module.exports = { createSync }
