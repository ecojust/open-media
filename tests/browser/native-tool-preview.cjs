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
}
main().catch(e=>{console.error(e);process.exitCode=1}).finally(async()=>{await browser?.close();server?.kill()})
