import type { MotionStyle } from './motion-style-catalog.ts'

type Context = CanvasRenderingContext2D

/** Original static composition studies; these thumbnails are not rendered videos. */
export function drawCodeStylePoster(canvas: HTMLCanvasElement, style: MotionStyle): void {
  const c = canvas.getContext('2d')
  if (!c) return
  const p = style.palette
  c.save(); c.scale(canvas.width / 480, canvas.height / 270)
  const rect = (x: number, y: number, w: number, h: number, color: string, radius = 0) => {
    c.fillStyle = color; c.beginPath(); c.roundRect(x, y, w, h, radius); c.fill()
  }
  const line = (points: number[][], color = p.accent, width = 2) => {
    c.strokeStyle = color; c.lineWidth = width; c.beginPath()
    points.forEach(([x, y], i) => i ? c.lineTo(x!, y!) : c.moveTo(x!, y!)); c.stroke()
  }
  const circle = (x: number, y: number, r: number, color: string) => {
    c.fillStyle = color; c.beginPath(); c.arc(x, y, r, 0, Math.PI * 2); c.fill()
  }
  const label = (value: string, x: number, y: number, size = 10, color = p.textColor) => {
    c.fillStyle = color; c.font = `600 ${size}px sans-serif`; c.fillText(value, x, y)
  }
  const bars = (x: number, y: number, w: number, color = p.textColor) => {
    rect(x, y, w, 6, color, 2); rect(x, y + 14, w * .72, 3, `${color}70`, 1)
  }
  const scene = (x: number, y: number, w: number, h: number) => {
    c.save(); c.beginPath(); c.rect(x, y, w, h); c.clip()
    const g = c.createLinearGradient(x, y, x, y + h); g.addColorStop(0, p.secondary); g.addColorStop(1, p.background)
    c.fillStyle = g; c.fillRect(x, y, w, h)
    circle(x + w * .76, y + h * .27, h * .12, `${p.textColor}b0`)
    c.fillStyle = `${p.accent}c0`; c.beginPath(); c.moveTo(x, y + h)
    c.lineTo(x + w * .32, y + h * .36); c.lineTo(x + w * .57, y + h * .72); c.lineTo(x + w * .86, y + h * .43); c.lineTo(x + w, y + h); c.fill()
    c.restore()
  }
  rect(0, 0, 480, 270, p.background)
  switch (style.id) {
    case 'product-keynote': {
      const g = c.createRadialGradient(245, 120, 10, 245, 120, 225)
      g.addColorStop(0, `${p.accent}38`); g.addColorStop(1, `${p.accent}00`)
      c.fillStyle = g; c.fillRect(0, 0, 480, 270)
      label('01 / IN FOCUS', 29, 34, 10, p.secondary)
      rect(127, 57, 259, 150, `${p.textColor}25`, 10); rect(130, 60, 253, 144, p.background, 8)
      rect(144, 76, 64, 112, `${p.textColor}0d`, 4)
      for (let i = 0; i < 5; i++) rect(154, 90 + i * 18, 38 - i % 2 * 9, 4, i ? `${p.textColor}50` : p.accent, 2)
      scene(220, 76, 148, 77); bars(220, 166, 102)
      line([[220, 83], [220, 76], [236, 76]], p.secondary, 2)
      circle(350, 124, 5, p.secondary); line([[350, 124], [412, 96], [445, 96]], p.secondary)
      rect(106, 208, 300, 5, `${p.textColor}45`, 3); bars(30, 225, 122)
      break
    }
    case 'evidence-dossier':
      for (let i = 0; i < 8; i++) line([[0, 24 + i * 32], [480, 24 + i * 32]], `${p.textColor}07`, 1)
      rect(28, 34, 186, 202, `${p.textColor}13`, 3); rect(24, 29, 186, 202, '#fffdf5', 3)
      label('SOURCE / 01', 42, 53, 10, p.secondary)
      for (let i = 0; i < 10; i++) rect(42, 72 + i * 13, 125 + (i % 3) * 8, 4, `${p.textColor}50`, 1)
      rect(38, 108, 152, 20, `${p.accent}30`, 1)
      line([[190, 118], [260, 94], [272, 94]], p.accent, 2)
      rect(265, 70, 185, 118, p.textColor, 5); label('EVIDENCE', 282, 94, 11, p.background)
      bars(282, 115, 144, p.background); bars(282, 151, 107, p.background)
      line([[282, 125], [422, 125]], p.accent, 4)
      label('01', 280, 226, 23, p.accent); line([[322, 217], [447, 217]], p.secondary)
      break
    case 'split-compare':
      scene(24, 54, 211, 165); scene(245, 54, 211, 165)
      rect(24, 54, 211, 165, `${p.background}38`)
      label('BEFORE', 24, 35, 12, p.accent); label('AFTER', 245, 35, 12, p.secondary)
      line([[240, 45], [240, 227]], p.textColor, 2); circle(240, 134, 15, p.textColor)
      line([[237, 129], [232, 134], [237, 139]], p.background, 2); line([[243, 129], [248, 134], [243, 139]], p.background, 2)
      for (const x of [48, 270]) { rect(x, 101, 78, 61, `${p.background}40`, 4); line([[x, 117], [x, 101], [x + 17, 101]], x < 240 ? p.accent : p.secondary, 3) }
      bars(24, 238, 128); bars(270, 238, 128)
      break
    case 'lyric-spectrum':
      for (let i = 0; i < 64; i++) {
        const a = i * Math.PI / 32, radius = 80, length = 9 + 27 * Math.abs(Math.sin(i * .48) * Math.cos(i * .21))
        line([[240 + Math.cos(a) * radius, 124 + Math.sin(a) * radius], [240 + Math.cos(a) * (radius + length), 124 + Math.sin(a) * (radius + length)]], i % 3 ? p.accent : p.secondary, 3)
      }
      c.save(); c.beginPath(); c.arc(240, 124, 70, 0, Math.PI * 2); c.clip(); scene(169, 53, 142, 142); c.restore()
      label('SOUND / MOTION', 180, 246, 12)
      for (let i = 0; i < 18; i++) { const h = 3 + Math.abs(Math.sin(i * .8)) * 14; rect(24 + i * 5, 125 - h / 2, 2, h, `${p.secondary}90`); rect(370 + i * 5, 125 - h / 2, 2, h, `${p.accent}90`) }
      break
    case 'vintage-film':
      rect(0, 37, 480, 197, '#0d0d0e')
      for (let i = 0; i < 17; i++) { rect(i * 30 + 5, 43, 16, 9, p.background, 2); rect(i * 30 + 5, 218, 16, 9, p.background, 2) }
      scene(-100, 63, 168, 144); scene(80, 63, 270, 144); scene(362, 63, 168, 144)
      rect(80, 63, 270, 144, '#c6903b30')
      for (let i = 0; i < 280; i++) rect((i * 139 % 479), 63 + (i * 53 % 144), 1, 1, '#ffeedc35')
      label('FRAME 024', 84, 198, 9, '#fff3d7'); label('MEMORY / SEQUENCE', 24, 24, 10)
      break
    case 'route-atlas': {
      for (let i = 0; i < 11; i++) { line([[i * 50, 0], [i * 50 - 70, 270]], `${p.secondary}18`, 1); line([[0, i * 30], [480, i * 30 + 45]], `${p.secondary}18`, 1) }
      c.strokeStyle = `${p.secondary}36`; c.lineWidth = 34; c.beginPath(); c.moveTo(-20, 190); c.bezierCurveTo(200, 20, 170, 300, 490, 100); c.stroke()
      const points = [[58, 184], [158, 112], [276, 151], [401, 65]]
      line(points, p.accent, 4)
      points.forEach(([x, y], i) => { circle(x!, y!, 9, p.background); circle(x!, y!, 4, p.accent); label(`0${i + 1}`, x! + 12, y! + 4, 10) })
      rect(27, 28, 139, 52, p.textColor, 5); label('ROUTE / STORY', 39, 48, 11, p.background); rect(39, 60, 81, 3, p.secondary)
      scene(320, 160, 132, 77); rect(320, 235, 132, 3, p.accent)
      break
    }
    case 'macro-lens':
      scene(25, 49, 245, 170)
      rect(114, 91, 61, 61, `${p.background}45`); c.strokeStyle = p.accent; c.lineWidth = 2; c.strokeRect(114, 91, 61, 61)
      line([[175, 91], [318, 63]], p.accent, 1); line([[175, 152], [318, 208]], p.accent, 1)
      circle(366, 134, 84, p.accent); circle(366, 134, 80, p.background)
      c.save(); c.beginPath(); c.arc(366, 134, 75, 0, Math.PI * 2); c.clip(); scene(258, 19, 290, 255); c.restore()
      line([[350, 134], [382, 134]], p.textColor, 1); line([[366, 118], [366, 150]], p.textColor, 1)
      label('DETAIL / 3×', 312, 245, 11); label('SOURCE', 26, 30, 10)
      break
    case 'parallax-panorama':
      for (let i = 3; i >= 0; i--) {
        const x = 45 + i * 31, y = 34 + i * 22
        rect(x - 2, y - 2, 292, 152, `${p.textColor}40`, 3); scene(x, y, 288, 148)
        rect(x, y, 288, 148, `${p.background}${i ? '50' : '00'}`)
      }
      c.setLineDash([5, 5]); line([[28, 242], [118, 231], [262, 243], [444, 218]], p.accent, 2); c.setLineDash([])
      circle(276, 242, 4, p.accent); label('CAMERA →', 350, 250, 11)
      break
    case 'data-story':
      label('DATA / INSIGHT', 28, 32, 11, p.secondary); label('01', 28, 77, 32)
      bars(88, 53, 93); rect(28, 100, 124, 124, `${p.textColor}07`, 5)
      for (let i = 0; i < 5; i++) { bars(40, 115 + i * 19, 47, `${p.textColor}65`); rect(115, 115 + i * 19, 22, 5, `${p.accent}85`, 1) }
      for (let i = 0; i < 4; i++) line([[184, 83 + i * 44], [454, 83 + i * 44]], `${p.textColor}15`, 1)
      ;[61, 92, 76, 139, 165].forEach((h, i) => rect(195 + i * 51, 215 - h, 28, h, i === 4 ? p.secondary : p.accent, 3))
      line([[184, 213], [454, 213]], `${p.textColor}70`, 1)
      label('SOURCE → COMPARISON', 184, 246, 10)
      break
    case 'blueprint-explode':
      for (let i = 0; i < 16; i++) { line([[i * 32, 0], [i * 32, 270]], `${p.accent}12`, 1); line([[0, i * 32], [480, i * 32]], `${p.accent}12`, 1) }
      c.setLineDash([3, 5]); line([[240, 23], [240, 245]], `${p.textColor}50`, 1); c.setLineDash([])
      for (let i = 2; i >= 0; i--) {
        const y = 58 + i * 70, points = [[141, y], [240, y - 31], [339, y], [240, y + 31], [141, y]]
        c.fillStyle = `${p.accent}${i === 1 ? '58' : '28'}`; c.beginPath(); points.forEach(([x, py], j) => j ? c.lineTo(x!, py!) : c.moveTo(x!, py!)); c.fill(); line(points, p.accent, 1.5)
        line([[339, y], [372, y - 15], [429, y - 15]], p.secondary, 1); label(`0${3 - i}`, 401, y - 22, 10)
        line([[141, y], [141, y + 9], [240, y + 40], [339, y + 9], [339, y]], `${p.accent}75`, 1)
      }
      label('ASSEMBLY / LAYERS', 24, 250, 10)
      break
  }
  c.restore()
}
