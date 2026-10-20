import sound0 from '../assets/transition-sounds/air-sweep.wav?url'
import sound1 from '../assets/transition-sounds/rise.wav?url'
import sound2 from '../assets/transition-sounds/impact.wav?url'
import sound3 from '../assets/transition-sounds/sparkle.wav?url'
import sound4 from '../assets/transition-sounds/snap.wav?url'
import sound5 from '../assets/transition-sounds/reverse.wav?url'
import sound6 from '../assets/transition-sounds/glitch.wav?url'
import sound7 from '../assets/transition-sounds/bubble.wav?url'
import sound8 from '../assets/transition-sounds/chime.wav?url'
import sound9 from '../assets/transition-sounds/soft-wipe.wav?url'

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
  { id: 'air-sweep', title: '风掠', description: '明亮的风声掠过切点，适合滑动与快速推进。', duration: 0.8, anchor: 0.35, filename: 'air-sweep.wav', url: sound0 },
  { id: 'rise', title: '上升扫频', description: '逐渐升高的电子扫频，适合揭幕与画面放大。', duration: 0.9, anchor: 0.65, filename: 'rise.wav', url: sound1 },
  { id: 'impact', title: '低频冲击', description: '短促低音与空气冲击，适合强调与重拍切换。', duration: 0.8, anchor: 0.03, filename: 'impact.wav', url: sound2 },
  { id: 'sparkle', title: '晶粒闪烁', description: '细小晶粒依次闪亮，适合柔光与碎片转场。', duration: 1.1, anchor: 0.15, filename: 'sparkle.wav', url: sound3 },
  { id: 'snap', title: '短促切换', description: '干净利落的轻拍声，适合快速切镜与卡点。', duration: 0.28, anchor: 0.04, filename: 'snap.wav', url: sound4 },
  { id: 'reverse', title: '反向吸入', description: '从远处聚拢的气流，适合收缩与聚焦画面。', duration: 0.75, anchor: 0.6, filename: 'reverse.wav', url: sound5 },
  { id: 'glitch', title: '数字跳切', description: '错落的电子脉冲，适合数字故障与切片动画。', duration: 0.55, anchor: 0.2, filename: 'glitch.wav', url: sound6 },
  { id: 'bubble', title: '气泡弹跳', description: '圆润轻巧的弹跳音，适合活泼与趣味切换。', duration: 0.5, anchor: 0.06, filename: 'bubble.wav', url: sound7 },
  { id: 'chime', title: '金属轻鸣', description: '清亮金属音缓缓散开，适合章节切换与发现。', duration: 1.2, anchor: 0.03, filename: 'chime.wav', url: sound8 },
  { id: 'soft-wipe', title: '柔和擦拭', description: '温和细腻的空气摩擦，适合淡化与柔焦转场。', duration: 0.7, anchor: 0.3, filename: 'soft-wipe.wav', url: sound9 },
]
