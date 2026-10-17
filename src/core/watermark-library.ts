/** Original offline overlay materials bundled with the application. */
export type WatermarkCategory = '互动贴纸' | '装饰动效' | '提示标注' | '字幕标签'

export interface WatermarkMaterial {
  id: string
  name: string
  category: WatermarkCategory
  tags: string[]
  url: string
  poster: string
  kind: 'video' | 'image'
  duration: number
  width: number
  height: number
  chromaKey?: boolean
  placement?: 'center' | 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right' | 'bottom-center'
}

export const WATERMARK_CATEGORIES: WatermarkCategory[] = ['互动贴纸', '装饰动效', '提示标注', '字幕标签']

const definitions: Array<[string, string, WatermarkCategory, string[], WatermarkMaterial['placement']?]> = [
  ['thumb-pulse', '点赞鼓励', '互动贴纸', ['点赞', '鼓励', '弹跳'], 'bottom-right'],
  ['star-save', '收藏星星', '互动贴纸', ['收藏', '星星', '旋转'], 'bottom-right'],
  ['follow-pop', '关注提醒', '互动贴纸', ['关注', '按钮', '呼吸'], 'bottom-center'],
  ['share-plane', '分享纸飞机', '互动贴纸', ['分享', '飞行', '纸飞机'], 'bottom-right'],
  ['heart-wave', '爱心波纹', '互动贴纸', ['爱心', '喜欢', '心跳'], 'bottom-right'],
  ['celebrate', '庆祝彩带', '装饰动效', ['庆祝', '彩纸', '派对']],
  ['sparkle-trail', '闪烁星光', '装饰动效', ['星光', '闪烁', '装饰']],
  ['ripple-rings', '循环光环', '装饰动效', ['光环', '波纹', '呼吸']],
  ['corner-frame', '聚焦边框', '装饰动效', ['边框', '镜头', '聚焦']],
  ['loading-dots', '跳动圆点', '装饰动效', ['等待', '加载', '节奏']],
  ['rec-label', '录制标记', '提示标注', ['录制', '红点', '闪烁'], 'top-left'],
  ['notice-bubble', '重点来了', '提示标注', ['重点', '气泡', '提示'], 'top-right'],
  ['cursor-click', '点击指针', '提示标注', ['指针', '点击', '引导']],
  ['point-arrow', '指向箭头', '提示标注', ['箭头', '指向', '强调']],
  ['focus-circle', '圈出重点', '提示标注', ['圆圈', '标注', '强调']],
  ['chapter-card', '精彩回顾', '字幕标签', ['章节', '标题', '回顾'], 'bottom-left'],
  ['note-strip', '温馨提示', '字幕标签', ['提醒', '标签', '提示'], 'bottom-left'],
  ['thanks-card', '感谢观看', '字幕标签', ['片尾', '感谢', '结束'], 'bottom-center'],
]

export const WATERMARK_MATERIALS: WatermarkMaterial[] = definitions.map(([id, name, category, tags, placement]) => ({
  id,
  name,
  category,
  tags,
  url: `/watermarks/${id}.mp4`,
  poster: `/watermarks/${id}.png`,
  kind: 'video',
  duration: 4,
  width: 640,
  height: 360,
  chromaKey: true,
  placement: placement ?? 'center',
}))
