/** Stable fragment geometry shared by timeline playback and material previews. */
export const FRAGMENT_EFFECTS = ['fragment-burst', 'fragment-vortex', 'fragment-collapse', 'pixel-dissolve', 'pixel-wave', 'slice-stagger', 'slice-vertical', 'checker-flip', 'tile-orbit', 'glitch-slices', 'zipper-slices', 'stepped-shutter'] as const
export type FragmentEffect = typeof FRAGMENT_EFFECTS[number]

export interface TransitionFragment {
  sourceRect: { x: number; y: number; width: number; height: number }
  /** Destination center before rotating the whole frame. */
  center: { x: number; y: number }
  scaleX: number
  scaleY: number
  /** Radians around this fragment's center. */
  rotation: number
  opacity: number
}

export interface FragmentTransitionPlan {
  visibility: number
  width: number
  height: number
  cols: number
  rows: number
  spacing: number
  /** Radians around the original frame center. */
  rotation: number
  pieces: TransitionFragment[]
}

export function isFragmentEffect(effect: string): effect is FragmentEffect {
  return (FRAGMENT_EFFECTS as readonly string[]).includes(effect)
}

const clamp = (value: number) => Math.max(0, Math.min(1, value))

/** Visibility has already passed through the transition's selected easing. */
export function fragmentTransitionPlan(effect: FragmentEffect, visibility: number, width: number, height: number): FragmentTransitionPlan {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) throw new Error('转场画面尺寸必须为正数。')
  const v = Number.isFinite(visibility) ? clamp(visibility) : 0, d = 1 - v
  const pixel = effect === 'pixel-dissolve' || effect === 'pixel-wave'
  const horizontal = effect === 'slice-stagger' || effect === 'glitch-slices'
  const vertical = effect === 'slice-vertical' || effect === 'stepped-shutter'
  const cols = pixel ? 16 : horizontal ? 1 : vertical ? 12 : effect === 'zipper-slices' ? 2 : effect === 'checker-flip' ? 10 : 8
  const rows = pixel ? 10 : effect === 'glitch-slices' ? 16 : effect === 'slice-stagger' || effect === 'zipper-slices' ? 12 : vertical ? 1 : effect === 'checker-flip' ? 6 : 5
  const spacing = effect === 'fragment-burst' ? 1 + .9 * d : effect === 'fragment-vortex' ? 1 + .65 * d : effect === 'fragment-collapse' ? 1 - .65 * d : effect === 'tile-orbit' ? 1 + .45 * d : 1
  const rotation = effect === 'fragment-vortex' ? 1.1 * d : effect === 'fragment-collapse' ? -.5 * d : effect === 'tile-orbit' ? -2 * d : 0
  const cw = width / cols, ch = height / rows
  const pieces: TransitionFragment[] = []
  for (let row = 0; row < rows; row++) for (let col = 0; col < cols; col++) {
    const h = ((col * 37 + row * 17 + col * row * 13) % 101) / 100
    let scaleX = 1, scaleY = 1, phi = 0, opacity = v, offsetX = 0, offsetY = 0
    if (effect === 'fragment-burst' || effect === 'fragment-vortex' || effect === 'fragment-collapse' || effect === 'tile-orbit') {
      phi = effect === 'tile-orbit' ? 2 * d : (h - .5) * Math.PI * d * (effect === 'fragment-burst' ? 1.2 : effect === 'fragment-collapse' ? .8 : 1)
      const scale = effect === 'fragment-burst' ? v ** 1.4 : effect === 'fragment-vortex' ? v ** 1.25 : effect === 'tile-orbit' ? v ** 1.2 : spacing * v ** 1.1
      // Keep rotated fragments inside their grid cells so neighboring pieces
      // retain distinct edges throughout the movement.
      scaleX = scaleY = Math.min(scale,
        spacing / (Math.abs(Math.cos(phi)) + ch / cw * Math.abs(Math.sin(phi))),
        spacing / (Math.abs(Math.cos(phi)) + cw / ch * Math.abs(Math.sin(phi))))
    } else {
      const delay = effect === 'pixel-dissolve' ? .45 * h
        : effect === 'pixel-wave' ? .6 * (col / 15 + row / 9) / 2
          : effect === 'checker-flip' ? .25 * ((col + row) % 2)
            : effect === 'glitch-slices' ? 0 : effect === 'zipper-slices' ? .45 * row / 11
              : effect === 'stepped-shutter' ? .55 * col / 11 : .25 * h
      const q = clamp((v - delay) / (1 - delay))
      opacity = effect === 'pixel-wave' ? Math.sqrt(q) : q
      if (pixel) scaleX = scaleY = q
      if (effect === 'slice-stagger') offsetX = (row % 2 ? 1 : -1) * (1 - q) * width
      if (effect === 'slice-vertical') offsetY = (col % 2 ? 1 : -1) * (1 - q) * height
      if (effect === 'checker-flip') { scaleX = Math.sin(q * Math.PI / 2); scaleY = .9 + .1 * q }
      if (effect === 'glitch-slices') offsetX = Math.sin(24 * Math.PI * d + 6 * Math.PI * h) * .16 * d * width
      if (effect === 'zipper-slices') offsetX = (col === 0 ? -1 : 1) * (1 - q) * width * .6
      if (effect === 'stepped-shutter') { scaleX = q; offsetX = (1 - q) * cw / 2; opacity = q ** .25 }
    }
    pieces.push({
      sourceRect: { x: col * cw, y: row * ch, width: cw, height: ch },
      center: { x: width / 2 + spacing * ((col + .5) * cw - width / 2) + offsetX, y: height / 2 + spacing * ((row + .5) * ch - height / 2) + offsetY },
      scaleX, scaleY, rotation: phi, opacity,
    })
  }
  return { visibility: v, width, height, cols, rows, spacing, rotation, pieces }
}

/** Draw current frame pixels; this function neither snapshots nor owns media. */
export function drawFragmentTransition(ctx: CanvasRenderingContext2D, source: CanvasImageSource, sourceWidth: number, sourceHeight: number, effect: FragmentEffect, visibility: number, width: number, height: number): void {
  if (!(visibility > 0)) return
  // The intact endpoint is a single draw, preventing any grid seams.
  if (visibility >= 1) { ctx.drawImage(source, 0, 0, sourceWidth, sourceHeight, 0, 0, width, height); return }
  const plan = fragmentTransitionPlan(effect, visibility, width, height)
  ctx.save()
  ctx.beginPath(); ctx.rect(0, 0, width, height); ctx.clip()
  ctx.translate(width / 2, height / 2); ctx.rotate(plan.rotation); ctx.translate(-width / 2, -height / 2)
  for (const piece of plan.pieces) {
    if (piece.opacity <= 0 || piece.scaleX <= 0 || piece.scaleY <= 0) continue
    const rect = piece.sourceRect
    ctx.save()
    ctx.globalAlpha *= piece.opacity
    ctx.translate(piece.center.x, piece.center.y); ctx.rotate(piece.rotation); ctx.scale(piece.scaleX, piece.scaleY)
    ctx.drawImage(source, rect.x / width * sourceWidth, rect.y / height * sourceHeight,
      rect.width / width * sourceWidth, rect.height / height * sourceHeight,
      -rect.width / 2, -rect.height / 2, rect.width, rect.height)
    ctx.restore()
  }
  ctx.restore()
}
