export type MotionStyleId = 'paper-ink' | 'iso-cards' | 'flat-pop' | 'line-focus' | 'studio-depth' | 'shape-rhythm' | 'sticker-notes' | 'tech-hud' | 'editorial-collage' | 'aurora-glass' | 'geometric-grid' | 'neon-retro' | 'pixel-arcade' | 'liquid-color' | 'expressive-type'
export interface MotionStyle {
  id: MotionStyleId
  name: string
  description: string
  palette: { background: string; accent: string; secondary: string; textColor: string }
  layout: 'split' | 'center' | 'stack' | 'collage'
  motion: 'bounce' | 'slide' | 'drift' | 'step' | 'orbit'
  fontFamily: 'sans-serif' | 'serif' | 'monospace'
  tags: string[]
  note?: string
}

/** Original, asset-driven 2D compositions. Every generated layer remains editable. */
export const MOTION_STYLES: readonly MotionStyle[] = [
  { id:'paper-ink',name:'纸感手绘',description:'纸张颗粒、铅笔线框与逐格轻摆，适合手作、生活和温暖叙事。',palette:{background:'#f6ecd6',accent:'#d5523e',secondary:'#e7b847',textColor:'#282721'},layout:'split',motion:'step',fontFamily:'serif',tags:['手绘','纸张','逐格'] },
  { id:'iso-cards',name:'等轴卡片',description:'等轴网格、层叠基座与弹性升起，展示产品模块和信息结构。',palette:{background:'#e9e4f8',accent:'#7862ca',secondary:'#8dcab6',textColor:'#30294e'},layout:'stack',motion:'bounce',fontFamily:'sans-serif',tags:['等轴','层叠','产品'],note:'使用二维等轴装饰与卡片动画，素材保持平面，不生成三维模型。' },
  { id:'flat-pop',name:'扁平跃动',description:'大胆色块、圆点与弹性入场，让素材在清晰的构图里接力。',palette:{background:'#f8f2df',accent:'#286dce',secondary:'#ed7656',textColor:'#17354f'},layout:'split',motion:'bounce',fontFamily:'sans-serif',tags:['扁平','色块','弹性'] },
  { id:'line-focus',name:'极简线描',description:'细线、圆环与留白，配合轻缓平移和标题揭示。',palette:{background:'#111a20',accent:'#d5b777',secondary:'#738d94',textColor:'#f1eee4'},layout:'center',motion:'slide',fontFamily:'serif',tags:['线条','留白','品牌'] },
  { id:'studio-depth',name:'柔光立体',description:'柔光球体、层次阴影和悬浮卡片，营造干净的产品展台。',palette:{background:'#e8e9f1',accent:'#7e83bb',secondary:'#c8a77c',textColor:'#25283e'},layout:'center',motion:'drift',fontFamily:'sans-serif',tags:['柔光','材质','悬浮'],note:'立体感来自二维光影与图层，不包含真实三维建模或物理模拟。' },
  { id:'shape-rhythm',name:'柔形律动',description:'圆弧、胶囊与缩放呼应，以图形节奏连接素材和文字。',palette:{background:'#f1ebff',accent:'#8061c7',secondary:'#ec977f',textColor:'#352651'},layout:'stack',motion:'orbit',fontFamily:'sans-serif',tags:['圆弧','节奏','柔形'],note:'图形通过关键帧运动，不对用户素材执行轮廓变形。' },
  { id:'sticker-notes',name:'知识贴纸',description:'白边卡片、网格和重点标签，适合讲解、步骤和知识总结。',palette:{background:'#e6f0e6',accent:'#347863',secondary:'#edbb54',textColor:'#173e33'},layout:'split',motion:'slide',fontFamily:'sans-serif',tags:['科普','贴纸','重点'] },
  { id:'tech-hud',name:'科技视窗',description:'精细网格、定位括角与环形标尺，突出数据和操作画面。',palette:{background:'#0a1925',accent:'#5be2da',secondary:'#edb66a',textColor:'#e2f6f5'},layout:'split',motion:'slide',fontFamily:'monospace',tags:['科技','网格','标尺'] },
  { id:'editorial-collage',name:'杂志拼贴',description:'撕纸、半调点阵与错位叠层，给照片和观点鲜明的版面节奏。',palette:{background:'#eadfc9',accent:'#c94d38',secondary:'#537c83',textColor:'#292925'},layout:'collage',motion:'step',fontFamily:'serif',tags:['拼贴','报刊','照片'] },
  { id:'aurora-glass',name:'极光玻璃',description:'弥散光斑、透明面板和轻缓漂移，适合科技介绍与视觉展示。',palette:{background:'#101b31',accent:'#8e9bfa',secondary:'#65d4c3',textColor:'#eef1ff'},layout:'center',motion:'drift',fontFamily:'sans-serif',tags:['渐变','玻璃','漂浮'],note:'使用预绘光影和半透明图层，避免逐帧全画面折射计算。' },
  { id:'geometric-grid',name:'几何构成',description:'圆、方块和网格按节奏错位，强调明确的秩序与色彩对比。',palette:{background:'#eee9dc',accent:'#ca463e',secondary:'#285eab',textColor:'#242526'},layout:'split',motion:'bounce',fontFamily:'sans-serif',tags:['几何','网格','构成'] },
  { id:'neon-retro',name:'霓虹复古',description:'落日光晕、透视网格与霓虹色带，为素材加入复古电子气氛。',palette:{background:'#180d31',accent:'#f365c5',secondary:'#5bd5ed',textColor:'#fff0fd'},layout:'center',motion:'drift',fontFamily:'monospace',tags:['霓虹','复古','光晕'] },
  { id:'pixel-arcade',name:'像素节拍',description:'像素边框、阶梯色块与离散步进，适合游戏和轻快记录。',palette:{background:'#17243b',accent:'#99df8d',secondary:'#edbb67',textColor:'#edf3d8'},layout:'stack',motion:'step',fontFamily:'monospace',tags:['像素','阶梯','节拍'] },
  { id:'liquid-color',name:'流彩色团',description:'饱满色团缓慢交错、呼吸缩放，让素材随有机节奏出现。',palette:{background:'#231540',accent:'#d97fe5',secondary:'#fbaf78',textColor:'#fff0f7'},layout:'center',motion:'orbit',fontFamily:'sans-serif',tags:['流彩','有机','色团'],note:'使用色团图层和关键帧形成流动感，不执行流体模拟。' },
  { id:'expressive-type',name:'活力花字',description:'醒目标题、放射贴片和弹性强调，适合人物、日常和轻松表达。',palette:{background:'#fff1c4',accent:'#d85671',secondary:'#6d83ce',textColor:'#3d2a4e'},layout:'collage',motion:'bounce',fontFamily:'sans-serif',tags:['花字','弹性','情绪'] },
]

export function getMotionStyle(id: string): MotionStyle {
  const style = MOTION_STYLES.find(item => item.id === id)
  if (!style) throw new Error('找不到这个成片风格，请重新选择。')
  return style
}
