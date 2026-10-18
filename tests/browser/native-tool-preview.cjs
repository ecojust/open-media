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
   if(command==='get_media_jobs')return[{id:'preview-job',state:++poll>1?'completed':'running',progress:poll>1?1:.5,stage:'合成',name:'preview'}]
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
 assert.equal(result.duration,.6);assert.match(result.url,/^asset:/);assert.equal(result.count,1);assert.equal(result.discards,1);assert(result.progress.some(p=>p.progress===.5&&p.stage==='合成'));assert.equal(result.progress.at(-1).progress,1)
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
   mode='engine-error';out.engineError=await timelineFrame(context,1.237,161).catch(e=>e.message)
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
 assert.equal(frames.abortName,'AbortError');assert(frames.cleanup.includes('cancel_media_job')&&frames.cleanup.includes('tool_preview_discard'));assert.match(frames.webError,/画布 PNG 导出.*The operation is insecure/)
 console.log('PASS desktop frame uses bounded IPC PNG without native-media canvas/fetch; real PNG cached; exact request; cancel/late cleanup; engine/bytes/canvas/cache errors distinguish stages')

}
main().catch(e=>{console.error(e);process.exitCode=1}).finally(async()=>{await browser?.close();server?.kill()})
