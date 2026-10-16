import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deflateSync } from 'node:zlib'
import { encodeTiff, encodeStaticGif, encodeIcon, validateIconSizes, standardIconSizes } from '../src/core/image-encoders.ts'

function crc32(bytes) {
  let value = 0xffffffff
  for (const byte of bytes) {
    value ^= byte
    for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0)
  }
  return (value ^ 0xffffffff) >>> 0
}
function pngChunk(type, payload) {
  const bytes = Buffer.alloc(payload.length + 12)
  bytes.writeUInt32BE(payload.length)
  bytes.write(type, 4)
  payload.copy(bytes, 8)
  bytes.writeUInt32BE(crc32(bytes.subarray(4, -4)), bytes.length - 4)
  return bytes
}
function pngFixture(size) {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(size)
  header.writeUInt32BE(size, 4)
  header[8] = 8
  header[9] = 6
  const pixels = Buffer.alloc((size * 4 + 1) * size)
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const index = y * (size * 4 + 1) + 1 + x * 4
    pixels[index] = 220
    pixels[index + 1] = 40
    pixels[index + 2] = 80
    pixels[index + 3] = x < size / 2 ? 255 : 0
  }
  return new Blob([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk('IHDR', header), pngChunk('IDAT', deflateSync(pixels)), pngChunk('IEND', Buffer.alloc(0))], { type: 'image/png' })
}

test('image encoders reject malformed data and icon sizes before writing files', async () => {
  for (const encoder of [encodeTiff, encodeStaticGif]) {
    assert.throws(() => encoder(new Uint8Array(3), 1, 1), /像素/)
    assert.throws(() => encoder(new Uint8Array(), 0, 1), /像素/)
  }
  assert.deepEqual(validateIconSizes(), [...standardIconSizes])
  assert.deepEqual(validateIconSizes([64, 16, 64]), [16, 64])
  for (const sizes of [[], [0], [17], [512], [NaN], [16.5]]) assert.throws(() => validateIconSizes(sizes), /图标尺寸/)
  await assert.rejects(encodeIcon([{ size: 16, blob: new Blob(['not PNG']) }]), /有效 PNG/)
  await assert.rejects(encodeIcon([{ size: 16, blob: pngFixture(32) }]), /有效 PNG/)
  await assert.rejects(encodeIcon([{ size: 16, blob: pngFixture(16) }, { size: 16, blob: pngFixture(16) }]), /重复尺寸/)
})

test('ICO contains a real ordered directory and independent PNG images for all selected sizes', async () => {
  const blob = await encodeIcon([...standardIconSizes].reverse().map(size => ({ size, blob: pngFixture(size) })))
  assert.equal(blob.type, 'image/x-icon')
  const bytes = await blob.arrayBuffer()
  const view = new DataView(bytes)
  assert.equal(view.getUint16(0, true), 0)
  assert.equal(view.getUint16(2, true), 1)
  assert.equal(view.getUint16(4, true), 6)
  let expectedOffset = 6 + 6 * 16
  for (let index = 0; index < standardIconSizes.length; index++) {
    const size = standardIconSizes[index]
    const cursor = 6 + index * 16
    assert.equal(view.getUint8(cursor) || 256, size)
    assert.equal(view.getUint8(cursor + 1) || 256, size)
    assert.equal(view.getUint16(cursor + 4, true), 1)
    assert.equal(view.getUint16(cursor + 6, true), 32)
    const length = view.getUint32(cursor + 8, true)
    const offset = view.getUint32(cursor + 12, true)
    assert.equal(offset, expectedOffset)
    assert.equal(view.getUint32(offset), 0x89504e47)
    assert.equal(view.getUint32(offset + 16), size)
    assert.equal(view.getUint32(offset + 20), size)
    assert.deepEqual(Buffer.from(bytes.slice(offset, offset + length)), Buffer.from(await pngFixture(size).arrayBuffer()))
    expectedOffset += length
  }
  assert.equal(expectedOffset, bytes.byteLength)
})

const hasDecoder = spawnSync('ffmpeg', ['-version']).status === 0
test('real decoders preserve TIFF RGBA and static GIF colors with binary transparency', { skip: !hasDecoder && 'media decoder unavailable' }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'open-media-image-'))
  const pixels = new Uint8Array([
    255, 0, 0, 255, 0, 255, 0, 128, 0, 0, 255, 127,
    22, 67, 103, 0, 80, 90, 100, 255, 255, 255, 255, 200,
  ])
  try {
    for (const [format, encoder] of [['tiff', encodeTiff], ['gif', encodeStaticGif]]) {
      const blob = encoder(pixels, 3, 2)
      assert.equal(blob.type, `image/${format}`)
      const file = join(directory, `pixels.${format}`)
      writeFileSync(file, Buffer.from(await blob.arrayBuffer()))
      const decoded = execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-frames:v', '1', '-threads', '1', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'])
      assert.equal(decoded.length, pixels.length)
      if (format === 'tiff') assert.deepEqual(decoded, Buffer.from(pixels), 'TIFF stores exact straight RGBA pixels including partial and zero alpha')
      else for (let offset = 0; offset < pixels.length; offset += 4) {
        const transparent = pixels[offset + 3] < 128
        assert.equal(decoded[offset + 3], transparent ? 0 : 255)
        if (!transparent) assert.deepEqual(decoded.subarray(offset, offset + 3), Buffer.from(pixels.subarray(offset, offset + 3)))
      }
    }
    const ico = await encodeIcon([{ size: 16, blob: pngFixture(16) }, { size: 256, blob: pngFixture(256) }])
    const file = join(directory, 'icon.ico')
    writeFileSync(file, Buffer.from(await ico.arrayBuffer()))
    const decoded = execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-map', '0:v:1', '-frames:v', '1', '-threads', '1', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'], { maxBuffer: 1024 * 1024 })
    assert.equal(decoded.length, 256 * 256 * 4)
    assert.deepEqual([...decoded.subarray(0, 4)], [220, 40, 80, 255])
    assert.deepEqual([...decoded.subarray(255 * 4, 256 * 4)], [220, 40, 80, 0])
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test('static GIF reduces a large color set with an adaptive palette and remains decodable', { skip: !hasDecoder && 'media decoder unavailable' }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'open-media-palette-'))
  try {
    const width = 64, height = 64
    const pixels = new Uint8Array(width * height * 4)
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) pixels.set([x * 4, y * 4, ((x + y) % 64) * 4, 255], (y * width + x) * 4)
    const file = join(directory, 'palette.gif')
    writeFileSync(file, Buffer.from(await encodeStaticGif(pixels, width, height).arrayBuffer()))
    const decoded = execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-frames:v', '1', '-threads', '1', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'])
    assert.equal(decoded.length, pixels.length)
    let error = 0
    for (let offset = 0; offset < pixels.length; offset += 4) {
      assert.equal(decoded[offset + 3], 255)
      for (let channel = 0; channel < 3; channel++) error += Math.abs(decoded[offset + channel] - pixels[offset + channel])
    }
    assert.ok(error / (width * height * 3) < 10, 'adaptive palette keeps the synthetic image mean color error below 10 of 255')
  } finally { rmSync(directory, { recursive: true, force: true }) }
})
