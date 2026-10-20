import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'

// 本项目原创合成音效：只使用振荡器、确定性噪声与包络，无外部录音或采样。
export const SAMPLE_RATE = 24000
export const SOUND_DEFINITIONS = [
  { id: 'air-sweep', title: '风掠', description: '明亮的风声掠过切点，适合滑动与快速推进。', duration: 0.8, anchor: 0.35 },
  { id: 'rise', title: '上升扫频', description: '逐渐升高的电子扫频，适合揭幕与画面放大。', duration: 0.9, anchor: 0.65 },
  { id: 'impact', title: '低频冲击', description: '短促低音与空气冲击，适合强调与重拍切换。', duration: 0.8, anchor: 0.03 },
  { id: 'sparkle', title: '晶粒闪烁', description: '细小晶粒依次闪亮，适合柔光与碎片转场。', duration: 1.1, anchor: 0.15 },
  { id: 'snap', title: '短促切换', description: '干净利落的轻拍声，适合快速切镜与卡点。', duration: 0.28, anchor: 0.04 },
  { id: 'reverse', title: '反向吸入', description: '从远处聚拢的气流，适合收缩与聚焦画面。', duration: 0.75, anchor: 0.6 },
  { id: 'glitch', title: '数字跳切', description: '错落的电子脉冲，适合数字故障与切片动画。', duration: 0.55, anchor: 0.2 },
  { id: 'bubble', title: '气泡弹跳', description: '圆润轻巧的弹跳音，适合活泼与趣味切换。', duration: 0.5, anchor: 0.06 },
  { id: 'chime', title: '金属轻鸣', description: '清亮金属音缓缓散开，适合章节切换与发现。', duration: 1.2, anchor: 0.03 },
  { id: 'soft-wipe', title: '柔和擦拭', description: '温和细腻的空气摩擦，适合淡化与柔焦转场。', duration: 0.7, anchor: 0.3 },
]

const tau = Math.PI * 2
const sine = phase => Math.sin(tau * phase)
const gaussian = (time, center, width) => Math.exp(-(((time - center) / width) ** 2))
const attackDecay = (time, start, attack, decay) => time < start ? 0 : (1 - Math.exp(-(time - start) / attack)) * Math.exp(-(time - start) / decay)

function randomFor(id) {
  let state = 2166136261
  for (const letter of id) state = Math.imul(state ^ letter.charCodeAt(0), 16777619) >>> 0
  return () => {
    state ^= state << 13; state ^= state >>> 17; state ^= state << 5
    return (state >>> 0) / 2147483648 - 1
  }
}

/** 在内存中生成固定的 PCM16 WAV，便于测试可重复性。 */
export function renderTransitionSound(item) {
  const random = randomFor(item.id)
  const samples = new Float64Array(Math.round(SAMPLE_RATE * item.duration))
  let low = 0, smoother = 0, peak = 0
  for (let index = 0; index < samples.length; index++) {
    const time = index / SAMPLE_RATE, noise = random()
    low += 0.16 * (noise - low)
    smoother += 0.025 * (noise - smoother)
    const high = noise - low
    let sample = 0
    switch (item.id) {
      case 'air-sweep':
        sample = gaussian(time, item.anchor, 0.18) * (0.7 * low + 0.18 * high)
          * (0.65 + 0.35 * sine(260 * time + 850 * time * time))
        break
      case 'rise': {
        const envelope = time <= item.anchor ? (time / item.anchor) ** 2 : Math.exp(-(time - item.anchor) / 0.045)
        sample = envelope * (0.31 * sine(130 * time + 900 * time ** 3) + 0.19 * low + 0.08 * high)
        break
      }
      case 'impact': {
        const age = Math.max(0, time - 0.012), envelope = attackDecay(time, 0.012, 0.005, 0.18)
        sample = envelope * (0.8 * sine(47 * age + 2.6 * (1 - Math.exp(-age * 25)))
          + 0.5 * low * Math.exp(-age * 20) + 0.2 * high * Math.exp(-age * 60))
        break
      }
      case 'sparkle':
        for (let grain = 0; grain < 8; grain++) {
          const start = 0.11 + grain * 0.076, age = time - start
          const frequency = [1760, 2637, 2093, 3520, 2349, 3136, 3951, 2794][grain]
          sample += attackDecay(time, start, 0.003, 0.11) * (0.14 * sine(frequency * age) + 0.035 * sine(frequency * 2.003 * age))
        }
        break
      case 'snap': {
        const age = time - 0.018
        sample = attackDecay(time, 0.018, 0.003, 0.026) * (0.75 * high + 0.25 * sine(950 * age - 4500 * age * age))
        sample += attackDecay(time, 0.039, 0.002, 0.012) * 0.25 * noise
        break
      }
      case 'reverse': {
        const envelope = time <= item.anchor ? (time / item.anchor) ** 3 : Math.exp(-(time - item.anchor) / 0.018)
        sample = envelope * (0.55 * low + 0.12 * high + 0.16 * sine(310 * time - 150 * time * time))
        break
      }
      case 'glitch':
        for (let pulse = 0; pulse < 6; pulse++) {
          const start = [0.03, 0.12, 0.19, 0.25, 0.34, 0.42][pulse], age = time - start
          const fundamental = [780, 260, 1560, 390, 1040, 520][pulse]
          sample += attackDecay(time, start, 0.002, 0.016) * (0.24 * sine(fundamental * age) + 0.1 * sine(fundamental * 3 * age) + 0.07 * high)
        }
        break
      case 'bubble': {
        const age = Math.max(0, time - 0.02)
        sample = attackDecay(time, 0.02, 0.006, 0.073) * (0.65 * sine(175 * age + 12 * (1 - Math.exp(-age * 30))) + 0.1 * sine(350 * age))
        const bounce = Math.max(0, time - 0.19)
        sample += attackDecay(time, 0.19, 0.004, 0.045) * 0.22 * sine(250 * bounce + 4 * (1 - Math.exp(-bounce * 40)))
        break
      }
      case 'chime': {
        const age = time - 0.015
        sample = attackDecay(time, 0.015, 0.003, 0.25) * (0.4 * sine(1175 * age)
          + 0.22 * sine(1897 * age) + 0.1 * sine(2901 * age))
        sample += attackDecay(time, 0.015, 0.001, 0.009) * 0.1 * high
        break
      }
      case 'soft-wipe':
        sample = gaussian(time, item.anchor, 0.15) * (0.9 * smoother + 0.19 * low + 0.025 * high)
        break
      default:
        throw new Error(`未知转场音效：${item.id}`)
    }
    // 两端平滑收零，避免拖动剪辑或单独试听时出现边界杂音。
    const edge = Math.min(1, time / 0.012, (item.duration - time - 1 / SAMPLE_RATE) / 0.035)
    sample *= Math.sin(Math.max(0, edge) * Math.PI / 2) ** 2
    samples[index] = sample
    peak = Math.max(peak, Math.abs(sample))
  }
  const bytes = Buffer.alloc(44 + samples.length * 2)
  bytes.write('RIFF', 0); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8)
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22)
  bytes.writeUInt32LE(SAMPLE_RATE, 24); bytes.writeUInt32LE(SAMPLE_RATE * 2, 28)
  bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34)
  bytes.write('data', 36); bytes.writeUInt32LE(samples.length * 2, 40)
  for (let index = 0; index < samples.length; index++) bytes.writeInt16LE(Math.round(samples[index] * 0.78 / peak * 32767), 44 + index * 2)
  return bytes
}

function generate() {
  const root = fileURLToPath(new URL('../', import.meta.url))
  const destination = path.join(root, 'src/assets/transition-sounds')
  mkdirSync(destination, { recursive: true })
  const sounds = SOUND_DEFINITIONS.map(item => {
    const bytes = renderTransitionSound(item), filename = `${item.id}.wav`
    writeFileSync(path.join(destination, filename), bytes)
    return { ...item, filename, codec: 'pcm_s16le', sampleRate: SAMPLE_RATE, channels: 1, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }
  })
  writeFileSync(path.join(destination, 'manifest.json'), `${JSON.stringify({
    provenance: '本项目原创确定性合成；仅使用振荡器、噪声与包络，无外部录音或采样。',
    license: 'MIT', generator: 'scripts/generate-transition-sounds.mjs', sounds,
  }, null, 2)}\n`)
  const imports = sounds.map((item, index) => `import sound${index} from '../assets/transition-sounds/${item.filename}?url'`).join('\n')
  const entries = sounds.map((item, index) => `  { id: '${item.id}', title: '${item.title}', description: '${item.description}', duration: ${item.duration}, anchor: ${item.anchor}, filename: '${item.filename}', url: sound${index} },`).join('\n')
  writeFileSync(path.join(root, 'src/core/transition-sound-catalog.ts'), `${imports}

export interface TransitionSoundItem {
  id: string
  title: string
  description: string
  duration: number
  /** 音频中的重音位置；添加时对齐视频切点。 */
  anchor: number
  url: string
  filename: string
}

export const TRANSITION_SOUNDS: readonly TransitionSoundItem[] = [
${entries}
]
`)
  console.log(`已生成 ${sounds.length} 个原创转场音效，共 ${sounds.reduce((sum, sound) => sum + sound.bytes, 0)} 字节。`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) generate()
