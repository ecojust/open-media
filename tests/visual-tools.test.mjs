import test from 'node:test'
import assert from 'node:assert/strict'
import { createProject, createClip, validateProject } from '../src/core/project.ts'
import { clipDuration, sourceTimeAt, createHistory, commitHistory, undoHistory } from '../src/core/timeline.ts'
import { animatedClipAt, easeProgress, speedSegments } from '../src/core/visual-animation.ts'
import { executeVisualTool as run } from '../src/core/visual-tools.ts'
import { addTransition, transitionVisualAt } from '../src/core/transitions.ts'

function fixture() {
 const p = createProject('视觉工具', { width: 640, height: 360 })
 const a = { id:'video-source', kind:'video',name:'视频',url:'blob:video',duration:12,width:640,height:360,size:10,mime:'video/mp4' }
 p.assets.push(a)
 p.tracks.find(t=>t.kind==='video').clips.push(createClip(a,p,{id:'video-clip',trimOut:6}))
 return p
}
test('关键帧有界校验、缓动插值、完整存储和单步撤销',()=>{
 const p=fixture(), original=JSON.stringify(p)
 const next=run(p,'open_media_clip_keyframes_set',{clipId:'video-clip',keyframes:{x:[{time:0,value:0,easing:'ease-in'},{time:2,value:100}],scaleX:[{time:0,value:1},{time:2,value:2}],opacity:[{time:0,value:1},{time:2,value:0.2}]}}).project
 const c=next.tracks[1].clips[0], at=animatedClipAt(c,1)
 assert.equal(at.width,960);assert.equal(at.x,25-160);assert.equal(at.opacity,0.6)
 assert.deepEqual(validateProject(next,{trusted:true}).tracks[1].clips[0].keyframes,c.keyframes)
 assert.equal(JSON.stringify(p),original)
 const history=commitHistory(createHistory(p),next);assert.deepEqual(undoHistory(history).present,p)
 assert.throws(()=>run(p,'clip_keyframes_set',{clipId:'video-clip',keyframes:{opacity:[{time:7,value:1}]}}),/时间/)
 assert.throws(()=>run(p,'clip_keyframes_set',{clipId:'video-clip',keyframes:{x:[{time:1,value:1},{time:1,value:2}]}}),/递增/)
})
test('源裁剪和聚焦生成实际可评估变换，失败不污染项目',()=>{
 const p=fixture(), cropped=run(p,'clip_crop',{clipId:'video-clip',crop:{x:0.25,y:0.1,width:0.5,height:0.8}}).project
 assert.equal(cropped.tracks[1].clips[0].crop.width,0.5)
 assert.throws(()=>run(p,'clip_crop',{clipId:'video-clip',crop:{x:0.9,y:0,width:0.2,height:1}}),/源画面/)
 const c=run(p,'focus_region',{clipId:'video-clip',region:{x:0.25,y:0.25,width:0.5,height:0.5},duration:1}).project.tracks[1].clips[0]
 assert.equal(animatedClipAt(c,1).width,1280);assert.equal(animatedClipAt(c,1).x,-320)
 assert.equal(p.tracks[1].clips[0].keyframes,undefined)
})
test('六类视觉标注保存为可编辑片段且排除字幕检测',()=>{
 let p=fixture()
 for (const kind of ['arrow','rectangle','highlight','mask','spotlight','blur']) {
  const r=run(p,'overlay_add',{kind,start:1,duration:2,x:20,y:30,width:100,height:60});p=r.project
  const clip=p.tracks.flatMap(t=>t.clips).find(c=>c.id===r.selection)
  assert.equal(clip.overlay.kind,kind);assert.equal(clip.textRole,'watermark')
 }
 assert.equal(p.tracks.find(t=>t.name==='视觉标注轨道').clips.length,6)
 assert.equal(validateProject(p,{trusted:true}).tracks[0].clips.at(-1).overlay.kind,'blur')
})
test('四类可编辑标题动画与模板字体颜色布局Logo定制',()=>{
 let p=fixture();const ids=[]
 for(const preset of ['chapter','lower-third','corner','subtitle']) { const r=run(p,'title_add',{preset,text:'章节内容',start:0,duration:3,animation:'slide'});p=r.project;ids.push(r.selection) }
 p.assets.push({id:'logo-image',kind:'image',name:'Logo',url:'blob:logo',duration:0,width:100,height:100,size:10,mime:'image/png'})
 p=run(p,'template_customize',{clipIds:ids,color:'#112233',fontFamily:'serif',fontSize:35,layout:'top-left',logoAssetId:'logo-image'}).project
 for(const c of p.tracks.flatMap(t=>t.clips).filter(c=>ids.includes(c.id))) { assert.equal(c.text,'章节内容');assert.equal(c.color,'#112233');assert.equal(c.fontSize,35);assert.equal(c.x,32) }
 assert.equal(p.tracks[0].name,'Logo轨道')
})
test('停帧固定源时间、静音、真实展示时长及恢复原裁剪',()=>{
 const p=fixture(), r=run(p,'clip_freeze_frame',{clipId:'video-clip',sourceTime:4,duration:20}), c=r.project.tracks[1].clips[0]
 assert.equal(clipDuration(c),20);assert.equal(sourceTimeAt(c,10),4);assert.equal(c.volume,0)
 const restored=run(r.project,'clip_freeze_frame',{clipId:c.id,clear:true}).project.tracks[1].clips[0]
 assert.equal(restored.trimOut,6);assert.equal(restored.volume,1);assert.equal(restored.freezeFrame,undefined)
 assert.throws(()=>run(p,'clip_freeze_frame',{clipId:c.id,sourceTime:12}),/源时间/)
})
test('曲线时长与源时间使用同一分区且保持音调字段存储',()=>{
 const p=fixture(), c=run(p,'clip_speed_ramp',{clipId:'video-clip',points:[{position:0,speed:1},{position:1,speed:2}],easing:'linear',preservePitch:false}).project.tracks[1].clips[0]
 assert.ok(Math.abs(clipDuration(c)-6*Math.log(2))<0.001)
 const segs=speedSegments(c);assert.equal(segs.length,32)
 for(const s of segs) assert.ok(Math.abs(sourceTimeAt(c,s.timeStart)-s.sourceStart)<1e-8)
 assert.equal(validateProject({...p,tracks:p.tracks.map(t=>t.kind==='video'?{...t,clips:[c]}:t)},{trusted:true}).tracks[1].clips[0].speedRamp.preservePitch,false)
 assert.throws(()=>run(p,'clip_speed_ramp',{clipId:'video-clip',points:[{position:0.1,speed:1},{position:1,speed:2}]}),/端点/)
})
test('转场参数决定方向缓动颜色模糊和单侧范围，锁定拒绝',()=>{
 let p=fixture();p.tracks[1].clips.push(createClip(p.assets[0],p,{id:'second',start:6,trimIn:6,trimOut:12}));p=addTransition(p,6,'slide-left',2)
 const id=p.tracks[0].clips[0].id
 p=run(p,'transition_parameters_set',{clipId:id,direction:'up',easing:'ease-in',color:'#123456',blur:10,scope:'incoming'}).project
 assert.equal(transitionVisualAt(p,'video-clip',5.5),undefined)
 const v=transitionVisualAt(p,'second',6.5);assert.equal(v.translateX,0);assert.equal(v.translateY,-0.75);assert.equal(v.blur,10);assert.equal(v.blurStrength,.75)
 p.tracks[0].locked=true;assert.throws(()=>run(p,'transition_parameters_set',{clipId:id,clear:true}),/解锁/)
})
test('标记保留存档并校验全局ID，旧文档省略字段不变',()=>{
 const p=fixture();assert.equal(validateProject(p,{trusted:true}).markers,undefined)
 p.markers=[{id:'chapter-one',time:100,label:'章节',kind:'chapter',color:'#aabbcc'}]
 assert.deepEqual(validateProject(p,{trusted:true}).markers,p.markers)
 p.markers[0].id='video-clip';assert.throws(()=>validateProject(p,{trusted:true}),/重复/)
 assert.equal(easeProgress(.5,'step'),0)
})

test('分割变速与动画保持原源时间和相同曲线，停帧分割保持展示时长',async()=>{
 const {splitClip}=await import('../src/core/timeline.ts')
 let p=fixture();p=run(p,'clip_speed_ramp',{clipId:'video-clip',points:[{position:0,speed:.5},{position:.7,speed:2},{position:1,speed:1}]}).project
 p=run(p,'clip_keyframes_set',{clipId:'video-clip',keyframes:{x:[{time:0,value:20,easing:'ease-in-out'},{time:3,value:200}]}}).project
 const before=p.tracks[1].clips[0],cut=1.113,after=splitClip(p,before.id,cut),[left,right]=after.tracks[1].clips
 assert.ok(Math.abs(clipDuration(left)+clipDuration(right)-clipDuration(before))<1e-10)
 for(const t of [cut,cut+.1,cut+1]) {assert.ok(Math.abs(sourceTimeAt(right,t)-sourceTimeAt(before,t))<1e-10);assert.ok(Math.abs(animatedClipAt(right,t).x-animatedClipAt(before,t).x)<1e-10)}
 const frozen=run(fixture(),'clip_freeze_frame',{clipId:'video-clip',sourceTime:4,duration:3}).project
 const pieces=splitClip(frozen,'video-clip',1).tracks[1].clips
 assert.equal(clipDuration(pieces[0]),1);assert.equal(clipDuration(pieces[1]),2);assert.equal(sourceTimeAt(pieces[1],2),4)
})
test('素材来源持久化且拒绝凭据/非网页URL/错误校验值',()=>{
 const p=fixture();p.assets[0].provenance={kind:'url',url:'https://example.com/media.mp4',finalUrl:'https://cdn.example.com/v.mp4',sha256:'a'.repeat(64),size:100,importedAt:Date.now()}
 assert.deepEqual(validateProject(p).assets[0].provenance,p.assets[0].provenance)
 p.assets[0].provenance.url='https://user:password@example.com/video';assert.throws(()=>validateProject(p),/凭据/)
 p.assets[0].provenance.url='file:///tmp/media.mp4';assert.throws(()=>validateProject(p),/网页/)
 p.assets[0].provenance.url='https://example.com';p.assets[0].provenance.sha256='wrong';assert.throws(()=>validateProject(p),/校验/)
})
