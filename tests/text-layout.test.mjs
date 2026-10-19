import test from 'node:test'
import assert from 'node:assert/strict'
import { createTextClip } from '../src/core/project.ts'
import { drawTextClip } from '../src/core/preview.ts'
import { TextLayoutCache } from '../src/core/text-layout.ts'

function makeContext() {
  return {
    measurements: 0, painted: [],
    measureText(text) { this.measurements++; return { width: text.length * (parseFloat(this.font.match(/[\d.]+px/)?.[0]) || 20) / 2 } },
    fillRect(...args) { this.painted.push(['background', this.fillStyle, ...args]) },
    fillText(...args) { this.painted.push(['text', this.fillStyle, this.font, ...args]) },
  }
}

test('连续字幕帧重用折行和字形测量，变更位置、颜色、透明度仍绘制最新属性', () => {
  const context = makeContext(), cache = new TextLayoutCache()
  const clip = createTextClip({ width: 640, height: 360 }, { text: '文字测试 longer text\n第二行', width: 180, background: '#123456' })
  drawTextClip(context, clip, cache)
  const measured = context.measurements
  for (let frame = 0; frame < 120; frame++) drawTextClip(context, { ...clip, x: frame, opacity: frame / 120, color: '#abcdef' }, cache)
  assert.equal(context.measurements, measured)
  assert.equal(context.painted.at(-1)[1], '#abcdef')
  cache.dispose()
})

test('文本、字体、框宽与对齐连续修改和撤销后，缓存绘制与直接测量完全一致', () => {
  const context = makeContext(), reference = makeContext(), cache = new TextLayoutCache()
  const original = createTextClip({ width: 640, height: 360 }, { text: 'A title\n中文字幕 repeated text', width: 220, background: '#123456' })
  const variants = [original, { ...original, text: '新内容 Long edited subtitle' }, { ...original, width: 140 },
    { ...original, fontSize: 37, fontWeight: 400, fontFamily: 'serif' }, { ...original, textAlign: 'left', textVerticalAlign: 'top' },
    { ...original, textAlign: 'right', textVerticalAlign: 'bottom', height: 220 }, { ...original, background: 'transparent' },
    { ...original, textRole: 'watermark' }, { ...original, text: ' \n' }, original]
  for (const clip of variants) {
    context.painted = []; reference.painted = []
    drawTextClip(context, clip, cache); drawTextClip(reference, clip)
    assert.deepEqual(context.painted, reference.painted)
  }
  for (const name of ['direction', 'fontKerning', 'fontStretch', 'fontVariantCaps', 'letterSpacing', 'wordSpacing', 'textRendering']) {
    const measured = context.measurements
    context[name] = 'changed'
    drawTextClip(context, original, cache)
    assert(context.measurements > measured, `${name} 影响字体布局时须重新测量`)
  }
  cache.dispose()
})

test('字体加载完成、失败、同数量替换字体与修改字体描述符都会使旧布局失效', () => {
  class Fonts extends EventTarget {
    status = 'loaded'
    faces = [{ family: 'Test', style: 'normal', weight: '400', status: 'loaded' }];
    [Symbol.iterator]() { return this.faces.values() }
  }
  const previous = globalThis.document, fonts = new Fonts()
  globalThis.document = { fonts }
  const context = makeContext(), cache = new TextLayoutCache()
  try {
    const clip = createTextClip({ width: 640, height: 360 }, { text: '字体加载测试' })
    const invalidate = action => { drawTextClip(context, clip, cache); const measured = context.measurements; action(); drawTextClip(context, clip, cache); assert(context.measurements > measured) }
    invalidate(() => fonts.dispatchEvent(new Event('loadingdone')))
    invalidate(() => fonts.dispatchEvent(new Event('loadingerror')))
    invalidate(() => { fonts.faces = [{ ...fonts.faces[0] }] })
    invalidate(() => { fonts.faces[0].featureSettings = '"kern" 0' })
    invalidate(() => { fonts.faces[0].sizeAdjust = '130%' })
    invalidate(() => { fonts.faces[0].variationSettings = '"wdth" 125' })
    fonts.status = 'loading'
    invalidate(() => {})
    fonts.status = 'loaded'
  } finally { cache.dispose(); if (previous === undefined) delete globalThis.document; else globalThis.document = previous }
})

test('编辑大量不同字幕后，布局按条数和文本总量淘汰，并在关闭时释放', () => {
  const context = makeContext(), cache = new TextLayoutCache()
  context.font = '20px sans-serif'
  for (let i = 0; i < 300; i++) cache.get(context, `字幕 ${i}`, 1000, false)
  assert(cache.entries.size <= 128)
  for (let i = 0; i < 100; i++) cache.get(context, `${i} ${'文字'.repeat(1500)}`, 1000, false)
  assert(cache.characters <= 131072)
  assert(cache.entries.size < 128)
  cache.dispose()
  assert.equal(cache.entries.size, 0)
  assert.equal(cache.characters, 0)
  assert.equal(cache.context, undefined)
})
