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
  preview.dispose()
  const output=await exportTimelineWebM(crop,{fps:20,videoBitsPerSecond:1000000})
  return {cropPixel,movePixels,focusPixel,maskPixel,blurPixel,spotlightPixels,frozenPixels,fadePixel,output:[...new Uint8Array(await output.arrayBuffer())]}
 })
 const blue=p=>p[2]>220&&p[0]<20,black=p=>p[0]+p[1]+p[2]<10
 assert(blue(result.cropPixel));assert(black(result.movePixels[0]));assert(result.movePixels[1][0]>110&&result.movePixels[1][0]<140);assert(blue(result.focusPixel));assert(result.maskPixel[1]>240&&result.maskPixel[0]<10);assert(result.blurPixel[0]>50&&result.blurPixel[2]>50);assert(black(result.spotlightPixels[0])&&blue(result.spotlightPixels[1]));assert(result.frozenPixels.every(blue));assert(result.fadePixel[0]>55&&result.fadePixel[0]<75&&result.fadePixel[1]>55&&result.fadePixel[1]<75&&result.fadePixel[2]<10,`colored fade opacity ${result.fadePixel}`)
 console.log('PASS 源裁剪/移动透明关键帧/区域聚焦/遮罩/聚光/局部模糊/停帧的实际 Canvas 像素')
 const out=path.join(folder,'crop-export.webm');await fs.writeFile(out,Buffer.from(result.output));const pixels=execFileSync('ffmpeg',['-v','error','-i',out,'-vf','crop=2:2:79:44,scale=1:1','-f','rawvideo','-pix_fmt','rgb24','-']);assert(pixels.length>90);for(let i=0;i<pixels.length;i+=3)assert(pixels[i+2]>180&&pixels[i]<50)
 console.log(`PASS 浏览器真实裁剪导出并逐帧解码验证 ${out}`)
 await page.screenshot({path:'/tmp/open-media-visual-tools.png'})
}
main().catch(e=>{console.error(e);process.exitCode=1}).finally(async()=>{await browser?.close();server?.kill()})
