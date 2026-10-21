const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { execFileSync } = require('node:child_process')
const { chromium } = require('@playwright/test')

async function main() {
  const root = path.resolve(__dirname, '../..')
  const directory = path.resolve(process.env.OPEN_MEDIA_MOTION_REPORT || (process.env.BROWSER_ARTIFACTS ? path.join(process.env.BROWSER_ARTIFACTS, 'motion-style-render') : path.join(os.tmpdir(), 'open-media-motion-render')))
  fs.mkdirSync(directory, { recursive: true })
  const source = path.join(directory, 'source.webm'), music = path.join(directory, 'music.wav')
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=24:d=3', '-c:v', 'libvpx', '-deadline', 'realtime', '-cpu-used', '8', source])
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', music])
  const { createServer } = await import('vite')
  const server = await createServer({ root, server: { host: '127.0.0.1', port: 5294, strictPort: false, hmr: false, watch: null }, logLevel: 'error' })
  let browser
  try {
    await server.listen()
    browser = await chromium.launch({ executablePath: process.env.BROWSER_EXECUTABLE || process.env.CHROMIUM_PATH || chromium.executablePath(), headless: true, args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] })
    const page = await browser.newPage({ viewport: { width: 1640, height: 1700 } }), errors = []
    page.on('pageerror', error => errors.push(error.message))
    await page.route('**/__motion__', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><meta charset="utf-8"><style>body{margin:20px;background:#111827;color:#f8fafc;font:16px sans-serif}.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:18px}canvas{width:100%;display:block;border-radius:8px}p{margin:8px 0 0}</style><div class="grid"></div>' }))
    await page.route('**/__source.webm', route => route.fulfill({ contentType: 'video/webm', body: fs.readFileSync(source) }))
    await page.route('**/__music.wav', route => route.fulfill({ contentType: 'audio/wav', body: fs.readFileSync(music) }))
    await page.exposeFunction('saveArtifact', (name, base64) => { const file = path.join(directory, path.basename(name)); fs.writeFileSync(file, Buffer.from(base64, 'base64')); return file })
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__motion__`)
    const result = await page.evaluate(async () => {
      const { MOTION_STYLES } = await import('/src/core/motion-style-catalog.ts')
      const { renderMotionStyleArt } = await import('/src/core/motion-style-art.ts')
      const { composeMotionProject } = await import('/src/core/motion-style-composer.ts')
      const { createProject, createClip, validateProject } = await import('/src/core/project.ts')
      const { importMediaFile } = await import('/src/core/media-import.ts')
      const { TimelinePreview, drawTextClip } = await import('/src/core/preview.ts')
      const { prepareEditorTool } = await import('/src/core/editor-tool-service.ts')
      const { exportProjectFile, importProjectFile } = await import('/src/core/project-file.ts')
      const files = new Map()
      const importBlob = async (blob, name) => { const asset = await importMediaFile(new File([blob], name, { type: blob.type })); files.set(asset.id, blob); return asset }
      const image = document.createElement('canvas'); image.width = 640; image.height = 360
      const context = image.getContext('2d'); context.fillStyle = '#0d384a'; context.fillRect(0,0,640,360)
      context.fillStyle = '#14b8a6'; context.beginPath(); context.arc(440,155,110,0,Math.PI*2); context.fill()
      context.fillStyle = '#e2f6f4'; context.font = 'bold 56px sans-serif'; context.fillText('OPEN MEDIA',40,210)
      const still = await importBlob(await new Promise(resolve => image.toBlob(resolve,'image/png')), 'source-image.png')
      const video = await importBlob(await (await fetch('/__source.webm')).blob(),'source.webm')
      const sound = await importBlob(await (await fetch('/__music.wav')).blob(),'music.wav')
      let project = createProject('效果片段验证', {width:640,height:360,fps:24}); project.assets.push(still,video,sound)
      const stats = canvas => {
        const pixels = canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data
        let hash = 2166136261, luma = 0, visible = 0
        for(let i=0;i<pixels.length;i+=4){hash=Math.imul(hash^(pixels[i]+pixels[i+1]*3+pixels[i+2]*7),16777619);luma+=pixels[i]+pixels[i+1]+pixels[i+2];if(pixels[i+3]>0)visible++}
        return {hash:hash>>>0,luma:luma/(canvas.width*canvas.height*3),visible}
      }
      const checks=[]; let exportProject
      for(const style of MOTION_STYLES){
        const art=await renderMotionStyleArt(style.id,{},640,360)
        const resources={background:await importBlob(art.background,`${style.id}-background.png`),decoration:await importBlob(art.decoration,`${style.id}-decoration.png`)}
        const options={styleId:style.id,scenes:[{assetId:still.id,heading:'创意，从此动起来',caption:'素材 · 文字 · 节奏',duration:2},{assetId:video.id,heading:'生成效果片段，继续剪辑',duration:2}],musicAssetId:sound.id}
        const composed=composeMotionProject(project,options,resources).project
        const cell=document.createElement('div'), canvas=document.createElement('canvas'),label=document.createElement('p');canvas.width=640;canvas.height=360;label.textContent=style.name;cell.append(canvas,label);document.querySelector('.grid').append(cell)
        const preview=new TimelinePreview(canvas,composed);await preview.prepare();const samples=[]
        for(const time of [.06,1,2.7]){await preview.seekReady(time);preview.render(time);samples.push(stats(canvas))}
        await preview.seekReady(1);preview.render(1);preview.dispose()
        // Portrait layouts use the same generated assets and ordinary project renderer.
        const portrait=createProject('竖屏', {width:360,height:640,fps:24});portrait.assets=[still,video,sound]
        const p=composeMotionProject(portrait,options,resources).project,pc=document.createElement('canvas');pc.width=360;pc.height=640
        const pp=new TimelinePreview(pc,p);await pp.prepare();await pp.seekReady(1);pp.render(1);const portraitStats=stats(pc);pp.dispose();pc.width=pc.height=1
        checks.push({id:style.id,samples,portrait:portraitStats,backgroundBytes:art.background.size,decorationBytes:art.decoration.size})
        if(style.id==='neon-retro')exportProject=composed
      }
      const base64 = async blob => new Promise(resolve=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result).split(',')[1]);reader.readAsDataURL(blob)})
      // Exercise the public shared tool with an occupied, locked source timeline.
      // Only the returned encoded video belongs in the live project, not the
      // internal composition's artwork or text tracks.
      const sourceTrack=project.tracks.find(track=>track.kind==='video')
      sourceTrack.clips.push(createClip(video,project,{trimOut:2}));sourceTrack.locked=true
      project.markers=[{id:'existing-marker',time:1,label:'Existing edit',kind:'chapter',color:'#33aaff'}]
      project=validateProject(project,{trusted:true})
      const before=JSON.stringify(project),progress=[]
      const prepared=await prepareEditorTool('open_media_motion_clip_generate',{
        styleId:'neon-retro',title:'效果片段',scenes:[{assetId:still.id,heading:'创意，从此动起来',duration:2},{assetId:video.id,heading:'生成后继续剪辑',duration:2}],musicAssetId:sound.id,
        expectedRevision:9,expectedProjectId:project.id,
      },{project,revision:9,blobs:files,source:'mcp',signal:new AbortController().signal,onProgress:update=>progress.push(update),assertCurrent:()=>{if(JSON.stringify(project)!==before)throw new Error('Original project was mutated')}})
      if(!prepared.project||prepared.assets?.length!==1||prepared.project.assets.length!==project.assets.length+1)throw new Error('Generation must add exactly one actual video asset')
      if(JSON.stringify(prepared.project.tracks)!==JSON.stringify(project.tracks)||JSON.stringify(prepared.project.markers)!==JSON.stringify(project.markers))throw new Error('Asset-only generation changed original timeline')
      const generated=prepared.assets[0]
      if(generated.asset.kind!=='video'||!generated.blob?.size||prepared.data.assetId!==generated.asset.id)throw new Error('Missing encoded video result')
      if(JSON.stringify(prepared.data).includes('blob:'))throw new Error('MCP result leaked frontend-only URLs')
      await prepared.accept?.()
      const output=generated.blob
      await window.saveArtifact('motion-export.webm',await base64(output))
      const archive=await exportProjectFile(prepared.project,{blobs:new Map([...files,[generated.asset.id,output]])})
      const reopened=await importProjectFile(archive)
      const recovered=reopened.project.assets.find(asset=>asset.id===generated.asset.id)
      const decoded=await importMediaFile(new File([reopened.blobs.get(recovered.id)],recovered.name,{type:recovered.mime}))
      if(decoded.width!==640||decoded.height!==360||Math.abs(decoded.duration-4)>.3)throw new Error('Generated video did not survive save/reopen')
      URL.revokeObjectURL(decoded.url);reopened.revoke()
      const nativeProject=structuredClone(exportProject),textAssets={}
      for(const asset of nativeProject.assets)asset.nativePath=await window.saveArtifact(`${asset.id}-${asset.name}`,await base64(files.get(asset.id)))
      for(const track of nativeProject.tracks.filter(track=>track.kind==='text'))for(const clip of track.clips){
        const canvas=document.createElement('canvas');canvas.width=Math.ceil(clip.width);canvas.height=Math.ceil(clip.height);drawTextClip(canvas.getContext('2d'),clip)
        const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/png')),nativePath=await window.saveArtifact(`text-${clip.id}.png`,await base64(blob))
        textAssets[clip.id]={id:`text-${clip.id}`,name:`${clip.id}.png`,kind:'image',url:nativePath,nativePath,mime:'image/png',size:blob.size,width:canvas.width,height:canvas.height,duration:0}
      }
      await window.saveArtifact('native-project.json',await base64(new Blob([JSON.stringify({project:nativeProject,textAssets})],{type:'application/json'})))
      return {checks,outputBytes:output.size,generated:prepared.data,progress,savedProjectBytes:archive.size}
    })
    assert.equal(result.checks.length,15)
    assert.equal(new Set(result.checks.map(row=>row.samples[1].hash)).size,15,'15 distinct compositions')
    for(const row of result.checks){
      assert.notEqual(row.samples[0].hash,row.samples[1].hash,`${row.id}: entrance changes actual pixels`)
      assert.notEqual(row.samples[1].hash,row.samples[2].hash,`${row.id}: second scene changes actual pixels`)
      assert(row.samples[1].luma>5&&row.portrait.luma>5,`${row.id}: visible landscape and portrait`)
      assert(row.decorationBytes>1000&&row.backgroundBytes>1000)
    }
    assert(result.outputBytes>20000)
    await page.screenshot({path:path.join(directory,'gallery.png'),fullPage:true})
    const probe=JSON.parse(execFileSync('ffprobe',['-v','error','-show_streams','-show_format','-of','json',path.join(directory,'motion-export.webm')],{encoding:'utf8'}))
    assert(probe.streams.some(stream=>stream.codec_type==='video'&&stream.width===640&&stream.height===360))
    assert(probe.streams.some(stream=>stream.codec_type==='audio'),'music is present in encoded output')
    // Decode the complete output, then verify distinct source scenes survive actual encoding.
    execFileSync('ffmpeg',['-v','error','-i',path.join(directory,'motion-export.webm'),'-f','null','-'])
    const frames=[1,2.8].map(time=>execFileSync('ffmpeg',['-v','error','-ss',String(time),'-i',path.join(directory,'motion-export.webm'),'-frames:v','1','-vf','scale=64:36','-f','rawvideo','-pix_fmt','rgb24','-']))
    assert.equal(frames[0].length,64*36*3);assert.equal(frames[1].length,64*36*3);assert(!frames[0].equals(frames[1]))
    assert.deepEqual(errors,[])
    fs.writeFileSync(path.join(directory,'report.json'),JSON.stringify({...result,streams:probe.streams.map(s=>({codec:s.codec_name,type:s.codec_type,width:s.width,height:s.height})),errors},null,2))
    console.log(`PASS 15 styles, landscape/portrait motion, shared MCP tool encoding to one project asset, locked timeline preserved, save/reopen, video+music and complete decode. Artifacts: ${directory}`)
  } finally {await browser?.close();await server.close()}
}
main().catch(error=>{console.error(error);process.exitCode=1})
