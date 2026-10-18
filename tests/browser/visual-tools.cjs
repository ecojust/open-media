const assert = require('node:assert/strict')
const { spawn, execFileSync } = require('node:child_process')
const fs = require('node:fs/promises'), os = require('node:os'), path = require('node:path'), net = require('node:net')
const { chromium } = require('@playwright/test')
let server, browser
async function startServer() {
 const probe=net.createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r))
 server=spawn(process.execPath,[path.resolve('node_modules/vite/bin/vite.js'),'--host','127.0.0.1','--port',String(port),'--strictPort'],{stdio:'pipe'})
 const url=`http://127.0.0.1:${port}`;for(let i=0;i<120;i++){try{if((await fetch(url)).ok)return url}catch{};await new Promise(r=>setTimeout(r,100))}throw Error('服务未启动')
}
async function main(){
 const folder=await fs.mkdtemp(path.join(os.tmpdir(),'open-media-visual-'))
 const video=path.join(folder,'source.webm')
 execFileSync('ffmpeg',['-hide_banner','-loglevel','error','-f','lavfi','-i','color=c=red:s=160x90:r=20:d=1','-f','lavfi','-i','color=c=blue:s=160x90:r=20:d=1','-filter_complex','[0:v][1:v]concat=n=2:v=1:a=0[v]','-map','[v]','-c:v','libvpx','-threads','1',video])
 const url=await startServer();browser=await chromium.launch({headless:true,executablePath:process.env.BROWSER_EXECUTABLE||chromium.executablePath(),args:['--no-sandbox','--autoplay-policy=no-user-gesture-required']})
 const page=await browser.newPage();await page.route('**/visual-fixture',r=>r.fulfill({contentType:'text/html',body:'<canvas width="160" height="90"></canvas>'}));const bytes=await fs.readFile(video);await page.route('**/visual-source.webm',r=>r.fulfill({contentType:'video/webm',body:bytes}));await page.goto(`${url}/visual-fixture`)
 const result=await page.evaluate(async()=>{
  const {createProject,createClip}=await import('/src/core/project.ts'),{TimelinePreview}=await import('/src/core/preview.ts'),{executeVisualTool:run}=await import('/src/core/visual-tools.ts'),{exportTimelineWebM}=await import('/src/core/browser-export.ts'),{addTransition}=await import('/src/core/transitions.ts')
  const source=document.createElement('canvas');source.width=160;source.height=90;const sc=source.getContext('2d');sc.fillStyle='#ff0000';sc.fillRect(0,0,80,90);sc.fillStyle='#0000ff';sc.fillRect(80,0,80,90)
  const p=createProject('视觉预览',{width:160,height:90,fps:20,background:'#000000'});p.assets=[{id:'image',kind:'image',name:'红蓝',url:source.toDataURL(),duration:0,width:160,height:90,size:20,mime:'image/png'},{id:'movie',kind:'video',name:'源视频',url:URL.createObjectURL(await (await fetch('/visual-source.webm')).blob()),duration:2,width:160,height:90,size:100,mime:'video/webm'}];p.tracks[1].clips=[createClip(p.assets[0],p,{id:'clip',trimOut:2,volume:0})]
  const canvas=document.querySelector('canvas'),preview=new TimelinePreview(canvas,p);await preview.prepare();const pixel=(x,y)=>[...canvas.getContext('2d').getImageData(x,y,1,1).data]
  const render=async(project,t)=>{preview.setProject(project);await preview.prepare();await preview.seekReady(t);preview.render(t);return pixel(80,45)}
  const crop=run(p,'clip_crop',{clipId:'clip',crop:{x:.5,y:0,width:.5,height:1}}).project
  const cropPixel=await render(crop,.5)
  const move=run(p,'clip_keyframes_set',{clipId:'clip',keyframes:{x:[{time:0,value:0},{time:1,value:80}],opacity:[{time:0,value:1},{time:1,value:.5}]}}).project
  await render(move,1);const movePixels=[pixel(20,45),pixel(100,45)]
  const focus=run(p,'focus_region',{clipId:'clip',region:{x:.5,y:0,width:.5,height:1},duration:1}).project;const focusPixel=await render(focus,1)
  const mask=run(p,'overlay_add',{kind:'mask',start:0,duration:2,x:20,y:20,width:40,height:40,color:'#00ff00'}).project;await render(mask,1);const maskPixel=pixel(30,30)
  const blur=run(p,'overlay_add',{kind:'blur',start:0,duration:2,x:50,y:5,width:60,height:80,blurRadius:10}).project;await render(blur,1);const blurPixel=pixel(80,45)
  const spotlight=run(p,'overlay_add',{kind:'spotlight',start:0,duration:2,x:100,y:20,width:30,height:30,opacity:1}).project;await render(spotlight,1);const spotlightPixels=[pixel(20,20),pixel(110,30)]
  const movie=structuredClone(p);movie.tracks[1].clips=[createClip(p.assets[1],movie,{id:'movie-clip',volume:0})]
  const frozen=run(movie,'clip_freeze_frame',{clipId:'movie-clip',sourceTime:1.5,duration:2}).project;const frozenPixels=[];for(const t of [.1,1.5])frozenPixels.push(await render(frozen,t))
  const split=structuredClone(movie);split.tracks[1].clips=[createClip(p.assets[1],movie,{id:'before',trimOut:1,opacity:.5,volume:0}),createClip(p.assets[1],movie,{id:'after',start:1,trimIn:1,trimOut:2,opacity:.5,volume:0})]
  let colored=addTransition(split,1,'fade',1);colored=run(colored,'transition_parameters_set',{clipId:colored.tracks[0].clips[0].id,color:'#00ff00'}).project
  const fadePixel=await render(colored,.75)
  let overlays=createProject('通用标注导出',{width:480,height:240,fps:20,background:'#000000'})
  const kinds=['ellipse','brackets','double-arrow','leader','underline','check']
  for(const [index,kind] of kinds.entries()) overlays=run(overlays,'overlay_add',{kind,start:0,duration:2,x:10+(index%3)*160,y:10+Math.floor(index/3)*120,width:140,height:90,color:'#00ff00',strokeWidth:6}).project
  const {exportProjectFile,importProjectFile}=await import('/src/core/project-file.ts')
  const reopened=(await importProjectFile(await exportProjectFile(overlays))).project
  canvas.width=480;canvas.height=240;await render(reopened,1)
  const strokePoints=[[70,3],[3,10],[70,45],[100,20],[70,87],[51,72]],emptyPoints=[[70,45],[70,3],[70,10],[70,45],[70,45],[70,13]]
  const overlayPixels=kinds.map((kind,index)=>({kind,stroke:pixel(10+(index%3)*160+strokePoints[index][0],10+Math.floor(index/3)*120+strokePoints[index][1]),empty:pixel(10+(index%3)*160+emptyPoints[index][0],10+Math.floor(index/3)*120+emptyPoints[index][1])}))
  const nativeRasters=[],previousNative=window.__TAURI_INTERNALS__
  window.__TAURI_INTERNALS__={invoke:async(command,args)=>{
   if(command!=='import_blob_asset')throw Error(`Unexpected native overlay call: ${command}`)
   const data=Uint8Array.from(args.bytes),blob=new Blob([data],{type:'image/png'}),image=await createImageBitmap(blob)
   const raster=document.createElement('canvas');raster.width=image.width;raster.height=image.height;raster.getContext('2d').drawImage(image,0,0);image.close()
   const index=nativeRasters.length,point=strokePoints[index],empty=emptyPoints[index]
   nativeRasters.push({kind:kinds[index],bytes:args.bytes,stroke:[...raster.getContext('2d').getImageData(...point,1,1).data],empty:[...raster.getContext('2d').getImageData(...empty,1,1).data]})
   return {id:`raster-${index}`,kind:'image',name:args.name,url:URL.createObjectURL(blob),duration:0,width:raster.width,height:raster.height,size:data.length,mime:'image/png'}
  }}
  try {const {prepareNativeProject}=await import('/src/core/native-project.ts');const prepared=await prepareNativeProject(reopened);if(Object.keys(prepared.textAssets).length!==6)throw Error('原生导出必须准备全部6种标注')}finally{if(previousNative)window.__TAURI_INTERNALS__=previousNative;else delete window.__TAURI_INTERNALS__}
  preview.dispose()
  const overlayOutput=await exportTimelineWebM(reopened,{fps:20,videoBitsPerSecond:2000000})
  const output=await exportTimelineWebM(crop,{fps:20,videoBitsPerSecond:1000000})
  return {overlayPixels,nativeRasters,overlayOutput:[...new Uint8Array(await overlayOutput.arrayBuffer())],cropPixel,movePixels,focusPixel,maskPixel,blurPixel,spotlightPixels,frozenPixels,fadePixel,output:[...new Uint8Array(await output.arrayBuffer())]}
 })
 const blue=p=>p[2]>220&&p[0]<20,black=p=>p[0]+p[1]+p[2]<10
 assert(blue(result.cropPixel));assert(black(result.movePixels[0]));assert(result.movePixels[1][0]>110&&result.movePixels[1][0]<140);assert(blue(result.focusPixel));assert(result.maskPixel[1]>240&&result.maskPixel[0]<10);assert(result.blurPixel[0]>50&&result.blurPixel[2]>50);assert(black(result.spotlightPixels[0])&&blue(result.spotlightPixels[1]));assert(result.frozenPixels.every(blue));assert(result.fadePixel[0]>55&&result.fadePixel[0]<75&&result.fadePixel[1]>55&&result.fadePixel[1]<75&&result.fadePixel[2]<10,`colored fade opacity ${result.fadePixel}`)
 console.log('PASS 源裁剪/移动透明关键帧/区域聚焦/遮罩/聚光/局部模糊/停帧的实际 Canvas 像素')
 const out=path.join(folder,'crop-export.webm');await fs.writeFile(out,Buffer.from(result.output));const pixels=execFileSync('ffmpeg',['-v','error','-i',out,'-vf','crop=2:2:79:44,scale=1:1','-f','rawvideo','-pix_fmt','rgb24','-']);assert(pixels.length>90);for(let i=0;i<pixels.length;i+=3)assert(pixels[i+2]>180&&pixels[i]<50)
 console.log(`PASS 浏览器真实裁剪导出并逐帧解码验证 ${out}`)
 const green=p=>p[1]>220&&p[0]<20&&p[2]<20
 for(const item of result.overlayPixels){assert(green(item.stroke),`${item.kind} 实际预览线条 ${item.stroke}`);assert(black(item.empty),`${item.kind} 必须保留空心/无笔画区域 ${item.empty}`)}
 for(const item of result.nativeRasters){assert(green(item.stroke)&&item.stroke[3]>220,`${item.kind} 原生PNG线条`);assert(item.empty[3]<10,`${item.kind} 原生PNG保留透明`);await fs.writeFile(path.join(folder,`${item.kind}.png`),Buffer.from(item.bytes))}
 const overlayOut=path.join(folder,'editable-overlays.webm');await fs.writeFile(overlayOut,Buffer.from(result.overlayOutput))
 const raw=execFileSync('ffmpeg',['-v','error','-ss','1','-i',overlayOut,'-frames:v','1','-f','rawvideo','-pix_fmt','rgb24','-'],{maxBuffer:1e6})
 const strokePoints=[[70,3],[3,10],[70,45],[100,20],[70,87],[51,72]],emptyPoints=[[70,45],[70,3],[70,10],[70,45],[70,45],[70,13]]
 for(let i=0;i<6;i++)for(const[point,filled]of[[strokePoints[i],true],[emptyPoints[i],false]]){const x=10+(i%3)*160+point[0],y=10+Math.floor(i/3)*120+point[1],at=(y*480+x)*3,p=[...raw.subarray(at,at+3)];assert(filled?p[1]>180&&p[0]<40&&p[2]<40:p.every(c=>c<25),`导出标注 ${i} ${filled?'线条':'空心'} ${p}`)}
 console.log(`PASS 6种通用标注真实Canvas、便携保存重开、原生透明PNG栅格、真实WebM解码 ${overlayOut}`)
 await page.screenshot({path:'/tmp/open-media-visual-tools.png'})
}
main().catch(e=>{console.error(e);process.exitCode=1}).finally(async()=>{await browser?.close();server?.kill()})
