import test from 'node:test'
import assert from 'node:assert/strict'
import { validateImageCrop, clampImageCrop, imageCropFromPoints, moveImageCrop, resizeImageCrop, imageRulerTicks } from '../src/core/image-crop.ts'

test('crop validation preserves exact source pixels and rejects invalid or stale export regions', () => {
  assert.deepEqual(validateImageCrop(undefined, 400, 300), { x: 0, y: 0, width: 400, height: 300 })
  assert.deepEqual(validateImageCrop({ x: 399, y: 299, width: 1, height: 1 }, 400, 300), { x: 399, y: 299, width: 1, height: 1 })
  for (const crop of [
    null,
    { x: 0, y: 0, width: 0, height: 1 }, { x: 0.5, y: 0, width: 1, height: 1 },
    { x: -1, y: 0, width: 1, height: 1 }, { x: 399, y: 299, width: 2, height: 1 },
    { x: 0, y: 300, width: 1, height: 1 }, { x: 0, y: 0, width: NaN, height: 1 },
  ]) assert.throws(() => validateImageCrop(crop, 400, 300), /框选范围/)
  assert.throws(() => validateImageCrop(undefined, 0, 300), /原图尺寸/)
})

test('drawing works in every direction, respects snap increments and allows image edge pixels', () => {
  const expected = { x: 25, y: 40, width: 150, height: 110 }
  for (const [a, b] of [
    [{ x: 25, y: 40 }, { x: 175, y: 150 }], [{ x: 175, y: 150 }, { x: 25, y: 40 }],
    [{ x: 25, y: 150 }, { x: 175, y: 40 }], [{ x: 175, y: 40 }, { x: 25, y: 150 }],
  ]) assert.deepEqual(imageCropFromPoints(a, b, 400, 300), expected)
  assert.deepEqual(imageCropFromPoints({ x: 12, y: 19 }, { x: 103, y: 58 }, 400, 300, 10), { x: 10, y: 20, width: 90, height: 40 })
  assert.deepEqual(imageCropFromPoints({ x: 400, y: 300 }, { x: 400, y: 300 }, 400, 300), { x: 399, y: 299, width: 1, height: 1 })
  assert.deepEqual(imageCropFromPoints({ x: -100, y: -20 }, { x: 500, y: 400 }, 400, 300), { x: 0, y: 0, width: 400, height: 300 })
})

test('moving keeps dimensions intact and clamps to the original image independent of viewport scale', () => {
  const crop = { x: 80, y: 60, width: 120, height: 90 }
  assert.deepEqual(moveImageCrop(crop, { x: 1000, y: -100 }, 400, 300), { x: 280, y: 0, width: 120, height: 90 })
  assert.deepEqual(moveImageCrop(crop, { x: 1, y: -1 }, 400, 300), { x: 81, y: 59, width: 120, height: 90 })
  assert.deepEqual(moveImageCrop(crop, { x: 13, y: 8 }, 400, 300, 10), { x: 90, y: 70, width: 120, height: 90 })
  assert.deepEqual(clampImageCrop({ x: 800, y: -100, width: 100.4, height: 1000 }, 400, 300), { x: 300, y: 0, width: 100, height: 300 })
})

test('all resize handles anchor their opposite edges and cannot cross or escape source bounds', () => {
  const crop = { x: 80, y: 60, width: 120, height: 90 }
  assert.deepEqual(resizeImageCrop(crop, 'nw', { x: -100, y: -100 }, 400, 300), { x: 0, y: 0, width: 200, height: 150 })
  assert.deepEqual(resizeImageCrop(crop, 'se', { x: 1000, y: 1000 }, 400, 300), { x: 80, y: 60, width: 320, height: 240 })
  assert.deepEqual(resizeImageCrop(crop, 'sw', { x: 1000, y: -1000 }, 400, 300), { x: 199, y: 60, width: 1, height: 1 })
  assert.deepEqual(resizeImageCrop(crop, 'ne', { x: -1000, y: 1000 }, 400, 300), { x: 80, y: 149, width: 1, height: 1 })
  for (const handle of ['n', 'e', 's', 'w']) {
    const changed = resizeImageCrop(crop, handle, { x: 10, y: 10 }, 400, 300)
    assert.equal(handle === 'n' || handle === 's' ? changed.width : changed.height, handle === 'n' || handle === 's' ? crop.width : crop.height)
    validateImageCrop(changed, 400, 300)
  }
})

test('rulers show source coordinates after scrolling and limit tick count to the visible viewport', () => {
  const ticks = imageRulerTicks(1000000, 2, 10000, 500)
  assert.ok(ticks.length < 100)
  assert.ok(ticks.every(tick => tick.value >= 5000 && tick.value <= 5250))
  assert.equal(ticks[0].offset, 0)
  assert.ok(ticks.some(tick => tick.major))
  const magnified = imageRulerTicks(64, 8, 0, 512)
  assert.deepEqual(magnified.slice(0, 3).map(tick => tick.value), [0, 1, 2])
  assert.deepEqual(imageRulerTicks(64, 0, 0, 512), [])
})
