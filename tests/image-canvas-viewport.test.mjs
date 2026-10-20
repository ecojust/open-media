import test from 'node:test'
import assert from 'node:assert/strict'
import { fitImageCanvas, imageCanvasSourcePoint, zoomImageCanvas, resizeImageCanvas, revealImageCanvasBounds } from '../src/core/image-canvas-viewport.ts'

const approximately = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-8, `${actual} should be ${expected}`)

test('fit preserves source proportions, centers the image and can fit very large sources below one percent', () => {
  const view = fitImageCanvas(4000, 3000, 1000, 600)
  assert.equal(view.scale, 520 / 3000)
  approximately(view.offsetX * 2 + 4000 * view.scale, 1000)
  approximately(view.offsetY * 2 + 3000 * view.scale, 600)
  assert.equal(fitImageCanvas(200, 100, 1000, 600).scale, 1)
  const huge = fitImageCanvas(200000, 100000, 500, 400)
  assert.ok(huge.scale < .01)
  assert.deepEqual(zoomImageCanvas(huge, huge.scale / 2), huge, 'zoom out at an exceptionally small fit never enlarges the image')
  assert.ok(Object.values(fitImageCanvas(0, NaN, 0, 0)).every(Number.isFinite))
})

test('zoom keeps the exact original pixel under the pointer at every scale and clamps manual zoom', () => {
  const original = fitImageCanvas(4000, 3000, 1000, 600)
  const anchor = { x: 731, y: 107 }
  const source = imageCanvasSourcePoint(original, anchor)
  for (const scale of [.01, .3, 1, 2.5, 8, 100]) {
    const zoomed = zoomImageCanvas(original, scale, anchor)
    const result = imageCanvasSourcePoint(zoomed, anchor)
    approximately(result.x, source.x); approximately(result.y, source.y)
    assert.ok(zoomed.scale >= .01 && zoomed.scale <= 8)
  }
  assert.deepEqual(zoomImageCanvas(original, NaN, anchor), original)
  assert.deepEqual(zoomImageCanvas(original, 0, anchor), original)
})

test('resizing a manually navigated viewport keeps its center source coordinate without changing zoom', () => {
  const view = { scale: 3.5, offsetX: -901, offsetY: 156, viewportWidth: 800, viewportHeight: 500 }
  const before = imageCanvasSourcePoint(view, { x: 400, y: 250 })
  const resized = resizeImageCanvas(view, 440, 780)
  assert.equal(resized.scale, view.scale)
  assert.deepEqual(imageCanvasSourcePoint(resized, { x: 220, y: 390 }), before)
})

test('reveal follows edited source regions without changing the source crop or zoom', () => {
  const view = { scale: 2, offsetX: -100, offsetY: -100, viewportWidth: 600, viewportHeight: 400 }
  const selection = { x: 400, y: 240, width: 100, height: 60 }
  const result = revealImageCanvasBounds(view, selection)
  assert.equal(result.scale, 2)
  assert.ok(result.offsetX + selection.x * result.scale >= 32)
  assert.ok(result.offsetX + (selection.x + selection.width) * result.scale <= 568)
  assert.ok(result.offsetY + selection.y * result.scale >= 32)
  assert.ok(result.offsetY + (selection.y + selection.height) * result.scale <= 368)
  assert.deepEqual(revealImageCanvasBounds(result, selection), result)
  assert.deepEqual(selection, { x: 400, y: 240, width: 100, height: 60 })
  const large = revealImageCanvasBounds(view, { x: 20, y: 10, width: 1000, height: 1000 })
  approximately(large.offsetX + 520 * large.scale, large.viewportWidth / 2)
  approximately(large.offsetY + 510 * large.scale, large.viewportHeight / 2)
})
