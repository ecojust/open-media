import test from 'node:test'
import assert from 'node:assert/strict'
import { createProject, createTrack, createTextClip, createClip } from '../src/core/project.ts'
import { clipBounds, visibleVisualClips, snapClipPosition } from '../src/core/preview-position.ts'

const project = { width: 640, height: 360 }
const geometry = { x: 60, y: 40, width: 160, height: 40, rotation: 0 }
const near = (actual, expected) => assert(Math.abs(actual - expected) < 1e-8, `${actual} 应接近 ${expected}`)

test('旋转矩形的可见边界与围绕中心绘制保持一致，保留负坐标', () => {
  assert.deepEqual(clipBounds(geometry), { left: 60, top: 40, right: 220, bottom: 80, centerX: 140, centerY: 60 })
  const quarter = clipBounds({ ...geometry, rotation: 90 })
  near(quarter.left, 120); near(quarter.right, 160); near(quarter.top, -20); near(quarter.bottom, 140)
  const diagonal = clipBounds({ ...geometry, rotation: -45 })
  const half = 100 / Math.sqrt(2)
  near(diagonal.left, 140 - half); near(diagonal.bottom, 60 + half)
  assert.deepEqual(clipBounds({ ...geometry, x: -100 }), { left: -100, top: 40, right: 60, bottom: 80, centerX: -20, centerY: 60 })
})

test('吸附同时覆盖画布中心与四侧，距离阈值不会截断自由位置', () => {
  assert.deepEqual(snapClipPosition(geometry, { x: 242, y: 162 }, project, [], 6), { x: 240, y: 160, guides: { x: 320, y: 180 } })
  assert.deepEqual(snapClipPosition(geometry, { x: 3, y: 4 }, project, [], 6), { x: 0, y: 0, guides: { x: 0, y: 0 } })
  assert.deepEqual(snapClipPosition(geometry, { x: 477, y: 316 }, project, [], 6), { x: 480, y: 320, guides: { x: 640, y: 360 } })
  assert.deepEqual(snapClipPosition(geometry, { x: 90, y: 110 }, project, [], 6), { x: 90, y: 110, guides: { x: null, y: null } })
  assert.deepEqual(snapClipPosition(geometry, { x: 242, y: 162 }, project, [], 6, false), { x: 242, y: 162, guides: { x: null, y: null } })
})

test('可见片段提供中心和边缘参考，只选最近目标并处理旋转后边缘', () => {
  const reference = { x: 390, y: 90, width: 80, height: 60, rotation: 0 }
  assert.deepEqual(snapClipPosition(geometry, { x: 231, y: 91 }, project, [reference], 6), { x: 230, y: 90, guides: { x: 390, y: 90 } })
  assert.deepEqual(snapClipPosition(geometry, { x: 352, y: 102 }, project, [reference], 6), { x: 350, y: 100, guides: { x: 430, y: 120 } })
  const rotated = snapClipPosition({ ...geometry, rotation: 90 }, { x: -57, y: 61 }, project, [], 6)
  near(rotated.x, -60); near(rotated.y, 60)
  assert.equal(rotated.guides.x, 0); assert.equal(rotated.guides.y, 0)
  const scaled = snapClipPosition(geometry, { x: 250, y: 170 }, project, [], 12)
  assert.equal(scaled.x, 240); assert.equal(scaled.y, 160)
  assert.equal(snapClipPosition(geometry, { x: 250, y: 170 }, project, [], 6).guides.x, null)
})

test('当前画面参考排除透明、非活跃、音频、缺失素材与画布外片段，锁定画面仍可供对齐', () => {
  const p = createProject('当前画面', project)
  const text = createTrack('text'); text.id = 'labels'; text.locked = true
  const picture = createTrack('video'), audio = createTrack('audio')
  const asset = { id: 'image', name: '水印.png', kind: 'image', url: 'blob:image', duration: 0, width: 20, height: 20, size: 100, mime: 'image/png' }
  p.assets.push(asset)
  const label = (id, options = {}) => createTextClip(p, { ...geometry, id, trimOut: 3, text: id, ...options })
  text.clips.push(label('locked'), label('invisible', { opacity: 0 }), label('past', { start: 0, trimOut: 1 }), label('future', { start: 4 }), label('outside', { x: -300 }), label('partial', { x: -80 }), label('empty', { text: '', background: 'transparent' }), label('empty-subtitle-background', { text: '', background: '#cc2233' }), label('background', { text: '', textRole: 'watermark', background: '#cc2233' }), label('fade-start', { start: 1, fadeIn: 1 }))
  picture.clips.push(createClip(asset, p, { id: 'watermark', width: 20, height: 20 }), createClip(asset, p, { id: 'missing', assetId: 'missing' }))
  audio.clips.push(createClip(asset, p, { id: 'audio-only' }))
  p.tracks = [text, picture, audio]
  assert.deepEqual(visibleVisualClips(p, 1).map(item => item.clip.id), ['locked', 'partial', 'background', 'watermark'])
  assert(visibleVisualClips(p, 1.5).some(item => item.clip.id === 'fade-start'), '淡入开始后可见图形恢复对齐参考')
})
