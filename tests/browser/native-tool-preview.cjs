const assert=require('node:assert/strict'),{spawn}=require('node:child_process'),path=require('node:path'),net=require('node:net'),{chromium}=require('@playwright/test')
let browser,server
async function main(){
 const probe=net.createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r));const url=`http://127.0.0.1:${port}`
 server=spawn(process.execPath,[path.resolve('node_modules/vite/bin/vite.js'),'--host','127.0.0.1','--port',String(port),'--strictPort'],{stdio:'pipe'})
 for(let i=0;i<100;i++){try{if((await fetch(url)).ok)break}catch{};await new Promise(r=>setTimeout(r,100))}
 browser=await chromium.launch({headless:true,executablePath:process.env.BROWSER_EXECUTABLE||chromium.executablePath(),args:['--no-sandbox']});const page=await browser.newPage();await page.route('**/native-preview-fixture',r=>r.fulfill({contentType:'text/html',body:'<div>临时预览</div>'}));await page.goto(`${url}/native-preview-fixture`)
 const result=await page.evaluate(async()=>{
  const {createProject,createClip}=await import('/src/core/project.ts'),{runTimelinePreview}=await import('/src/native-preview-tools.ts')
  const asset={id:'source',kind:'video',name:'视频',url:'asset://source',nativePath:'/safe/media/source.mp4',duration:3,width:160,height:90,size:100,mime:'video/mp4'},project=createProject('测试',{width:160,height:90});project.assets=[asset];project.tracks[1].clips=[createClip(asset,project)]
  let mode='success',poll=0,resolveBegin,called=[],progress=[]
  window.__TAURI_INTERNALS__={convertFileSrc:path=>`asset://localhost${path}`,invoke:async(command,args)=>{
   called.push(command)
   if(command==='begin_tool_preview'){if(mode==='late')await new Promise(r=>resolveBegin=r);return{id:'preview-job',state:'running',progress:0,name:'preview'}}
   if(command==='get_media_jobs')return[{id:'preview-job',state:++poll>1?'completed':'running',progress:poll>1?1:.5,stage:'合成',name:'preview',encodedFrames:15,outputTime:.3,elapsedSeconds:1.5}]
   if(command==='tool_preview_result')return{...asset,id:'preview',name:'区间预览.mp4',nativePath:'/safe/media/tool-preview-aaaa.mp4',duration:.6}
   if(command==='cancel_media_job'||command==='tool_preview_discard')return null
   throw Error(`未预期调用 ${command}`)
  }}
  const output=await runTimelinePreview(project,1.2,1.8,{onProgress:u=>progress.push(u)})
  const value={duration:output.asset.duration,url:output.asset.url,count:project.assets.length,progress};await output.discard();await output.discard();value.discards=called.filter(c=>c==='tool_preview_discard').length
  called=[];mode='late';const abort=new AbortController();const promise=runTimelinePreview(project,0,1,{signal:abort.signal}).catch(e=>e.name)
  while(!resolveBegin)await new Promise(r=>setTimeout(r,0));abort.abort();resolveBegin();value.late=await promise;value.cleanup=called
  delete window.__TAURI_INTERNALS__;value.browserError=await runTimelinePreview(project,0,1).catch(e=>e.message)
  return value
 })
 assert.equal(result.duration,.6);assert.match(result.url,/^asset:/);assert.equal(result.count,1);assert.equal(result.discards,1);assert(result.progress.some(p=>Math.abs(p.progress-.545)<1e-8&&p.stage==='合成'&&p.encodedFrames===15&&p.outputTime===.3&&p.elapsedSeconds===1.5));assert.equal(result.progress.at(-1).progress,1)
 assert.equal(result.late,'AbortError');assert(result.cleanup.includes('cancel_media_job')&&result.cleanup.includes('tool_preview_discard'));assert.match(result.browserError,/桌面端/)
 console.log('PASS 临时预览 artifact/0..1进度/显式清理/不注册工程素材；取消晚到begin仍取消并清理；网页明确拒绝')
 const frames=await page.evaluate(async()=>{
  const {createProject,createClip,createTextClip}=await import('/src/core/project.ts'),{timelineFrame}=await import('/src/core/editor-preview-tools.ts'),{getToolArtifact}=await import('/src/core/tool-artifacts.ts')
  const asset={id:'video',kind:'video',name:'本地视频',url:'asset://localhost/safe/source.mp4',nativePath:'/safe/media/source.mp4',duration:3,width:160,height:90,size:100,mime:'video/mp4'}
  const project=createProject('原生取帧',{width:160,height:90});project.assets=[asset];project.tracks.find(t=>t.kind==='video').clips=[createClip(asset,project)]
  const png=document.createElement('canvas');png.width=161;png.height=91;png.getContext('2d').fillRect(0,0,161,91);const pngBase64=png.toDataURL('image/png').split(',')[1]
  const originalBlob=HTMLCanvasElement.prototype.toBlob,originalFetch=window.fetch,originalOpen=indexedDB.open,originalDigest=crypto.subtle.digest
  let canvasReads=0,assetReads=0,mode='success',resolveBegin,calls=[],specs=[]
  const insecure=()=>new DOMException('The operation is insecure.','SecurityError')
  HTMLCanvasElement.prototype.toBlob=function(){canvasReads++;throw insecure()}
  window.fetch=(input,...args)=>{if(String(input).startsWith('asset:')){assetReads++;return Promise.reject(insecure())}return originalFetch(input,...args)}
  window.__TAURI_INTERNALS__={convertFileSrc:path=>`asset://localhost${path}`,invoke:async(command,args)=>{
   calls.push(command)
   if(command==='begin_tool_preview'){specs.push(args.spec);if(mode==='late')await new Promise(r=>resolveBegin=r);if(mode==='engine-error')throw new Error('fixture engine failure');return{id:'png-job',state:'completed',progress:1,name:'frame'}}
   if(command==='tool_preview_result')return{...asset,id:'frame',name:'时间线画面.png',kind:'image',mime:'image/png',nativePath:'/safe/media/tool-preview-0123456789abcdef0123456789abcdef.png',width:161,height:91,pngBase64:mode==='missing-bytes'?undefined:pngBase64}
   if(command==='cancel_media_job'||command==='tool_preview_discard')return null
   throw Error(`未预期调用 ${command}`)
  }}
  const context={project,revision:0,blobs:new Map(),source:'mcp',signal:new AbortController().signal,onProgress:()=>{}}
  try{
   const frame=await timelineFrame(context,1.237,161),stored=await getToolArtifact(frame.artifactId),decoded=await createImageBitmap(stored.blob)
   const out={time:frame.time,dimensions:[decoded.width,decoded.height],base64:frame.base64===pngBase64,bytes:stored.metadata.bytes,canvasReads,assetReads,spec:specs[0],discards:calls.filter(c=>c==='tool_preview_discard').length};decoded.close()
   indexedDB.open=()=>{throw insecure()};out.cacheError=await timelineFrame(context,1.237,161).catch(e=>e.message);indexedDB.open=originalOpen
   crypto.subtle.digest=async()=>{throw insecure()};out.hashError=await timelineFrame(context,1.237,161).catch(e=>e.message);crypto.subtle.digest=originalDigest
   mode='missing-bytes';out.bytesError=await timelineFrame(context,1.237,161).catch(e=>e.message)
   mode='engine-error';out.engineError=await timelineFrame(context,1.237,161).catch(e=>{out.engineDetails={stage:e.stage,resources:e.relatedResources,context:e.context};return e.message})
   mode='late';calls=[];const controller=new AbortController(),late=timelineFrame({...context,signal:controller.signal},1.237,161).catch(e=>e.name)
   while(!resolveBegin)await new Promise(r=>setTimeout(r,0));controller.abort();resolveBegin();out.abortName=await late;out.cleanup=calls
   delete window.__TAURI_INTERNALS__
   const web=createProject('浏览器错误阶段',{width:160,height:90});web.tracks.find(t=>t.kind==='text').clips=[createTextClip(web,{text:'测试',trimOut:2})]
   out.webError=await timelineFrame({...context,project:web},1,160).catch(e=>e.message)
   return out
  }finally{HTMLCanvasElement.prototype.toBlob=originalBlob;window.fetch=originalFetch;indexedDB.open=originalOpen;crypto.subtle.digest=originalDigest;delete window.__TAURI_INTERNALS__}
 })
 assert.equal(frames.time,1.237);assert.deepEqual(frames.dimensions,[161,91]);assert(frames.base64&&frames.bytes>0);assert.equal(frames.canvasReads,0);assert.equal(frames.assetReads,0);assert.equal(frames.discards,1)
 assert.equal(frames.spec.frameOnly,true);assert.equal(frames.spec.start,1.237);assert.equal(frames.spec.width,161);assert.equal(frames.spec.end,undefined)
 assert.match(frames.cacheError,/预览缓存.*The operation is insecure/);assert.match(frames.hashError,/预览缓存.*The operation is insecure/);assert.match(frames.bytesError,/PNG 字节读取/);assert.match(frames.engineError,/原生.*fixture engine failure/)
 assert.equal(frames.engineDetails.stage,'原生画面合成');assert.deepEqual(frames.engineDetails.resources,[{assetId:'video',name:'本地视频'}]);assert.deepEqual(frames.engineDetails.context,{time:1.237,width:161})
 assert.equal(frames.abortName,'AbortError');assert(frames.cleanup.includes('cancel_media_job')&&frames.cleanup.includes('tool_preview_discard'));assert.match(frames.webError,/画布 PNG 导出.*The operation is insecure/)
 console.log('PASS desktop frame uses bounded IPC PNG without native-media canvas/fetch; real PNG cached; exact request; cancel/late cleanup; engine/bytes/canvas/cache errors distinguish stages')

 const preparation=await page.evaluate(async()=>{
  const {createProject,createClip,createTextClip}=await import('/src/core/project.ts'),{prepareNativeProject}=await import('/src/core/native-project.ts'),{timelineFrame}=await import('/src/core/editor-preview-tools.ts')
  const project=createProject('范围准备',{width:3840,height:2160}),asset={id:'native',kind:'video',name:'已导入视频',nativePath:'/safe/native.mp4',url:'asset://localhost/native.mp4',duration:30,width:3840,height:2160,size:100,mime:'video/mp4'}
  const unrelated={...asset,id:'unrelated',name:'区间外素材',nativePath:undefined,url:'https://invalid.example/expired'}
  project.assets=[asset,unrelated];project.tracks.find(t=>t.kind==='video').clips=[createClip(asset,project),{...createClip(unrelated,project),start:50}]
  const active=createTextClip(project,{text:'当前区间',start:10,trimOut:8,width:2000,height:200}),inactive=createTextClip(project,{text:'不应栅格化',start:50,trimOut:10,width:20000,height:20000})
  project.tracks.find(t=>t.kind==='text').clips=[active,inactive]
  const originalFetch=window.fetch,originalBlob=HTMLCanvasElement.prototype.toBlob;let fetches=0,imported=[],progress=[],spec
  window.fetch=(...args)=>{fetches++;return originalFetch(...args)}
  const png=document.createElement('canvas');png.width=1008;png.height=567;png.getContext('2d').fillRect(0,0,1008,567);const pngBase64=png.toDataURL('image/png').split(',')[1]
  window.__TAURI_INTERNALS__={convertFileSrc:path=>`asset://localhost${path}`,invoke:async(command,args)=>{
   if(command==='import_blob_asset'){
    const data=Uint8Array.from(args.bytes),image=await createImageBitmap(new Blob([data],{type:'image/png'})),dimensions=[image.width,image.height];image.close();imported.push(dimensions)
    return{...asset,id:'text',kind:'image',width:dimensions[0],height:dimensions[1],name:args.name,nativePath:undefined,url:URL.createObjectURL(new Blob([data],{type:'image/png'})),mime:'image/png'}
   }
   if(command==='begin_tool_preview'){spec=args.spec;return{id:'requested-frame',state:'completed',progress:1}}
   if(command==='tool_preview_result')return{...asset,kind:'image',width:1008,height:567,nativePath:'/safe/result.png',pngBase64}
   if(command==='tool_preview_discard')return null
   throw Error(`Unexpected ${command}`)
  }}
  try{
   const prepared=await prepareNativeProject(project,undefined,{range:{start:9,end:19},rasterScale:.25,onProgress:u=>progress.push(u)})
   const out={fetches,preparedText:Object.keys(prepared.textAssets),activeId:active.id,imported:[...imported],projectUnchanged:!project.assets[1].nativePath,progress}
   const frame=await timelineFrame({project,revision:0,blobs:new Map(),source:'mcp',signal:new AbortController().signal,onProgress:()=>{}},15,1008)
   out.requestedFrame={time:frame.time,width:frame.width,height:frame.height,start:spec.start,nativeWidth:spec.width,textAssets:Object.keys(spec.textAssets)}
   window.fetch=async()=>{throw new DOMException('The operation is insecure.','SecurityError')}
   out.assetError=await prepareNativeProject(project,undefined,{range:{start:51,end:52}}).catch(e=>({message:e.message,code:e.code,stage:e.stage,resource:e.resource}))
   HTMLCanvasElement.prototype.toBlob=function(){throw new DOMException('The operation is insecure.','SecurityError')}
   out.textError=await prepareNativeProject(project,undefined,{range:{start:15}}).catch(e=>({message:e.message,stage:e.stage,resource:e.resource}))
   return out
  }finally{window.fetch=originalFetch;HTMLCanvasElement.prototype.toBlob=originalBlob;delete window.__TAURI_INTERNALS__}
 })
 assert.equal(preparation.fetches,0);assert.deepEqual(preparation.preparedText,[preparation.activeId]);assert.deepEqual(preparation.imported,[[500,50]]);assert(preparation.projectUnchanged&&preparation.progress.length)
 assert.deepEqual(preparation.requestedFrame,{time:15,width:1008,height:567,start:15,nativeWidth:1008,textAssets:[preparation.activeId]})
 assert.equal(preparation.assetError.code,'MEDIA_TOOL_FAILED');assert.equal(preparation.assetError.stage,'素材读取');assert.deepEqual(preparation.assetError.resource,{assetId:'unrelated',name:'区间外素材'});assert.match(preparation.assetError.message,/区间外素材.*unrelated.*insecure/)
 assert.equal(preparation.textError.stage,'字幕 PNG 导出');assert.equal(preparation.textError.resource.clipId,preparation.activeId)
 console.log('PASS 9–19秒仅准备相交素材并提前缩小字幕；15秒1008宽原生PNG请求；精确素材/字幕错误阶段、标识和名称')

}
main().catch(e=>{console.error(e);process.exitCode=1}).finally(async()=>{await browser?.close();server?.kill()})
