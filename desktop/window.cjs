const sizes = { pet: [74, 148], edge: [74, 72] }
const minimumNote = { width: 360, height: 300 }
const clamp = (value, min, max) => Math.max(min, Math.min(max, value))

function fit(bounds, area) {
  return {
    ...bounds,
    x: Math.round(clamp(bounds.x, area.x, area.x + area.width - bounds.width)),
    y: Math.round(clamp(bounds.y, area.y, area.y + area.height - bounds.height)),
  }
}

function dimensions(mode, area, noteSize) {
  if (mode !== 'note') return sizes[mode]
  if (Number.isInteger(noteSize?.width) && Number.isInteger(noteSize?.height)) {
    return [
      clamp(noteSize.width, Math.min(minimumNote.width, area.width), area.width),
      clamp(noteSize.height, Math.min(minimumNote.height, area.height), area.height),
    ]
  }
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

function dock(bounds, area, edge) {
  bounds = { ...bounds }
  if (edge === 'left') bounds.x = area.x
  if (edge === 'right') bounds.x = area.x + area.width - bounds.width
  if (edge === 'top') bounds.y = area.y
  if (edge === 'bottom') bounds.y = area.y + area.height - bounds.height
  return fit(bounds, area)
}

// The eye line is the common anchor in the three illustrations (CSS pixels).
function face(mode, bounds) {
  return { x: bounds.x + (mode === 'note' ? bounds.width - 46 : Math.round(bounds.width / 2)),
    y: bounds.y + 37 }
}

function position(mode, area, anchor, edge, noteSize) {
  const [width, height] = dimensions(mode, area, noteSize)
  const offset = face(mode, { x: 0, y: 0, width })
  return dock({ width, height, x: anchor.x - offset.x, y: anchor.y - offset.y }, area, mode === 'note' ? null : edge)
}

function resizeNote(bounds, area, direction, dx, dy) {
  const minWidth = Math.min(minimumNote.width, area.width)
  const minHeight = Math.min(minimumNote.height, area.height)
  let { x, y } = bounds
  let right = x + bounds.width, bottom = y + bounds.height
  if (direction.includes('w')) x = clamp(x + dx, area.x, right - minWidth)
  if (direction.includes('e')) right = clamp(right + dx, x + minWidth, area.x + area.width)
  if (direction.includes('n')) y = clamp(y + dy, area.y, bottom - minHeight)
  if (direction.includes('s')) bottom = clamp(bottom + dy, y + minHeight, area.y + area.height)
  return { x, y, width: right - x, height: bottom - y }
}

module.exports = { dock, face, fit, nearestEdge, position, resizeNote }
