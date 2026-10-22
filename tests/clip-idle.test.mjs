import test from 'node:test'
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { createClip, createProject, createTextClip, validateProject, cloneProject, MAX_CLIPS } from '../src/core/project.ts'
import { clipEnd, clipDuration, splitClip, sourceTimeAt, createHistory, commitHistory, undoHistory } from '../src/core/timeline.ts'
import { addTransition } from '../src/core/transitions.ts'
import { animatedClipAt } from '../src/core/visual-animation.ts'
import { classifyVideoClip, splitIdleVideoClip, prepareIdleSplit } from '../src/core/clip-idle.ts'
import { executeProjectTool, validateMcpToolArguments, MCP_TOOLS } from '../src/core/mcp-tools.ts'
import { executeTimelineBatch } from '../src/core/project-operations.ts'

const nativeUrl = new URL('../src/native-asset-tools.ts', import.meta.url).href
registerHooks({load(url, context, next) {
  return url === nativeUrl ? {format:'module',shortCircuit:true,source:'export const runAssetTool = (...args) => globalThis.__idleNative(...args)'} : next(url,context)
}})
function fixture(options = {}) {
  const project = createProject('静止分割测试')
  const asset = { id:'source',name:'视频.mp4',kind:'video',url:'asset://localhost/media/video.mp4',nativePath:'/media/video.mp4',mime:'video/mp4',duration:60,width:1920,height:1080,size:1000 }
  project.assets.push(asset)
  const clip = createClip(asset,project,{id:'target',start:10,trimIn:5,trimOut:25,...options})
  project.tracks.find(track => track.kind === 'video').clips.push(clip)
  project.tracks.find(track => track.kind === 'text').clips.push(createTextClip(project,{id:'subtitle',text:'内容保持完整',start:12,trimOut:4}))
  project.tracks.find(track => track.kind === 'audio').clips.push(createClip(asset,project,{id:'sound',start:10,trimIn:5,trimOut:25}))
  return {project,clip,asset,track:project.tracks.find(track => track.kind === 'video')}
}
const detected = (...ranges) => ({intervals:ranges.map(([start,end])=>({kind:'freeze',start,end,confidence:.9}))})
const pieces = result => result.project.tracks.find(t=>t.kind==='video').clips
const context = project => ({project,revision:2,source:'mcp',blobs:new Map(),signal:new AbortController().signal,onProgress:()=>{}})

test('static source spans split atomically and preserve source coverage, timing and all other tracks',()=>{
  const {project}=fixture({speed:2}), before=structuredClone(project)
  const result=splitIdleVideoClip(project,{clipId:'target',minDuration:2},detected([7,13],[17,23]))
  assert.deepEqual(project,before)
  assert.equal(result.data.splitCount,4);assert.equal(result.data.repeatCount,2);assert.equal(result.data.repeatDuration,6)
  assert.deepEqual(pieces(result).map(c=>[c.start,c.trimIn,c.trimOut,c.classification]),[[10,5,7,undefined],[11,7,13,'repeat'],[14,13,17,undefined],[16,17,23,'repeat'],[19,23,25,undefined]])
  assert.deepEqual(result.project.tracks.find(track => track.kind === 'text'),project.tracks.find(track => track.kind === 'text'));assert.deepEqual(result.project.tracks.find(track => track.kind === 'audio'),project.tracks.find(track => track.kind === 'audio'))
  assert.equal(clipEnd(pieces(result).at(-1)),clipEnd(project.tracks.find(track => track.kind === 'video').clips[0]))
  const history=commitHistory(createHistory(project),result.project);assert.deepEqual(undoHistory(history).present,project)
})
test('only freeze detection qualifies; silence, black and distant repeated frames never split',()=>{
  const {project}=fixture(), before=structuredClone(project)
  const result=splitIdleVideoClip(project,{clipId:'target'}, {intervals:[{kind:'silence',start:5,end:25},{kind:'black',start:5,end:25}],repeatedIntervals:[{start:5,end:25}]})
  assert.equal(result.project,undefined);assert.equal(result.data.repeatCount,0);assert.equal(result.data.splitCount,0);assert.deepEqual(project,before)
})
test('minimum applies after trimming and speed changes, not to the untrimmed original interval',()=>{
  const {project}=fixture({speed:2})
  const result=splitIdleVideoClip(project,{clipId:'target',minDuration:3},detected([0,8],[9,14],[18,40]))
  assert.deepEqual(result.data.sourceIntervals,[{start:18,end:25,confidence:.9}]);assert.equal(result.data.repeatDuration,3.5)
})
test('overlapping and adjacent detections are merged; full and tail frozen ranges leave no tiny duplicate cuts',()=>{
  const {project}=fixture()
  const result=splitIdleVideoClip(project,{clipId:'target'},detected([5,9],[8,12],[12,25]))
  assert.equal(result.data.splitCount,0);assert.equal(result.data.repeatCount,1);assert.equal(pieces(result)[0].classification,'repeat')
  const again=splitIdleVideoClip(result.project,{clipId:'target'},detected([5,25]))
  assert.equal(pieces(again).length,1);assert.equal(again.data.splitCount,0)
  const tail=splitIdleVideoClip(project,{clipId:'target'},detected([20,60]))
  assert.equal(tail.data.splitCount,1);assert.equal(pieces(tail).at(-1).trimOut,25)
})
test('split keeps source-time and animation continuity for trimmed speed ramps and keyframes',()=>{
  const {project,clip}=fixture({animationOffset:2,keyframes:{x:[{time:0,value:0},{time:40,value:400,easing:'linear'}]},speedRamp:{points:[{position:0,speed:1},{position:1,speed:3}],easing:'linear',preservePitch:true}})
  const result=splitIdleVideoClip(project,{clipId:'target',minDuration:.5},detected([8,16],[19,24]))
  assert.equal(result.data.repeatCount,2)
  for(let time=clip.start;time<clipEnd(clip)-1e-5;time+=.13){
    const part=pieces(result).find(c=>time>=c.start&&time<clipEnd(c)+1e-8)
    assert.ok(part);assert.ok(Math.abs(sourceTimeAt(part,time)-sourceTimeAt(clip,time))<1e-6)
    assert.ok(Math.abs(animatedClipAt(part,time).x-animatedClipAt(clip,time).x)<1e-6)
  }
  assert.ok(Math.abs(clipEnd(pieces(result).at(-1))-clipEnd(clip))<1e-6)
})
test('outgoing transition rebinds to last split and incoming retains first ID without moving or resizing',()=>{
  const {project,asset}=fixture({start:5,trimIn:0,trimOut:20})
  project.tracks.find(track => track.kind === 'video').clips.unshift(createClip(asset,project,{id:'before',start:0,trimIn:0,trimOut:5}))
  project.tracks.find(track => track.kind === 'video').clips.push(createClip(asset,project,{id:'after',start:25,trimIn:20,trimOut:25}))
  const withTransitions=addTransition(addTransition(project,5,'fade',1),25,'zoom',1)
  const originalTransitions=withTransitions.tracks.find(t=>t.kind==='transition').clips
  const result=splitIdleVideoClip(withTransitions,{clipId:'target'},detected([5,10]))
  const video=pieces(result), effects=result.project.tracks.find(t=>t.kind==='transition').clips
  assert.equal(effects[0].transition.toClipId,'target');assert.equal(effects[1].transition.fromClipId,video.at(-2).id)
  effects.forEach((effect,index)=>{assert.equal(effect.start,originalTransitions[index].start);assert.equal(clipDuration(effect),clipDuration(originalTransitions[index]))})
})
test('cuts that would shrink a transition or restart an existing fade reject without changing input',()=>{
  const {project,asset}=fixture({start:0,trimIn:0,trimOut:20})
  project.tracks.find(track => track.kind === 'video').clips.push(createClip(asset,project,{id:'after',start:20,trimOut:5}))
  const withTransition=addTransition(project,20,'fade',1), before=structuredClone(withTransition)
  assert.throws(()=>splitIdleVideoClip(withTransition,{clipId:'target'},detected([10,19.8])),/缩短已有转场/)
  assert.deepEqual(withTransition,before)
  const fading=fixture({fadeIn:5});assert.throws(()=>splitIdleVideoClip(fading.project,{clipId:'target'},detected([7,15])),/淡入淡出/)
})
test('classification is saved, old documents remain ordinary, splits and copies keep repeat without changing playback data',()=>{
  const {project,clip}=fixture(), old=validateProject(JSON.parse(JSON.stringify(project)),{trusted:true})
  assert.equal(old.tracks.find(track => track.kind === 'video').clips[0].classification,undefined)
  const result=classifyVideoClip(project,'target','repeat')
  const reopened=validateProject(JSON.parse(JSON.stringify(result.project)),{trusted:true})
  const tagged=reopened.tracks.find(track => track.kind === 'video').clips[0],{classification,...other}=tagged
  assert.equal(classification,'repeat');assert.deepEqual(other,clip)
  const split=splitClip(reopened,'target',15);assert.ok(split.tracks.find(track => track.kind === 'video').clips.every(c=>c.classification==='repeat'))
  const copied=executeProjectTool(reopened,'open_media_clip_duplicate',{clipId:'target'}).project
  assert.ok(copied.tracks.find(track => track.kind === 'video').clips.every(c=>c.classification==='repeat'))
  const cleared=classifyVideoClip(reopened,'target','normal');assert.equal(cleared.project.tracks.find(track => track.kind === 'video').clips[0].classification,undefined)
  const invalid=cloneProject(project);invalid.tracks.find(track => track.kind === 'video').clips[0].classification='arbitrary';assert.throws(()=>validateProject(invalid,{trusted:true}),/片段类型/)
})
test('locks, unsupported sources, invalid detector ranges and capacity reject without partial editing',()=>{
  const {project}=fixture();project.tracks.find(track => track.kind === 'video').locked=true
  assert.throws(()=>splitIdleVideoClip(project,{clipId:'target'},detected([8,15])),/解锁/)
  assert.throws(()=>classifyVideoClip(project,'target','repeat'),/解锁/)
  project.tracks.find(track => track.kind === 'video').locked=false
  assert.throws(()=>splitIdleVideoClip(project,{clipId:'subtitle'},detected([8,15])),/视频/)
  assert.throws(()=>splitIdleVideoClip(project,{clipId:'target'},detected([8,7])),/无效/)
  assert.throws(()=>splitIdleVideoClip(project,{clipId:'target'},{}),/未返回有效/)
  const template=project.tracks.find(track => track.kind === 'text').clips[0]
  project.tracks.find(track => track.kind === 'text').clips=Array.from({length:MAX_CLIPS-2},(_,i)=>({...template,id:`text-${i}`}))
  const before=structuredClone(project)
  assert.throws(()=>splitIdleVideoClip(project,{clipId:'target'},detected([8,15])),/上限/)
  assert.deepEqual(project,before)
})
test('classification supports atomic MCP batch and the published schemas match async behavior',()=>{
  const {project}=fixture()
  const batch=executeTimelineBatch(project,{operations:[{tool:'open_media_clip_classify',arguments:{clipId:'target',classification:'repeat'}}]}, {revision:1,execute:executeProjectTool})
  assert.equal(batch.project.tracks.find(track => track.kind === 'video').clips[0].classification,'repeat')
  const schema=MCP_TOOLS.find(t=>t.name==='open_media_clip_split_idle')
  assert.equal(schema._meta['openmedia/execution'].mode,'asynchronous')
  assert.equal(schema._meta['openmedia/execution'].cancelTool,'open_media_job_cancel')
  assert.throws(()=>validateMcpToolArguments(schema.name,{clipId:'target',minDuration:0}),/范围/)
  assert.throws(()=>validateMcpToolArguments(schema.name,{clipId:'target',freezeNoiseDb:5}),/范围/)
  assert.throws(()=>validateMcpToolArguments('open_media_clip_classify',{clipId:'target',classification:'unknown'}),/选项/)
})
test('shared preparation only requests selected source range with freeze-only detection and never mutates live state',async()=>{
  const {project}=fixture({speed:.5}), before=structuredClone(project), calls=[]
  globalThis.__idleNative=async(operation,args,control)=>{calls.push({operation,args});assert.ok(control.signal);return detected([8,14])}
  const result=await prepareIdleSplit({clipId:'target',minDuration:3,freezeNoiseDb:-40},context(project))
  assert.equal(calls.length,1);assert.equal(calls[0].operation,'asset_detect_idle')
  assert.deepEqual({...calls[0].args,asset:undefined},{asset:undefined,start:5,end:25,freezeOnly:true,minDuration:1.5,freezeNoiseDb:-40})
  assert.equal(result.data.repeatCount,1);assert.equal(result.data.repeatDuration,12);assert.deepEqual(project,before)
})
test('cancelled or stale analysis rejects before a project is prepared',async()=>{
  const {project}=fixture(),before=structuredClone(project), controller=new AbortController()
  globalThis.__idleNative=async()=>{controller.abort();return detected([8,14])}
  await assert.rejects(prepareIdleSplit({clipId:'target'},{...context(project),signal:controller.signal}),{name:'AbortError'})
  globalThis.__idleNative=async()=>detected([8,14])
  await assert.rejects(prepareIdleSplit({clipId:'target'},{...context(project),assertCurrent(){throw Error('版本变化')}}),/版本变化/)
  assert.deepEqual(project,before)
})
