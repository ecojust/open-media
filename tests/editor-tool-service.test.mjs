import test from 'node:test'
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { IDBFactory } from 'fake-indexeddb'
import { createClip, createProject, createSubtitleClip, cloneProject } from '../src/core/project.ts'
import { updateSpeechSettings } from '../src/core/speech-settings.ts'
import { getSpeechPronunciation, setSpeechPronunciation } from '../src/core/speech-pronunciation.ts'

// Keep the shared service, schemas, project operations and artifact cache real.
// Replace only IPC endpoints, so commit/cancel/accept behavior runs end to end.
const boundaries = {
 '../src/native-ai.ts':['getAiStatus','downloadAiModel','repairAiModel','beginAiGeneration','getAiJob','cancelAiJob','cancelAiModelDownload'],
 '../src/native.ts':['acceptSpeechJobs','beginSpeechJob','beginSpeechModelDownload','cancelMediaJob','cancelSpeechJob','cancelSpeechModelDownload','discardSpeechJob','getMediaJobs','getSpeechJob','getSpeechStatus','repairSpeechModel','revealMediaJobOutput','importBlobAsset'],
 '../src/native-asset-tools.ts':['runAssetTool'],
 '../src/native-audio-tools.ts':['beginAudioTool','getAudioTool','cancelAudioTool','acceptAudioTool','discardAudioTool'],
 '../src/native-project-compression.ts':['beginProjectVideoCompression','getProjectVideoCompressionJob','cancelProjectVideoCompression','acceptProjectVideoCompression','discardProjectVideoCompression','prepareProjectCompressionAsset','prepareProjectVideoOriginal'],
 '../src/native-transcription.ts':['getAsrStatus','beginAsrDownload','beginAsrTranscription','getAsrJob','cancelAsrJob'],
 '../src/native-mcp-files.ts':['beginMcpMediaJob','importMcpMediaPaths','openMcpProjectFile','saveMcpProjectFile'],
 '../src/native-video-generation.ts':['getVideoGenerationStatus','beginVideoModelDownload','cancelVideoModelDownload','beginVideoGeneration','getVideoGenerationJob','cancelVideoGeneration'],
 '../src/core/native-project.ts':['prepareNativeProject'],
 '../src/native-project-files.ts':['prepareNativeProjectArchive','restoreNativeProjectArchive'],
}
const modules = new Map(Object.entries(boundaries).map(([file,names])=>[new URL(file,import.meta.url).href,names]))
registerHooks({load(url,context,next){const names=modules.get(url);return names?{format:'module',shortCircuit:true,source:names.map(name=>`export const ${name} = (...args) => globalThis.__editorToolsIo.${name}(...args)`).join('\n')}:next(url,context)}})
const { prepareEditorTool } = await import('../src/core/editor-tool-service.ts')
const { createMcpAutomation } = await import('../src/core/mcp-automation.ts')
const { readToolArtifact } = await import('../src/core/tool-artifacts.ts')
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no});return{promise,resolve,reject}}
async function until(check){
 // Real hashing and artifact storage may finish after many event-loop turns under parallel test load.
 const deadline=performance.now()+5000
 while(!check()){if(performance.now()>=deadline)throw Error('timed out after 5 seconds');await new Promise(resolve=>setTimeout(resolve,5))}
}
async function finished(controller,job){await until(()=>controller.status(job.id).state!=='running');await new Promise(resolve=>setImmediate(resolve));return controller.status(job.id)}
function fixture(){
 updateSpeechSettings({ voiceId: 'voice', rate: 1, alignText: true })
 globalThis.indexedDB=new IDBFactory()
 const bytes=new Uint8Array([82,73,70,70,1,2,3,4]),blob=new Blob([bytes],{type:'audio/wav'}),url=URL.createObjectURL(blob)
 const asset={id:'audio',name:'真实读取的音频.wav',kind:'audio',url,nativePath:'/private/media/audio.wav',duration:2,width:0,height:0,size:8,mime:'audio/wav'}
 const project=createProject('共享工具测试');project.assets.push(asset);project.tracks.find(track => track.kind === 'audio').clips.push(createClip(asset,project,{id:'audio-clip'}));project.tracks.find(track => track.kind === 'text').clips.push(createSubtitleClip(project,{id:'caption',text:'测试字幕'}))
 const calls=[],io={}
 for(const names of Object.values(boundaries))for(const name of names)io[name]=async()=>{}
 io.getSpeechStatus=async()=>({ready:true,voices:[{id:'voice',name:'本地音色',language:'zh',status:'ready'}]})
 io.beginSpeechJob=async request=>({id:request.requestId,state:'completed',stage:'完成',asset:{...asset,id:'speech'}})
 io.beginAudioTool=async()=>({id:'audio-job',state:'completed',stage:'完成',progress:1,result:{asset:{...asset,id:'processed'}}})
 io.getAsrStatus=async()=>({ready:false,runtimeReady:true,models:[]})
 globalThis.__editorToolsIo=Object.fromEntries(Object.keys(io).map(name=>[name,(...args)=>{calls.push({name,args});return io[name](...args)}]))
 const context={project,revision:4,source:'mcp',blobs:new Map([[asset.id,blob]]),signal:new AbortController().signal,onProgress:()=>{}}
 return{project,asset,blob,bytes,url,io,calls,context,close(){URL.revokeObjectURL(url)}}
}
function controllerFixture(){const f=fixture();let project=f.project,revision=4,busy=false;const commits=[],owned=[],announcements=[];const host={getProject:()=>project,getRevision:()=>revision,isBusy:()=>busy,isDirty:()=>false,getBlobs:()=>f.context.blobs,getSaveTarget:()=>undefined,commit(next,label,expected){if(expected.revision!==revision||expected.projectId!==project.id)return false;project=next;revision++;commits.push(label);return true},async adopt(next){project=next;revision++},async hydrate(value){return value.project},async didSave(){},async didOpen(){},history(){},getPlayback:()=>({time:0,playing:false,selectedClipId:''}),async setPlayback(patch){return patch},ownAsset(asset){owned.push(asset)},onBusy(value){busy=value},onJobsChanged(){},announce(message){announcements.push(message)}};return{...f,host,commits,owned,announcements,controller:createMcpAutomation(host),get current(){return project},get revision(){return revision},externalChange(){revision++;project=cloneProject(project);project.title='本地新修改'}}}

test('shared schemas reject unknown fields and stale revision before native work',async()=>{const f=fixture();try{await assert.rejects(prepareEditorTool('open_media_audio_normalize',{clipId:'audio-clip',unexpected:true},f.context),/不支持/);await assert.rejects(prepareEditorTool('open_media_audio_normalize',{clipId:'audio-clip',expectedRevision:3},f.context),/版本/);assert.equal(f.calls.length,0)}finally{f.close()}})

test('source reads are synchronous bounded current-project operations with explicit resume versions', async () => {
  const f = controllerFixture()
  const version = 'a'.repeat(64)
  try {
    f.io.runAssetTool = async (operation, args) => {
      assert.equal(operation, 'asset_read')
      assert.equal(args.asset.id, f.asset.id)
      assert.equal(args.asset.nativePath, f.asset.nativePath)
      const offset = args.offset ?? 0, end = Math.min(f.bytes.length, offset + (args.length ?? 262144))
      return { assetId: f.asset.id, totalBytes: f.bytes.length, offset, nextOffset: end, done: end === f.bytes.length, sourceVersion: version, data: Buffer.from(f.bytes.slice(offset, end)).toString('base64') }
    }
    const first = await f.controller.execute('open_media_asset_read', { assetId: f.asset.id, length: 3, expectedProjectId: f.project.id, expectedRevision: 4 })
    assert.equal(first.execution, 'synchronous'); assert.equal(first.final, true); assert.equal(first.sourceVersion, version)
    assert.equal(first.responseType, 'result'); assert.equal(first.projectId, f.project.id); assert.equal(first.revision, 4)
    assert.equal(first.jobId, undefined); assert.equal(f.controller.list().length, 0)
    const second = await f.controller.execute('open_media_asset_read', { assetId: f.asset.id, offset: first.nextOffset, sourceVersion: first.sourceVersion, expectedRevision: 4 })
    assert.deepEqual(Buffer.concat([Buffer.from(first.data, 'base64'), Buffer.from(second.data, 'base64')]), Buffer.from(f.bytes))
    assert.equal(second.done, true)
    assert.equal(f.controller.list().length, 0); assert.equal(f.commits.length, 0)
    assert.equal(JSON.stringify([first, second]).includes('/private'), false)
    const calls = f.calls.length
    for (const args of [{ assetId: 'other-project-source' }, { assetId: f.asset.id, offset: 1 }, { assetId: f.asset.id, length: 262145 }, { assetId: f.asset.id, nativePath: '/private/secret' }, { assetId: f.asset.id, expectedProjectId: 'closed-project' }, { assetId: f.asset.id, expectedRevision: 3 }]) {
      await assert.rejects(f.controller.execute('open_media_asset_read', args))
    }
    assert.equal(f.calls.length, calls)
  } finally { await f.controller.dispose(); f.close() }
})

test('source block completion is discarded if project identity, revision or session changes while reading', async () => {
  for (const change of ['project', 'revision', 'session']) {
    const f = controllerFixture(), gate = deferred()
    let session = 1
    f.host.getProjectSession = () => session
    try {
      f.io.runAssetTool = () => gate.promise
      const reading = f.controller.execute('open_media_asset_read', { assetId: f.asset.id })
      await until(() => f.calls.some(call => call.name === 'runAssetTool'))
      if (change === 'project') f.host.getProject = () => ({ ...f.project, id: 'other-open-project' })
      else if (change === 'revision') f.externalChange()
      else session++
      gate.resolve({ data: 'cHJpdmF0ZQ==' })
      await assert.rejects(reading, /工程或版本已变化/)
      assert.equal(f.commits.length, 0)
    } finally { gate.resolve({}); await f.controller.dispose(); f.close() }
  }
})
test('MCP speech preview returns readable hashed artifact without exposing local asset paths',async()=>{const f=fixture();try{const result=await prepareEditorTool('open_media_speech_generate_preview',{text:'介绍 Open Media'},f.context);assert.ok(result.data.artifactId);assert.match(result.data.sha256,/^[a-f\d]{64}$/);assert.equal(result.data.asset.url,undefined);assert.equal(result.data.asset.nativePath,undefined);assert.equal(result.project,undefined);assert.equal(f.project.assets.length,1);const bytes=await readToolArtifact(result.data.artifactId);assert.deepEqual(Buffer.from(bytes.data,'base64'),Buffer.from(f.bytes));assert.equal(f.calls.filter(c=>c.name==='acceptSpeechJobs').length,0);await result.accept();assert.equal(f.calls.filter(c=>c.name==='acceptSpeechJobs').length,0);assert.equal(f.calls.filter(c=>c.name==='discardSpeechJob').length,1)}finally{f.close()}})
test('GUI preview uses persisted playable artifact without retaining the temporary native WAV',async()=>{const f=fixture();try{const result=await prepareEditorTool('open_media_speech_generate_preview',{text:'试听'}, {...f.context,source:'gui'});assert.equal(result.data.asset.url,undefined);assert.equal(result.data.asset.nativePath,undefined);assert.ok(result.data.artifactId);const read=await readToolArtifact(result.data.artifactId);assert.deepEqual(Buffer.from(read.data,'base64'),Buffer.from(f.bytes));await result.accept();await new Promise(resolve=>setImmediate(resolve));assert.equal(f.calls.filter(c=>c.name==='discardSpeechJob').length,1)}finally{f.close()}})
test('unreadable audition output is discarded before return or acceptance',async()=>{const f=fixture();try{f.io.beginSpeechJob=async request=>({id:request.requestId,state:'completed',stage:'完成',asset:{...f.asset,id:'bad',url:'blob:missing'}});await assert.rejects(prepareEditorTool('open_media_speech_generate_preview',{text:'试听'},f.context));assert.equal(f.calls.filter(c=>c.name==='discardSpeechJob').length,1);assert.equal(f.calls.filter(c=>c.name==='acceptSpeechJobs').length,0)}finally{f.close()}})
test('ASR missing conditional fields rejects before starting native download or transcription',async()=>{const f=fixture();try{await assert.rejects(prepareEditorTool('open_media_audio_transcribe',{action:'transcribe'},f.context),/有效音频/);await assert.rejects(prepareEditorTool('open_media_audio_transcribe',{action:'cancel'},f.context),/jobId/);assert.equal(f.calls.filter(c=>['beginAsrTranscription','beginAsrDownload','cancelAsrJob'].includes(c.name)).length,0)}finally{f.close()}})
test('dictionary preparation is transactional until accepted',async()=>{const f=fixture();setSpeechPronunciation([]);try{const result=await prepareEditorTool('open_media_speech_pronunciation_set',{entries:[{text:'AI',pronunciation:'人工智能'}]},f.context);assert.deepEqual(getSpeechPronunciation(),[]);await result.accept();assert.equal(getSpeechPronunciation()[0].pronunciation,'人工智能');assert.equal(f.project.tracks.find(track => track.kind === 'text').clips[0].text,'测试字幕')}finally{setSpeechPronunciation([]);f.close()}})
test('controller commits DSP once and acknowledges output after durable project update',async()=>{const f=controllerFixture();try{f.io.acceptAudioTool=async()=>{assert.equal(f.current.tracks.find(track => track.kind === 'audio').clips[0].assetId,'processed');assert.equal(f.commits.length,1)};const done=await finished(f.controller,await f.controller.execute('open_media_audio_normalize',{clipId:'audio-clip'}));assert.equal(done.state,'completed');assert.equal(f.revision,5);assert.equal(f.owned.length,1);assert.equal(f.calls.filter(c=>c.name==='discardAudioTool').length,0);assert.equal(done.result.asset.nativePath,undefined)}finally{await f.controller.dispose();f.close()}})
test('revision changes during processing discard prepared audio and preserve the newer project',async()=>{const f=controllerFixture(),gate=deferred();try{f.io.beginAudioTool=()=>gate.promise;const job=await f.controller.execute('open_media_audio_normalize',{clipId:'audio-clip'});await until(()=>f.calls.some(c=>c.name==='beginAudioTool'));f.externalChange();gate.resolve({id:'late',state:'completed',stage:'完成',progress:1,result:{asset:{...f.asset,id:'late'}}});const done=await finished(f.controller,job);assert.equal(done.state,'failed');assert.equal(f.commits.length,0);assert.equal(f.current.title,'本地新修改');assert.ok(f.calls.some(c=>c.name==='discardAudioTool'&&c.args[0]==='late'))}finally{await f.controller.dispose();f.close()}})
test('cancel arriving while native start is unresolved cleans late output and never commits',async()=>{const f=controllerFixture(),gate=deferred();try{f.io.beginAudioTool=()=>gate.promise;const job=await f.controller.execute('open_media_audio_normalize',{clipId:'audio-clip'});await until(()=>f.calls.some(c=>c.name==='beginAudioTool'));await f.controller.cancel(job.id);gate.resolve({id:'late',state:'completed',stage:'完成',progress:1,result:{asset:{...f.asset,id:'late'}}});const done=await finished(f.controller,job);assert.equal(done.state,'cancelled');assert.equal(f.commits.length,0);assert.ok(f.calls.some(c=>c.name==='discardAudioTool'));assert.equal(f.calls.filter(c=>c.name==='acceptAudioTool').length,0)}finally{await f.controller.dispose();f.close()}})
test('acknowledgment failure after commit must not discard media referenced by the project',async()=>{const f=controllerFixture();try{f.io.acceptAudioTool=async()=>{throw Error('ack unavailable')};const done=await finished(f.controller,await f.controller.execute('open_media_audio_normalize',{clipId:'audio-clip'}));assert.equal(done.state,'failed');assert.equal(f.commits.length,1);assert.equal(f.current.tracks.find(track => track.kind === 'audio').clips[0].assetId,'processed');assert.equal(f.calls.filter(c=>c.name==='discardAudioTool').length,0)}finally{await f.controller.dispose();f.close()}})
test('artifact acceptance is noncancelable while deleting its copied temporary audition',async()=>{const f=controllerFixture(),accept=deferred();try{f.io.discardSpeechJob=()=>accept.promise;const job=await f.controller.execute('open_media_speech_generate_preview',{text:'测试试听'});await until(()=>f.calls.some(c=>c.name==='discardSpeechJob'));assert.equal(f.controller.status(job.id).cancelable,false);await assert.rejects(f.controller.cancel(job.id),/无法取消/);accept.resolve();const done=await finished(f.controller,job);assert.equal(done.state,'completed');assert.equal(f.calls.filter(c=>c.name==='discardSpeechJob').length,1)}finally{accept.resolve();await f.controller.dispose();f.close()}})
test('post-commit asset registration failure still acknowledges media and never discards it',async()=>{const f=controllerFixture();try{f.host.ownAsset=()=>{throw Error('registration unavailable')};const done=await finished(f.controller,await f.controller.execute('open_media_audio_normalize',{clipId:'audio-clip'}));assert.equal(done.state,'failed');assert.equal(f.commits.length,1);assert.equal(f.calls.filter(c=>c.name==='acceptAudioTool').length,1);assert.equal(f.calls.filter(c=>c.name==='discardAudioTool').length,0)}finally{await f.controller.dispose();f.close()}})
test('ASR status rejects transcription-only fields instead of silently ignoring requested subtitle creation',async()=>{const f=fixture();try{await assert.rejects(prepareEditorTool('open_media_audio_transcribe',{action:'status',createSubtitles:true},f.context),/不适用/);assert.equal(f.calls.filter(c=>c.name==='getAsrStatus').length,0)}finally{f.close()}})

function compressionFixture() {
 const f=controllerFixture(), source={...f.asset,id:'video-original',name:'录屏.mp4',kind:'video',width:640,height:360,duration:10,size:1000,nativePath:'/private/media/video.mp4',url:'asset://localhost/private/video.mp4',mime:'video/mp4'}
 f.project.assets.push(source)
 f.project.tracks.find(track => track.kind === 'video').clips.push(createClip(source,f.project,{id:'video-one',trimOut:4}),createClip(source,f.project,{id:'video-two',start:4,trimIn:4,trimOut:10}))
 f.project.tracks.find(track => track.kind === 'audio').clips.push(createClip(source,f.project,{id:'video-sound',trimOut:4}))
 const asset={...source,id:'video-compressed',size:400,nativePath:'/private/media/compressed.mp4',url:'asset://localhost/private/compressed.mp4'}
 const job={id:'compression-native',state:'completed',progress:1,stage:'完成',current:1,total:1,elapsedSeconds:1,items:[{sourceIds:[source.id],sourceSize:1000,outputSize:400,state:'completed',asset}]}
 f.io.beginProjectVideoCompression=async()=>job
 f.io.prepareProjectCompressionAsset=async value=>value
 f.io.prepareProjectVideoOriginal=async value=>value
 return{...f,source,compressed:asset,job}
}
test('MCP compression returns async work then commits every split and sound reference once before acceptance',async()=>{
 const f=compressionFixture();try{
  f.io.acceptProjectVideoCompression=async()=>{assert.equal(f.commits.length,1);assert.ok(f.host.getProject().tracks.find(track => track.kind === 'video').clips.every(clip=>clip.assetId==='video-compressed'))}
  const started=await f.controller.execute('open_media_project_video_compress',{mode:'quality',quality:'high',expectedRevision:4})
  assert.equal(started.final,false);assert.ok(started.jobId)
  const finishedJob=await finished(f.controller,started)
  assert.equal(finishedJob.state,'completed');assert.equal(finishedJob.result.processedCount,1);assert.equal(finishedJob.result.savedBytes,600)
  assert.equal(f.host.getProject().tracks.find(track => track.kind === 'audio').clips.find(clip=>clip.id==='video-sound').assetId,'video-compressed')
  assert.equal(f.commits.length,1);assert.equal(f.owned.length,1)
  assert.ok(!JSON.stringify(finishedJob.result).includes('/private/'))
  const restored=await finished(f.controller,await f.controller.execute('open_media_project_video_restore',{}))
  assert.equal(restored.state,'completed');assert.equal(restored.result.restoredCount,1)
  assert.ok(f.host.getProject().tracks.find(track => track.kind === 'video').clips.every(clip=>clip.assetId==='video-original'))
  assert.equal(f.host.getProject().assets.length,3);assert.equal(f.commits.length,2)
 }finally{await f.controller.dispose();f.close()}
})
test('MCP compression revision race discards its output without replacing newer project state',async()=>{
 const f=compressionFixture(),gate=deferred();try{
  f.io.beginProjectVideoCompression=()=>gate.promise
  const started=await f.controller.execute('open_media_project_video_compress',{mode:'quality'})
  await until(()=>f.calls.some(call=>call.name==='beginProjectVideoCompression'))
  f.externalChange();gate.resolve(f.job)
  const done=await finished(f.controller,started)
  assert.equal(done.state,'failed');assert.equal(f.commits.length,0);assert.equal(f.host.getProject().title,'本地新修改')
  assert.ok(f.calls.some(call=>call.name==='discardProjectVideoCompression'))
  assert.equal(f.calls.some(call=>call.name==='acceptProjectVideoCompression'),false)
 }finally{gate.resolve(f.job);await f.controller.dispose();f.close()}
})
test('MCP compression canceled during start cleans late output and leaves all source references intact',async()=>{
 const f=compressionFixture(),gate=deferred();try{
  f.io.beginProjectVideoCompression=()=>gate.promise
  const started=await f.controller.execute('open_media_project_video_compress',{mode:'lossless'})
  await until(()=>f.calls.some(call=>call.name==='beginProjectVideoCompression'))
  await f.controller.cancel(started.id);gate.resolve(f.job)
  const done=await finished(f.controller,started)
  assert.equal(done.state,'cancelled');assert.equal(f.commits.length,0)
  assert.ok(f.host.getProject().tracks.find(track => track.kind === 'video').clips.every(clip=>clip.assetId==='video-original'))
  assert.ok(f.calls.some(call=>call.name==='cancelProjectVideoCompression'))
  assert.ok(f.calls.some(call=>call.name==='discardProjectVideoCompression'))
 }finally{gate.resolve(f.job);await f.controller.dispose();f.close()}
})

function idleFixture(){
 const f=controllerFixture(),asset={...f.asset,id:'static-video',kind:'video',name:'静止检测.mp4',duration:20,width:640,height:360,url:'asset://localhost/private/static.mp4',nativePath:'/private/static.mp4'}
 f.project.assets.push(asset);f.project.tracks.find(track => track.kind === 'video').clips.push(createClip(asset,f.project,{id:'static-clip',start:4,trimIn:2,trimOut:18}))
 f.io.runAssetTool=async()=>({intervals:[{kind:'freeze',start:6,end:12,confidence:.9}]})
 return f
}
test('MCP static split has one asynchronous job and one atomic commit; classification is immediately queryable',async()=>{
 const f=idleFixture();try{
  const started=await f.controller.execute('open_media_clip_split_idle',{clipId:'static-clip',minDuration:3,expectedRevision:4})
  assert.equal(started.final,false);assert.ok(started.jobId)
  const done=await finished(f.controller,started)
  assert.equal(done.state,'completed');assert.equal(done.result.repeatCount,1);assert.equal(done.result.splitCount,2)
  assert.equal(f.commits.length,1);assert.equal(f.current.tracks.find(track => track.kind === 'video').clips.length,3)
  const marked=f.current.tracks.find(track => track.kind === 'video').clips.find(clip=>clip.classification==='repeat')
  assert.ok(marked);assert.equal(marked.start,8)
  const cleared=await f.controller.execute('open_media_clip_classify',{clipId:marked.id,classification:'normal'})
  assert.equal(cleared.classification,'normal');assert.equal(f.current.tracks.find(track => track.kind === 'video').clips.find(clip=>clip.id===marked.id).classification,undefined)
  assert.equal(f.commits.length,2)
 }finally{await f.controller.dispose();f.close()}
})
test('MCP idle detection cancellation does not commit late detections',async()=>{
 const f=idleFixture(),gate=deferred();try{
  f.io.runAssetTool=()=>gate.promise
  const started=await f.controller.execute('open_media_clip_split_idle',{clipId:'static-clip'})
  await until(()=>f.calls.some(call=>call.name==='runAssetTool'))
  await f.controller.cancel(started.id);gate.resolve({intervals:[{kind:'freeze',start:6,end:12}]})
  const done=await finished(f.controller,started);assert.equal(done.state,'cancelled');assert.equal(f.commits.length,0);assert.equal(f.current.tracks.find(track => track.kind === 'video').clips.length,1)
 }finally{gate.resolve({intervals:[]});await f.controller.dispose();f.close()}
})
test('MCP idle detection revision conflict leaves the newer project intact',async()=>{
 const f=idleFixture(),gate=deferred();try{
  f.io.runAssetTool=()=>gate.promise
  const started=await f.controller.execute('open_media_clip_split_idle',{clipId:'static-clip'})
  await until(()=>f.calls.some(call=>call.name==='runAssetTool'))
  f.externalChange();gate.resolve({intervals:[{kind:'freeze',start:6,end:12}]})
  const done=await finished(f.controller,started);assert.equal(done.state,'failed');assert.equal(f.commits.length,0);assert.equal(f.current.title,'本地新修改');assert.equal(f.current.tracks.find(track => track.kind === 'video').clips.length,1)
 }finally{gate.resolve({intervals:[]});await f.controller.dispose();f.close()}
})
