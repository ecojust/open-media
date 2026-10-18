import test from 'node:test'
import assert from 'node:assert/strict'
import { createProject, createTextClip } from '../src/core/project.ts'
import { listMcpMaterials, prepareMcpMaterial } from '../src/core/mcp-materials.ts'

const music = { id: 'piano', title: '轻柔钢琴', style: '钢琴', description: '安静日常', duration: 30, url: '/assets/piano.mp3', filename: 'piano.mp3' }
const segment = { id: 'intro', title: '星光序章', style: '星空', description: '流动星光', placement: 'prepend', heading: '默认标题', subheading: '默认副标题', textColor: '#ffffff', duration: 5, width: 1280, height: 720, url: '/assets/intro.webm', posterUrl: '/assets/intro.jpg', filename: 'intro.webm' }
const watermark = { id: 'animated', name: '动态提示', category: '提示标注', tags: ['提示', '动画'], kind: 'video', url: '/watermarks/animated.mp4', fallbackUrl: '/watermarks/animated.webm', poster: '/watermarks/animated.png', duration: 4, width: 640, height: 360, placement: 'top-left', chromaKey: true, spillSuppression: true }
const textWatermark = { id: 'editable', name: '文字卡片', category: '可编辑文字', tags: ['文字', '标签'], kind: 'text', url: '', poster: '/watermarks/editable.png', duration: 5, width: 640, height: 360, placement: 'bottom-center', textTemplate: { text: '可编辑标题', color: '#fff', background: 'transparent', fontFamily: 'sans-serif', fontWeight: 600, textAlign: 'center', fontSize: 32, width: 500, height: 120 } }

function fixture(kind = 'audio', overrides = {}) {
  const requests = [], imports = [], notifications = []
  const blob = new Blob(['offline-bundled-media'], { type: kind === 'audio' ? 'audio/mpeg' : 'video/webm' })
  const asset = { id: 'prepared-media', name: '内置素材', kind, duration: kind === 'audio' ? 30 : 5, width: kind === 'audio' ? 0 : 1280, height: kind === 'audio' ? 0 : 720, size: blob.size, mime: blob.type, nativePath: '/tmp/open-media/prepared.wav', url: 'asset://localhost/prepared-media' }
  const dependencies = {
    loadMusic: async () => [music],
    loadVideoSegments: async () => [segment],
    loadWatermarks: async () => [watermark, textWatermark],
    chooseWatermarkSource: item => item.fallbackUrl ?? item.url,
    fetchBlob: async (url, signal) => { requests.push({ url, signal }); return blob },
    native: { isDesktop: () => true, importBlobAsset: async (bytes, name) => { imports.push({ bytes, name }); return { ...asset, name } } },
    onAsset: (prepared, bytes) => notifications.push({ prepared, bytes }),
    ...overrides,
  }
  return { requests, imports, notifications, dependencies, asset, blob }
}

test('素材目录支持关键词与分页，返回可用元数据而不泄漏内部地址', async () => {
  const f = fixture()
  const musicPage = await listMcpMaterials({ kind: 'music', search: '安静', offset: 0, limit: 1 }, f.dependencies)
  assert.equal(musicPage.total, 1)
  assert.equal(musicPage.items[0].name, '轻柔钢琴')
  assert.equal(musicPage.items[0].mediaKind, 'audio')
  const watermarkPage = await listMcpMaterials({ kind: 'watermark', search: '文字' }, f.dependencies)
  assert.equal(watermarkPage.total, 1)
  assert.equal(watermarkPage.items[0].editableText, true)
  assert.equal(watermarkPage.items[0].text, '可编辑标题')
  const segmentPage = await listMcpMaterials({ kind: 'video_segment' }, f.dependencies)
  assert.equal(segmentPage.items[0].heading, '默认标题')
  for (const page of [musicPage, watermarkPage, segmentPage]) assert.doesNotMatch(JSON.stringify(page), /url|poster|nativePath|\/assets\//i)
  assert.equal((await listMcpMaterials({ kind: 'music', offset: 5 }, f.dependencies)).items.length, 0)
  await assert.rejects(listMcpMaterials({ kind: 'music', limit: 101 }, f.dependencies), /分页/)
  await assert.rejects(listMcpMaterials({ kind: 'unknown' }, f.dependencies), /类型/)
})

test('真实内置水印目录能分页检索全部分类', async () => {
  const page = await listMcpMaterials({ kind: 'watermark', limit: 100 })
  assert.ok(page.total >= 500)
  assert.equal(page.items.length, 100)
  const editable = await listMcpMaterials({ kind: 'watermark', search: '可编辑文字', limit: 100 })
  assert.equal(editable.total, 132)
  assert.ok(editable.items.every(item => item.editableText))
  assert.doesNotMatch(JSON.stringify(page), /\/watermarks\//)
})

test('可编辑水印保留文字属性，不读取缩略图也不创建媒体素材', async () => {
  const f = fixture(), original = createProject(), before = structuredClone(original)
  const prepared = await prepareMcpMaterial(original, { kind: 'watermark', id: 'editable', start: 3 }, f.dependencies)
  const track = prepared.project.tracks.find(item => item.id === prepared.selection.trackId)
  const clip = track.clips.find(item => item.id === prepared.selection.clipId)
  assert.equal(track.kind, 'text')
  assert.equal(clip.text, '可编辑标题')
  assert.equal(clip.start, 3)
  assert.equal(clip.textRole, 'watermark')
  assert.equal(f.requests.length, 0)
  assert.equal(f.imports.length, 0)
  assert.equal(prepared.assets, undefined)
  assert.deepEqual(original, before)
})

test('动画水印使用可播放源并保留抠像及溢色设置，返回原生资源供主项目登记', async () => {
  const f = fixture('video'), project = createProject()
  const prepared = await prepareMcpMaterial(project, { kind: 'watermark', id: 'animated', start: 2 }, f.dependencies)
  assert.equal(f.requests[0].url, '/watermarks/animated.webm')
  assert.equal(f.imports[0].name, '动态提示.webm')
  const track = prepared.project.tracks.find(item => item.id === prepared.selection.trackId)
  const clip = track.clips[0]
  assert.equal(clip.chromaKey.enabled, true)
  assert.equal(clip.chromaKey.spillSuppression, true)
  assert.equal(clip.volume, 0)
  assert.equal(clip.start, 2)
  assert.equal(prepared.assets[0].blob, f.blob)
  assert.equal(prepared.assets[0].asset.nativePath, f.asset.nativePath)
  assert.equal(prepared.assets[0].asset.libraryRole, 'watermark')
  assert.equal(prepared.project.assets[0].libraryRole, 'watermark')
  assert.equal(f.notifications.length, 1)
  assert.equal(project.assets.length, 0)
})

test('背景音乐放入专用轨道，保留默认音量和淡入淡出', async () => {
  const f = fixture(), project = createProject()
  const prepared = await prepareMcpMaterial(project, { kind: 'music', id: 'piano', start: 7 }, f.dependencies)
  const track = prepared.project.tracks.find(item => item.id === prepared.selection.trackId)
  assert.equal(track.name, '背景音乐轨道')
  assert.equal(track.clips[0].start, 7)
  assert.equal(track.clips[0].volume, 0.3)
  assert.ok(track.clips[0].fadeIn > 0)
  assert.ok(track.clips[0].fadeOut > 0)
  assert.equal(f.requests[0].url, music.url)
  assert.equal(prepared.assets[0].asset.libraryRole, 'background-music')
  assert.equal(prepared.project.assets[0].libraryRole, 'background-music')
})

test('片头标题覆盖后仍可编辑，前插时所有既有片段整体后移', async () => {
  const f = fixture('video'), project = createProject()
  project.tracks[0].clips.push(createTextClip(project, { id: 'existing-text', text: '既有字幕', start: 1 }))
  const prepared = await prepareMcpMaterial(project, { kind: 'video_segment', id: 'intro', placement: 'prepend', heading: '新的标题', subheading: '' }, f.dependencies)
  assert.equal(prepared.project.tracks.flatMap(track => track.clips).find(clip => clip.id === 'existing-text').start, 6)
  const titles = prepared.project.tracks.find(track => track.name === '片头片尾文字')
  assert.equal(titles.clips.length, 1)
  assert.equal(titles.clips[0].text, '新的标题')
  assert.equal(titles.clips[0].start, 0)
  const clip = prepared.project.tracks.flatMap(track => track.clips).find(item => item.id === prepared.selection.clipId)
  assert.equal(clip.start, 0)
  assert.equal(project.tracks[0].clips[0].start, 1)
  assert.equal(prepared.assets[0].asset.libraryRole, 'video-segment')
  assert.equal(prepared.project.assets[0].libraryRole, 'video-segment')
})

test('无效ID、标题、平台及外部素材地址在读取前拒绝', async () => {
  const project = createProject(), f = fixture()
  await assert.rejects(prepareMcpMaterial(project, { kind: 'music', id: 'https://example.com/file' }, f.dependencies), /标识/)
  await assert.rejects(prepareMcpMaterial(project, { kind: 'music', id: 'missing' }, f.dependencies), /找不到/)
  await assert.rejects(prepareMcpMaterial(project, { kind: 'video_segment', id: 'intro', heading: 'a'.repeat(121) }, f.dependencies), /120/)
  await assert.rejects(prepareMcpMaterial(project, { kind: 'music', id: 'piano', heading: '不支持' }, f.dependencies), /仅适用/)
  await assert.rejects(prepareMcpMaterial(project, { kind: 'music', id: 'piano' }, { ...f.dependencies, native: { ...f.dependencies.native, isDesktop: () => false } }), /桌面端/)
  for (const url of ['https://example.com/music.mp3', '//example.com/music.mp3', '/assets/../music.mp3']) {
    await assert.rejects(prepareMcpMaterial(project, { kind: 'music', id: 'piano' }, { ...f.dependencies, loadMusic: async () => [{ ...music, url }] }), /地址无效/)
  }
  assert.equal(f.requests.length, 0)
  assert.equal(f.imports.length, 0)
})

test('预先取消不进行导入，导入期间取消会释放临时预览地址且不登记素材', async () => {
  const project = createProject(), cancelled = new AbortController(), f = fixture()
  cancelled.abort()
  await assert.rejects(prepareMcpMaterial(project, { kind: 'music', id: 'piano' }, { ...f.dependencies, signal: cancelled.signal }), { name: 'AbortError' })
  assert.equal(f.requests.length, 0)
  const controller = new AbortController(), revoked = [], previous = URL.revokeObjectURL
  URL.revokeObjectURL = url => revoked.push(url)
  try {
    await assert.rejects(prepareMcpMaterial(project, { kind: 'music', id: 'piano' }, {
      ...f.dependencies, signal: controller.signal,
      native: { isDesktop: () => true, importBlobAsset: async () => { controller.abort(); return { ...f.asset, url: 'blob:temporary-preview', sourceUrl: 'blob:temporary-source' } } },
    }), { name: 'AbortError' })
  } finally { URL.revokeObjectURL = previous }
  assert.deepEqual(revoked, ['blob:temporary-preview', 'blob:temporary-source'])
  assert.equal(f.notifications.length, 0)
  assert.equal(project.assets.length, 0)
})

test('空文件、媒体类型不符及锁定前插均不修改项目', async () => {
  const project = createProject(), f = fixture()
  await assert.rejects(prepareMcpMaterial(project, { kind: 'music', id: 'piano' }, { ...f.dependencies, fetchBlob: async () => new Blob([]) }), /文件为空/)
  await assert.rejects(prepareMcpMaterial(project, { kind: 'video_segment', id: 'intro' }, f.dependencies), /本地媒体文件/)
  project.tracks[0].locked = true
  project.tracks[0].clips.push(createTextClip(project, { text: '锁定字幕' }))
  const video = fixture('video'), before = structuredClone(project)
  await assert.rejects(prepareMcpMaterial(project, { kind: 'video_segment', id: 'intro' }, video.dependencies), /解锁/)
  assert.deepEqual(project, before)
  assert.equal(video.notifications.length, 0)
})

test('科普素材可按主题找到，元数据区分片头片尾并隐藏打包路径', async () => {
  const { VIDEO_SEGMENT_PRESETS } = await import('../src/core/video-segment-presets.ts')
  const loadVideoSegments = async () => VIDEO_SEGMENT_PRESETS.map(item => ({ ...item, url: `/assets/${item.id}.webm`, posterUrl: `/assets/${item.id}.jpg`, filename: `${item.id}.webm`, duration: 5, width: 1280, height: 720 }))
  const segments = await listMcpMaterials({ kind: 'video_segment', search: '科普', limit: 100 }, { loadVideoSegments })
  assert.equal(segments.total, 12)
  assert.equal(segments.items.filter(item => item.placement === 'prepend').length, 6)
  assert.equal(segments.items.filter(item => item.placement === 'append').length, 6)
  assert(segments.items.every(item => item.collection === 'science' && item.editableText && item.tags.includes('科普')))
  assert(!JSON.stringify(segments).includes('/assets/'))
  const watermarks = await listMcpMaterials({ kind: 'watermark', search: '科普', limit: 100 })
  const science = watermarks.items.filter(item => item.collection === 'science')
  assert.equal(science.length, 24)
  assert.equal(science.filter(item => item.editableText).length, 8)
  assert(science.every(item => item.tags.includes('科普')))
})

test('通用模板通过专题检索，文字、配色、时长和动作一次应用且不导入媒体', async () => {
  const page = await listMcpMaterials({ kind: 'watermark', collection: 'general', limit: 100 })
  assert.equal(page.total, 24)
  assert(page.items.every(item => item.editableText && item.collection === 'general'))
  const f = fixture(), original = createProject()
  const result = await prepareMcpMaterial(original, {
    kind: 'watermark', id: page.items[0].id, start: 2, text: '这是我的内容', color: '#fedcba',
    background: 'transparent', duration: 7, animation: 'slide-left', watermarkPlacement: 'top-right',
  }, { ...f.dependencies, loadWatermarks: undefined })
  const clip = result.project.tracks.flatMap(track => track.clips).find(clip => clip.id === result.selection.clipId)
  assert.equal(clip.text, '这是我的内容'); assert.equal(clip.color, '#fedcba'); assert.equal(clip.trimOut, 7)
  assert.equal(clip.start, 2); assert.equal(clip.background, 'transparent')
  assert(clip.keyframes.x[0].value > clip.x); assert.equal(clip.keyframes.x[1].value, clip.x)
  assert.equal(clip.keyframes.opacity.at(-1).time, 7); assert.equal(f.imports.length, 0)
  assert.equal(original.tracks.flatMap(track => track.clips).length, 0)
  for (const args of [{ kind: 'music', id: 'piano', text: '不能静默忽略' }, { kind: 'watermark', id: 'animated', animation: 'fade' }, { kind: 'music', id: 'piano', duration: 7 }]) {
    await assert.rejects(prepareMcpMaterial(original, args, f.dependencies), /仅适用|时长/)
  }
  await assert.rejects(listMcpMaterials({ kind: 'watermark', collection: 'invalid' }), /专题/)
})

test('片头片尾自定义时长使用完整动画，标题布局保持可编辑且原项目原子后移', async () => {
  const f = fixture('video'), project = createProject()
  project.tracks[0].clips.push(createTextClip(project, { id: 'existing', text: '既有内容', start: 2 }))
  const result = await prepareMcpMaterial(project, { kind: 'video_segment', id: 'intro', duration: 8, titleLayout: 'left', heading: '自定义章节' }, f.dependencies)
  const clips = result.project.tracks.flatMap(track => track.clips)
  const movie = clips.find(clip => clip.id === result.selection.clipId)
  assert.equal(movie.trimOut, 5); assert.equal(movie.speed, 5 / 8)
  assert.equal(clips.find(clip => clip.id === 'existing').start, 10)
  const title = clips.find(clip => clip.text === '自定义章节')
  assert.equal(title.trimOut, 8); assert.equal(title.textAlign, 'left')
  assert.equal(project.tracks[0].clips[0].start, 2)
  await assert.rejects(prepareMcpMaterial(project, { kind: 'video_segment', id: 'intro', duration: 40 }, f.dependencies), /时长/)
  await assert.rejects(prepareMcpMaterial(project, { kind: 'watermark', id: 'editable', titleLayout: 'left' }, f.dependencies), /仅适用/)
})
