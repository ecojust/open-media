import test from 'node:test'
import assert from 'node:assert/strict'
import { FRAGMENT_EFFECTS, drawFragmentTransition, fragmentTransitionPlan, isFragmentEffect } from '../src/core/fragment-transitions.ts'
import { transitionVisualForParameters } from '../src/core/transitions.ts'

const close = (a, b, message) => assert(Math.abs(a - b) < 1e-8, message ?? `${a} != ${b}`)

test('碎片只分割源画面，数量有界，完整端点覆盖原画面且消失端点完全透明', () => {
  assert.equal(FRAGMENT_EFFECTS.length, 12)
  assert(!isFragmentEffect('fade'))
  for (const effect of FRAGMENT_EFFECTS) {
    assert(isFragmentEffect(effect))
    const start = fragmentTransitionPlan(effect, 1, 1920, 1080)
    assert(start.pieces.length > 1 && start.pieces.length <= 160)
    close(start.pieces.reduce((sum, tile) => sum + tile.sourceRect.width * tile.sourceRect.height, 0), 1920 * 1080)
    for (const tile of start.pieces) {
      assert(tile.sourceRect.x >= 0 && tile.sourceRect.y >= 0)
      assert(tile.sourceRect.x + tile.sourceRect.width <= 1920 + 1e-8)
      assert(tile.sourceRect.y + tile.sourceRect.height <= 1080 + 1e-8)
      close(tile.center.x, tile.sourceRect.x + tile.sourceRect.width / 2)
      close(tile.center.y, tile.sourceRect.y + tile.sourceRect.height / 2)
      close(tile.scaleX, 1); close(tile.scaleY, 1); close(tile.rotation, 0); close(tile.opacity, 1)
    }
    close(start.rotation, 0)
    assert(fragmentTransitionPlan(effect, 0, 1920, 1080).pieces.every(tile => tile.opacity === 0))
    assert.deepEqual(fragmentTransitionPlan(effect, -1, 1920, 1080), fragmentTransitionPlan(effect, 0, 1920, 1080))
    assert.deepEqual(fragmentTransitionPlan(effect, 2, 1920, 1080), start)
  }
})

test('碎片轨迹可重复定位，任意比例下旋转碎片不越过对应网格单元', () => {
  for (const [width, height] of [[1920, 1080], [1080, 1920], [3000, 500], [500, 3000]]) {
    for (const effect of FRAGMENT_EFFECTS) for (const visibility of [0, .01, .21, .5, .83, .99, 1]) {
      const plan = fragmentTransitionPlan(effect, visibility, width, height)
      // Seeking elsewhere and returning cannot change the geometry.
      fragmentTransitionPlan(effect, .324, width, height)
      assert.deepEqual(fragmentTransitionPlan(effect, visibility, width, height), plan)
      for (const tile of plan.pieces) {
        for (const value of [tile.center.x, tile.center.y, tile.scaleX, tile.scaleY, tile.rotation, tile.opacity]) assert(Number.isFinite(value))
        assert(tile.opacity >= 0 && tile.opacity <= 1)
        if (!effect.startsWith('fragment-') && effect !== 'tile-orbit') continue
        const c = Math.abs(Math.cos(tile.rotation)), s = Math.abs(Math.sin(tile.rotation))
        assert(tile.sourceRect.width * tile.scaleX * c + tile.sourceRect.height * tile.scaleY * s <= plan.spacing * width / plan.cols + 1e-8)
        assert(tile.sourceRect.height * tile.scaleY * c + tile.sourceRect.width * tile.scaleX * s <= plan.spacing * height / plan.rows + 1e-8)
      }
    }
  }
})

test('十二种运动具有不同空间行为，像素延迟和棋盘翻转在切点两侧对称', () => {
  const plans = Object.fromEntries(FRAGMENT_EFFECTS.map(effect => [effect, fragmentTransitionPlan(effect, .5, 1600, 1000)]))
  assert(plans['fragment-burst'].spacing > 1)
  assert(plans['fragment-vortex'].rotation > 0)
  assert(plans['fragment-collapse'].spacing < 1 && plans['fragment-collapse'].rotation < 0)
  const wave = plans['pixel-wave'].pieces
  assert(wave[0].opacity > wave.at(-1).opacity)
  assert(new Set(plans['pixel-dissolve'].pieces.map(tile => tile.opacity)).size > 50)
  const horizontal = plans['slice-stagger'].pieces
  assert(horizontal[0].center.x < 800 && horizontal[1].center.x > 800)
  close(horizontal[0].center.y, horizontal[0].sourceRect.height / 2)
  const vertical = plans['slice-vertical'].pieces
  assert(vertical[0].center.y < 500 && vertical[1].center.y > 500)
  close(vertical[0].center.x, vertical[0].sourceRect.width / 2)
  const checker = plans['checker-flip'].pieces
  assert(checker[0].scaleX > checker[1].scaleX)
  assert(checker.every(tile => tile.scaleY > tile.scaleX))
  const orbit = plans['tile-orbit']
  assert(orbit.spacing > 1 && orbit.rotation < 0)
  for (const piece of orbit.pieces) close(orbit.rotation + piece.rotation, 0, '环绕时画面纹理保持竖直')
  const jitter = plans['glitch-slices'].pieces
  assert(jitter.some(piece => piece.center.x < 800) && jitter.some(piece => piece.center.x > 800))
  assert(jitter.every(piece => Math.abs(piece.center.x - 800) <= .16 * .5 * 1600))
  const zipper = plans['zipper-slices'].pieces
  assert(zipper[0].center.x + zipper[0].sourceRect.width / 2 < 800)
  assert(zipper[1].center.x - zipper[1].sourceRect.width / 2 > 800)
  assert(zipper[0].opacity > zipper.at(-1).opacity)
  const shutter = plans['stepped-shutter'].pieces
  for (const piece of shutter) close(piece.center.x + piece.sourceRect.width * piece.scaleX / 2, piece.sourceRect.x + piece.sourceRect.width, '每片右边缘固定')
  assert(shutter[0].scaleX > shutter.at(-1).scaleX)
  for (const effect of FRAGMENT_EFFECTS) {
    const visual = transitionVisualForParameters(effect, .5, { easing: 'ease-in', blur: 8 })
    close(visual.visibility, .25); close(visual.blurStrength, .75); close(visual.blur, 8)
    // Tile alpha is the only added opacity; do not fade the frame a second time.
    close(visual.opacity, 1)
  }
})

function drawingContext() {
  const calls = [], stack = []
  return {
    calls, globalAlpha: .6,
    save() { stack.push(this.globalAlpha) },
    restore() { this.globalAlpha = stack.pop() },
    beginPath() {}, rect() {}, clip() {}, translate() {}, rotate() {}, scale() {},
    drawImage(...args) { calls.push({ args, alpha: this.globalAlpha }) },
  }
}

test('绘制使用当前帧真实源像素，端点无缝且不额外分配媒体或绘图缓冲', () => {
  for (const effect of FRAGMENT_EFFECTS) {
    const ctx = drawingContext(), frame = { id: 'current-frame' }
    drawFragmentTransition(ctx, frame, 320, 180, effect, 0, 1280, 720)
    assert.equal(ctx.calls.length, 0)
    drawFragmentTransition(ctx, frame, 320, 180, effect, 1, 1280, 720)
    assert.equal(ctx.calls.length, 1)
    assert.deepEqual(ctx.calls[0].args, [frame, 0, 0, 320, 180, 0, 0, 1280, 720])
    ctx.calls.length = 0
    drawFragmentTransition(ctx, frame, 320, 180, effect, .61, 1280, 720)
    assert(ctx.calls.length > 1 && ctx.calls.length <= 160)
    assert(ctx.calls.every(call => call.args[0] === frame && call.args[1] >= 0 && call.args[2] >= 0 && call.args[3] > 0 && call.args[4] > 0 && call.alpha <= .6))
    close(ctx.globalAlpha, .6)
    const nextFrame = { id: 'next-frame' }
    ctx.calls.length = 0
    drawFragmentTransition(ctx, nextFrame, 320, 180, effect, .61, 1280, 720)
    assert(ctx.calls.every(call => call.args[0] === nextFrame), '重复帧不允许使用旧位图')
  }
})
