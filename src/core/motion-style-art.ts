import { getMotionStyle, type MotionStyle } from './motion-style-catalog.ts'

type Palette = MotionStyle['palette']
type Context = CanvasRenderingContext2D
function paletteFor(style: MotionStyle, override: Partial<Palette>): Palette {
  const palette = { ...style.palette, ...override }
  for (const value of Object.values(palette)) if (!/^#[\da-f]{6}$/i.test(value)) throw new Error('风格配色需使用六位十六进制颜色。')
  return palette
}
function rounded(ctx: Context, x: number, y: number, width: number, height: number, radius: number, color: string | CanvasGradient): void {
  ctx.fillStyle = color; ctx.beginPath(); ctx.roundRect(x, y, width, height, radius); ctx.fill()
}
function circle(ctx: Context, x: number, y: number, radius: number, color: string | CanvasGradient): void {
  ctx.fillStyle = color; ctx.beginPath(); ctx.arc(x, y, radius, 0, Math.PI * 2); ctx.fill()
}
function line(ctx: Context, points: number[][], color: string, width = 2, close = false): void {
  ctx.strokeStyle = color; ctx.lineWidth = width; ctx.beginPath()
  points.forEach(([x, y], i) => i ? ctx.lineTo(x!, y!) : ctx.moveTo(x!, y!))
  if (close) ctx.closePath()
  ctx.stroke()
}
function polygon(ctx: Context, points: number[][], color: string): void {
  ctx.fillStyle = color; ctx.beginPath()
  points.forEach(([x, y], i) => i ? ctx.lineTo(x!, y!) : ctx.moveTo(x!, y!))
  ctx.closePath(); ctx.fill()
}
function glow(ctx: Context, x: number, y: number, radius: number, color: string | CanvasGradient): void {
  const gradient = ctx.createRadialGradient(x, y, 0, x, y, radius)
  gradient.addColorStop(0, `${color}b0`); gradient.addColorStop(.45, `${color}55`); gradient.addColorStop(1, `${color}00`)
  circle(ctx, x, y, radius, gradient)
}
function grid(ctx: Context, color: string, spacing = 60): void {
  for (let x = 0; x <= 1600; x += spacing) line(ctx, [[x, 0], [x, 900]], color, 1)
  for (let y = 0; y <= 900; y += spacing) line(ctx, [[0, y], [1600, y]], color, 1)
}
function random(seed: number): () => number {
  let state = seed >>> 0
  return () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 4294967296 }
}
function grain(ctx: Context, color: string, count = 800): void {
  const next = random(34891)
  for (let i = 0; i < count; i++) {
    const x = next() * 1600, y = next() * 900
    line(ctx, [[x, y], [x + next() * 5, y + next() * 2]], color, .7)
  }
}

/** Draws original static artwork once; ordinary clip keyframes supply its movement. */
export function drawMotionStyleBackground(ctx: Context, width: number, height: number, styleId: string, override: Partial<Palette> = {}): void {
  const style = getMotionStyle(styleId), p = paletteFor(style, override)
  ctx.save(); ctx.scale(width / 1600, height / 900)
  ctx.fillStyle = p.background; ctx.fillRect(0, 0, 1600, 900)
  switch (style.id) {
    case 'paper-ink':
      grain(ctx, `${p.textColor}25`, 2200)
      line(ctx, [[54, 80], [60, 47], [200, 51]], `${p.textColor}a0`, 3)
      line(ctx, [[1400, 850], [1550, 845], [1547, 770]], `${p.textColor}a0`, 3)
      for (let i = 0; i < 7; i++) line(ctx, [[1270 + i * 22, 50], [1230 + i * 22, 110]], `${p.accent}48`, 5)
      break
    case 'iso-cards':
      for (let i = -1200; i < 2200; i += 100) { line(ctx, [[i, 0], [i + 1600, 900]], `${p.accent}16`, 1); line(ctx, [[i, 0], [i - 1600, 900]], `${p.accent}16`, 1) }
      polygon(ctx, [[940, 720], [1320, 500], [1600, 660], [1220, 880]], `${p.accent}20`)
      polygon(ctx, [[0, 140], [160, 48], [320, 140], [160, 232]], `${p.secondary}50`)
      break
    case 'flat-pop':
      circle(ctx, 1580, 80, 200, p.secondary); circle(ctx, 60, 900, 180, p.accent)
      polygon(ctx, [[1380, 770], [1500, 560], [1590, 850]], `${p.accent}55`)
      for (let i = 0; i < 6; i++) circle(ctx, 75 + i * 27, 80, 5, p.accent)
      break
    case 'line-focus':
      line(ctx, [[68, 130], [68, 68], [500, 68]], `${p.accent}a0`, 1.3)
      line(ctx, [[1100, 832], [1532, 832], [1532, 770]], `${p.accent}a0`, 1.3)
      for (let i = 0; i < 7; i++) { ctx.strokeStyle = `${p.accent}25`; ctx.lineWidth = 1; ctx.beginPath(); ctx.arc(1480, 140, 100 + i * 28, 0, Math.PI * 2); ctx.stroke() }
      break
    case 'studio-depth': {
      glow(ctx, 1250, 200, 650, p.accent); glow(ctx, 250, 810, 470, p.secondary)
      const floor = ctx.createLinearGradient(0, 600, 0, 900); floor.addColorStop(0, `${p.background}00`); floor.addColorStop(1, `${p.textColor}18`)
      ctx.fillStyle = floor; ctx.fillRect(0, 600, 1600, 300)
      ctx.fillStyle = `${p.textColor}07`; ctx.beginPath(); ctx.ellipse(850, 790, 510, 55, 0, 0, Math.PI * 2); ctx.fill()
      break
    }
    case 'shape-rhythm':
      rounded(ctx, -180, 90, 400, 720, 200, `${p.secondary}45`)
      rounded(ctx, 1450, -150, 250, 660, 125, `${p.accent}50`)
      circle(ctx, 1330, 830, 160, `${p.secondary}55`); circle(ctx, 1330, 830, 100, p.background)
      break
    case 'sticker-notes':
      grid(ctx, `${p.accent}10`, 50)
      for (const [x, y, a] of [[60, 65, -.15], [1470, 790, .18]]) { ctx.save(); ctx.translate(x!, y!); ctx.rotate(a!); rounded(ctx, -20, -18, 150, 50, 2, `${p.secondary}85`); ctx.restore() }
      line(ctx, [[1420, 80], [1530, 100], [1510, 150]], `${p.accent}80`, 4)
      break
    case 'tech-hud':
      grid(ctx, `${p.accent}12`, 50)
      for (const x of [55, 1545]) { line(ctx, [[x, 160], [x, 70], [x + (x < 800 ? 110 : -110), 70]], `${p.accent}a0`, 3); line(ctx, [[x, 740], [x, 830], [x + (x < 800 ? 110 : -110), 830]], `${p.accent}a0`, 3) }
      for (let i = 0; i < 35; i++) rounded(ctx, 100 + i * 40, 865, i % 5 ? 9 : 18, i % 5 ? 3 : 6, 0, `${p.accent}${i % 5 ? '35' : '99'}`)
      glow(ctx, 1480, 80, 260, p.accent)
      break
    case 'editorial-collage': {
      grain(ctx, `${p.textColor}24`, 2600)
      ctx.save(); ctx.translate(1450, 230); ctx.rotate(.14); rounded(ctx, -80, -360, 180, 1000, 0, `${p.accent}32`); ctx.restore()
      for (let y = 30; y < 900; y += 12) for (let x = 20; x < 140; x += 12) circle(ctx, x, y, 1.8, `${p.textColor}35`)
      polygon(ctx, [[1020, 850], [1090, 820], [1110, 838], [1190, 815], [1250, 842], [1330, 818], [1420, 838], [1600, 810], [1600, 900], [1020, 900]], p.secondary)
      break
    }
    case 'aurora-glass':
      glow(ctx, 100, 160, 800, p.accent); glow(ctx, 1450, 760, 900, p.secondary); glow(ctx, 1250, 80, 550, p.accent)
      rounded(ctx, 38, 38, 1524, 824, 48, '#ffffff06')
      ctx.strokeStyle = '#ffffff20'; ctx.lineWidth = 1; ctx.beginPath(); ctx.roundRect(38, 38, 1524, 824, 48); ctx.stroke()
      break
    case 'geometric-grid':
      grid(ctx, `${p.textColor}12`, 150)
      circle(ctx, 1520, 60, 170, p.accent)
      rounded(ctx, 0, 650, 130, 250, 0, p.secondary)
      polygon(ctx, [[1380, 900], [1600, 680], [1600, 900]], p.textColor)
      for (let i = 0; i < 5; i++) line(ctx, [[80 + i * 18, 40], [80 + i * 18, 120]], p.textColor, 6)
      break
    case 'neon-retro': {
      glow(ctx, 800, 500, 560, p.accent)
      const sun = ctx.createLinearGradient(0, 25, 0, 300); sun.addColorStop(0, p.secondary); sun.addColorStop(1, p.accent)
      circle(ctx, 1380, 140, 180, sun)
      for (let y = 140; y < 330; y += 23) rounded(ctx, 1180, y, 400, 6 + (y - 140) / 13, 0, p.background)
      for (let x = -1600; x <= 3200; x += 160) line(ctx, [[800 + (x - 800) * .15, 570], [x, 900]], `${p.secondary}50`, 1.5)
      for (let i = 0; i < 9; i++) { const y = 570 + i * i * 5; line(ctx, [[0, y], [1600, y]], `${p.accent}80`, 1) }
      break
    }
    case 'pixel-arcade':
      for (let i = 0; i < 12; i++) { rounded(ctx, i * 28, 900 - (i % 4 + 1) * 28, 28, (i % 4 + 1) * 28, 0, p.accent); rounded(ctx, 1572 - i * 28, 0, 28, (i % 3 + 1) * 28, 0, p.secondary) }
      for (let i = 0; i < 48; i++) { const x = ((i * 317) % 1480) + 60, y = ((i * 151) % 760) + 70; rounded(ctx, x, y, 4, 4, 0, `${p.textColor}35`) }
      break
    case 'liquid-color':
      glow(ctx, 200, 100, 650, p.accent); glow(ctx, 1400, 760, 640, p.secondary)
      for (const [x,y,r] of [[-80,600,210],[1540,90,220],[1340,940,240]]) circle(ctx,x!,y!,r!,`${p.accent}38`)
      break
    case 'expressive-type':
      for (let i = 0; i < 38; i++) { const a = i * Math.PI * 2 / 38; line(ctx, [[800 + Math.cos(a) * 730, 450 + Math.sin(a) * 390], [800 + Math.cos(a) * 920, 450 + Math.sin(a) * 580]], `${p.accent}24`, i % 3 ? 3 : 8) }
      for (let i = 0; i < 10; i++) circle(ctx, 60 + i * 22, 75 + (i % 2) * 16, 5, p.secondary)
      break
  }
  ctx.restore()
}

export function drawMotionStyleDecoration(ctx: Context, size: number, styleId: string, override: Partial<Palette> = {}): void {
  const style = getMotionStyle(styleId), p = paletteFor(style, override)
  ctx.save(); ctx.scale(size / 640, size / 640)
  switch (style.id) {
    case 'paper-ink':
      for (let i = 0; i < 3; i++) line(ctx, [[100+i*3,330],[250,100+i*3],[435,160],[520,350],[370,530],[160,480],[100+i*3,330]], `${p.textColor}${i ? '70' : 'ff'}`, 5)
      circle(ctx, 330, 310, 128, `${p.secondary}c0`); line(ctx, [[220,300],[310,390],[430,220]], p.accent, 18)
      break
    case 'iso-cards':
      for (let i = 2; i >= 0; i--) { const y=245+i*75; polygon(ctx,[[95,y],[320,y-130],[545,y],[320,y+130]],i===0?p.accent:p.secondary); polygon(ctx,[[95,y],[320,y+130],[320,y+155],[95,y+25]],`${p.textColor}40`); polygon(ctx,[[320,y+130],[545,y],[545,y+25],[320,y+155]],`${p.textColor}24`) }
      break
    case 'flat-pop':
      circle(ctx,230,250,160,p.accent);polygon(ctx,[[300,460],[470,160],[600,460]],p.secondary);rounded(ctx,75,390,260,130,22,p.textColor)
      break
    case 'line-focus':
      for(let i=0;i<8;i++){ctx.strokeStyle=`${p.accent}${i%2?'70':'dd'}`;ctx.lineWidth=3;ctx.beginPath();ctx.ellipse(320,320,220,70+i*16,i*Math.PI/8,0,Math.PI*2);ctx.stroke()}
      circle(ctx,510,280,12,p.accent)
      break
    case 'studio-depth': {
      const gradient=ctx.createRadialGradient(230,180,10,320,320,225);gradient.addColorStop(0,'#ffffff');gradient.addColorStop(.25,p.secondary);gradient.addColorStop(.65,p.accent);gradient.addColorStop(1,p.background)
      ctx.shadowColor=`${p.textColor}30`;ctx.shadowBlur=26;ctx.shadowOffsetY=18;circle(ctx,320,310,210,gradient);ctx.shadowBlur=0;ctx.shadowOffsetY=0
      break
    }
    case 'shape-rhythm':
      for(let i=0;i<6;i++){ctx.save();ctx.translate(320,320);ctx.rotate(i*Math.PI/3);rounded(ctx,30,-65,240,130,65,i%2?p.secondary:p.accent);ctx.restore()};circle(ctx,320,320,90,p.background)
      break
    case 'sticker-notes':
      ctx.save();ctx.translate(320,320);ctx.rotate(-.12);rounded(ctx,-220,-200,440,400,22,'#ffffff');rounded(ctx,-200,-180,400,360,15,p.accent);line(ctx,[[-120,0],[-20,90],[130,-100]],p.background,26);rounded(ctx,-75,-220,150,50,2,`${p.secondary}dd`);ctx.restore()
      break
    case 'tech-hud':
      for(let i=0;i<4;i++){ctx.strokeStyle=`${p.accent}${i%2?'60':'dd'}`;ctx.lineWidth=i===2?12:2;ctx.beginPath();ctx.arc(320,320,100+i*45,i*.8,Math.PI*1.7+i*.8);ctx.stroke()}
      line(ctx,[[320,75],[320,160]],p.secondary,5);line(ctx,[[320,480],[320,565]],p.secondary,5);line(ctx,[[75,320],[160,320]],p.secondary,5);line(ctx,[[480,320],[565,320]],p.secondary,5);circle(ctx,320,320,9,p.accent)
      break
    case 'editorial-collage':
      ctx.save();ctx.translate(320,320);ctx.rotate(.12);polygon(ctx,[[-230,-160],[-190,-190],[-150,-170],[-100,-200],[-30,-176],[40,-190],[100,-170],[170,-195],[230,-170],[210,200],[-210,180]],'#fff8e7');rounded(ctx,-175,-140,350,270,0,p.secondary);for(let y=-105;y<130;y+=16)for(let x=-150;x<160;x+=16)circle(ctx,x,y,2.4,`${p.textColor}90`);rounded(ctx,-180,150,250,10,0,p.textColor);ctx.restore()
      break
    case 'aurora-glass':
      glow(ctx,300,260,290,p.accent);glow(ctx,420,400,200,p.secondary)
      for(let i=2;i>=0;i--){const x=80+i*45,y=90+i*50;rounded(ctx,x,y,330,300,40,'#ffffff16');ctx.strokeStyle='#ffffff90';ctx.lineWidth=2;ctx.beginPath();ctx.roundRect(x,y,330,300,40);ctx.stroke();rounded(ctx,x+40,y+45,150,8,4,'#ffffff70')}
      break
    case 'geometric-grid':
      rounded(ctx,75,75,240,240,0,p.accent);circle(ctx,435,195,120,p.secondary);polygon(ctx,[[75,565],[315,325],[315,565]],p.textColor);rounded(ctx,340,340,215,215,0,p.secondary);for(let i=0;i<7;i++)line(ctx,[[355+i*28,350],[355+i*28,545]],p.background,10)
      break
    case 'neon-retro':
      ctx.shadowBlur=30;ctx.shadowColor=p.accent;line(ctx,[[320,65],[570,500],[70,500],[320,65]],p.accent,10);ctx.shadowColor=p.secondary;line(ctx,[[320,140],[510,470],[130,470],[320,140]],p.secondary,5);ctx.shadowBlur=0
      break
    case 'pixel-arcade': {
      const cells=['001111100','011111110','111111111','110110110','111111111','001101100','011000110']
      cells.forEach((row,y)=>[...row].forEach((v,x)=>{if(v==='1')rounded(ctx,75+x*54,120+y*54,48,48,0,y<3?p.accent:p.secondary)}))
      break
    }
    case 'liquid-color':
      for(const [x,y,r,c] of [[225,250,165,p.accent],[390,350,175,p.secondary],[240,425,112,p.accent]] as [number,number,number,string][]){const g=ctx.createRadialGradient(x-40,y-65,10,x,y,r);g.addColorStop(0,'#fff4ef');g.addColorStop(.25,c);g.addColorStop(1,c);circle(ctx,x,y,r,g)}
      break
    case 'expressive-type': {
      const points=Array.from({length:24},(_,i)=>{const a=i*Math.PI/12,r=i%2?190:280;return [320+Math.cos(a)*r,320+Math.sin(a)*r]})
      polygon(ctx,points,'#ffffff');ctx.save();ctx.translate(320,320);ctx.scale(.92,.92);ctx.translate(-320,-320);polygon(ctx,points,p.accent);ctx.restore();circle(ctx,320,320,100,p.secondary)
      break
    }
  }
  ctx.restore()
}

function png(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve,reject)=>canvas.toBlob(blob=>blob?resolve(blob):reject(new Error('风格图形生成失败。')),'image/png'))
}
export async function renderMotionStyleArt(styleId: string, palette: Partial<Palette> = {}, width = 1600, height = 900): Promise<{ background: Blob; decoration: Blob }> {
  if(!Number.isFinite(width)||!Number.isFinite(height)||width<16||height<16||width>7680||height>7680) throw new Error('风格画布尺寸无效。')
  const ratio=Math.min(1,1920/Math.max(width,height))
  const background=document.createElement('canvas'), decoration=document.createElement('canvas')
  background.width=Math.max(16,Math.round(width*ratio));background.height=Math.max(16,Math.round(height*ratio));decoration.width=640;decoration.height=640
  const bg=background.getContext('2d'),fg=decoration.getContext('2d')
  if(!bg||!fg)throw new Error('当前环境无法绘制风格素材。')
  drawMotionStyleBackground(bg,background.width,background.height,styleId,palette);drawMotionStyleDecoration(fg,640,styleId,palette)
  const [back,front]=await Promise.all([png(background),png(decoration)])
  background.width=background.height=decoration.width=decoration.height=0
  return {background:back,decoration:front}
}

/** Compact static style sample used in the catalog; final motion is visible on the timeline. */
export function drawMotionStylePoster(canvas: HTMLCanvasElement, styleId: string): void {
  const p=getMotionStyle(styleId).palette,ctx=canvas.getContext('2d')
  if(!ctx)return
  drawMotionStyleBackground(ctx,canvas.width,canvas.height,styleId)
  ctx.save();ctx.scale(canvas.width/1600,canvas.height/900)
  ctx.save();ctx.translate(900,120);drawMotionStyleDecoration(ctx,580,styleId);ctx.restore()
  rounded(ctx,120,265,680,54,12,p.textColor);rounded(ctx,120,355,520,22,8,`${p.textColor}80`);rounded(ctx,120,410,400,22,8,`${p.textColor}50`);rounded(ctx,120,560,180,58,16,p.accent)
  ctx.restore()
}
