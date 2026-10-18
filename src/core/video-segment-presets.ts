export type VideoSegmentPlacement = 'prepend' | 'append'
export type VideoSegmentTitleLayout = 'center' | 'left' | 'lower-third'

export interface VideoSegmentCaption {
  heading: string
  subheading: string
  textColor: string
  /** Desired timeline length; the complete background motion is retimed to fit. */
  duration?: number
  layout?: VideoSegmentTitleLayout
}

export interface VideoSegmentPreset extends VideoSegmentCaption {
  id: string
  title: string
  style: string
  description: string
  placement: VideoSegmentPlacement
  collection?: 'science' | 'general'
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
  { id: 'science-orbital-atlas', title: '星轨观测', style: '天体观测', description: '球面经纬、倾斜轨道与行进光点，留出中央标题阅读区。', placement: 'prepend', collection: 'science', heading: '从一颗星，认识宇宙', subheading: '观测 · 假设 · 验证', textColor: '#eff4f1' },
  { id: 'science-spectrum-lab', title: '光谱实验室', style: '光学折射', description: '纸白底色与棱镜光束，分色光谱从边缘展开。', placement: 'prepend', collection: 'science', heading: '一束光里的答案', subheading: '把看不见的规律，变成看得见的实验', textColor: '#203c42' },
  { id: 'science-molecular-chain', title: '生命的编码', style: '双螺旋结构', description: '双螺旋和成对节点缓缓运动，呈现微观结构的秩序。', placement: 'prepend', collection: 'science', heading: '生命，写在微观世界', subheading: '从结构出发，寻找生命的规律', textColor: '#eff4f1' },
  { id: 'science-blueprint-launch', title: '工程解构', style: '工程投影', description: '尺寸线、剖面环和分层构件，清晰呈现工程结构。', placement: 'prepend', collection: 'science', heading: '拆开原理，读懂世界', subheading: '结构 · 尺度 · 精度', textColor: '#eff4f1' },
  { id: 'science-data-field', title: '数据有迹', style: '证据网络', description: '浅色画布上的证据网络和柱列，描绘有依据的探索。', placement: 'prepend', collection: 'science', heading: '让数据，讲清楚真相', subheading: '每一个结论，都从证据开始', textColor: '#203c42' },
  { id: 'science-terrain-observer', title: '地球剖面', style: '地形等值线', description: '多层等高线与剖面曲线，构成观察地球的尺度感。', placement: 'prepend', collection: 'science', heading: '把视线，放大到地球', subheading: '穿过表象，看见深处的联系', textColor: '#eff4f1' },
  { id: 'science-orbit-return', title: '宇宙余响', style: '行星地平线', description: '星点回归行星地平线，用轻缓轨迹收束探索。', placement: 'append', collection: 'science', heading: '保持好奇，继续仰望', subheading: '今天的答案，是下一次探索的起点', textColor: '#eff4f1' },
  { id: 'science-spectrum-resolve', title: '光的回声', style: '光谱回波', description: '光谱波纹舒展成层次分明的余韵，保留明亮留白。', placement: 'append', collection: 'science', heading: '实验结束，思考继续', subheading: '用新的视角，再看一次熟悉的世界', textColor: '#203c42' },
  { id: 'science-molecular-summary', title: '生命共鸣', style: '分子结构', description: '分子环从画面两端展开，定格微观旅程的结论。', placement: 'append', collection: 'science', heading: '微小之处，自有辽阔', subheading: '感谢陪伴这一次微观旅程', textColor: '#eff4f1' },
  { id: 'science-blueprint-complete', title: '原理归档', style: '研究归档', description: '三视图与四阶段路径，像研究档案一样沉稳收束。', placement: 'append', collection: 'science', heading: '把原理，带回生活', subheading: '保留问题，让下一次发现发生', textColor: '#eff4f1' },
  { id: 'science-data-archive', title: '证据留存', style: '数据结论', description: '趋势、分布与离散观测三种图形，为结论留下证据。', placement: 'append', collection: 'science', heading: '结论有据，探索无止', subheading: '记录证据，也保留对未知的好奇', textColor: '#203c42' },
  { id: 'science-terrain-horizon', title: '山海未尽', style: '山海地形', description: '地形线汇聚成层叠地平线，延续对未知世界的好奇。', placement: 'append', collection: 'science', heading: '世界很大，下一站见', subheading: '让好奇心，带我们走得更远', textColor: '#eff4f1' },
  { id: 'general-paper-rise', title: '纸层展开', style: '轻纸叠层', description: '斜切纸层从底边展开，左侧眉题与大标题适合章节或栏目开场。', placement: 'prepend', collection: 'general', heading: '从这里开始', subheading: '01 / 开场', textColor: '#354746', layout: 'left' },
  { id: 'general-gallery-reveal', title: '画廊开场', style: '画廊框线', description: '三重细框沿边缘依次勾勒，配合克制的金属色标记。', placement: 'prepend', collection: 'general', heading: '新的篇章', subheading: '用清晰的表达，分享你的想法', textColor: '#edf1ea' },
  { id: 'general-geometric-curtain', title: '几何启幕', style: '对角幕布', description: '两组斜向色面从对角进入，形成清楚而轻盈的开场节奏。', placement: 'prepend', collection: 'general', heading: '即刻开始', subheading: '让每一帧都有自己的节奏', textColor: '#354746' },
  { id: 'general-soft-halo', title: '柔光序幕', style: '双角柔光', description: '冷暖光晕在对角边缘缓慢舒展，深色中央保持安静。', placement: 'prepend', collection: 'general', heading: '精彩即将展开', subheading: '记录此刻，分享所见', textColor: '#edf1ea' },
  { id: 'general-offset-blocks', title: '错位构成', style: '错位拼块', description: '四组错位色块先后归位，用明确的块面关系框出标题。', placement: 'prepend', collection: 'general', heading: '换个角度', subheading: '发现值得分享的片刻', textColor: '#354746' },
  { id: 'general-line-assembly', title: '细线成章', style: '线条构建', description: '细线逐步成形，左侧标题与上方小眉题组成清晰的栏目式开场。', placement: 'prepend', collection: 'general', heading: '关于这一刻', subheading: '01 / 本期内容', textColor: '#354746', layout: 'left' },
  { id: 'general-film-window', title: '影窗初启', style: '横向开窗', description: '窄窗向两边展开为完整画幅，保留细框与节制的边缘标记。', placement: 'prepend', collection: 'general', heading: '画面从此开始', subheading: '你的故事，现在开场', textColor: '#edf1ea' },
  { id: 'general-grain-gradient', title: '微光渐层', style: '哑光斜束', description: '带细微颗粒的暖色渐层上，浅紫光束轻轻滑过边缘。', placement: 'prepend', collection: 'general', heading: '分享新的灵感', subheading: '让平常的瞬间，留下不同的印象', textColor: '#354746' },
  { id: 'general-paper-fold', title: '纸页收束', style: '折页留白', description: '纸面收束到画角，下方结语与右侧署名留下安静而完整的结尾。', placement: 'append', collection: 'general', heading: '感谢观看', subheading: '署名 / 你的名字', textColor: '#354746', layout: 'lower-third' },
  { id: 'general-gallery-close', title: '画廊留白', style: '双框收束', description: '错位双框滑向各自位置，边缘短线组成平衡的结尾。', placement: 'append', collection: 'general', heading: '故事未完', subheading: '期待下一次相遇', textColor: '#edf1ea' },
  { id: 'general-curtain-settle', title: '幕布余韵', style: '垂帘轻合', description: '半透明垂帘在两边轻轻归拢，底部柔和曲线留出余韵。', placement: 'append', collection: 'general', heading: '下次再见', subheading: '让美好继续发生', textColor: '#354746' },
  { id: 'general-soft-afterglow', title: '柔光回响', style: '弧光余晖', description: '低处的暖色弧光和上方柔光相呼应，文字清晰停留。', placement: 'append', collection: 'general', heading: '感谢相伴', subheading: '愿这一刻，留下温柔的余韵', textColor: '#edf1ea' },
  { id: 'general-blocks-balance', title: '色块归位', style: '阶梯平衡', description: '两组窄色块以错峰节奏归位，用简洁的形状平衡画面。', placement: 'append', collection: 'general', heading: '保持关注', subheading: '更多内容，即将分享', textColor: '#354746' },
  { id: 'general-line-signature', title: '细线落款', style: '曲线落笔', description: '下方结语与右侧落款搭配一笔延展的细线，适合作者署名与鸣谢。', placement: 'append', collection: 'general', heading: '让故事继续', subheading: '创作 / 你的名字', textColor: '#354746', layout: 'lower-third' },
  { id: 'general-film-resolve', title: '影窗定格', style: '胶片式收边', description: '浅底画幅、层叠框线和轻收边，形成稳妥的结束构图。', placement: 'append', collection: 'general', heading: '到这里，刚刚好', subheading: '谢谢你，把时间留给这段画面', textColor: '#354746' },
  { id: 'general-grain-dusk', title: '微光渐隐', style: '颗粒余光', description: '细微颗粒与窄光束沿深色画面边缘流动，柔和地结束。', placement: 'append', collection: 'general', heading: '我们再会', subheading: '留下回声，也留下期待', textColor: '#edf1ea' },
]
