export type CaptureSelectionMode = 'region' | 'window' | 'screen'
export interface SelectionRect { x: number; y: number; width: number; height: number }
export interface SelectionSize { width: number; height: number }
export interface SelectionDisplay {
  id: string
  name: string
  logicalWidth: number
  logicalHeight: number
  pixelWidth: number
  pixelHeight: number
}
export interface SelectionTarget {
  id: string
  name: string
  kind: 'screen' | 'window'
  rect: SelectionRect
  sourceWidth: number
  sourceHeight: number
}
export interface CaptureSelectionContext {
  requestId: string
  displayId: string
  display: SelectionDisplay
  targets: SelectionTarget[]
  audioDevices?: { id: string; name: string }[]
  audioState?: 'loading' | 'ready' | 'error'
  audioError?: string
  preferences?: { purpose?: 'record' | 'screenshot'; mode?: CaptureSelectionMode; sourceId?: string; outputSize?: SelectionSize; microphone?: boolean; audioDevice?: string }
  availableModes?: CaptureSelectionMode[]
}
export interface CaptureSelection {
  sourceId: string
  region?: SelectionRect
  outputSize?: SelectionSize
  microphone?: boolean
  audioDevice?: string
}
export type SelectionHandle = 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | 'nw'
export interface SelectionPoint { x: number; y: number }

const clamp = (value: number, minimum: number, maximum: number) => Math.min(Math.max(value, minimum), maximum)

export function limitPoint(point: SelectionPoint, display: SelectionDisplay): SelectionPoint {
  return { x: clamp(point.x, 0, display.logicalWidth), y: clamp(point.y, 0, display.logicalHeight) }
}

export function drawSelection(start: SelectionPoint, end: SelectionPoint, display: SelectionDisplay): SelectionRect {
  const a = limitPoint(start, display), b = limitPoint(end, display)
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(a.x - b.x), height: Math.abs(a.y - b.y) }
}

export function moveSelection(rect: SelectionRect, delta: SelectionPoint, display: SelectionDisplay): SelectionRect {
  return { ...rect, x: clamp(rect.x + delta.x, 0, display.logicalWidth - rect.width), y: clamp(rect.y + delta.y, 0, display.logicalHeight - rect.height) }
}

export function resizeSelection(rect: SelectionRect, handle: SelectionHandle, delta: SelectionPoint, display: SelectionDisplay): SelectionRect {
  const minimumWidth = 16 * display.logicalWidth / display.pixelWidth
  const minimumHeight = 16 * display.logicalHeight / display.pixelHeight
  let left = rect.x, top = rect.y, right = rect.x + rect.width, bottom = rect.y + rect.height
  if (handle.includes('w')) left = clamp(left + delta.x, 0, right - minimumWidth)
  if (handle.includes('e')) right = clamp(right + delta.x, left + minimumWidth, display.logicalWidth)
  if (handle.includes('n')) top = clamp(top + delta.y, 0, bottom - minimumHeight)
  if (handle.includes('s')) bottom = clamp(bottom + delta.y, top + minimumHeight, display.logicalHeight)
  return { x: left, y: top, width: right - left, height: bottom - top }
}

export function physicalSelection(rect: SelectionRect, display: SelectionDisplay): SelectionRect {
  const scaleX = display.pixelWidth / display.logicalWidth, scaleY = display.pixelHeight / display.logicalHeight
  const left = clamp(Math.round(rect.x * scaleX), 0, display.pixelWidth)
  const top = clamp(Math.round(rect.y * scaleY), 0, display.pixelHeight)
  const right = clamp(Math.round((rect.x + rect.width) * scaleX), left, display.pixelWidth)
  const bottom = clamp(Math.round((rect.y + rect.height) * scaleY), top, display.pixelHeight)
  return { x: left, y: top, width: right - left, height: bottom - top }
}

export function logicalSelection(rect: SelectionRect, display: SelectionDisplay): SelectionRect {
  const scaleX = display.logicalWidth / display.pixelWidth, scaleY = display.logicalHeight / display.pixelHeight
  return { x: rect.x * scaleX, y: rect.y * scaleY, width: rect.width * scaleX, height: rect.height * scaleY }
}

export function selectionAtPoint(targets: SelectionTarget[], point: SelectionPoint): SelectionTarget | undefined {
  return targets.find(({ rect }) => point.x >= rect.x && point.x <= rect.x + rect.width && point.y >= rect.y && point.y <= rect.y + rect.height)
}

export function validateSelection(selection: CaptureSelection, context: CaptureSelectionContext): string | undefined {
  const target = context.targets.find(item => item.id === selection.sourceId)
  if (!target) return '录制来源不可用，请重新选择。'
  if (context.preferences?.purpose !== 'screenshot' && selection.microphone !== false) {
    if (context.audioState === 'loading') return '正在读取麦克风来源，请稍候；也可关闭麦克风后开始录制。'
    if (context.audioState === 'error') return `${context.audioError || '无法读取麦克风来源。'}请关闭麦克风后继续，或取消并重新选择。`
  }
  if (context.preferences?.purpose !== 'screenshot' && selection.microphone !== false && selection.audioDevice && context.audioDevices && !context.audioDevices.some(device => device.id === selection.audioDevice)) return '所选麦克风已断开或不可用，请重新选择来源，或关闭麦克风。'
  const region = selection.region
  if (region) {
    if (target.kind !== 'screen') return '区域录制需要选择屏幕。'
    if (![region.x, region.y, region.width, region.height].every(Number.isInteger)) return '录制范围必须使用整数像素。'
    if (region.x < 0 || region.y < 0 || region.width < 16 || region.height < 16) return '请框选至少 16 × 16 像素的区域。'
    if (region.x + region.width > target.sourceWidth || region.y + region.height > target.sourceHeight) return '录制区域不能超出当前屏幕。'
  }
  const size = selection.outputSize
  if (size && (![size.width, size.height].every(value => Number.isInteger(value) && value >= 16 && value % 2 === 0) || size.width > 7680 || size.height > 4320)) return '输出尺寸需为偶数整数，宽 16–7680、高 16–4320 像素。'
  return undefined
}
