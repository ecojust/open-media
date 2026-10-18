import type { WatermarkMaterial } from './watermark-library.ts'

/** Original explanatory graphics; measurements and curves are visual examples. */
const motion: Array<Pick<WatermarkMaterial, 'id' | 'name' | 'category' | 'tags' | 'placement'>> = [
  { id: 'science-measurement', name: '测量 · 相对刻度', category: '提示标注', tags: ['实验', '工程', '测量', '标尺', '示意'], placement: 'bottom-center' },
  { id: 'science-orbit', name: '天文 · 轨道指示', category: '装饰动效', tags: ['天文', '轨道', '运动', '示意'], placement: 'center' },
  { id: 'science-brackets', name: '观察 · 聚焦括角', category: '提示标注', tags: ['实验', '工程', '聚焦', '括角', '观察'], placement: 'center' },
  { id: 'science-leader', name: '解析 · 目标引线', category: '提示标注', tags: ['工程', '实验', '引线', '目标', '标注'], placement: 'center' },
  { id: 'science-waveform', name: '信号 · 波形窗口', category: '装饰动效', tags: ['数据', '实验', '波形', '信号', '示意'], placement: 'bottom-left' },
  { id: 'science-comparison', name: '对比 · 双向分隔', category: '提示标注', tags: ['实验', '数据', '对照', '比较', '分隔'], placement: 'center' },
  { id: 'science-steps', name: '过程 · 四步进度', category: '提示标注', tags: ['实验', '工程', '步骤', '进度', '过程'], placement: 'bottom-center' },
  { id: 'science-bars', name: '数据 · 三组示意', category: '装饰动效', tags: ['数据', '实验', '图表', '对比', '示意'], placement: 'bottom-right' },
  { id: 'science-axes', name: '趋势 · 坐标投影', category: '装饰动效', tags: ['数据', '数学', '坐标', '趋势', '示意'], placement: 'bottom-left' },
  { id: 'science-dimension', name: '工程 · 纵向测量', category: '提示标注', tags: ['工程', '测量', '高度', '尺寸', '示意'], placement: 'center' },
  { id: 'science-scale', name: '尺度 · 分级比例尺', category: '提示标注', tags: ['工程', '地理', '尺度', '比例尺', '示意'], placement: 'bottom-left' },
  { id: 'science-process', name: '逻辑 · 流程分支', category: '提示标注', tags: ['工程', '逻辑', '步骤', '流程', '分支'], placement: 'bottom-center' },
  { id: 'science-path', name: '运动 · 曲线轨迹', category: '装饰动效', tags: ['物理', '运动', '路径', '方向', '示意'], placement: 'center' },
  { id: 'science-angle', name: '几何 · 角度扇区', category: '提示标注', tags: ['数学', '工程', '角度', '几何', '示意'], placement: 'center' },
  { id: 'science-section', name: '结构 · 分层剖面', category: '装饰动效', tags: ['工程', '地理', '材料', '结构', '剖面', '示意'], placement: 'center' },
  { id: 'science-pin', name: '定位 · 编号引脚', category: '提示标注', tags: ['实验', '工程', '位置', '编号', '定位'], placement: 'top-right' },
]

const text: WatermarkMaterial[] = [
  { id: 'science-question', name: '提问 · 留白大标题', category: '可编辑文字', tags: ['科普', '问题', '标题', '章节'], kind: 'text', url: '', poster: '/watermarks/science-question.png', duration: 4, width: 640, height: 360, placement: 'center', collection: 'science', textTemplate: { text: '为什么会这样？', color: '#f3efdf', background: 'transparent', fontFamily: 'serif', fontWeight: 600, textAlign: 'center', fontSize: 40, width: 560, height: 72 } },
  { id: 'science-finding', name: '结论 · 观察笔记', category: '可编辑文字', tags: ['科普', '实验', '结论', '观察'], kind: 'text', url: '', poster: '/watermarks/science-finding.png', duration: 4, width: 640, height: 360, placement: 'bottom-left', collection: 'science', textTemplate: { text: '关键发现\n在这里写下你的结论', color: '#d7f3f6', background: '#182632', fontFamily: 'sans-serif', fontWeight: 500, textAlign: 'left', fontSize: 27, width: 440, height: 98 } },
  { id: 'science-source', name: '引用 · 资料出处', category: '可编辑文字', tags: ['科普', '资料', '来源', '引用', '文献'], kind: 'text', url: '', poster: '/watermarks/science-source.png', duration: 4, width: 640, height: 360, placement: 'bottom-left', collection: 'science', textTemplate: { text: '资料来源\n在这里注明作者与年份', color: '#e7e9eb', background: '#1d242c', fontFamily: 'sans-serif', fontWeight: 400, textAlign: 'left', fontSize: 20, width: 440, height: 76 } },
  { id: 'science-equation', name: '公式 · 解释标签', category: '可编辑文字', tags: ['科普', '物理', '数学', '公式', '解释'], kind: 'text', url: '', poster: '/watermarks/science-equation.png', duration: 4, width: 640, height: 360, placement: 'center', collection: 'science', textTemplate: { text: 'E = mc²\n能量与质量的关系', color: '#edbd72', background: 'transparent', fontFamily: 'monospace', fontWeight: 500, textAlign: 'center', fontSize: 30, width: 480, height: 104 } },
  { id: 'science-definition', name: '定义 · 关键术语', category: '可编辑文字', tags: ['科普', '概念', '定义', '术语'], kind: 'text', url: '', poster: '/watermarks/science-definition.png', duration: 4, width: 640, height: 360, placement: 'bottom-left', collection: 'science', textTemplate: { text: '概念定义\n在这里解释关键术语', color: '#f3efdf', background: '#233442', fontFamily: 'serif', fontWeight: 500, textAlign: 'left', fontSize: 28, width: 450, height: 104 } },
  { id: 'science-hypothesis', name: '假设 · 条件推演', category: '可编辑文字', tags: ['科普', '实验', '假设', '推理'], kind: 'text', url: '', poster: '/watermarks/science-hypothesis.png', duration: 4, width: 640, height: 360, placement: 'center', collection: 'science', textTemplate: { text: '如果……\n那么……', color: '#d7f3f6', background: 'transparent', fontFamily: 'serif', fontWeight: 500, textAlign: 'left', fontSize: 36, width: 320, height: 120 } },
  { id: 'science-unit', name: '数值 · 单位说明', category: '可编辑文字', tags: ['科普', '数据', '量纲', '单位', '数值'], kind: 'text', url: '', poster: '/watermarks/science-unit.png', duration: 4, width: 640, height: 360, placement: 'bottom-right', collection: 'science', textTemplate: { text: '数值 / 单位\n请填入实测数据', color: '#edbd72', background: '#182632', fontFamily: 'monospace', fontWeight: 500, textAlign: 'right', fontSize: 25, width: 360, height: 92 } },
  { id: 'science-procedure', name: '步骤 · 实验条件', category: '可编辑文字', tags: ['科普', '实验', '步骤', '条件', '操作'], kind: 'text', url: '', poster: '/watermarks/science-procedure.png', duration: 4, width: 640, height: 360, placement: 'top-left', collection: 'science', textTemplate: { text: '实验步骤 01\n在这里填写操作与条件', color: '#f3efdf', background: 'transparent', fontFamily: 'sans-serif', fontWeight: 500, textAlign: 'left', fontSize: 26, width: 500, height: 96 } },
]

export const SCIENCE_WATERMARK_MATERIALS: WatermarkMaterial[] = [
  ...motion.map((item): WatermarkMaterial => ({ ...item, collection: 'science', tags: ['科普', ...item.tags], url: `/watermarks/${item.id}.mp4`, fallbackUrl: `/watermarks/${item.id}.webm`, poster: `/watermarks/${item.id}.png`, kind: 'video', duration: 4, width: 640, height: 360, chromaKey: true, spillSuppression: true })),
  ...text.map(item => ({ ...item, textTemplate: { ...item.textTemplate!, fadeIn: 0.35, fadeOut: 0.2 } })),
]
