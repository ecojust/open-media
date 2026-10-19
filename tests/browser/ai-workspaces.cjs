const assert = require('node:assert/strict')
const { chromium, expect } = require('@playwright/test')
const { existsSync } = require('node:fs')

// Native IPC is simulated here to verify shared UI state. This does not claim
// inference quality or full model execution; runtime checks are separate.
async function mount(page, base) {
  await page.route('**/__ai__', route => route.fulfill({ contentType:'text/html',body:'<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body,#app{height:100%;margin:0}*{box-sizing:border-box}.app-shell{height:100%;display:flex;flex-direction:column}</style></head><body><div id="app"></div></body></html>' }))
  await page.goto(`${base}__ai__`)
  await page.evaluate(async () => {
    const source=await (await fetch('/src/components/AiGenerationWorkspace.vue')).text()
    const vueURL=source.match(/from ["']([^"']*\/vue\.js[^"']*)["']/)[1]
    const {createApp,h,ref}=await import(vueURL)
    const Workspace=(await import('/src/components/AiGenerationWorkspace.vue')).default
    const Center=(await import('/src/components/AiModelCenter.vue')).default
    await import('/src/style.css')
    const common={version:'test',size:1000000000,downloadedBytes:0,hardware:'测试硬件要求',runtime:{state:'ready'},bundled:false,requiresLicenseAcceptance:true,license:'测试许可',licenseUrl:'https://example.com/license'}
    const state=window.aiHarness={calls:[],unexpected:[],models:[
      {...common,id:'qwen-image',name:'Qwen-Image',provider:'image',capabilities:['text-to-image','image-to-image'],state:'not-downloaded'},
      {...common,id:'z-image-turbo',name:'Z-Image-Turbo',provider:'image',capabilities:['text-to-image','image-to-image'],state:'ready'},
      {...common,id:'ace-step-1.5-turbo',name:'ACE-Step 1.5 Turbo',provider:'music',capabilities:['text-to-music','lyrics-to-song'],state:'ready'},
      {...common,id:'voice-fixture',name:'已下载配音',provider:'speech',capabilities:['text-to-speech'],state:'ready'},
      {...common,id:'video-fixture',name:'已下载视频',provider:'video',capabilities:['text-to-video'],state:'ready'},
    ],jobs:[],provider:ref('image'),open:ref(false),filter:ref(),added:[],timeline:[],edited:[]}
    const canvas=document.createElement('canvas');canvas.width=64;canvas.height=64;const ctx=canvas.getContext('2d');ctx.fillStyle='#5588aa';ctx.fillRect(0,0,64,64)
    state.asset={id:'result-image',name:'测试生成图片.png',kind:'image',url:canvas.toDataURL(),duration:5,width:64,height:64,size:300,mime:'image/png',nativePath:'/fixture/image.png'}
    const status=()=>JSON.parse(JSON.stringify({models:state.models,jobs:state.jobs,busy:state.jobs.some(job=>job.state==='running')||state.models.some(model=>['downloading','verifying'].includes(model.state))}))
    window.__TAURI_INTERNALS__={convertFileSrc:()=>state.asset.url,invoke:async(command,args={})=>{
      state.calls.push({command,args:JSON.parse(JSON.stringify(args))})
      if(command==='ai_get_status')return status()
      if(command==='ai_model_download'||command==='ai_model_repair'){if(!args.acceptedLicense)throw Error('许可未确认');const model=state.models.find(model=>model.id===args.modelId);model.state='downloading';return status()}
      if(command==='ai_model_cancel'){state.models.find(model=>model.id===args.modelId).state='not-downloaded';return status()}
      if(command==='ai_generate'){const request=args.request;const job={id:`${request.provider}:${request.request.requestId}`,provider:request.provider,modelId:request.request.modelId,kind:'generation',state:'running',stage:'排队等待推理',startedAt:Date.now(),elapsedSeconds:0,assets:[],cancelable:true};state.jobs.unshift(job);return structuredClone(job)}
      if(command==='ai_job_cancel'){state.jobs.find(job=>job.id===args.id).state='cancelled';return}
      if(command==='pick_media_assets')return [state.asset]
      if(command==='reveal_media_asset')return
      state.unexpected.push(command);throw Error(`Unexpected command ${command}`)
    }}
    state.refresh=async()=>{const service=await import('/src/core/ai-service.ts');await service.refreshAi()}
    createApp({render:()=>h('div',{class:'app-shell','data-theme':'dark'},[
      h('button',{onClick:()=>{state.filter.value=undefined;state.open.value=true}},'全局模型中心'),
      h('button',{onClick:()=>state.provider.value=state.provider.value==='image'?'music':'image'},'切换工作区'),
      h(Workspace,{key:state.provider.value,provider:state.provider.value,native:true,active:true,projectTitle:'共享项目',onOpenModels:value=>{state.filter.value=value;state.open.value=true},onAddAsset:asset=>state.added.push(asset),onAddTimeline:asset=>state.timeline.push(asset),onEditImage:asset=>state.edited.push(asset)}),
      h(Center,{open:state.open.value,native:true,initialProvider:state.filter.value,onClose:()=>state.open.value=false}),
    ])}).mount('#app')
  })
}

async function main(){
  const {createServer}=await import('vite'),server=await createServer({server:{host:'127.0.0.1',port:0,hmr:false,watch:{ignored:['**']}},logLevel:'error'})
  await server.listen();let browser
  try{
    browser=await chromium.launch({headless:true,executablePath:process.env.BROWSER_EXECUTABLE||(existsSync('/usr/bin/chromium')?'/usr/bin/chromium':undefined),args:['--no-sandbox']})
    const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];page.on('pageerror',cause=>errors.push(cause.message));page.setDefaultTimeout(12000)
    await mount(page,server.resolvedUrls.local[0])
    await page.getByLabel('图像提示词',{exact:true}).fill('山谷里的一座安静的小屋')
    await expect(page.getByTestId('ai-generation-start')).toBeDisabled()
    await page.getByRole('button',{name:'全局模型中心',exact:true}).click()
    const center=page.getByRole('dialog',{name:'AI 模型中心',exact:true})
    await expect(center.locator('[data-ai-model]')).toHaveCount(5)
    await center.locator('[data-ai-model="qwen-image"]').getByRole('button',{name:'下载',exact:true}).click()
    const license=page.getByRole('dialog',{name:'下载模型',exact:true})
    await expect(license.getByRole('button',{name:'开始下载'})).toBeDisabled()
    await license.getByRole('checkbox').check();await license.getByRole('button',{name:'开始下载'}).click()
    await expect(license).not.toBeVisible();await expect(center.locator('[data-ai-model="qwen-image"]')).toContainText('正在下载')
    await center.locator('[data-ai-model="qwen-image"]').getByRole('button',{name:'取消',exact:true}).click()
    await expect(center.locator('[data-ai-model="qwen-image"]')).toContainText('待下载')
    await page.evaluate(()=>{window.aiHarness.models[0].state='ready';return window.aiHarness.refresh()})
    await center.getByRole('button',{name:'关闭AI 模型中心',exact:true}).click()
    await expect(page.getByTestId('ai-generation-start')).toBeEnabled().catch(async cause=>{console.error(await page.locator('.ai-generation-workspace').innerText(),await page.evaluate(()=>({calls:window.aiHarness.calls,models:window.aiHarness.models})));throw cause})
    await page.getByRole('button',{name:'图生图',exact:true}).click();await expect(page.getByTestId('ai-generation-start')).toBeDisabled()
    await page.getByRole('button',{name:'选择起始图片',exact:true}).click()
    await page.getByLabel('重绘强度').fill('0.7');await page.getByTestId('ai-generation-start').click()
    await expect.poll(()=>page.evaluate(()=>window.aiHarness.calls.filter(call=>call.command==='ai_generate').length)).toBe(1)
    let request=await page.evaluate(()=>window.aiHarness.calls.filter(call=>call.command==='ai_generate').at(-1).args.request)
    assert.equal(request.provider,'image');assert.equal(request.request.inputAsset.id,'result-image');assert.equal(request.request.strength,.7)
    await page.getByRole('button',{name:'切换工作区',exact:true}).click()
    await expect(page.getByTestId('music-generation-workspace')).toBeVisible()
    await page.getByRole('button',{name:'全局模型中心',exact:true}).click();await center.getByRole('tab',{name:'任务',exact:false}).click();await expect(center).toContainText('排队等待推理')
    await center.getByRole('button',{name:'取消任务',exact:true}).click();await expect(center).toContainText('已取消');await center.getByRole('button',{name:'关闭AI 模型中心',exact:true}).click()
    await page.getByLabel('音乐提示词',{exact:true}).fill('轻快的木吉他与钢琴，温暖自然')
    await expect(page.getByTestId('ai-generation-start')).toBeDisabled()
    await page.getByRole('button',{name:'纯音乐',exact:true}).click();await page.getByTestId('ai-generation-start').click()
    await expect.poll(()=>page.evaluate(()=>window.aiHarness.calls.filter(call=>call.command==='ai_generate').length)).toBe(2)
    request=await page.evaluate(()=>window.aiHarness.calls.filter(call=>call.command==='ai_generate').at(-1).args.request)
    assert.equal(request.provider,'music');assert.equal(request.request.instrumental,true);assert.equal(request.request.lyrics,'');assert.equal(request.request.seconds,30)
    await page.getByRole('button',{name:'取消生成',exact:true}).click()
    await page.getByRole('button',{name:'歌曲',exact:true}).click();await page.getByLabel('歌曲歌词').fill('[Verse]\n清晨的光落在窗前')
    await page.getByTestId('ai-generation-start').click()
    await expect.poll(()=>page.evaluate(()=>window.aiHarness.calls.filter(call=>call.command==='ai_generate').length)).toBe(3)
    request=await page.evaluate(()=>window.aiHarness.calls.filter(call=>call.command==='ai_generate').at(-1).args.request)
    assert.equal(request.request.instrumental,false);assert.match(request.request.lyrics,/清晨/)
    await page.getByRole('button',{name:'取消生成',exact:true}).click();await page.getByRole('button',{name:'切换工作区',exact:true}).click()
    await expect(page.getByLabel('图像提示词',{exact:true})).toHaveValue('山谷里的一座安静的小屋')
    await page.getByRole('button',{name:'文生图',exact:true}).click();await page.getByLabel('生成模型',{exact:true}).selectOption('z-image-turbo')
    await expect(page.getByLabel('生成步数')).toHaveValue('9');await expect(page.getByLabel('图像负向提示词')).toHaveCount(0)
    await page.getByTestId('ai-generation-start').click();await expect.poll(()=>page.evaluate(()=>window.aiHarness.calls.filter(call=>call.command==='ai_generate').length)).toBe(4);await page.evaluate(()=>{const state=window.aiHarness;Object.assign(state.jobs[0],{state:'completed',stage:'生成完成',assets:[state.asset],progress:1});return state.refresh()})
    await expect(page.locator('.ai-generation-result>img')).toBeVisible()
    await page.getByRole('button',{name:'加入素材',exact:true}).click();await page.getByRole('button',{name:'加入时间线',exact:true}).click();await page.getByRole('button',{name:'编辑图片',exact:true}).click()
    assert.deepEqual(await page.evaluate(()=>[window.aiHarness.added.length,window.aiHarness.timeline.length,window.aiHarness.edited.length]),[1,1,1])
    await page.setViewportSize({width:520,height:900})
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false)
    assert.deepEqual(await page.evaluate(()=>window.aiHarness.unexpected),[]);assert.deepEqual(errors,[])
    console.log('PASS shared AI GUI contracts: global models, consent, download cancellation, background jobs, image input, lyrics/instrumental modes, drafts, model-specific controls, results and narrow layout (mocked IPC; no full-model inference claimed)')
  }finally{await browser?.close();await server.close()}
}
main().catch(cause=>{console.error(cause);process.exitCode=1})
