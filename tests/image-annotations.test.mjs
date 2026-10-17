import test from 'node:test'
import assert from 'node:assert/strict'
import { validateImageAnnotations, cloneImageAnnotations, imageAnnotationBounds, hitImageAnnotation, MAX_IMAGE_ANNOTATIONS, MAX_IMAGE_ANNOTATION_POINTS, MAX_IMAGE_ANNOTATION_TEXT } from '../src/core/image-annotations.ts'

const label = (overrides = {}) => ({ kind: 'text', id: 'title', x: 10, y: 20, text: '图片文字\n第二行', fontSize: 24, fontFamily: 'sans-serif', fontWeight: 600, color: '#ffffff', opacity: 1, ...overrides })
const stroke = (overrides = {}) => ({ kind: 'stroke', id: 'stroke', points: [{ x: 10, y: 20 }, { x: 50, y: 20 }, { x: 50, y: 60 }], color: '#ff3366', width: 10, opacity: 0.4, style: 'pen', ...overrides })

test('原图坐标及文字笔触样式完整保留，校验和历史克隆隔离每个点', () => {
  const source = [label({ x: -12.5 }), stroke()]
  const normalized = validateImageAnnotations(source)
  assert.deepEqual(normalized, source)
  assert.notEqual(normalized[0], source[0])
  assert.notEqual(normalized[1].points[0], source[1].points[0])
  const copy = cloneImageAnnotations(normalized)
  copy[0].text = '副本'
  copy[1].points[0].x = 999
  assert.equal(normalized[0].text, source[0].text)
  assert.equal(normalized[1].points[0].x, 10)
  assert.deepEqual(validateImageAnnotations(undefined), [])
  assert.deepEqual(validateImageAnnotations([]), [])
  for (const style of ['pen', 'marker', 'dashed']) assert.equal(validateImageAnnotations([stroke({ style })])[0].style, style)
})

test('未知类型、空笔触、重复标识、非有限或超范围参数不能进入渲染', () => {
  for (const invalid of [null, {}, [null], Array(1), [label(), label()], [stroke({ points: [] })], [stroke({ points: Array(1) })], [stroke({ kind: 'unknown' })], [stroke({ style: 'invalid' })]]) assert.throws(() => validateImageAnnotations(invalid))
  for (const invalid of [NaN, Infinity, -Infinity, '12', null]) {
    for (const key of ['x', 'y', 'fontSize', 'fontWeight', 'opacity']) assert.throws(() => validateImageAnnotations([label({ [key]: invalid })]))
    assert.throws(() => validateImageAnnotations([stroke({ points: [{ x: invalid, y: 0 }] })]))
    assert.throws(() => validateImageAnnotations([stroke({ width: invalid })]))
  }
  for (const invalid of [-0.1, 1.1]) assert.throws(() => validateImageAnnotations([stroke({ opacity: invalid })]))
  for (const invalid of [0, -1, 2049]) assert.throws(() => validateImageAnnotations([stroke({ width: invalid })]))
  for (const invalid of ['#zzzzzz', 'url(https://invalid)', '#12345']) assert.throws(() => validateImageAnnotations([label({ color: invalid })]), /颜色/)
  for (const invalid of ['', 'sans-serif;24px', 'sans-serif\n', '""']) assert.throws(() => validateImageAnnotations([label({ fontFamily: invalid })]), /字体/)
})

test('元素、总笔触点和总文字限制在深复制之前明确拒绝', () => {
  assert.throws(() => validateImageAnnotations(Array.from({ length: MAX_IMAGE_ANNOTATIONS + 1 }, (_, index) => label({ id: `text-${index}` }))), /最多/)
  assert.throws(() => validateImageAnnotations([stroke({ points: new Array(MAX_IMAGE_ANNOTATION_POINTS + 1).fill({ x: 0, y: 0 }) })]), /复杂/)
  const half = new Array(Math.floor(MAX_IMAGE_ANNOTATION_POINTS / 2) + 1).fill({ x: 0, y: 0 })
  assert.throws(() => validateImageAnnotations([stroke({ id: 'first', points: half }), stroke({ id: 'second', points: half })]), /复杂/)
  assert.throws(() => validateImageAnnotations(Array.from({ length: Math.floor(MAX_IMAGE_ANNOTATION_TEXT / 20000) + 1 }, (_, index) => label({ id: `text-${index}`, text: '字'.repeat(20000) }))), /文字总量/)
  assert.throws(() => validateImageAnnotations([label({ text: '字'.repeat(20001) })]), /文字/)
})

test('笔触命中按实际折线路径计算，点笔触和透明元素也有明确行为', () => {
  const annotation = stroke()
  assert.deepEqual(imageAnnotationBounds(annotation), { x: 5, y: 15, width: 50, height: 50 })
  assert.equal(hitImageAnnotation(annotation, { x: 30, y: 23 }), true)
  assert.equal(hitImageAnnotation(annotation, { x: 48, y: 40 }), true)
  assert.equal(hitImageAnnotation(annotation, { x: 25, y: 45 }), false, '不能仅凭总包围框选中没有笔触的区域')
  assert.equal(hitImageAnnotation(annotation, { x: 30, y: 28 }), false)
  assert.equal(hitImageAnnotation(annotation, { x: 30, y: 28 }, 3), true)
  assert.equal(hitImageAnnotation(stroke({ style: 'dashed' }), { x: 30, y: 20 }), true)
  const dot = stroke({ points: [{ x: 20, y: 30 }] })
  assert.deepEqual(imageAnnotationBounds(dot), { x: 15, y: 25, width: 10, height: 10 })
  assert.equal(hitImageAnnotation(dot, { x: 24, y: 34 }), false)
  assert.equal(hitImageAnnotation({ ...dot, style: 'marker' }, { x: 24, y: 34 }), true)
  assert.equal(hitImageAnnotation({ ...dot, style: 'marker', points: [{ x: 20, y: 30 }, { x: 20, y: 30 }] }, { x: 24, y: 34 }), true)
  assert.equal(hitImageAnnotation({ ...dot, opacity: 0 }, { x: 20, y: 30 }), false)
  assert.equal(hitImageAnnotation(dot, { x: NaN, y: 30 }), false)
})

test('多行文字保留左上锚点与行高，空白文字不截获画布命中', () => {
  const annotation = label({ x: -10, y: 5, text: 'A\r\nB\rC', fontSize: 20 })
  assert.deepEqual(imageAnnotationBounds(annotation), { x: -10, y: 5, width: 13, height: 75 })
  assert.equal(hitImageAnnotation(annotation, { x: 0, y: 60 }), true)
  assert.equal(hitImageAnnotation(annotation, { x: 20, y: 60 }), false)
  assert.equal(hitImageAnnotation(label({ text: '  \n' }), { x: 10, y: 20 }), false)
})
