import test from 'node:test'
import assert from 'node:assert/strict'
import { resizeClipFromCorner } from '../src/core/preview-position.ts'

const project = { width: 640, height: 360 }
const clip = { x: 100, y: 80, width: 160, height: 80, rotation: 0 }
const near = (actual, expected) => assert(Math.abs(actual - expected) < 1e-8, `${actual} ≈ ${expected}`)
function anchor(value, corner) {
  const sx = corner.endsWith('e') ? -1 : 1, sy = corner.startsWith('s') ? -1 : 1
  const angle = value.rotation * Math.PI / 180
  return { x: value.x + value.width / 2 + Math.cos(angle) * sx * value.width / 2 - Math.sin(angle) * sy * value.height / 2,
    y: value.y + value.height / 2 + Math.sin(angle) * sx * value.width / 2 + Math.cos(angle) * sy * value.height / 2 }
}
test('图片角缩放保持比例与对角锚点，旋转后同样成立', () => {
  for (const rotation of [0, 35, 90, -120]) for (const corner of ['nw', 'ne', 'sw', 'se']) {
    const before = { ...clip, rotation }, next = resizeClipFromCorner(before, { x: 45, y: 36 }, corner, project, [], 6, false)
    near(next.width / next.height, 2)
    const a = anchor(before, corner), b = anchor({ ...next, rotation }, corner)
    near(a.x, b.x); near(a.y, b.y)
  }
})
test('角缩放吸附画面边缘并保留比例，关闭吸附后精确保留自由结果', () => {
  const before = { ...clip, x: 0, y: 0 }
  const snapped = resizeClipFromCorner(before, { x: 162, y: 81 }, 'se', project, [], 6)
  near(snapped.width, 320); near(snapped.height, 160); assert.equal(snapped.guides.x, 320)
  const free = resizeClipFromCorner(before, { x: 162, y: 81 }, 'se', project, [], 6, false)
  near(free.width, 322); near(free.height, 161)
})
test('自由缩放可单独调整宽高，越过对角不会产生负尺寸', () => {
  const resized = resizeClipFromCorner(clip, { x: 80, y: 0 }, 'se', project, [], 6, false, false)
  near(resized.width, 240); near(resized.height, 80)
  const crossed = resizeClipFromCorner(clip, { x: -500, y: -500 }, 'se', project, [], 6, false)
  assert(crossed.width >= 1 && crossed.height >= 1); near(crossed.width / crossed.height, 2)
})
