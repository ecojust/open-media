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

test('字幕背景只包裹各行文字，空行不绘制背景，保留自动换行和对齐', () => {
  const calls = []
  const context = {
    measureText: text => ({ width: text.length * 10 }),
    fillRect: (...args) => calls.push(['background', ...args]),
    fillText: (...args) => calls.push(['text', ...args]),
  }
  const clip = createTextClip({ width: 100, height: 100 }, { width: 54, height: 100, text: 'abcdef\n\nz', background: '#ffffff', textAlign: 'left', fontSize: 10 })
  drawTextClip(context, clip)
  const backgrounds = calls.filter(call => call[0] === 'background')
  const text = calls.filter(call => call[0] === 'text')
  assert.equal(backgrounds.length, 3)
  assert.equal(backgrounds[0][1], 10)
  assert.equal(backgrounds[0][3], 34)
  assert.equal(backgrounds[2][3], 14, '短行背景宽度随文字缩小')
  assert(backgrounds.every(([, , , , height]) => height < 13))
  assert.deepEqual(text.map(call => call[1]), ['abc', 'def', '', 'z'])
  assert.equal(context.textAlign, 'left')
  assert.equal(text[0][2], 12)
  assert.equal(calls.findIndex(call => call[0] === 'text'), 3, '所有背景先绘制，避免遮盖相邻行文字')
})

test('少量文字在大字幕框中按真实字形范围着色，支持左中右对齐和空白字幕', () => {
  for (const alignment of ['left', 'center', 'right']) {
    const backgrounds = []
    const context = {
      measureText() {
        const left = this.textAlign === 'left' ? -1 : this.textAlign === 'right' ? 29 : 14
        return { width: 30, actualBoundingBoxLeft: left, actualBoundingBoxRight: 28 - left, actualBoundingBoxAscent: 8, actualBoundingBoxDescent: 6 }
      },
      fillRect: (...args) => backgrounds.push(args),
      fillText() {},
    }
    const clip = createTextClip({ width: 640, height: 360 }, { width: 600, height: 300, text: '文字', fontSize: 20, background: '#112233', textAlign: alignment })
    drawTextClip(context, clip)
    assert.equal(backgrounds.length, 1)
    assert.equal(backgrounds[0][2], 36)
    assert(Math.abs(backgrounds[0][3] - 18.8) < 1e-9)
    const x = alignment === 'left' ? 12 : alignment === 'right' ? 588 : 300
    const left = alignment === 'left' ? -1 : alignment === 'right' ? 29 : 14
    assert.equal(backgrounds[0][0], x - left - 4)
    assert.equal(backgrounds[0][1], 150 - 8 - 2.4)
    backgrounds.length = 0
    drawTextClip(context, { ...clip, text: '  \n\t' })
    assert.equal(backgrounds.length, 0, '空白文本应完全透明')
  }
})

test('文字水印模板保留作为设计元素的整块底板', () => {
  const backgrounds = []
  const context = { measureText: text => ({ width: text.length * 10 }), fillRect: (...args) => backgrounds.push(args), fillText() {} }
  drawTextClip(context, createTextClip({ width: 640, height: 360 }, { textRole: 'watermark', width: 400, height: 120, text: '章节标题', background: '#242a44' }))
  assert.deepEqual(backgrounds, [[0, 0, 400, 120]])
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
