import { defineConfig } from 'vite'

import { readFileSync } from 'node:fs'

const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'))

export default defineConfig({
  base: './',
  define: { __APP_VERSION__: JSON.stringify(version) },
  build: { target: ['chrome105', 'safari15.4'] },
  plugins: [{
    name: 'include-third-party-notices',
    generateBundle() {
      const source = readFileSync(new URL('./THIRD-PARTY-NOTICES.txt', import.meta.url))
      this.emitFile({ type: 'asset', fileName: 'THIRD-PARTY-NOTICES.txt', source })
    },
  }],
})
