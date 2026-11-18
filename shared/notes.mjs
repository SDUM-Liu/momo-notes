export const defaultSettings = {
  alwaysOnTop: true, openAtLogin: false, snap: true, edgeImage: '',
  baseUrl: '', model: '', proxyPort: '', key: '', autoInstallUpdates: false,
}

export function localDay(date = new Date()) {
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return [date.getFullYear(), month, day].join('-')
}

export function emptyNote() {
  return {
    type: 'doc',
    content: [{
      type: 'taskList',
      content: [{
        type: 'taskItem', attrs: { checked: false },
        content: [{ type: 'paragraph' }],
      }],
    }],
  }
}

export function nodeText(node, withStatus = false) {
  if (node.type === 'image') return '[图片]'
  if (node.type === 'hardBreak') return '\n'
  const separator = ['paragraph', 'heading'].includes(node.type) ? '' : '\n'
  const content = node.text ?? (node.content ?? []).map(child => nodeText(child, withStatus)).join(separator)
  if (withStatus && node.type === 'taskItem') return (node.attrs?.checked ? '[已完成] ' : '[待办] ') + content
  return content
}

export function hasContent(node) {
  return Boolean(node.text?.trim() || ['image', 'table'].includes(node.type) || node.content?.some(hasContent))
}
