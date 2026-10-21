import test from 'node:test'
import assert from 'node:assert/strict'
import { createClip, createProject, createTextClip, createTrack, MAX_ASSETS, MAX_PROJECT_DURATION, MAX_TRACKS, validateProject } from '../src/core/project.ts'
import { MOTION_STYLES } from '../src/core/motion-style-catalog.ts'
import { prepareMotionStyleTool, planMotionClipGeneration } from '../src/core/motion-style-service.ts'
import { isSharedEditorTool, prepareEditorTool } from '../src/core/editor-tool-service.ts'
import { projectSourceAssets } from '../src/core/editor-assets.ts'
import { commitHistory, createHistory, projectDuration, undoHistory } from '../src/core/timeline.ts'

const tool = 'open_media_motion_clip_generate'
const png = () => new Blob([Uint8Array.from([137,80,78,71,13,10,26,10])],{type:'image/png'})
const webm = () => new Blob([Uint8Array.from([26,69,223,163])],{type:'video/webm'})
const image = (id,patch={}) => ({id,name:`${id}.png`,kind:'image',mime:'image/png',url:`blob:${id}`,width:1280,height:720,duration:0,size:2048,...patch})
function fixture(size={width:1280,height:720}) {
  const project = createProject('原始剪辑工程',size)
  project.assets.push(image('photo'),image('unused'))
  project.mcpMotion={enabled:true,assetIds:['photo'],styleId:'flat-pop'}
  project.tracks[0].clips.push(createTextClip(project,{start:7,trimOut:5,text:'原字幕不参与短片渲染'}))
  project.markers=[{id:'original-marker',time:8,label:'原章节',kind:'chapter'}]
  return project
}
const options = () => ({styleId:'flat-pop',scenes:[{assetId:'photo',heading:'观察细节',caption:'生成独立视频素材',duration:4}]})
function context(project,controller=new AbortController()) { return {project,revision:3,source:'mcp',blobs:new Map(),signal:controller.signal,onProgress(){}} }
function dependencies(overrides={}) {
  const calls=[],revoked=[],nativeEvents=[]
  let serial=0,rendered
  const deps={
    calls,revoked,nativeEvents,
    async renderArt(...args){calls.push(['art',...args]);return {background:png(),decoration:png()}},
    isDesktop:()=>false,
    async importBrowser(file){
      const id=`generated-${++serial}`;calls.push(['import',file])
      return image(id,{name:file.name,size:file.size,...(file.type.startsWith('video/')?{kind:'video',mime:file.type,width:rendered.width,height:rendered.height,duration:projectDuration(rendered)}:{})})
    },
    async renderBrowser(project,options){rendered=structuredClone(project);calls.push(['browser',rendered,options]);options.onProgress?.(.5);return webm()},
    async renderNative(project,signal,onProgress){
      rendered=structuredClone(project);calls.push(['native',rendered,signal]);onProgress({stage:'编码中',progress:.5,encodedFrames:48,outputTime:2})
      return {asset:image('native-video',{kind:'video',mime:'video/mp4',width:Math.floor(project.width/2)*2,height:Math.floor(project.height/2)*2,duration:projectDuration(project),nativePath:'/generated/clip.mp4'}),accept:async()=>{nativeEvents.push('accept')},discard:async()=>{nativeEvents.push('discard')}}
    },
    revokeAsset(asset){revoked.push(asset.id)},
    ...overrides,
  }
  return deps
}

test('catalog and dry run are side-effect free; isolated scenes always start at zero',async()=>{
  const project=fixture(),before=structuredClone(project),deps=dependencies({renderArt(){throw Error('must not render')}})
  const list=await prepareMotionStyleTool('open_media_motion_style_list',{},context(project),deps)
  assert.equal(list.data.total,MOTION_STYLES.length);list.data.items[0].name='changed'
  assert.notEqual((await prepareMotionStyleTool('open_media_motion_style_list',{},context(project),deps)).data.items[0].name,'changed')
  const result=await prepareMotionStyleTool(tool,{...options(),dryRun:true,expectedRevision:3,expectedProjectId:project.id},context(project),deps)
  assert.equal(result.data.start,0);assert.equal(result.data.scenes[0].start,0);assert.equal(result.data.duration,4)
  assert.equal(result.data.destination,'assets');assert.equal(result.data.placement,undefined)
  assert.equal(result.data.width,1280);assert.equal(result.data.height,720);assert.deepEqual(result.data.sourceAssetIds,['photo'])
  assert.equal(result.project,undefined);assert.equal(result.assets,undefined);assert.equal(result.data.dryRun,true)
  assert.deepEqual(project,before);assert.deepEqual(deps.calls,[])
})

test('asset generation is independent of locked/full/long existing timelines and reserves only one final asset',()=>{
  const project=fixture()
  project.tracks=Array.from({length:MAX_TRACKS},()=>({...createTrack('text'),locked:true}))
  project.tracks[0].clips.push(createTextClip(project,{start:MAX_PROJECT_DURATION-4,trimOut:4}))
  project.assets.push(...Array.from({length:MAX_ASSETS-1-project.assets.length},(_,index)=>image(`extra-${index}`)))
  const plan=planMotionClipGeneration(project,options())
  assert.equal(plan.start,0);assert.equal(plan.duration,4);assert.deepEqual(plan.warnings,[])
  assert.throws(()=>planMotionClipGeneration(project,{...options(),destination:'timeline'}),/24 小时/)
  project.assets.push(image('last-slot'))
  assert.throws(()=>planMotionClipGeneration(project,options()),/1000 个素材/)
})

test('browser rendering commits one visible ordinary video with its blob, preserving original tracks/markers and one-step undo',async()=>{
  const project=fixture(),before=structuredClone(project),deps=dependencies(),progress=[]
  const result=await prepareMotionStyleTool(tool,options(),{...context(project),onProgress:update=>progress.push(update)},deps)
  assert.deepEqual(project,before);assert.deepEqual(result.project.tracks,project.tracks);assert.deepEqual(result.project.markers,project.markers)
  assert.deepEqual(result.project.mcpMotion,project.mcpMotion)
  assert.equal(result.project.title,project.title);assert.equal(result.project.width,1280);assert.equal(result.project.height,720)
  assert.equal(result.project.assets.length,project.assets.length+1);assert.equal(result.assets.length,1)
  const entry=result.assets[0]
  assert.equal(entry.asset.kind,'video');assert.equal(entry.asset.libraryRole,undefined);assert.equal(entry.blob.type,'video/webm')
  assert.ok(projectSourceAssets(result.project).some(asset=>asset.id===entry.asset.id))
  assert.equal(result.data.assetId,entry.asset.id);assert.equal(result.data.renderer,'browser');assert.equal(result.data.destination,'assets')
  assert.equal(result.selection,undefined);assert.equal(result.data.clipId,undefined)
  const temporary=deps.calls.find(call=>call[0]==='browser')[1]
  assert.equal(temporary.width,project.width);assert.equal(temporary.fps,project.fps);assert.equal(projectDuration(temporary),4)
  assert(!temporary.assets.some(asset=>asset.id==='unused'))
  assert(!temporary.tracks.flatMap(track=>track.clips).some(clip=>clip.text==='原字幕不参与短片渲染'))
  assert(!temporary.markers.some(marker=>marker.id==='original-marker'))
  assert.equal(temporary.mcpMotion,undefined)
  assert.deepEqual(deps.revoked,['generated-1','generated-2'])
  assert.equal(progress.at(-1).progress,1)
  assert.deepEqual(undoHistory(commitHistory(createHistory(project),result.project)).present,project)
  validateProject(result.project,{trusted:true})
  await result.accept();await result.accept();await result.discard()
  assert.deepEqual(deps.revoked,['generated-1','generated-2'])
})

test('timeline destination inserts exactly one ordinary video clip on a new track at playhead or project end',async()=>{
  for(const start of [undefined,2]){
    const project=fixture(),deps=dependencies()
    const input={...options(),destination:'timeline',...(start===undefined?{}:{insert:{start}})}
    const plan=planMotionClipGeneration(project,input)
    assert.deepEqual(plan.insert,{start:start??12})
    const result=await prepareMotionStyleTool(tool,input,context(project),deps)
    assert.equal(result.project.tracks.length,project.tracks.length+1)
    assert.deepEqual(result.project.tracks.slice(1),project.tracks)
    const track=result.project.tracks[0]
    assert.equal(track.kind,'video');assert.equal(track.clips.length,1)
    assert.equal(track.clips[0].start,start??12);assert.equal(track.clips[0].assetId,result.data.assetId)
    assert.deepEqual(result.selection,{trackId:track.id,clipId:track.clips[0].id})
    assert.equal(result.data.start,start??12);assert.equal(result.data.duration,4)
    assert.deepEqual(result.project.markers,project.markers)
    await result.discard()
  }
})

test('explicit destination track is validated before rendering and never shifts existing clips',async()=>{
  const project=fixture(),track=project.tracks[1]
  track.clips.push(createClip(project.assets[0],project,{start:5,trimOut:5}))
  const input={...options(),destination:'timeline',insert:{trackId:track.id,start:1}}
  const result=await prepareMotionStyleTool(tool,input,context(project),dependencies())
  assert.equal(result.project.tracks.length,project.tracks.length)
  assert.deepEqual(result.project.tracks[1].clips[0],track.clips[0]);assert.equal(result.project.tracks[1].clips.length,2)
  for(const insert of [{trackId:track.id,start:6},{trackId:'missing'},{trackId:project.tracks[0].id},{start:NaN},{start:'1'},{start:-1},{start:1,extra:1}])assert.throws(()=>planMotionClipGeneration(project,{...options(),destination:'timeline',insert}))
  track.locked=true
  assert.throws(()=>planMotionClipGeneration(project,input),/解锁/)
  assert.doesNotThrow(()=>planMotionClipGeneration(project,options()))
  await result.discard()
})

test('native render owns only the final file and accepts at most once; odd project dimensions stay unchanged',async()=>{
  const project=fixture({width:1281,height:721}),deps=dependencies({isDesktop:()=>true})
  const result=await prepareMotionStyleTool(tool,options(),context(project),deps)
  assert.equal(deps.calls.filter(call=>call[0]==='import').length,2)
  assert.equal(result.assets.length,1);assert.equal(result.assets[0].blob,undefined)
  assert.equal(result.assets[0].asset.nativePath,'/generated/clip.mp4')
  assert.equal(result.data.renderer,'native');assert.equal(result.data.width,1280);assert.equal(result.data.height,720)
  assert.equal(result.project.width,1281);assert.equal(result.project.height,721)
  assert.deepEqual(deps.revoked,['generated-1','generated-2'])
  await Promise.all([result.accept(),result.accept()]);await result.discard()
  assert.deepEqual(deps.nativeEvents,['accept'])
})

test('current active compressed source is rendered without materializing original or unrelated assets',async()=>{
  const project=fixture(),video=image('source',{kind:'video',mime:'video/mp4',duration:10,nativePath:'/source/large-original.mp4'})
  project.assets.push(video,image('working',{kind:'video',mime:'video/mp4',duration:10,nativePath:'/working/small.mp4',compression:{originalAssetId:'source',mode:'quality',quality:'balanced',active:true,createdAt:new Date().toISOString()}}))
  project.mcpMotion.assetIds=['source']
  for(const selectedId of ['source','working'])for(const requestedId of ['source','working']){
    const authorized={...project,mcpMotion:{...project.mcpMotion,assetIds:[selectedId]}}
    assert.deepEqual(planMotionClipGeneration(authorized,{...options(),scenes:[{assetId:requestedId,duration:4}]}).sourceAssetIds,['working'])
  }
  const deps=dependencies({isDesktop:()=>true}),before=structuredClone(project)
  const result=await prepareMotionStyleTool(tool,{...options(),scenes:[{assetId:'source',duration:4}]},context(project),deps)
  const temporary=deps.calls.find(call=>call[0]==='native')[1]
  assert.deepEqual(result.data.sourceAssetIds,['working'])
  assert.deepEqual(temporary.assets.filter(asset=>!asset.id.startsWith('generated-')).map(asset=>asset.id),['working'])
  assert.equal(temporary.assets.find(asset=>asset.id==='working').compression,undefined)
  assert.deepEqual(project,before)
  await result.discard();assert.deepEqual(deps.nativeEvents,['discard'])
})

test('unknown options, old placement, invalid target, revision drift and project switch fail before drawing',async()=>{
  const project=fixture(),before=structuredClone(project),deps=dependencies()
  for(const patch of [{styleId:'missing'},{scenes:[{assetId:'missing'}]},{placement:'append'},{destination:'replace'},{insert:{start:0}},{dryRun:'yes'},{unknown:true},{expectedRevision:2},{expectedProjectId:'different'}])await assert.rejects(prepareMotionStyleTool(tool,{...options(),...patch},context(project),deps))
  await assert.rejects(prepareMotionStyleTool(tool,options(),{...context(project),assertCurrent(){throw Error('project changed')}},deps),/project changed/)
  await assert.rejects(prepareMotionStyleTool('open_media_motion_compose',options(),context(project),deps),/未知/)
  assert.deepEqual(project,before);assert.deepEqual(deps.calls,[])
})

test('cancellation before drawing, during drawing and during partial art import cleans all owned URLs',async()=>{
  const project=fixture(),controller=new AbortController(),deps=dependencies()
  controller.abort();await assert.rejects(prepareMotionStyleTool(tool,options(),context(project,controller),deps),{name:'AbortError'})
  assert.deepEqual(deps.calls,[])
  const duringArt=new AbortController(),artDeps=dependencies({async renderArt(){duringArt.abort();return {background:png(),decoration:png()}}})
  await assert.rejects(prepareMotionStyleTool(tool,options(),context(project,duringArt),artDeps),{name:'AbortError'})
  assert.deepEqual(artDeps.revoked,[])
  const duringImport=new AbortController(),importDeps=dependencies(),importer=importDeps.importBrowser
  importDeps.importBrowser=async file=>{const asset=await importer(file);duringImport.abort();return asset}
  await assert.rejects(prepareMotionStyleTool(tool,options(),context(project,duringImport),importDeps),{name:'AbortError'})
  assert.deepEqual(importDeps.revoked,['generated-1'])
})

test('cancelled native render completion and current-project drift discard final file and temporary art without mutation',async()=>{
  for(const reason of ['cancel','project','revision']){
    const project=fixture(),before=structuredClone(project),controller=new AbortController(),deps=dependencies({isDesktop:()=>true}),renderer=deps.renderNative
    let changed=false
    deps.renderNative=async(...args)=>{const output=await renderer(...args);if(reason==='cancel')controller.abort();else changed=true;return output}
    const ctx={...context(project,controller),assertCurrent(){if(changed)throw Error(`${reason} changed`)}}
    await assert.rejects(prepareMotionStyleTool(tool,options(),ctx,deps))
    assert.deepEqual(deps.nativeEvents,['discard']);assert.deepEqual(deps.revoked,['generated-1','generated-2']);assert.deepEqual(project,before)
  }
})

test('browser encode cancellation never imports its video; late video decode cancellation reclaims all three URLs',async()=>{
  const project=fixture(),controller=new AbortController(),deps=dependencies(),renderer=deps.renderBrowser
  deps.renderBrowser=async(...args)=>{const result=await renderer(...args);controller.abort();return result}
  await assert.rejects(prepareMotionStyleTool(tool,options(),context(project,controller),deps),{name:'AbortError'})
  assert.equal(deps.calls.filter(call=>call[0]==='import').length,2);assert.deepEqual(deps.revoked,['generated-1','generated-2'])
  const late=new AbortController(),lateDeps=dependencies(),importer=lateDeps.importBrowser
  lateDeps.importBrowser=async file=>{const asset=await importer(file);if(file.type.startsWith('video/'))late.abort();return asset}
  await assert.rejects(prepareMotionStyleTool(tool,options(),context(project,late),lateDeps),{name:'AbortError'})
  assert.deepEqual(lateDeps.revoked,['generated-1','generated-2','generated-3'])
})

test('encoder, decoding and malformed/truncated final output failures reclaim resources',async()=>{
  const project=fixture(),before=structuredClone(project)
  const encode=dependencies({async renderBrowser(){throw Error('encode failed')}})
  await assert.rejects(prepareMotionStyleTool(tool,options(),context(project),encode),/encode failed/)
  assert.deepEqual(encode.revoked,['generated-1','generated-2'])
  for(const patch of [{duration:1},{duration:Infinity},{kind:'image'},{width:640},{url:''},{size:0},{id:'photo'}]){
    const deps=dependencies({isDesktop:()=>true}),render=deps.renderNative
    deps.renderNative=async(...args)=>{const output=await render(...args);return {...output,asset:{...output.asset,...patch}}}
    await assert.rejects(prepareMotionStyleTool(tool,options(),context(project),deps))
    assert.deepEqual(deps.nativeEvents,['discard']);assert.deepEqual(deps.revoked,['generated-1','generated-2'])
  }
  assert.deepEqual(project,before)
})

test('host rejection releases final output once while accepted outputs remain owned by the host',async()=>{
  for(const desktop of [false,true]){
    const project=fixture(),deps=dependencies({isDesktop:()=>desktop}),result=await prepareMotionStyleTool(tool,options(),context(project),deps)
    await result.discard();await result.discard();await result.accept()
    assert.deepEqual(deps.nativeEvents,desktop?['discard']:[])
    assert.deepEqual(deps.revoked,desktop?['generated-1','generated-2']:['generated-1','generated-2','generated-3'])
  }
})

test('shared MCP runner exposes the capability and validates arguments before rendering',async()=>{
  const project=fixture()
  assert.equal(isSharedEditorTool(tool),true);assert.equal(isSharedEditorTool('open_media_motion_compose'),false)
  const result=await prepareEditorTool(tool,{...options(),dryRun:true,expectedRevision:3},context(project))
  assert.equal(result.data.dryRun,true);assert.equal(result.data.destination,'assets');assert.equal(result.project,undefined)
  await assert.rejects(prepareEditorTool(tool,{...options(),dryRun:true,expectedRevision:2},context(project)),/revision/)
  await assert.rejects(prepareEditorTool(tool,{...options(),dryRun:true,placement:'append'},context(project)))
})

test('effect generation and dry run require an enabled ready current-project MCP configuration',async()=>{
  for(const config of [undefined,{enabled:false,assetIds:['photo'],styleId:'flat-pop'},{enabled:true,assetIds:[],styleId:'flat-pop'},{enabled:true,assetIds:['photo']},{enabled:true,assetIds:['missing'],styleId:'flat-pop'}]){
    const project=fixture(),deps=dependencies()
    if(config===undefined)delete project.mcpMotion
    else project.mcpMotion=config
    for(const dryRun of [false,true])await assert.rejects(prepareMotionStyleTool(tool,{...options(),dryRun},context(project),deps))
    assert.throws(()=>planMotionClipGeneration(project,options()))
    assert.deepEqual(deps.calls,[])
  }
})

test('configured style is authoritative and omitted style uses it; scene and logo sources must be selected',async()=>{
  const project=fixture(),deps=dependencies(),{styleId:_style,...withoutStyle}=options()
  const plan=planMotionClipGeneration(project,withoutStyle)
  assert.equal(plan.styleId,'flat-pop')
  const prepared=await prepareMotionStyleTool(tool,{...withoutStyle,dryRun:true},context(project),deps)
  assert.equal(prepared.data.styleId,'flat-pop')
  for(const patch of [{styleId:'paper-ink'},{scenes:[{assetId:'unused',duration:4}]},{logoAssetId:'unused'},{scenes:undefined},{scenes:[]}]){
    await assert.rejects(prepareMotionStyleTool(tool,{...options(),...patch,dryRun:true},context(project),deps))
  }
  const selectedLogo=await prepareMotionStyleTool(tool,{...withoutStyle,logoAssetId:'photo',dryRun:true},context(project),deps)
  assert.deepEqual(selectedLogo.data.sourceAssetIds,['photo'])
  assert.deepEqual(deps.calls,[])
})

test('GUI callers cannot bypass MCP-only generation even with valid configuration or dry run',async()=>{
  const project=fixture(),deps=dependencies()
  for(const dryRun of [false,true])await assert.rejects(prepareMotionStyleTool(tool,{...options(),dryRun},{...context(project),source:'gui'},deps),/仅供 MCP/)
  await assert.rejects(prepareEditorTool(tool,{...options(),dryRun:true},{...context(project),source:'gui'}),/MCP/)
  assert.deepEqual(deps.calls,[])
})

test('current-project background audio remains available without authorizing unrelated visual materials',async()=>{
  const project=fixture(),deps=dependencies()
  project.assets.push(image('music',{kind:'audio',mime:'audio/wav',width:0,height:0,duration:2}))
  const prepared=await prepareMotionStyleTool(tool,{...options(),musicAssetId:'music',dryRun:true},context(project),deps)
  assert.deepEqual(prepared.data.sourceAssetIds,['photo','music'])
  await assert.rejects(prepareMotionStyleTool(tool,{...options(),musicAssetId:'unused',dryRun:true},context(project),deps))
  assert.deepEqual(deps.calls,[])
})


test('外部代码风格在预检查和生成前明确拒绝二维预设路径，不加载或写入媒体', async () => {
  const codeStyles = MOTION_STYLES.filter(style => !style.presetSupported)
  assert(codeStyles.length > 0)
  for (const style of codeStyles) {
    const project = fixture(), deps = dependencies()
    project.mcpMotion.styleId = style.id
    const before = structuredClone(project)
    for (const dryRun of [true, false]) {
      const input = { ...options(), styleId: style.id, dryRun }
      await assert.rejects(prepareMotionStyleTool(tool, input, context(project), deps), /外部 Agent.*不支持内置二维预设/)
      await assert.rejects(prepareMotionStyleTool(tool, { ...input, styleId: undefined }, context(project), deps), /外部 Agent.*不支持内置二维预设/)
    }
    assert.throws(() => planMotionClipGeneration(project, { ...options(), styleId: style.id }), /外部 Agent/)
    assert.deepEqual(deps.calls, [])
    assert.deepEqual(deps.revoked, [])
    assert.deepEqual(deps.nativeEvents, [])
    assert.deepEqual(project, before)
  }
})
