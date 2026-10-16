export interface ImageCrop { x: number; y: number; width: number; height: number }
export interface ImagePoint { x: number; y: number }
export type ImageCropHandle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w'

function dimensions(width: number, height: number): void {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) throw new Error('原图尺寸无效。')
}

/** Export must reject stale or invalid coordinates instead of silently changing the requested pixels. */
export function validateImageCrop(crop: ImageCrop | undefined, sourceWidth: number, sourceHeight: number): ImageCrop {
  dimensions(sourceWidth, sourceHeight)
  if (crop === undefined) return { x: 0, y: 0, width: sourceWidth, height: sourceHeight }
  if (!crop || ![crop.x, crop.y, crop.width, crop.height].every(Number.isSafeInteger) || crop.x < 0 || crop.y < 0 || crop.width < 1 || crop.height < 1) throw new Error('框选范围必须使用整数像素，宽度和高度至少为 1。')
  if (crop.width > sourceWidth || crop.height > sourceHeight || crop.x > sourceWidth - crop.width || crop.y > sourceHeight - crop.height) throw new Error('框选范围超出原图，请重新选择。')
  return { ...crop }
}

function finite(value: number, fallback: number): number { return Number.isFinite(value) ? value : fallback }
function clamp(value: number, min: number, max: number): number { return Math.min(max, Math.max(min, value)) }
function snap(value: number, step: number): number {
  const increment = Math.max(1, Math.round(finite(step, 1)))
  return Math.round(finite(value, 0) / increment) * increment
}

/** Pointer and numeric editing stay inside the original image, including single-pixel selections. */
export function clampImageCrop(crop: ImageCrop, sourceWidth: number, sourceHeight: number): ImageCrop {
  dimensions(sourceWidth, sourceHeight)
  const width = clamp(Math.round(finite(crop.width, 1)), 1, sourceWidth)
  const height = clamp(Math.round(finite(crop.height, 1)), 1, sourceHeight)
  return { x: clamp(Math.round(finite(crop.x, 0)), 0, sourceWidth - width), y: clamp(Math.round(finite(crop.y, 0)), 0, sourceHeight - height), width, height }
}

export function imageCropFromPoints(start: ImagePoint, end: ImagePoint, sourceWidth: number, sourceHeight: number, step = 1): ImageCrop {
  dimensions(sourceWidth, sourceHeight)
  const ax = clamp(snap(start.x, step), 0, sourceWidth)
  const ay = clamp(snap(start.y, step), 0, sourceHeight)
  const bx = clamp(snap(end.x, step), 0, sourceWidth)
  const by = clamp(snap(end.y, step), 0, sourceHeight)
  return clampImageCrop({ x: Math.min(ax, bx), y: Math.min(ay, by), width: Math.max(1, Math.abs(bx - ax)), height: Math.max(1, Math.abs(by - ay)) }, sourceWidth, sourceHeight)
}

export function moveImageCrop(crop: ImageCrop, delta: ImagePoint, sourceWidth: number, sourceHeight: number, step = 1): ImageCrop {
  const current = validateImageCrop(crop, sourceWidth, sourceHeight)
  return clampImageCrop({ ...current, x: snap(current.x + delta.x, step), y: snap(current.y + delta.y, step) }, sourceWidth, sourceHeight)
}

export function resizeImageCrop(crop: ImageCrop, handle: ImageCropHandle, delta: ImagePoint, sourceWidth: number, sourceHeight: number, step = 1): ImageCrop {
  const current = validateImageCrop(crop, sourceWidth, sourceHeight)
  let left = current.x, top = current.y, right = current.x + current.width, bottom = current.y + current.height
  if (handle.includes('w')) left = clamp(snap(left + delta.x, step), 0, right - 1)
  if (handle.includes('e')) right = clamp(snap(right + delta.x, step), left + 1, sourceWidth)
  if (handle.includes('n')) top = clamp(snap(top + delta.y, step), 0, bottom - 1)
  if (handle.includes('s')) bottom = clamp(snap(bottom + delta.y, step), top + 1, sourceHeight)
  return { x: left, y: top, width: right - left, height: bottom - top }
}

export interface ImageRulerTick { value: number; offset: number; major: boolean }

/** Generate only visible marks, keeping large images inexpensive at high zoom. */
export function imageRulerTicks(length: number, scale: number, scroll: number, viewport: number): ImageRulerTick[] {
  if (length <= 0 || scale <= 0 || viewport <= 0 || ![length, scale, scroll, viewport].every(Number.isFinite)) return []
  const desired = 65 / scale
  const power = 10 ** Math.floor(Math.log10(desired))
  const major = Math.max(1, [1, 2, 5, 10].find(value => value * power >= desired)! * power)
  const minor = Math.max(1, Math.round(major / 10))
  const marks: ImageRulerTick[] = []
  const start = Math.max(0, Math.floor(scroll / scale / minor) * minor)
  const end = Math.min(length, (scroll + viewport) / scale)
  for (let value = start; value <= end; value += minor) marks.push({ value, offset: value * scale - scroll, major: value % major === 0 })
  return marks
}
