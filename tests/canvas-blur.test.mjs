import test from 'node:test'
import assert from 'node:assert/strict'
import { canvasBlurSize } from '../src/core/canvas-blur.ts'

test('模糊缓冲同时限制长轴和像素总数，两条渲染路径均不放大源画面', () => {
  const sizes = [[3840, 2160], [7680, 4320], [4096, 4096], [16384, 1000], [1000, 16384]]
  for (const fallback of [false, true]) for (const radius of [0.5, 2, 16, 50]) {
    for (const [width, height] of sizes) {
      const [actualWidth, actualHeight] = canvasBlurSize(width, height, radius, fallback)
      assert.ok(Number.isInteger(actualWidth) && Number.isInteger(actualHeight))
      assert.ok(actualWidth >= 1 && actualHeight >= 1)
      assert.ok(actualWidth <= Math.min(width, 2048) && actualHeight <= Math.min(height, 2048))
      assert.ok(actualWidth * actualHeight <= 1_048_576, '两个复用画布必须各自遵守像素预算')
    }
  }
  assert.deepEqual(canvasBlurSize(4096, 4096, 1, true), [1024, 1024])
})

test('预算内的小半径保留预览细节，不因备用渲染路径缩小到固定低分辨率', () => {
  for (const size of [[1280, 720], [720, 1280], [853, 479], [1024, 1024]]) {
    for (const radius of [0, 0.1, 1, 2]) {
      assert.deepEqual(canvasBlurSize(...size, radius, true), size)
      assert.deepEqual(canvasBlurSize(...size, radius, false), size)
    }
  }
})

test('竖屏按高度限制长轴，交换横纵尺寸后预算结果也随之交换', () => {
  for (const fallback of [false, true]) {
    assert.deepEqual(canvasBlurSize(256, 4096, 1, fallback), [128, 2048])
    assert.deepEqual(canvasBlurSize(4096, 256, 1, fallback), [2048, 128])
    const portrait = canvasBlurSize(1080, 1920, 1, fallback)
    assert.deepEqual(portrait, canvasBlurSize(1920, 1080, 1, fallback).reverse())
    assert.ok(portrait[0] < portrait[1] && portrait[0] * portrait[1] <= 1_048_576)
  }
})

test('备用路径随大半径降低采样量，薄画面至少保留一个像素且原生路径不受该缩放影响', () => {
  assert.deepEqual(canvasBlurSize(1280, 720, 4, true), [640, 360])
  assert.deepEqual(canvasBlurSize(1280, 720, 16, true), [160, 90])
  let previous = [1280, 720]
  for (const radius of [2, 4, 16, 50]) {
    const size = canvasBlurSize(1280, 720, radius, true)
    assert.ok(size[0] <= previous[0] && size[1] <= previous[1])
    assert.ok(radius * size[0] / 1280 <= 2 && radius * size[1] / 720 <= 2)
    assert.deepEqual(canvasBlurSize(1280, 720, radius, false), [1280, 720])
    previous = size
  }
  assert.deepEqual(canvasBlurSize(16, 9, 50, true), [1, 1])
  assert.deepEqual(canvasBlurSize(1, 500, 50, true), [1, 20])
  assert.deepEqual(canvasBlurSize(500, 1, 50, true), [20, 1])
})
