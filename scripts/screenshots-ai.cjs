// Capture the real application with opt-in models in their not-downloaded state.
// Native IPC only supplies catalog/platform fixtures; no inference or download runs.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { chromium, expect } = require('@playwright/test')
const root = path.resolve(__dirname, '..')
const read = name => JSON.parse(fs.readFileSync(path.join(root, 'src-tauri/resources', name), 'utf8'))
const videoCatalog = read('video-generation-models.json')
const videoModels = videoCatalog.models.map(model => ({ id: model.id, name: model.name, modes: model.modes, version: videoCatalog.revision, size: model.totalBytes, downloadedBytes: 0, state: 'not-downloaded', hardware: 'Apple 芯片 Mac · macOS 15 或更新版本；建议 64 GB 以上统一内存。低内存模式使用 SSD，生成较慢，需预留模型与输出空间。', licenseUrl: videoCatalog.license.url }))
const generatedModels = ['ai-image-models.json', 'ai-music-models.json'].flatMap(name => read(name).models.map(model => ({ id:model.id,name:model.name,provider:model.kind,capabilities:model.modes,version:model.version,size:model.files.reduce((sum,file)=>sum+file.size,0),downloadedBytes:0,state:'not-downloaded',hardware:model.hardware,runtime:{state:'not-installed'},bundled:false,requiresLicenseAcceptance:true,license:model.license.name,licenseUrl:model.license.url })))
const speechNames = { 'zipvoice-distill-fp32':'ZipVoice Distill FP32', 'f5-v1-base-fp32':'F5-TTS v1 Base FP32', 'qwen3-tts-1.7b-serena':'Qwen3-TTS 1.7B BF16' }
const speechModels = read('speech-models.json').models.map(model=>({id:model.id,name:speechNames[model.id]||model.voices[0].name,provider:'speech',capabilities:['text-to-speech'],version:String(model.version),size:model.downloadSize||model.modelSize,downloadedBytes:0,state:'not-downloaded',hardware:`建议 ${model.id.includes('qwen')?16:8} GB 系统内存；优先可用 GPU，失败时回退 CPU。`,runtime:{state:'not-installed'},bundled:false,requiresLicenseAcceptance:false,license:model.license,voices:model.voices}))
const asr = JSON.parse(fs.readFileSync(path.join(root, 'scripts/audio-asr-models.lock.json'), 'utf8'))
const bundled = {id:'bundled',name:'Matcha 中英',provider:'speech',capabilities:['text-to-speech'],version:'bundled',size:0,downloadedBytes:0,state:'ready',hardware:'建议 4 GB 系统内存；优先可用 GPU，失败时回退 CPU。',runtime:{state:'ready'},bundled:true,requiresLicenseAcceptance:false}
const transcription = {id:asr.id,name:asr.name,provider:'transcription',capabilities:['audio-to-text'],version:asr.modelRevision,size:asr.downloadSize,downloadedBytes:0,state:'not-downloaded',hardware:asr.hardware,runtime:{state:'not-installed'},bundled:false,requiresLicenseAcceptance:false,license:asr.license,licenseUrl:asr.licenseUrl}
const models = [bundled,...speechModels,transcription,...generatedModels,...videoModels.map(model=>({...model,provider:'video',capabilities:model.modes,runtime:{state:'not-installed'},bundled:false,requiresLicenseAcceptance:true,license:'MiniMax H3 Community License'}))]
const drafts = {
 'open-media:video-generation-draft:v1':{mode:'storyboard',modelId:'h3-base-fl2va',size:'768x448',steps:20,seed:20261021,lowMemory:true,joinShots:true,shots:[
 {title:'01 · 晨雾与群山',prompt:'清晨的山谷，金色阳光穿过薄雾照亮层层群山。镜头由远景缓慢推进，沿河流的方向移动，空气里有细小的光尘。自然色彩，电影感光影，安静而辽阔。',seconds:4},
 {title:'02 · 林间的光',prompt:'低机位穿过松林，枝叶在微风中轻轻摆动，阳光在石径上留下斑驳影子。延续前一镜的暖金与青绿色调，平稳向前推进。',seconds:4},
 {title:'03 · 抵达湖畔',prompt:'镜头从树影中来到湖畔，开阔的水面映着雪山和云层。缓慢拉远，鸟群掠过远处天空，留下两秒安静的停留。',seconds:4},
 ]},
 'open-media:ai-image-draft:v1':{modelId:'qwen-image',prompt:'设计一张「山野漫游」旅行海报。画面中央是一座被松林环绕的湖泊，远处层叠雪山与浅金色云层。采用细腻的手绘插画风格，青绿、奶油白与暖橙配色，纸张肌理，前景有野花与露营帐篷。\n\n顶部留出标题空间，中文标题“山野漫游”，副标题“把日常，交给远方”。画面有清晰的前中后景，适合横版旅行短片封面。',negativePrompt:'水印、杂乱文字、过度锐化、模糊边缘、重复主体',imageMode:'text',size:'1024x576',strength:.65,steps:30,guidance:4,seed:20261021,lowMemory:true},
 'open-media:ai-music-draft:v1':{modelId:'ace-step-1.5-turbo',prompt:'为山野旅行短片创作一首温暖的中文独立民谣。木吉他分解和弦、柔和钢琴、轻盈鼓刷与弦乐铺底，清澈自然的人声。主歌安静舒缓，副歌逐渐明亮；收尾留出呼吸感。',lyrics:'[Verse]\n把清晨装进行囊\n沿着风走过山岗\n每一束落在掌心的光\n都是远方的回响\n\n[Chorus]\n去看山野，去追云端\n让日常慢慢变得柔软\n把这一刻唱成答案\n和你走过每一个转弯',instrumental:false,steps:8,seed:20261021,seconds:60,bpm:92,language:'zh',keyScale:'G major',lowMemory:true}
}

async function main(){
 let server,browser
 const {createServer}=await import('vite')
 if(!process.env.SCREENSHOT_BASE_URL){server=await createServer({root,server:{host:'127.0.0.1',port:0,strictPort:false,hmr:false,watch:{ignored:['**']}},logLevel:'error'});await server.listen()}
 const base=process.env.SCREENSHOT_BASE_URL||server.resolvedUrls.local[0]
 const out=path.join(root,'docs/screenshots');fs.mkdirSync(out,{recursive:true})
 try{
 browser=await chromium.launch({headless:true,executablePath:process.env.BROWSER_EXECUTABLE||'/usr/bin/chromium',args:['--no-sandbox']})
 const page=await browser.newPage({viewport:{width:1680,height:1050},deviceScaleFactor:1,locale:'zh-CN',timezoneId:'Asia/Shanghai'})
 const errors=[];page.on('pageerror',error=>errors.push(error.message));page.setDefaultTimeout(20000)
 await page.addInitScript(({models,videoModels,drafts})=>{
   localStorage.setItem('open-media:theme','light');localStorage.setItem('open-media:autosave','false')
   for(const [key,value] of Object.entries(drafts))localStorage.setItem(key,JSON.stringify(value))
   window.screenshotCalls=[]
   window.__TAURI_INTERNALS__={transformCallback:()=>1,unregisterCallback(){},convertFileSrc:path=>path,invoke:async(command,args={})=>{
     window.screenshotCalls.push(command)
     if(command==='ai_get_status')return {models,jobs:[],busy:false}
     if(command==='get_video_generation_status')return {supported:true,runtimeReady:false,models:videoModels}
     if(command==='list_video_generation_jobs'||command==='get_media_jobs'||command==='mcp_pending')return []
     if(command==='get_runtime_status')return {ready:true}
     if(command==='get_desktop_platform')return 'macos'
     if(command==='get_speech_status')return {ready:false,voices:[]}
     if(command==='mcp_get_status')return {running:false,connectedClients:0,pendingRequests:0}
     if(command==='list_stored_videos')return {directory:'',assets:[],warnings:[]}
     if(command==='configure_screenshot_shortcut')return args.shortcut
     if(command==='plugin:event|listen')return 1
     if(/generate|download|begin.*record|capture/.test(command))throw new Error(`截图不运行推理、下载或采集：${command}`)
     return null
   }}
 },{models,videoModels,drafts})
 await page.goto(base);await expect(page.getByTestId('home-workspace')).toBeVisible()
 async function capture(name){
   for(const theme of ['light','dark']){
     await page.getByTestId(`theme-${theme}`).click();await page.mouse.move(2,2)
     await page.evaluate(()=>document.fonts.ready);await page.waitForTimeout(350)
     assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false)
     await page.screenshot({path:path.join(out,`${name}-${theme}.png`),animations:'disabled'})
   }
 }
 await page.getByTestId('nav-generate').click();await expect(page.getByLabel('镜头 1 名称')).toHaveValue('01 · 晨雾与群山');await expect(page.getByTestId('generation-start')).toBeDisabled();await capture('video-generation')
 await page.getByTestId('nav-image-generate').click();await expect(page.getByLabel('图像提示词')).toHaveValue(/山野漫游/);await expect(page.getByTestId('ai-generation-start').filter({visible:true})).toBeDisabled();await capture('image-generation')
 await page.getByTestId('nav-song-generate').click();await expect(page.getByLabel('歌曲歌词')).toHaveValue(/把清晨装进行囊/);await capture('music-generation')
 await page.getByTestId('nav-image-generate').click();await page.getByRole('button',{name:'请前往下载',exact:true}).filter({visible:true}).click()
 const dialog=page.getByRole('dialog',{name:'关于 Open Media',exact:true});await expect(dialog).toBeVisible();await expect(dialog.getByTestId('ai-category-image')).toHaveAttribute('aria-expanded','true')
 // Theme controls are behind a modal, so close/reopen through normal UI for each theme.
 for(const theme of ['light','dark']){
   await dialog.getByRole('button',{name:'关闭关于 Open Media',exact:true}).click();await page.getByTestId(`theme-${theme}`).click();await page.getByRole('button',{name:'请前往下载',exact:true}).filter({visible:true}).click();await page.mouse.move(2,2);await page.waitForTimeout(350);await page.screenshot({path:path.join(out,`model-center-${theme}.png`),animations:'disabled'})
 }
 assert.deepEqual(errors,[])
 assert.equal(await page.evaluate(()=>window.screenshotCalls.some(command=>/^ai_generate$|^begin_video_generation$|^ai_model_download$/.test(command))),false)
 console.log('Captured eight AI workspace/model-center screenshots from the current App. Native catalog/platform IPC is a fixture; all optional models remain not downloaded, no synthetic results, no inference, download or device capture.')
 }finally{await browser?.close();await server?.close()}
}
main().catch(cause=>{console.error(cause);process.exitCode=1})
