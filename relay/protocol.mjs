export const protocol = 'momo-sync-v1'
const hexKey = '[a-f0-9]{64}'
export const ownerAuth = new RegExp('^host\\.(' + hexKey + ')\\.(' + hexKey + ')$')
export const peerAuth = new RegExp('^join\\.(' + hexKey + ')$')
export const roomPath = new RegExp('^/v1/(' + hexKey + ')$')
export const peerId = /^[0-9a-f-]{36}$/
export const health = { service: 'momo-sync', version: 1 }
