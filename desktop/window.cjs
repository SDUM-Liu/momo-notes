const sizes = { pet: [102, 148], edge: [57, 67] }
const clamp = (value, min, max) => Math.max(min, Math.min(max, value))

function fit(bounds, area) {
  return {
    ...bounds,
    x: Math.round(clamp(bounds.x, area.x, area.x + area.width - bounds.width)),
    y: Math.round(clamp(bounds.y, area.y, area.y + area.height - bounds.height)),
  }
}

function dimensions(mode, area) {
  if (mode !== 'note') return sizes[mode]
  const width = Math.min(area.width, Math.round(clamp(area.width * 0.27, 392, 750)))
  const height = Math.round(clamp(area.width * area.height / (8 * width), Math.min(335, area.height - 48), area.height - 48))
  return [width, height + 48]
}

function nearestEdge(bounds, area) {
  const distances = {
    left: bounds.x - area.x,
    right: area.x + area.width - bounds.x - bounds.width,
    top: bounds.y - area.y,
    bottom: area.y + area.height - bounds.y - bounds.height,
  }
  const [edge, distance] = Object.entries(distances).sort((a, b) => a[1] - b[1])[0]
  return distance <= 16 ? edge : null
}

function position(mode, area, anchor, edge) {
  const [width, height] = dimensions(mode, area)
  const bounds = { width, height, x: anchor.x - width / 2, y: anchor.y - height / 2 }
  if (mode === 'note') {
    bounds.x = anchor.x - width + 57
    bounds.y = anchor.y - 68
  }
  if (mode === 'edge') {
    if (edge === 'left') bounds.x = area.x
    if (edge === 'right') bounds.x = area.x + area.width - width
    if (edge === 'top') bounds.y = area.y
    if (edge === 'bottom') bounds.y = area.y + area.height - height
  }
  return fit(bounds, area)
}

function center(bounds) {
  return { x: bounds.x + Math.round(bounds.width / 2), y: bounds.y + Math.round(bounds.height / 2) }
}

module.exports = { center, fit, nearestEdge, position }
