import track0 from '../assets/background-music/snow-window.mp3?url'
import track1 from '../assets/background-music/street-blue.mp3?url'
import track2 from '../assets/background-music/autumn-garden.mp3?url'
import track3 from '../assets/background-music/chasing-light.mp3?url'
import track4 from '../assets/background-music/mountain-echo.mp3?url'
import track5 from '../assets/background-music/neon-night.mp3?url'
import track6 from '../assets/background-music/afternoon-groove.mp3?url'
import track7 from '../assets/background-music/traveler-tavern.mp3?url'
import track8 from '../assets/background-music/berry-funk.mp3?url'
import track9 from '../assets/background-music/stellar-drift.mp3?url'

export interface BackgroundMusicItem {
  id: string
  title: string
  style: string
  description: string
  bpm?: number
  duration: number
  url: string
  filename: string
}

export const BACKGROUND_MUSIC: readonly BackgroundMusicItem[] = [
  {
    id: 'snow-window',
    title: '雪落窗前',
    style: '钢琴圆舞曲',
    description: '轻柔三拍旋律，适合回忆、文字叙事与安静日常。',
    duration: 60.786939,
    filename: 'snow-window.mp3',
    url: track0,
  },
  {
    id: 'street-blue',
    title: '街角蓝调',
    style: '爵士蓝调',
    description: '松弛的蓝调律动，适合城市漫步、咖啡与生活记录。',
    duration: 52.610612,
    filename: 'street-blue.mp3',
    url: track1,
  },
  {
    id: 'autumn-garden',
    title: '秋日果园',
    style: '轻快原声',
    description: '明亮轻巧的田园旋律，适合旅行、手作与温暖开场。',
    duration: 120.032653,
    filename: 'autumn-garden.mp3',
    url: track2,
  },
  {
    id: 'chasing-light',
    title: '追光疾驰',
    style: '动感摇滚',
    description: '有力的鼓点与推进感，适合运动、挑战与快节奏剪辑。',
    duration: 120.032653,
    filename: 'chasing-light.mp3',
    url: track3,
  },
  {
    id: 'mountain-echo',
    title: '远山回响',
    style: '情绪管弦',
    description: '铺展的弦乐与钢琴，适合风景、叙事与情绪转场。',
    duration: 120.032653,
    filename: 'mountain-echo.mp3',
    url: track4,
  },
  {
    id: 'neon-night',
    title: '霓虹夜行',
    style: '电子节拍',
    description: '未来感电子律动，适合夜景、科技与节奏卡点。',
    duration: 120.032653,
    filename: 'neon-night.mp3',
    url: track5,
  },
  {
    id: 'afternoon-groove',
    title: '午后慢拍',
    style: '慵懒嘻哈',
    description: '舒缓键盘与轻鼓点，适合学习、独白与日常片段。',
    duration: 123.193469,
    filename: 'afternoon-groove.mp3',
    url: track6,
  },
  {
    id: 'traveler-tavern',
    title: '旅人酒馆',
    style: '中世纪民谣',
    description: '轻快古典民谣旋律，适合旅途、故事与奇幻场景。',
    duration: 105.508571,
    filename: 'traveler-tavern.mp3',
    url: track7,
  },
  {
    id: 'berry-funk',
    title: '莓果律动',
    style: '复古放克',
    description: '跳跃的切分节奏，适合潮流、趣味展示与活力片段。',
    duration: 120.032653,
    filename: 'berry-funk.mp3',
    url: track8,
  },
  {
    id: 'stellar-drift',
    title: '星际漫游',
    style: '太空氛围',
    description: '空灵缓慢的铺底旋律，适合夜空、冥想与空间展示。',
    duration: 134.478367,
    filename: 'stellar-drift.mp3',
    url: track9,
  },
]
