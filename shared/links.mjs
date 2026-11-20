export const codexSetupUrl = 'https://learn.chatgpt.com/docs/codex/cli'

export function webUrl(value) {
  try {
    const url = new URL(String(value).trim())
    if (['http:', 'https:'].includes(url.protocol) && !url.username && !url.password) return url.href
  } catch {}
  throw new Error('请输入以 https:// 或 http:// 开头的链接')
}

export const linkOrNull = value => {
  try { return webUrl(value) } catch { return null }
}
