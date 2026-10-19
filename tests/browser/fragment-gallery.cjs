const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { chromium, expect } = require('@playwright/test')
const root = path.resolve(__dirname, '../..')
const artifacts = process.env.BROWSER_ARTIFACTS || path.join(os.tmpdir(), 'open-media-fragment-gallery')
const docs = process.argv.includes('--docs')
fs.mkdirSync(artifacts, { recursive: true })
async function main() {
 const { createServer } = await import('vite')
 const server = await createServer({ root, cacheDir:path.join(artifacts,'vite-cache'), server:{host:'127.0.0.1',port:0,hmr:false,watch:null},logLevel:'error'})
 await server.listen()
 const browser = await chromium.launch({headless:true,args:['--no-sandbox'],executablePath:process.env.BROWSER_EXECUTABLE || process.env.CHROMIUM_PATH || chromium.executablePath()})
 const page = await browser.newPage({viewport:{width:1000,height:1800},reducedMotion:'reduce'}), errors=[]
 page.on('pageerror',e=>errors.push(e.message))
 try {
 await page.route('**/__gallery__',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><html><head><style>#app{max-width:900px;margin:20px auto}</style></head><body><div id="app"></div></body></html>'}))
 await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__gallery__`)
 await page.evaluate(async()=>{
 await import('/src/style.css')
 await import('/src/components/VideoEditor.vue')
 const source=await(await fetch('/src/components/TransitionLibrary.vue')).text()
 const vueURL=source.match(/from ["']([^"']*\/vue\.js[^"']*)["']/)[1]
 const {createApp,h}=await import(vueURL)
 const Gallery=(await import('/src/components/TransitionLibrary.vue')).default
 createApp({render:()=>h('div',{class:'app-shell','data-theme':'dark'},[h('div',{class:'video-editor',style:{'--ed-bg':'var(--ui-bg)','--ed-panel':'var(--ui-surface)','--ed-border':'var(--ui-line)','--ed-text':'var(--ui-text)','--ed-muted':'var(--ui-muted)','--ed-accent':'var(--ui-accent)'}},[h(Gallery,{fps:30,cut:{trackId:'v',fromClipId:'a',toClipId:'b',time:3,maxDuration:3},fromName:'场景 A',toName:'场景 B'})])])}).mount('#app')
 })
 await expect(page.getByRole('radio')).toHaveCount(35)
 await expect(page.locator('[data-animated=true]')).toHaveCount(0)
 const ids=['fragment-burst','fragment-vortex','fragment-collapse','pixel-dissolve','pixel-wave','slice-stagger','slice-vertical','checker-flip','tile-orbit','glitch-slices','zipper-slices','stepped-shutter']
 for (const id of ids) await expect(page.locator(`[data-effect="${id}"] [data-fragment-plan] > g`)).not.toHaveCount(0)
 const comparisons=await page.evaluate(async ids=>{
 const {drawFragmentTransition}=await import('/src/core/fragment-transitions.ts')
 const image=svg=>new Promise((resolve,reject)=>{const img=new Image();img.onload=()=>resolve(img);img.onerror=reject;img.src='data:image/svg+xml;charset=utf-8,'+encodeURIComponent(new XMLSerializer().serializeToString(svg))})
 const comparisons=[]
 for(const id of ids){
 const svg=document.querySelector(`[data-effect="${id}"]`).cloneNode(true);svg.setAttribute('width','160');svg.setAttribute('height','100');svg.removeAttribute('class')
 const scene=svg.cloneNode(true);while(scene.lastChild!==scene.firstChild)scene.removeChild(scene.lastChild)
 const composite=scene.querySelector('[id$="-composite"]')
 const use=document.createElementNS('http://www.w3.org/2000/svg','use');use.setAttribute('href','#'+composite.id);scene.appendChild(use)
 const source=await image(scene),expected=document.createElement('canvas'),actual=document.createElement('canvas');expected.width=actual.width=160;expected.height=actual.height=100
 const expectedContext=expected.getContext('2d'),actualContext=actual.getContext('2d')
 expectedContext.fillStyle='#101827';expectedContext.fillRect(0,0,160,100)
 drawFragmentTransition(expectedContext,source,160,100,id,Number(svg.dataset.visibility),160,100)
 actualContext.drawImage(await image(svg),0,0)
 const a=expectedContext.getImageData(0,0,160,100).data,b=actualContext.getImageData(0,0,160,100).data
 let mae=0,differing=0;for(let i=0;i<a.length;i+=4){const d=Math.max(...[0,1,2].map(c=>Math.abs(a[i+c]-b[i+c])));if(d>16)differing++;mae+=d}
 comparisons.push({id,mae:mae/16000,differing:differing/16000})
 }
 return comparisons
 },ids)
 for(const comparison of comparisons){assert(comparison.mae<6,JSON.stringify(comparison));assert(comparison.differing<.12,JSON.stringify(comparison))}
 await page.screenshot({path:path.join(artifacts,'all-static.png'),fullPage:true})
 await page.emulateMedia({reducedMotion:'no-preference'})
 await expect(page.locator('[data-animated=true]')).toHaveCount(1)
 for (const id of ids) {
 await page.locator('.transition-card').filter({has:page.locator(`input[value="${id}"]`)}).hover()
 const active = page.locator(`[data-effect="${id}"]`)
 await expect(active).toHaveAttribute('data-animated','true')
 await expect(page.locator('[data-animated=true]')).toHaveCount(1)
 const first=await active.getAttribute('data-visibility')
 await page.waitForTimeout(1200)
 const second=await active.getAttribute('data-visibility')
 assert.notEqual(first,second,`${id} must actually animate`)
 await expect(page.locator('[data-animated=true]')).toHaveCount(1)
 for(const other of ids.filter(x=>x!==id)) {
 const visibility=Number(await page.locator(`[data-effect="${other}"]`).getAttribute('data-visibility'))
 assert(Math.abs(visibility-.5)<1e-8,`${other} must remain at its representative frame`)
 }
 }
 await page.mouse.move(990,1790)
 await page.getByRole('button',{name:'碎片 6',exact:true}).click()
 await expect(page.getByRole('radio')).toHaveCount(6)
 await page.getByRole('radio').first().focus();await page.keyboard.press('ArrowRight')
 await expect(page.locator('input[value="fragment-vortex"]')).toBeChecked()
 await expect(page.locator('[data-effect="fragment-vortex"]')).toHaveAttribute('data-animated','true')
 await page.screenshot({path:path.join(artifacts,'keyboard-selected.png'),fullPage:true})
 await page.emulateMedia({reducedMotion:'reduce'})
 await expect(page.locator('[data-animated=true]')).toHaveCount(0)
 await expect(page.getByText('已根据系统设置静态展示效果')).toBeVisible()
 const gallery=page.getByTestId('transition-library')
 const docsDirectory=path.join(root,'docs/images')
 if (docs) fs.mkdirSync(docsDirectory,{recursive:true})
 await page.mouse.move(990,1790)
 await gallery.screenshot({path:docs ? path.join(docsDirectory,'transition-fragments.png') : path.join(artifacts,'fragments.png')})
 await page.getByRole('button',{name:'动感切片 6',exact:true}).click()
 await expect(page.getByRole('radio')).toHaveCount(6)
 await expect(page.locator('[data-animated=true]')).toHaveCount(0)
 await page.mouse.move(990,1790)
 await gallery.screenshot({path:docs ? path.join(docsDirectory,'transition-slices.png') : path.join(artifacts,'slices.png')})
 assert.deepEqual(errors,[])
 console.log(JSON.stringify({ok:true,cards:35,newEffects:12,animation:'one active card only',keyboard:true,reducedMotion:true,comparisons},null,2))
 }finally{await browser.close();await server.close();fs.rmSync(path.join(artifacts,'vite-cache'),{recursive:true,force:true})}
}
main().catch(e=>{console.error(e);process.exitCode=1})
