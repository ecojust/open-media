import { motionStylePrompt } from './motion-style-prompts.ts'

export type MotionStyleId =
  | 'paper-ink' | 'iso-cards' | 'flat-pop' | 'line-focus' | 'studio-depth'
  | 'shape-rhythm' | 'sticker-notes' | 'tech-hud' | 'editorial-collage' | 'aurora-glass'
  | 'geometric-grid' | 'neon-retro' | 'pixel-arcade' | 'liquid-color' | 'expressive-type'
  | 'product-keynote' | 'evidence-dossier' | 'split-compare' | 'lyric-spectrum' | 'vintage-film'
  | 'route-atlas' | 'macro-lens' | 'parallax-panorama' | 'data-story' | 'blueprint-explode'
export interface MotionStyle {
  id: MotionStyleId
  name: string
  description: string
  palette: { background: string; accent: string; secondary: string; textColor: string }
  layout: 'split' | 'center' | 'stack' | 'collage'
  motion: 'bounce' | 'slide' | 'drift' | 'step' | 'orbit'
  fontFamily: 'sans-serif' | 'serif' | 'monospace'
  tags: string[]
  /** Whether the local two-dimensional preset renderer implements this style. */
  presetSupported: boolean
  note?: string
  /** Default direction supplied to the agent, separate from user requirements. */
  prompt: string
}

/** Shared agent directions; presetSupported distinguishes local rendering support. */
const MOTION_STYLE_DEFINITIONS: readonly Omit<MotionStyle, 'prompt'>[] = [
  { presetSupported:true,id:'paper-ink',name:'纸感手绘',description:'纸张颗粒、铅笔线框与逐格轻摆，适合手作、生活和温暖叙事。',palette:{background:'#f6ecd6',accent:'#d5523e',secondary:'#e7b847',textColor:'#282721'},layout:'split',motion:'step',fontFamily:'serif',tags:['手绘','纸张','逐格'] },
  { presetSupported:true,id:'iso-cards',name:'等轴卡片',description:'等轴网格、层叠基座与弹性升起，展示产品模块和信息结构。',palette:{background:'#e9e4f8',accent:'#7862ca',secondary:'#8dcab6',textColor:'#30294e'},layout:'stack',motion:'bounce',fontFamily:'sans-serif',tags:['等轴','层叠','产品'],note:'使用二维等轴装饰与卡片动画，素材保持平面，不生成三维模型。' },
  { presetSupported:true,id:'flat-pop',name:'扁平跃动',description:'大胆色块、圆点与弹性入场，让素材在清晰的构图里接力。',palette:{background:'#f8f2df',accent:'#286dce',secondary:'#ed7656',textColor:'#17354f'},layout:'split',motion:'bounce',fontFamily:'sans-serif',tags:['扁平','色块','弹性'] },
  { presetSupported:true,id:'line-focus',name:'极简线描',description:'细线、圆环与留白，配合轻缓平移和标题揭示。',palette:{background:'#111a20',accent:'#d5b777',secondary:'#738d94',textColor:'#f1eee4'},layout:'center',motion:'slide',fontFamily:'serif',tags:['线条','留白','品牌'] },
  { presetSupported:true,id:'studio-depth',name:'柔光立体',description:'柔光球体、层次阴影和悬浮卡片，营造干净的产品展台。',palette:{background:'#e8e9f1',accent:'#7e83bb',secondary:'#c8a77c',textColor:'#25283e'},layout:'center',motion:'drift',fontFamily:'sans-serif',tags:['柔光','材质','悬浮'],note:'立体感来自二维光影与图层，不包含真实三维建模或物理模拟。' },
  { presetSupported:true,id:'shape-rhythm',name:'柔形律动',description:'圆弧、胶囊与缩放呼应，以图形节奏连接素材和文字。',palette:{background:'#f1ebff',accent:'#8061c7',secondary:'#ec977f',textColor:'#352651'},layout:'stack',motion:'orbit',fontFamily:'sans-serif',tags:['圆弧','节奏','柔形'],note:'图形通过关键帧运动，不对用户素材执行轮廓变形。' },
  { presetSupported:true,id:'sticker-notes',name:'知识贴纸',description:'白边卡片、网格和重点标签，适合讲解、步骤和知识总结。',palette:{background:'#e6f0e6',accent:'#347863',secondary:'#edbb54',textColor:'#173e33'},layout:'split',motion:'slide',fontFamily:'sans-serif',tags:['科普','贴纸','重点'] },
  { presetSupported:true,id:'tech-hud',name:'科技视窗',description:'精细网格、定位括角与环形标尺，突出数据和操作画面。',palette:{background:'#0a1925',accent:'#5be2da',secondary:'#edb66a',textColor:'#e2f6f5'},layout:'split',motion:'slide',fontFamily:'monospace',tags:['科技','网格','标尺'] },
  { presetSupported:true,id:'editorial-collage',name:'杂志拼贴',description:'撕纸、半调点阵与错位叠层，给照片和观点鲜明的版面节奏。',palette:{background:'#eadfc9',accent:'#c94d38',secondary:'#537c83',textColor:'#292925'},layout:'collage',motion:'step',fontFamily:'serif',tags:['拼贴','报刊','照片'] },
  { presetSupported:true,id:'aurora-glass',name:'极光玻璃',description:'弥散光斑、透明面板和轻缓漂移，适合科技介绍与视觉展示。',palette:{background:'#101b31',accent:'#8e9bfa',secondary:'#65d4c3',textColor:'#eef1ff'},layout:'center',motion:'drift',fontFamily:'sans-serif',tags:['渐变','玻璃','漂浮'],note:'使用预绘光影和半透明图层，避免逐帧全画面折射计算。' },
  { presetSupported:true,id:'geometric-grid',name:'几何构成',description:'圆、方块和网格按节奏错位，强调明确的秩序与色彩对比。',palette:{background:'#eee9dc',accent:'#ca463e',secondary:'#285eab',textColor:'#242526'},layout:'split',motion:'bounce',fontFamily:'sans-serif',tags:['几何','网格','构成'] },
  { presetSupported:true,id:'neon-retro',name:'霓虹复古',description:'落日光晕、透视网格与霓虹色带，为素材加入复古电子气氛。',palette:{background:'#180d31',accent:'#f365c5',secondary:'#5bd5ed',textColor:'#fff0fd'},layout:'center',motion:'drift',fontFamily:'monospace',tags:['霓虹','复古','光晕'] },
  { presetSupported:true,id:'pixel-arcade',name:'像素节拍',description:'像素边框、阶梯色块与离散步进，适合游戏和轻快记录。',palette:{background:'#17243b',accent:'#99df8d',secondary:'#edbb67',textColor:'#edf3d8'},layout:'stack',motion:'step',fontFamily:'monospace',tags:['像素','阶梯','节拍'] },
  { presetSupported:true,id:'liquid-color',name:'流彩色团',description:'饱满色团缓慢交错、呼吸缩放，让素材随有机节奏出现。',palette:{background:'#231540',accent:'#d97fe5',secondary:'#fbaf78',textColor:'#fff0f7'},layout:'center',motion:'orbit',fontFamily:'sans-serif',tags:['流彩','有机','色团'],note:'使用色团图层和关键帧形成流动感，不执行流体模拟。' },
  { presetSupported:true,id:'expressive-type',name:'活力花字',description:'醒目标题、放射贴片和弹性强调，适合人物、日常和轻松表达。',palette:{background:'#fff1c4',accent:'#d85671',secondary:'#6d83ce',textColor:'#3d2a4e'},layout:'collage',motion:'bounce',fontFamily:'sans-serif',tags:['花字','弹性','情绪'] },
  { presetSupported:false,id:'product-keynote',name:'发布会聚焦',description:'以真实演示为主角，用宽幅留白、区域推近和结果定格讲清功能。',palette:{background:'#080c14',accent:'#8cacf9',secondary:'#e4d3ad',textColor:'#f5f6fa'},layout:'center',motion:'slide',fontFamily:'sans-serif',tags:['发布会','推镜','真实演示'],note:'由外部 Agent 按素材中的重点区域编写镜头与画面代码，再渲染导入工程。' },
  { presetSupported:false,id:'evidence-dossier',name:'证据档案',description:'从原始文档与画面逐层聚焦证据，用高亮、页签和连线串起论述。',palette:{background:'#eae7de',accent:'#be4f3c',secondary:'#446b78',textColor:'#252a2d'},layout:'split',motion:'slide',fontFamily:'serif',tags:['证据','档案','聚焦'],note:'由外部 Agent 读取真实素材并编写裁切、高亮与关联动画，保留来源和原文。' },
  { presetSupported:false,id:'split-compare',name:'双屏对照',description:'同步分屏、滑动分界与成对推近，让前后状态和方案差异清晰可见。',palette:{background:'#101921',accent:'#6ed2c1',secondary:'#e5ae71',textColor:'#f1f4f5'},layout:'split',motion:'slide',fontFamily:'sans-serif',tags:['对比','同步','揭示'],note:'由外部 Agent 对齐真实素材的动作和结果，再生成可剪辑的对照视频。' },
  { presetSupported:false,id:'lyric-spectrum',name:'节拍声场',description:'真实音频驱动频谱、波形和克制的节拍呼吸，结合主视觉与逐句歌词。',palette:{background:'#110d24',accent:'#df97ff',secondary:'#72ded0',textColor:'#faf1ff'},layout:'center',motion:'orbit',fontFamily:'sans-serif',tags:['声谱','节拍','歌词'],note:'由外部 Agent 分析可用音频后编写同步画面；没有音频时使用明确的固定节奏。' },
  { presetSupported:false,id:'vintage-film',name:'银幕胶片',description:'片门、细颗粒和缓慢推镜组成银幕回忆，保留照片与视频的真实内容。',palette:{background:'#1e1a17',accent:'#d3a878',secondary:'#8c9c91',textColor:'#f0e6d4'},layout:'collage',motion:'drift',fontFamily:'serif',tags:['胶片','相册','回忆'],note:'由外部 Agent 围绕原始照片和视频编写胶片质感与镜头动画，再渲染导入。' },
  { presetSupported:false,id:'route-atlas',name:'路线漫游',description:'路线、站点和章节镜头串联素材，在行进与停留之间展开旅程。',palette:{background:'#eff1e8',accent:'#dc7350',secondary:'#5a8d83',textColor:'#263c40'},layout:'split',motion:'slide',fontFamily:'sans-serif',tags:['路线','章节','漫游'],note:'由外部 Agent 编写路线与镜头动画；没有可靠位置资料时采用抽象路径示意。' },
  { presetSupported:false,id:'macro-lens',name:'微距解构',description:'全景与局部放大窗同步显示，用取样框和细引线解释真实细节。',palette:{background:'#14242d',accent:'#65d8d1',secondary:'#eccb84',textColor:'#edf7f5'},layout:'split',motion:'slide',fontFamily:'sans-serif',tags:['局部放大','观察','解析'],note:'由外部 Agent 定位真实素材中的区域并编写取样动画，放大受源素材清晰度约束。' },
  { presetSupported:false,id:'parallax-panorama',name:'视差长镜',description:'前中后景沿连续镜头分层移动，以平滑长镜展示照片与视频的空间。',palette:{background:'#17232a',accent:'#dfb47b',secondary:'#8fb2aa',textColor:'#f2ede3'},layout:'center',motion:'drift',fontFamily:'serif',tags:['景深','长镜','空间'],note:'由外部 Agent 编写分层镜头；缺少可靠遮罩时使用完整素材的轻微镜头运动。' },
  { presetSupported:false,id:'data-story',name:'数据叙事',description:'从真实材料展开图表，用统一尺度、数值联动和局部强调讲清变化。',palette:{background:'#f2f4f7',accent:'#3267c7',secondary:'#e58857',textColor:'#27354a'},layout:'split',motion:'slide',fontFamily:'sans-serif',tags:['图表','比较','趋势'],note:'由外部 Agent 基于可核对的数据编写图表动画；无数据时采用分类或过程关系。' },
  { presetSupported:false,id:'blueprint-explode',name:'工程分解',description:'构件沿装配轴展开、编号解释再复位，以工程线条展示结构关系。',palette:{background:'#112338',accent:'#75cbdc',secondary:'#eab46e',textColor:'#ebf4fa'},layout:'stack',motion:'slide',fontFamily:'monospace',tags:['分解','结构','装配'],note:'由外部 Agent 按已知结构编写分解动画；图片和视频采用二维面片，真实三维需要几何数据。' },
]

export const MOTION_STYLES: readonly MotionStyle[] = MOTION_STYLE_DEFINITIONS.map(style => ({ ...style, prompt: motionStylePrompt(style) }))

export function getMotionStyle(id: string): MotionStyle {
  const style = MOTION_STYLES.find(item => item.id === id)
  if (!style) throw new Error('找不到这个成片风格，请重新选择。')
  return style
}
