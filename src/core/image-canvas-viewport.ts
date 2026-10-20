export interface ImageCanvasView {
  scale: number
  offsetX: number
  offsetY: number
  viewportWidth: number
  viewportHeight: number
}

export interface ImageCanvasPoint { x: number; y: number }
export interface ImageCanvasBounds extends ImageCanvasPoint { width: number; height: number }

export const IMAGE_CANVAS_MIN_SCALE = 0.01
export const IMAGE_CANVAS_MAX_SCALE = 8

function positive(value: number, fallback = 1): number { return Number.isFinite(value) && value > 0 ? value : fallback }

/** The view changes display coordinates only; editing and export keep source pixels. */
export function fitImageCanvas(width: number, height: number, viewportWidth: number, viewportHeight: number, padding = 40): ImageCanvasView {
  const vw = positive(viewportWidth), vh = positive(viewportHeight)
  const sourceWidth = positive(width), sourceHeight = positive(height)
  const inset = Math.max(0, Number.isFinite(padding) ? padding : 40)
  const scale = Math.min(1, Math.max(1, vw - inset * 2) / sourceWidth, Math.max(1, vh - inset * 2) / sourceHeight)
  return { scale, offsetX: (vw - sourceWidth * scale) / 2, offsetY: (vh - sourceHeight * scale) / 2, viewportWidth: vw, viewportHeight: vh }
}

export function imageCanvasSourcePoint(view: ImageCanvasView, point: ImageCanvasPoint): ImageCanvasPoint {
  return { x: (point.x - view.offsetX) / view.scale, y: (point.y - view.offsetY) / view.scale }
}

export function zoomImageCanvas(view: ImageCanvasView, requested: number, anchor: ImageCanvasPoint = { x: view.viewportWidth / 2, y: view.viewportHeight / 2 }): ImageCanvasView {
  if (!Number.isFinite(requested) || requested <= 0) return { ...view }
  // An exceptionally large source can fit below 1%; zooming out must not enlarge it.
  if (view.scale < IMAGE_CANVAS_MIN_SCALE && requested < view.scale) return { ...view }
  const scale = Math.max(IMAGE_CANVAS_MIN_SCALE, Math.min(IMAGE_CANVAS_MAX_SCALE, requested))
  const source = imageCanvasSourcePoint(view, anchor)
  return { ...view, scale, offsetX: anchor.x - source.x * scale, offsetY: anchor.y - source.y * scale }
}

export function resizeImageCanvas(view: ImageCanvasView, viewportWidth: number, viewportHeight: number): ImageCanvasView {
  const width = positive(viewportWidth), height = positive(viewportHeight)
  return { ...view, offsetX: view.offsetX + (width - view.viewportWidth) / 2, offsetY: view.offsetY + (height - view.viewportHeight) / 2, viewportWidth: width, viewportHeight: height }
}

export function revealImageCanvasBounds(view: ImageCanvasView, bounds: ImageCanvasBounds, padding = 32): ImageCanvasView {
  if (![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite)) return { ...view }
  const reveal = (offset: number, start: number, length: number, viewport: number) => {
    const inset = Math.min(Math.max(0, padding), viewport / 4)
    const left = offset + start * view.scale, right = left + Math.max(0, length) * view.scale
    if (right - left > viewport - inset * 2) return (viewport - (right - left)) / 2 - start * view.scale
    if (left < inset) return offset + inset - left
    if (right > viewport - inset) return offset + viewport - inset - right
    return offset
  }
  return { ...view, offsetX: reveal(view.offsetX, bounds.x, bounds.width, view.viewportWidth), offsetY: reveal(view.offsetY, bounds.y, bounds.height, view.viewportHeight) }
}
