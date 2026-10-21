import test from 'node:test'
import assert from 'node:assert/strict'
import { createClip, createProject, createTextClip, createTrack, MAX_ASSETS, MAX_CLIPS, MAX_PROJECT_DURATION, MAX_TRACKS, validateProject } from '../src/core/project.ts'
import { planMotionComposition, composeMotionProject } from '../src/core/motion-style-composer.ts'
import { MOTION_STYLES } from '../src/core/motion-style-catalog.ts'
import { animatedClipAt } from '../src/core/visual-animation.ts'
import { measureTextLayout } from '../src/core/text-layout.ts'
import { clipDuration, clipEnd, commitHistory, createHistory, findClip, projectDuration, redoHistory, undoHistory } from '../src/core/timeline.ts'

const asset = (id, patch = {}) => ({ id, name: `${id}.png`, kind: 'image', url: `blob:${id}`, duration: 0, width: 1280, height: 720, size: 12000, mime: 'image/png', ...patch })
const resources = () => ({ background: asset('style-background'), decoration: asset('style-decoration', { width: 640, height: 640 }) })
function fixture(size = { width: 1920, height: 1080 }) {
  const project = createProject('原始工程', size)
  project.assets.push(asset('picture'), asset('footage', { name: '视频.mp4', kind: 'video', mime: 'video/mp4', duration: 10 }), asset('music', { kind: 'audio', mime: 'audio/wav', duration: 2, width: 0, height: 0 }), asset('logo', { width: 200, height: 200 }))
  return project
}
function options(patch = {}) { return { styleId: 'paper-ink', scenes: [{ assetId: 'picture', heading: '可编辑的标题', caption: '独立说明文字', duration: 4 }, { assetId: 'footage', heading: '第二个场景', duration: 5, trimIn: 1 }], ...patch } }
const allClips = project => project.tracks.flatMap(track => track.clips)
function sourceClip(result, index = 0) { return result.project.tracks.find(track => track.name.endsWith('· 素材卡片')).clips[index] }

test('十五种风格都生成原生可编辑图层，标题、色彩、构图与运动各有区别', () => {
  const signatures = new Set()
  for (const style of MOTION_STYLES) {
    const original = fixture(), before = structuredClone(original)
    const result = composeMotionProject(original, options({ styleId: style.id }), resources())
    assert.deepEqual(original, before)
    assert.deepEqual(validateProject(result.project, { trusted: true }), result.project)
    assert.equal(result.project.title, original.title)
    assert.equal(result.project.width, original.width); assert.equal(result.project.height, original.height)
    assert.equal(result.project.fps, original.fps); assert.equal(result.project.autoSizeFromVideo, original.autoSizeFromVideo)
    assert.equal(result.project.assets.length, original.assets.length + 2)
    assert.equal(result.data.sceneCount, 2); assert.equal(result.data.duration, 9)
    assert.deepEqual(result.data.clipIds, result.project.tracks.filter(track => result.data.trackIds.includes(track.id)).flatMap(track => track.clips.map(clip => clip.id)))
    assert.equal(new Set(result.data.clipIds).size, result.data.clipIds.length)
    const texts = allClips(result.project).filter(clip => clip.text)
    assert.deepEqual(texts.map(clip => clip.text), ['可编辑的标题', '第二个场景', '独立说明文字'])
    assert(texts.every(clip => clip.textRole === 'watermark' && clip.background === 'transparent'))
    assert(texts.every(clip => clip.color === style.palette.textColor && clip.fontFamily === style.fontFamily))
    assert.equal(findClip(result.project, result.selection.clipId).track.id, result.selection.trackId)
    assert.equal(result.selection.clipId, sourceClip(result).id)
    const media = sourceClip(result)
    assert.equal(media.rotation, 0); assert.equal(media.keyframes.rotation, undefined)
    assert.equal(media.keyframes.opacity, undefined); assert(media.fadeIn > 0 && media.fadeOut > 0)
    assert.equal(media.volume, 0); assert.equal(media.fit, 'contain')
    signatures.add(JSON.stringify([media.x,media.y,media.width,media.height,media.keyframes]))
    const decorations = result.project.tracks.find(track => track.name.endsWith('· 图形装饰')).clips
    assert.equal(decorations.length, 4)
    assert(decorations.every(clip => clip.width <= Math.min(original.width,original.height) * .24))
    assert.equal(result.project.tracks.find(track => track.name.endsWith('· 背景')).clips.length, 1)
    assert.equal(projectDuration(result.project), 9)
  }
  assert.equal(signatures.size, 15)
})

test('规划可重复执行且不产生项目修改；默认时长、素材标题和覆盖色返回明确值', () => {
  const project = fixture(), before = structuredClone(project)
  const input = options({ title: '我的演示', accent: '#012345', background: '#abcdef', textColor: '#654321', scenes: [{ assetId: 'picture' }, { assetId: 'picture', heading: '  自定义标题  ', caption: '  第二次使用同一素材  ' }] })
  const plan = planMotionComposition(project, input)
  assert.deepEqual(plan, planMotionComposition(project, input))
  assert.deepEqual(project, before)
  assert.equal(plan.start, 0); assert.equal(plan.duration, 8)
  assert.deepEqual(plan.scenes.map(scene => [scene.heading, scene.caption, scene.start, scene.duration]), [['我的演示','',0,4],['自定义标题','第二次使用同一素材',4,4]])
  assert.deepEqual(plan.palette, { background: '#abcdef', accent: '#012345', secondary: MOTION_STYLES[0].palette.secondary, textColor: '#654321' })
  assert.equal(plan.sourceAudio, false); assert.equal(plan.tempo, 'balanced'); assert.equal(plan.musicVolume, .22)
  assert.deepEqual(plan.warnings, [])
  assert.equal(planMotionComposition(project, { styleId: 'paper-ink', scenes: [{ assetId: 'picture' }] }).scenes[0].heading, 'picture')
})

test('横屏、竖屏、方形的文字与主体保持安全边距；动画缩放和时刻有界', () => {
  for (const size of [{ width: 1920, height: 1080 }, { width: 1080, height: 1920 }, { width: 1000, height: 1000 }]) {
    for (const style of MOTION_STYLES) {
      const result = composeMotionProject(fixture(size), options({ styleId: style.id }), resources())
      for (const clip of allClips(result.project)) {
        for (const [property, frames] of Object.entries(clip.keyframes ?? {})) {
          assert(frames.every((frame, index) => Number.isFinite(frame.value) && frame.time >= 0 && frame.time <= clipDuration(clip) + 1e-8 && (index === 0 || frame.time > frames[index-1].time)))
          if (property === 'scaleX' || property === 'scaleY') assert(frames.every(frame => frame.value >= .6 && frame.value <= 1.15))
        }
        if (!clip.text && !['picture','footage'].includes(clip.assetId)) continue
        const displayed = animatedClipAt(clip, clip.start+clipDuration(clip)*.5)
        assert(displayed.x >= size.width*.05-1, `${style.id}: left ${displayed.x}`)
        assert(displayed.y >= size.height*.05-1, `${style.id}: top ${displayed.y}`)
        assert(displayed.x+displayed.width <= size.width*.95+1, `${style.id}: right`)
        assert(displayed.y+displayed.height <= size.height*.95+1, `${style.id}: bottom`)
        if (clip.text) assert(clip.fontSize >= 4 && clip.fontSize < clip.height)
      }
    }
  }
})

test('后插保留所有旧轨道，从静音锁定轨道也计入的末尾开始', () => {
  const project = fixture()
  const clip = createClip(project.assets[1],project,{start:12,trimIn:2,trimOut:8})
  project.tracks[1].clips.push(clip); project.tracks[1].muted = true; project.tracks[1].locked = true
  project.markers = [{ id:'old-marker',time:15,label:'原标记',kind:'review' }]
  const result = composeMotionProject(project,options(),resources())
  assert.equal(result.data.start,18); assert.equal(projectDuration(result.project),27)
  assert.deepEqual(result.project.tracks.slice(-project.tracks.length),project.tracks)
  assert.deepEqual(result.project.markers.find(marker => marker.id === 'old-marker'),project.markers[0])
  assert.deepEqual(result.project.markers.filter(marker => marker.id !== 'old-marker').map(marker => marker.time),[18,22])
  const media = sourceClip(result,1)
  assert.equal(media.trimIn,1); assert.equal(media.trimOut,6); assert.equal(media.speed,1)
})

test('前插整体移动音画、字幕及标记，完整保留绑定与旧关键帧，一次撤销或重做', () => {
  const project = fixture()
  const subtitle = createTextClip(project,{start:2,trimOut:3,text:'原字幕'})
  const video = createClip(project.assets[1],project,{start:1,trimIn:1,trimOut:9,speed:2,keyframes:{x:[{time:0,value:20},{time:4,value:40}]}})
  const audio = createClip(project.assets[2],project,{start:2,trimOut:3,speech:{textClipId:subtitle.id,text:subtitle.text,voiceId:'local-voice',rate:1}})
  project.tracks[0].clips.push(subtitle); project.tracks[1].clips.push(video); project.tracks[2].clips.push(audio)
  project.markers = [{ id:'chapter-original',time:2,label:'正文',kind:'chapter' }]
  const before = structuredClone(project), result = composeMotionProject(project,options({placement:'prepend'}),resources())
  for (const clip of allClips(project)) assert.deepEqual(findClip(result.project,clip.id).clip,{...clip,start:clip.start+9})
  assert.deepEqual(result.project.markers.find(marker => marker.id === 'chapter-original'),{...project.markers[0],time:11})
  assert.deepEqual(project,before)
  const history = commitHistory(createHistory(project),result.project)
  assert.deepEqual(undoHistory(history).present,project)
  assert.deepEqual(redoHistory(undoHistory(history)).present,result.project)
  assert.equal(projectDuration(result.project),projectDuration(project)+9)
})

test('短视频按剩余源时长缩短并说明；最低四分之一秒亦可生成合法关键帧', () => {
  const project = fixture()
  for (const remaining of [.25, .75, 3]) {
    const input = options({ scenes: [{ assetId:'footage',trimIn:10-remaining,duration:4 }, { assetId:'picture',duration:2 }] })
    const plan = planMotionComposition(project,input)
    assert.equal(plan.scenes[0].duration,remaining); assert.equal(plan.duration,remaining+2)
    assert.equal(plan.warnings.length,1); assert.match(plan.warnings[0],/正常速度/)
    const result = composeMotionProject(project,input,resources()), source = sourceClip(result)
    assert.equal(source.trimOut,10); assert.equal(source.speed,1); assert.equal(clipDuration(source),remaining)
    assert.equal(sourceClip(result,1).start,remaining)
    assert.deepEqual(result.data.warnings,plan.warnings)
    assert.doesNotThrow(() => validateProject(result.project,{trusted:true}))
  }
  for (const trimIn of [9.8,10]) assert.throws(() => planMotionComposition(project,options({scenes:[{assetId:'footage',trimIn}]})),/不足 0.25/)
  assert.throws(() => planMotionComposition(project,options({scenes:[{assetId:'picture',trimIn:0}]})),/只有视频/)
})

test('原声开关、可循环配乐、标志图片都保持独立可编辑轨道', () => {
  const project = fixture(), input = options({sourceAudio:true,musicAssetId:'music',musicVolume:.35,logoAssetId:'logo'})
  const result = composeMotionProject(project,input,resources())
  assert.equal(sourceClip(result,0).volume,0); assert.equal(sourceClip(result,1).volume,1)
  const musicTrack = result.project.tracks.find(track => track.name.endsWith('· 背景音乐')), music = musicTrack.clips[0]
  assert.equal(musicTrack.kind,'audio'); assert.equal(music.assetId,'music'); assert.equal(music.trimOut,9)
  assert.equal(music.volume,.35); assert.equal(music.fadeIn,.45); assert.equal(music.fadeOut,.7)
  assert.equal(clipEnd(music),result.data.start+result.data.duration)
  const logo = result.project.tracks[0]
  assert.match(logo.name,/标志/); assert.equal(logo.clips[0].assetId,'logo'); assert.equal(clipDuration(logo.clips[0]),9)
  assert(!result.project.tracks.some(track => track.kind === 'transition'))
  assert.equal(result.project.assets.length,6)
  assert.throws(() => planMotionComposition(project,options({musicAssetId:'picture'})),/背景音乐/)
  assert.throws(() => planMotionComposition(project,options({logoAssetId:'music'})),/标志图片/)
})

test('静缓与活跃节奏改变入场运动而不擅自改变场景时长', () => {
  const variants = ['calm','balanced','energetic'].map(tempo => composeMotionProject(fixture(),options({styleId:'flat-pop',tempo}),resources()))
  assert.equal(new Set(variants.map(result => JSON.stringify(sourceClip(result).keyframes))).size,3)
  assert(variants.every(result => result.data.duration === 9))
  const enters = variants.map(result => sourceClip(result).fadeIn)
  assert(enters[0] > enters[1] && enters[1] > enters[2])
})

test('有意留空的标题与说明不生成空字幕，长文本保留完整内容并按框缩小字号', () => {
  const empty = composeMotionProject(fixture(),options({scenes:[{assetId:'picture',heading:'  ',caption:''}]}),resources())
  assert(!allClips(empty.project).some(clip => clip.text))
  assert(!empty.project.tracks.some(track => track.name.endsWith('· 标题') || track.name.endsWith('· 说明')))
  assert.equal(empty.project.markers[0].label,'场景 1')
  const heading = '较长的可编辑标题'.repeat(12), caption = '保留文字内容'.repeat(35)
  const long = composeMotionProject(fixture(),options({scenes:[{assetId:'picture',heading,caption}]}),resources())
  const texts = allClips(long.project).filter(clip => clip.text)
  assert.deepEqual(texts.map(clip => clip.text),[heading,caption])
  assert(texts.every(clip => clip.fontSize >= 4 && clip.fontSize < 100))
})

test('窄标题框考虑实际24像素内边距和整行高度，短中文、120字与显式换行均不裁切', () => {
  for (const heading of ['创意，从此动起来', '中'.repeat(120), '第一行\n第二行\n\n第四行']) {
    for (const style of MOTION_STYLES) {
      for (const size of [{width:640,height:360},{width:1080,height:1920}]) {
        const result = composeMotionProject(fixture(size),options({styleId:style.id,scenes:[{assetId:'picture',heading}]}),resources())
        const clip = allClips(result.project).find(item => item.text === heading)
        const context = { measureText: text => ({width:[...text].length*clip.fontSize}) }
        const lines = measureTextLayout(context,heading,Math.max(1,clip.width-24),false)
        assert(lines.length*clip.fontSize*1.35 <= clip.height*.96, `${style.id} ${size.width}: ${lines.length}行，字号${clip.fontSize}超出框高${clip.height}`)
      }
    }
  }
})

test('拒绝无效数值、未知参数、类型与素材，不静默转成数字且不修改项目', () => {
  const project = fixture(), before = structuredClone(project)
  for (const duration of [null,'4',NaN,Infinity,-1,0,1.9,12.1]) assert.throws(() => planMotionComposition(project,options({scenes:[{assetId:'picture',duration}]})),/场景时长/)
  for (const trimIn of [null,'0',NaN,Infinity,-1,11]) assert.throws(() => planMotionComposition(project,options({scenes:[{assetId:'footage',trimIn}]})),/素材起点/)
  for (const musicVolume of [null,'0.5',NaN,Infinity,-.1,1.1]) assert.throws(() => planMotionComposition(project,options({musicVolume})),/音量/)
  for (const sourceAudio of [null,0,'true']) assert.throws(() => planMotionComposition(project,options({sourceAudio})),/开关/)
  for (const color of [null,'red','#fff','#01234567','url(x)']) assert.throws(() => planMotionComposition(project,options({accent:color})),/颜色/)
  for (const scenes of [null,{},[],Array.from({length:17},() => ({assetId:'picture'}))]) assert.throws(() => planMotionComposition(project,options({scenes})),/场景/)
  for (const scene of [null,[],{assetId:'missing'},{assetId:'music'},{assetId:'picture',opacity:1}]) assert.throws(() => planMotionComposition(project,options({scenes:[scene]})))
  for (const patch of [{styleId:'unknown'},{styleId:1},{placement:'replace'},{tempo:'fast'},{title:''},{title:'x'.repeat(121)},{musicAssetId:'missing'},{expectedRevision:'x'},{dryRun:true}]) assert.throws(() => planMotionComposition(project,options(patch)))
  for (const heading of [null,1,'x'.repeat(121),'bad\0text']) assert.throws(() => planMotionComposition(project,options({scenes:[{assetId:'picture',heading}]})),/标题/)
  for (const caption of [null,1,'x'.repeat(241)]) assert.throws(() => planMotionComposition(project,options({scenes:[{assetId:'picture',caption}]})),/说明/)
  assert.throws(() => planMotionComposition(project,null))
  assert.deepEqual(project,before)
})

test('图像资源失效或标识冲突时原子失败，未就地写入任何新资产或片段', () => {
  const project = fixture(), before = structuredClone(project)
  for (const patch of [{kind:'video'},{size:0},{size:NaN},{url:''},{width:0},{height:Infinity},{id:'picture'}]) {
    assert.throws(() => composeMotionProject(project,options(),{...resources(),background:asset('style-background',patch)}))
    assert.deepEqual(project,before)
  }
  const duplicate = resources(); duplicate.decoration.id = duplicate.background.id
  assert.throws(() => composeMotionProject(project,options(),duplicate),/重复/)
  assert.throws(() => composeMotionProject(project,options(),null),/缺少/)
})

test('提前检查锁轨、时长、标记和素材/轨道/片段容量上限', () => {
  const locked = fixture(); locked.tracks[1].clips.push(createClip(locked.assets[1],locked)); locked.tracks[1].locked = true
  assert.throws(() => planMotionComposition(locked,options({placement:'prepend'})),/解锁/)
  const emptyLocked = fixture(); emptyLocked.tracks.forEach(track => { track.locked = true })
  assert.doesNotThrow(() => composeMotionProject(emptyLocked,options({placement:'prepend'}),resources()))
  const long = fixture(); long.tracks[0].clips.push(createTextClip(long,{start:MAX_PROJECT_DURATION-3,trimOut:3}))
  assert.throws(() => planMotionComposition(long,options()),/24 小时/)
  const markers = fixture(); markers.markers = Array.from({length:1000},(_,i) => ({id:`marker-${i}`,time:i,label:`章节${i}`,kind:'chapter'}))
  assert.throws(() => planMotionComposition(markers,options()),/1000 个标记/)
  markers.markers = [{id:'late-marker',time:MAX_PROJECT_DURATION-1,label:'最后',kind:'review'}]
  assert.throws(() => planMotionComposition(markers,options({placement:'prepend'})),/标记将超过/)
  const tracks = fixture(); tracks.tracks = Array.from({length:MAX_TRACKS},() => createTrack('audio'))
  assert.throws(() => planMotionComposition(tracks,options()),/100 条轨道/)
  const assets = fixture(); assets.assets.push(...Array.from({length:MAX_ASSETS-assets.assets.length},(_,i) => asset(`extra-${i}`)))
  assert.throws(() => planMotionComposition(assets,options()),/1000 个素材/)
  const clips = fixture(), base = createTextClip(clips)
  clips.tracks[0].clips = Array.from({length:MAX_CLIPS-3},(_,i) => ({...base,id:`clip-${i}`}))
  assert.throws(() => planMotionComposition(clips,options()),/10000 个片段/)
})

test('保存为项目数据再校验可恢复所有原生动画；第二次成片不覆盖第一次图层', () => {
  const first = composeMotionProject(fixture(),options({styleId:'tech-hud'}),resources())
  const secondResources = { background:asset('background-2'),decoration:asset('decoration-2') }
  const second = composeMotionProject(first.project,options({styleId:'liquid-color',placement:'prepend'}),secondResources)
  const reopened = validateProject(JSON.parse(JSON.stringify(second.project)),{trusted:true})
  assert.deepEqual(reopened,second.project)
  for (const clip of allClips(first.project)) assert.deepEqual(findClip(reopened,clip.id).clip,{...clip,start:clip.start+9})
  assert.equal(reopened.assets.length,8)
  assert.equal(projectDuration(reopened),18)
})

test('超过桌面导出有效片段上限时规划和结果都明确警告，未越权修改全局容量', () => {
  const project = fixture(), base = createTextClip(project)
  project.tracks[0].clips = Array.from({length:499},(_,index) => ({...base,id:`existing-${index}`}))
  const input = options({scenes:[{assetId:'picture',heading:'',caption:''}]})
  const plan = planMotionComposition(project,input)
  assert.equal(plan.warnings.length,1)
  assert.match(plan.warnings[0],/505 个非转场片段/)
  assert.match(plan.warnings[0],/导出最多支持 500/)
  const result = composeMotionProject(project,input,resources())
  assert.deepEqual(result.data.warnings,plan.warnings)
  assert.equal(allClips(result.project).length,505)
})

test('原视频标识和历史工作副本标识都解析到当前压缩工作副本，保持剪辑预览效率', () => {
  const project = fixture()
  const compression = {originalAssetId:'footage',mode:'quality',quality:'balanced',createdAt:new Date().toISOString()}
  project.assets.push(asset('historical-copy',{kind:'video',duration:10,mime:'video/mp4',compression:{...compression,active:false}}),asset('active-copy',{kind:'video',duration:10,mime:'video/mp4',compression:{...compression,active:true}}))
  for (const assetId of ['footage','historical-copy','active-copy']) {
    const input = options({scenes:[{assetId,trimIn:1,duration:4}]})
    const plan = planMotionComposition(project,input)
    assert.equal(plan.scenes[0].assetId,'active-copy')
    const result = composeMotionProject(project,input,resources())
    assert.equal(sourceClip(result).assetId,'active-copy')
    assert.equal(sourceClip(result).trimIn,1); assert.equal(sourceClip(result).trimOut,5)
    assert.equal(result.project.assets.find(item => item.id === 'footage').url,'blob:footage')
  }
})

test('所有风格只生成原生缩放平移动画和普通淡入淡出，避免旋转与透明度逐像素表达式', () => {
  for (const style of MOTION_STYLES) {
    const result = composeMotionProject(fixture(),options({styleId:style.id}),resources())
    for (const clip of allClips(result.project)) {
      assert.equal(clip.rotation,0)
      assert.equal(clip.keyframes?.rotation,undefined,`${style.id}: ${clip.name}包含旋转`)
      assert.equal(clip.keyframes?.opacity,undefined,`${style.id}: ${clip.name}包含透明度关键帧`)
      if (clip.keyframes) {
        assert(clip.fadeIn > 0 && clip.fadeOut > 0,`${style.id}: ${clip.name}缺少原生淡入淡出`)
        assert(Object.keys(clip.keyframes).every(key => ['x','y','scaleX','scaleY'].includes(key)))
      }
    }
  }
})
