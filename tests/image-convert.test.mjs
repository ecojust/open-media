import test from 'node:test'
import assert from 'node:assert/strict'
import { encodeBitmap, imageDimensions, convertedImageName } from '../src/core/image-convert.ts'

test('bitmap output stores real bottom-up BGR rows with padding and readable dimensions', async () => {
  const pixels = new Uint8ClampedArray([
    255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255,
    255, 255, 255, 255, 0, 0, 0, 255, 128, 64, 32, 255,
  ])
  const blob = encodeBitmap(pixels, 3, 2)
  assert.equal(blob.type, 'image/bmp')
  const buffer = await blob.arrayBuffer()
  const data = new Uint8Array(buffer)
  const view = new DataView(buffer)
  assert.equal(String.fromCharCode(data[0], data[1]), 'BM')
  assert.equal(view.getUint32(2, true), buffer.byteLength)
  assert.equal(view.getInt32(18, true), 3)
  assert.equal(view.getInt32(22, true), 2)
  assert.equal(view.getUint16(28, true), 24)
  assert.equal(view.getUint32(34, true), 24)
  assert.deepEqual([...data.slice(54, 66)], [255, 255, 255, 0, 0, 0, 32, 64, 128, 0, 0, 0])
  assert.deepEqual([...data.slice(66, 78)], [0, 0, 255, 0, 255, 0, 255, 0, 0, 0, 0, 0])
  assert.throws(() => encodeBitmap(pixels, 4, 2), /像素数据/)
})

test('aspect constraints and rotation preserve a bounded output size without unintended enlargement', () => {
  const defaults = { keepAspect: true, allowUpscale: false, rotation: 0 }
  assert.deepEqual(imageDimensions(1920, 1080, { ...defaults, width: 800, height: 800 }), { width: 800, height: 450, drawWidth: 800, drawHeight: 450 })
  assert.deepEqual(imageDimensions(400, 200, { ...defaults, width: 800, rotation: 90 }), { width: 200, height: 400, drawWidth: 400, drawHeight: 200 })
  assert.deepEqual(imageDimensions(400, 200, { ...defaults, width: 800, allowUpscale: true, rotation: 270 }), { width: 400, height: 800, drawWidth: 800, drawHeight: 400 })
  assert.deepEqual(imageDimensions(100, 200, { ...defaults, keepAspect: false, width: 50, height: 50 }), { width: 50, height: 50, drawWidth: 50, drawHeight: 50 })
  assert.throws(() => imageDimensions(20000, 20000, defaults), /4000 万/)
  assert.throws(() => imageDimensions(100, 100, { ...defaults, width: NaN }), /目标尺寸/)
})

test('download names preserve readable stems and remove file path separators', () => {
  assert.equal(convertedImageName('项目.示意图.png', 'jpeg'), '项目.示意图.jpg')
  assert.equal(convertedImageName('../素材\\图.svg', 'bmp'), '.._素材_图.bmp')
})
