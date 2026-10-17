import test from 'node:test'
import assert from 'node:assert/strict'
import { createTextClip } from '../src/core/project.ts'
import { drawTextClip, fitRect, clipOpacityAt } from '../src/core/preview.ts'
import { browserVideoExportSupported, exportTimelineWebM } from '../src/core/browser-export.ts'

test('画面适配保持源宽高比，裁切模式只截取超出部分', () => {
  assert.deepEqual(fitRect(1920, 1080, 100, 100, 'contain'), [0, 0, 1920, 1080, 0, 21.875, 100, 56.25])
  assert.deepEqual(fitRect(1920, 1080, 100, 100, 'cover'), [420, 0, 1080, 1080, 0, 0, 100, 100])
  assert.deepEqual(fitRect(1920, 1080, 100, 100, 'fill'), [0, 0, 1920, 1080, 0, 0, 100, 100])
})

test('预览淡入淡出与时间线规则一致，片段外不渲染', () => {
  const clip = createTextClip({ width: 640, height: 360 }, { start: 2, trimOut: 4, fadeIn: 3, fadeOut: 3, opacity: 0.8 })
  assert.equal(clipOpacityAt(clip, 1), 0)
  assert.equal(clipOpacityAt(clip, 4), 0.8 * 2 / 3)
  assert.equal(clipOpacityAt(clip, 6), 0)
})

test('字幕共享绘制函数保留空行、自动换行、背景和对齐设置', () => {
  const calls = []
  const context = {
    measureText: text => ({ width: text.length * 10 }),
    fillRect: (...args) => calls.push(['background', ...args]),
    fillText: (...args) => calls.push(['text', ...args]),
  }
  const clip = createTextClip({ width: 100, height: 100 }, { width: 54, height: 100, text: 'abcdef\n\nz', background: '#ffffff', textAlign: 'left', fontSize: 10 })
  drawTextClip(context, clip)
  assert.deepEqual(calls[0], ['background', 0, 0, 54, 100])
  assert.deepEqual(calls.filter(call => call[0] === 'text').map(call => call[1]), ['abc', 'def', '', 'z'])
  assert.equal(context.textAlign, 'left')
  assert.equal(calls[1][2], 12)
})

test('没有浏览器编码能力时明确拒绝导出，不返回伪造文件', async () => {
  assert.equal(browserVideoExportSupported(), false)
  await assert.rejects(() => exportTimelineWebM({}), /不支持视频导出/)
})

test('字幕纵向对齐定位整个多行文本块，保留空行、换行间距和原有居中位置', () => {
  const clip = createTextClip({ width: 320, height: 240 }, { width: 120, height: 200, text: '第一行\n\n末行', fontSize: 20 })
  const positions = {}
  for (const alignment of ['top', 'middle', 'bottom', undefined]) {
    const calls = []
    const context = { measureText: text => ({ width: text.length * 20 }), fillText: (...args) => calls.push(args) }
    drawTextClip(context, { ...clip, textVerticalAlign: alignment })
    positions[String(alignment)] = calls.map(([, , y]) => y)
    assert.deepEqual(calls.map(([text]) => text), ['第一行', '', '末行'])
    assert.equal(context.textBaseline, 'middle')
  }
  assert.deepEqual(positions.top, [22, 49, 76])
  assert.deepEqual(positions.middle, [73, 100, 127])
  assert.deepEqual(positions.bottom, [124, 151, 178])
  assert.deepEqual(positions.undefined, positions.middle, '旧字幕未设置纵向对齐时不应改变画面')
})
