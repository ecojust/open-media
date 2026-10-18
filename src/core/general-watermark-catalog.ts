import type { WatermarkMaterial, WatermarkTextTemplate } from './watermark-library.ts'
import type { VisualMotionPreset } from './visual-motion-presets.ts'

type Definition = { id: string; name: string; tags: string[]; placement: WatermarkMaterial['placement']; text: string; width: number; height: number; fontSize: number; align?: WatermarkTextTemplate['textAlign']; family?: string; weight?: number; color?: string; background?: string; animation?: VisualMotionPreset }

/** Independent text layouts: content and subjects remain the editor's choice. */
const definitions: Definition[] = [
  { id: 'hero-title', name: '主标题 · 留白居中', tags: ['标题', '开场', '大字'], placement: 'center', text: '在这里写下标题', width: 560, height: 108, fontSize: 44, family: 'serif', weight: 600, animation: 'push-in' },
  { id: 'opening-question', name: '提问 · 双行开场', tags: ['标题', '问题', '双行'], placement: 'center', text: '从一个问题开始\n你最关心的是什么？', width: 540, height: 148, fontSize: 34, weight: 500, animation: 'fade' },
  { id: 'subtitle-strip', name: '副标题 · 底部信息条', tags: ['副标题', '补充', '底栏'], placement: 'bottom-center', text: '用一句话补充背景信息', width: 560, height: 64, fontSize: 24, background: '#172633', animation: 'slide-up' },
  { id: 'highlight-word', name: '重点 · 短句强调', tags: ['重点', '强调', '短句'], placement: 'center', text: '关键内容', width: 340, height: 108, fontSize: 48, weight: 700, color: '#edbd72', animation: 'pull-back' },
  { id: 'corner-tag', name: '角标 · 紧凑标签', tags: ['角标', '分类', '标签'], placement: 'top-right', text: '内容标签', width: 156, height: 54, fontSize: 23, weight: 600, color: '#172633', background: '#f1eee4', animation: 'slide-left' },
  { id: 'series-label', name: '系列 · 横向标识', tags: ['系列', '编号', '标识'], placement: 'top-left', text: '系列名称 · 第 01 期', width: 300, height: 58, fontSize: 23, align: 'left', animation: 'slide-right' },
  { id: 'identity-lower-third', name: '身份 · 双行介绍', tags: ['身份', '姓名', '人物', '介绍'], placement: 'bottom-left', text: '姓名 / 称呼\n身份或职责', width: 356, height: 100, fontSize: 26, align: 'left', background: '#172633', animation: 'slide-right' },
  { id: 'source-footnote', name: '来源 · 横向脚注', tags: ['来源', '资料', '引用', '脚注'], placement: 'bottom-left', text: '资料来源：作者 / 资料名 / 年份', width: 560, height: 50, fontSize: 18, align: 'left', background: '#172633', animation: 'fade' },
  { id: 'credit-signature', name: '署名 · 右侧落款', tags: ['署名', '作者', '制作', '落款'], placement: 'bottom-right', text: '制作 / 作者\n在这里署名', width: 270, height: 86, fontSize: 22, align: 'right', animation: 'fade' },
  { id: 'chapter-number', name: '章节 · 大号数字', tags: ['章节', '编号', '数字'], placement: 'center', text: '01', width: 206, height: 170, fontSize: 88, family: 'monospace', weight: 500, color: '#172633', background: '#f1eee4', animation: 'push-in' },
  { id: 'chapter-title', name: '章节 · 左侧标题', tags: ['章节', '标题', '目录'], placement: 'top-left', text: '第一章\n在这里填写章节名', width: 440, height: 126, fontSize: 32, family: 'serif', align: 'left', animation: 'slide-down' },
  { id: 'step-card', name: '步骤 · 操作卡片', tags: ['步骤', '操作', '流程'], placement: 'bottom-left', text: '步骤 01\n操作说明写在这里', width: 390, height: 108, fontSize: 27, align: 'left', background: '#172633', animation: 'slide-up' },
  { id: 'points-list', name: '要点 · 三行清单', tags: ['要点', '清单', '列表'], placement: 'center', text: '01  第一项要点\n02  第二项要点\n03  第三项要点', width: 480, height: 162, fontSize: 28, align: 'left', animation: 'fade' },
  { id: 'comparison-left', name: '对比 · 左侧标签', tags: ['对比', '方案', '左侧'], placement: 'top-left', text: '方案 A\n填写比较维度', width: 248, height: 104, fontSize: 27, align: 'left', color: '#b8e8f3', background: '#172633', animation: 'slide-right' },
  { id: 'comparison-right', name: '对比 · 右侧标签', tags: ['对比', '方案', '右侧'], placement: 'top-right', text: '方案 B\n填写比较维度', width: 248, height: 104, fontSize: 27, align: 'right', color: '#edbd72', background: '#172633', animation: 'slide-left' },
  { id: 'notice-card', name: '提示 · 暖色信息卡', tags: ['提示', '注意', '提醒'], placement: 'center', text: '请留意\n这里填写提醒内容', width: 452, height: 116, fontSize: 28, weight: 500, color: '#172633', background: '#edbd72', animation: 'pull-back' },
  { id: 'conclusion', name: '结论 · 居中总结', tags: ['结论', '总结', '收束'], placement: 'center', text: '结论\n用一句话总结重点', width: 520, height: 156, fontSize: 36, family: 'serif', animation: 'fade' },
  { id: 'quotation', name: '引述 · 两行引用', tags: ['引述', '引用', '观点'], placement: 'center', text: '“在这里填写引述内容”\n—— 引述对象', width: 560, height: 150, fontSize: 30, family: 'serif', animation: 'fade' },
  { id: 'value-unit', name: '数值 · 单位卡片', tags: ['数值', '单位', '统计'], placement: 'center', text: '数值\n单位', width: 246, height: 150, fontSize: 40, family: 'monospace', color: '#b8e8f3', background: '#172633', animation: 'push-in' },
  { id: 'phase-strip', name: '阶段 · 横向流程', tags: ['阶段', '流程', '进度'], placement: 'top-left', text: '准备  /  进行中  /  完成', width: 474, height: 58, fontSize: 23, family: 'monospace', align: 'left', animation: 'slide-down' },
  { id: 'time-stamp', name: '时间 · 紧凑标记', tags: ['时间', '刻度', '标记'], placement: 'bottom-right', text: '00:00 · 时间标记', width: 246, height: 54, fontSize: 21, family: 'monospace', background: '#172633', animation: 'none' },
  { id: 'side-note', name: '补充 · 窄幅旁注', tags: ['补充', '旁注', '说明', '窄幅'], placement: 'top-right', text: '补充说明\n第一行\n第二行\n第三行', width: 174, height: 174, fontSize: 23, align: 'left', background: '#172633', animation: 'slide-left' },
  { id: 'status-list', name: '状态 · 工作清单', tags: ['状态', '清单', '任务'], placement: 'bottom-left', text: '已完成  事项一\n待处理  事项二\n下一步  事项三', width: 386, height: 144, fontSize: 25, align: 'left', color: '#b8e8f3', animation: 'fade' },
  { id: 'closing-message', name: '结尾 · 行动提示', tags: ['结尾', '感谢', '关注'], placement: 'bottom-center', text: '感谢观看\n欢迎继续关注后续内容', width: 520, height: 118, fontSize: 29, animation: 'slide-up' },
]

export const GENERAL_WATERMARK_MATERIALS: WatermarkMaterial[] = definitions.map(item => ({
  id: `general-${item.id}`, name: item.name, category: '可编辑文字', collection: 'general', tags: ['通用', '可编辑', ...item.tags],
  kind: 'text', url: '', poster: `/watermarks/general-${item.id}.png`, duration: 5, width: 640, height: 360, placement: item.placement,
  textTemplate: { text: item.text, color: item.color ?? '#f1eee4', background: item.background ?? 'transparent', fontFamily: item.family ?? 'sans-serif', fontWeight: item.weight ?? 400, textAlign: item.align ?? 'center', fontSize: item.fontSize, width: item.width, height: item.height, animation: item.animation ?? 'fade' },
}))
