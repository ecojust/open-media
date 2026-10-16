import assert from 'node:assert/strict'
import test from 'node:test'
import { drawSelection, logicalSelection, moveSelection, physicalSelection, resizeSelection, selectionAtPoint, validateSelection } from '../src/core/capture-selection.ts'

const display = { id: 'screen:1', name: '主屏幕', logicalWidth: 1440, logicalHeight: 900, pixelWidth: 2880, pixelHeight: 1800 }
const screen = { id: display.id, name: display.name, kind: 'screen', rect: { x: 0, y: 0, width: 1440, height: 900 }, sourceWidth: 2880, sourceHeight: 1800 }
const context = { requestId: 'example', displayId: display.id, display, targets: [screen] }

test('反向框选映射到屏幕物理像素，越界坐标约束在当前屏幕', () => {
  const rect = drawSelection({ x: 640, y: 450 }, { x: -100, y: 100 }, display)
  assert.deepEqual(rect, { x: 0, y: 100, width: 640, height: 350 })
  assert.deepEqual(physicalSelection(rect, display), { x: 0, y: 200, width: 1280, height: 700 })
  assert.deepEqual(logicalSelection(physicalSelection(rect, display), display), rect)
})

test('移动和八方向缩放保持边界和至少16像素，不允许翻转选区', () => {
  const rect = { x: 100, y: 100, width: 200, height: 150 }
  assert.deepEqual(moveSelection(rect, { x: -1000, y: 2000 }, display), { x: 0, y: 750, width: 200, height: 150 })
  for (const handle of ['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw']) {
    for (const sign of [-1, 1]) {
      const resized = resizeSelection(rect, handle, { x: sign * 9999, y: sign * 9999 }, display)
      assert.ok(resized.x >= 0 && resized.y >= 0)
      assert.ok(resized.x + resized.width <= display.logicalWidth)
      assert.ok(resized.y + resized.height <= display.logicalHeight)
      const pixels = physicalSelection(resized, display)
      assert.ok(pixels.width >= 16 && pixels.height >= 16)
    }
  }
})

test('分数缩放使用端点取整，使靠屏幕边缘的选区保持准确', () => {
  const fractional = { ...display, logicalWidth: 1536, logicalHeight: 864, pixelWidth: 1920, pixelHeight: 1080 }
  const rect = { x: 100.4, y: 200.4, width: 1435.6, height: 663.6 }
  const pixels = physicalSelection(rect, fractional)
  assert.equal(pixels.x + pixels.width, 1920)
  assert.equal(pixels.y + pixels.height, 1080)
  assert.deepEqual(physicalSelection(logicalSelection(pixels, fractional), fractional), pixels)
})

test('窗口命中遵循原有层叠顺序并支持跨屏窗口的负坐标', () => {
  const front = { ...screen, id: 'window:front', kind: 'window', rect: { x: -100, y: 50, width: 400, height: 300 } }
  const back = { ...front, id: 'window:back', rect: { x: 0, y: 0, width: 900, height: 600 } }
  assert.equal(selectionAtPoint([front, back], { x: 200, y: 200 })?.id, 'window:front')
  assert.equal(selectionAtPoint([front, back], { x: 600, y: 200 })?.id, 'window:back')
  assert.equal(selectionAtPoint([front, back], { x: 1200, y: 200 }), undefined)
})

test('确认校验拒绝失效来源、屏外范围、窗口裁剪及编码器无效尺寸', () => {
  const valid = { sourceId: screen.id, region: { x: 200, y: 300, width: 1920, height: 1080 }, outputSize: { width: 1280, height: 720 } }
  assert.equal(validateSelection(valid, context), undefined)
  assert.match(validateSelection({ ...valid, sourceId: 'gone' }, context), /不可用/)
  assert.match(validateSelection({ ...valid, region: { ...valid.region, x: 2500 } }, context), /超出/)
  assert.match(validateSelection({ ...valid, region: { ...valid.region, width: 15 } }, context), /至少 16/)
  assert.match(validateSelection({ ...valid, region: { ...valid.region, x: 0.5 } }, context), /整数像素/)
  assert.match(validateSelection({ ...valid, outputSize: { width: 1281, height: 720 } }, context), /偶数/)
  assert.match(validateSelection({ ...valid, outputSize: { width: 7682, height: 720 } }, context), /偶数/)
  assert.match(validateSelection(valid, { ...context, targets: [{ ...screen, kind: 'window' }] }), /需要选择屏幕/)
})
