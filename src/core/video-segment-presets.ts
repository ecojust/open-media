export type VideoSegmentPlacement = 'prepend' | 'append'

export interface VideoSegmentCaption {
  heading: string
  subheading: string
  textColor: string
}

export interface VideoSegmentPreset extends VideoSegmentCaption {
  id: string
  title: string
  style: string
  description: string
  placement: VideoSegmentPlacement
}

/** Original motion compositions; editable type is added separately on the timeline. */
export const VIDEO_SEGMENT_PRESETS: readonly VideoSegmentPreset[] = [
  { id: 'midnight-orbit', title: '星轨序章', style: '深空环绕', description: '深青星轨与缓缓流转的金色光点。', placement: 'prepend', heading: '故事，从此刻开始', subheading: '记录每一个值得珍藏的瞬间', textColor: '#f5eedb' },
  { id: 'prism-dawn', title: '棱光初现', style: '渐变光棱', description: '蓝紫棱镜滑入，明亮光带层层展开。', placement: 'prepend', heading: '灵感正在发生', subheading: '打开想象，让创意发光', textColor: '#ffffff' },
  { id: 'gold-horizon', title: '鎏金时刻', style: '典雅光线', description: '低调黑金、浮动微粒与延展的地平线。', placement: 'prepend', heading: '每一帧，皆有分量', subheading: '用影像讲述不凡', textColor: '#f4dfad' },
  { id: 'paper-morning', title: '纸间晨光', style: '几何拼贴', description: '奶油色纸面、陶土圆盘与轻盈几何。', placement: 'prepend', heading: '把日常拍成诗', subheading: '今天也有新的发现', textColor: '#3e3531' },
  { id: 'azure-grid', title: '蓝图启程', style: '清晰科技', description: '深蓝网格缓慢推进，精密线框依次点亮。', placement: 'prepend', heading: '从想法到实现', subheading: '探索 · 创造 · 分享', textColor: '#dcefff' },
  { id: 'velvet-curtain', title: '暮色谢幕', style: '柔光帷幕', description: '紫红柔光和流动帷幕，为故事留出余韵。', placement: 'append', heading: '感谢看到这里', subheading: '愿下一次相遇，依然精彩', textColor: '#ffede9' },
  { id: 'ocean-line', title: '海岸留白', style: '轻柔海浪', description: '浅蓝渐变与层叠海浪，舒展而安静。', placement: 'append', heading: '慢一点，再见', subheading: '把美好留在心里', textColor: '#18464f' },
  { id: 'graphite-frame', title: '极简终章', style: '黑白构成', description: '银灰线框与建筑式几何，克制地收束画面。', placement: 'append', heading: '未完 · 待续', subheading: '下一段故事，即将开启', textColor: '#f1f2f3' },
  { id: 'coral-sunset', title: '落日回声', style: '温暖日落', description: '珊瑚与浅沙色交叠，圆形色块缓缓漂移。', placement: 'append', heading: '好时光，值得回放', subheading: '谢谢你的陪伴', textColor: '#683f3b' },
  { id: 'starlit-finale', title: '星光未散', style: '璀璨星幕', description: '紫色星尘与流动光环，定格温柔结尾。', placement: 'append', heading: '我们，下次再见', subheading: '让热爱继续发光', textColor: '#f6efff' },
]
