import test from 'node:test'
import assert from 'node:assert/strict'
import { createProject, createClip, createTextClip, createTrack } from '../src/core/project.ts'
import { addAsset, addClip, createHistory, commitHistory, undoHistory, sourceTimeAt } from '../src/core/timeline.ts'
import { speedSegments } from '../src/core/visual-animation.ts'
import { addRhythmMarkers, analyzeRhythm, rhythmCandidates, rhythmSelectedDuration, rhythmSignature, rhythmTime, rhythmTimelineTime, rhythmVideoEntries } from '../src/core/rhythm-assist.ts'

const defaults = { scope: 'project', minimum: .5, noiseDb: -45 }
function fixture() {
  let project = createProject('节奏检查')
  const asset = { id: 'source', kind: 'video', name: '操作演示.mp4', url: 'blob:source', duration: 60, width: 1920, height: 1080, size: 1024, mime: 'video/mp4' }
  project = addAsset(project, asset)
  const clip = createClip(asset, project, { id: 'video-a', start: 10, trimIn: 12, trimOut: 32, speed: 2 })
  project = addClip(project, project.tracks[1].id, clip)
  return { project, asset, clip }
}
const detected = (start, end, kind = 'freeze') => ({ kind, start, end, confidence: 1, evidence: { detector: kind, noiseDb: -50 } })
const values = (...intervals) => new Map([['source', { timeBase: 'assetSeconds', intervals }]])
const reportFor = (project, candidates) => ({ signature: rhythmSignature(project), candidates, errors: [], noAudioAssets: [], assetCount: 1, clipCount: 1, repetitionLimited: false })

test('节奏候选按裁切与倍速映射为时间线范围，并排除未使用源区间', () => {
  const { project } = fixture()
  const result = rhythmCandidates(project, values(detected(1, 5), detected(10, 18), detected(30, 50)), defaults)
  assert.deepEqual(result.map(item => [item.start, item.end, item.sourceStart, item.sourceEnd]), [[10, 13, 12, 18], [19, 20, 30, 32]])
  assert.equal(result[0].clipId, 'video-a')
  assert.equal(result[0].evidence[0].description, '连续画面变化低于静止检测阈值')
})

test('相同素材分割后分别映射，仅选中片段的范围不会混入其他片段', () => {
  let { project, asset } = fixture()
  project = addClip(project, project.tracks[1].id, createClip(asset, project, { id: 'video-b', start: 25, trimIn: 16, trimOut: 20 }))
  const response = values(detected(16, 20))
  assert.deepEqual(rhythmCandidates(project, response, defaults).map(item => [item.clipId, item.start, item.end]), [['video-a', 12, 14], ['video-b', 25, 29]])
  assert.deepEqual(rhythmCandidates(project, response, { ...defaults, scope: 'selected', selectedClipId: 'video-b' }).map(item => item.clipId), ['video-b'])
})

test('变速曲线与裁切保留的源范围使用播放一致的逆映射', () => {
  let { project, asset } = fixture()
  const clip = createClip(asset, project, { id: 'ramp', start: 30, trimIn: 5, trimOut: 25, speed: 1.5, speedRamp: { points: [{ position: 0, speed: .5 }, { position: .5, speed: 3 }, { position: 1, speed: 1 }], easing: 'ease-in-out', preservePitch: true, sourceRange: { start: 0, end: 40 } } })
  project = addClip(project, project.tracks[1].id, clip)
  for (const source of [5, 6, 10, 12.5, 18, 24.99, 25]) assert.ok(Math.abs(sourceTimeAt(clip, rhythmTimelineTime(clip, source)) - source) < 1e-8)
  const result = rhythmCandidates(project, values(detected(8, 18)), { ...defaults, scope: 'selected', selectedClipId: 'ramp' })
  assert.equal(result.length, 1)
  assert.ok(Math.abs(result[0].start - rhythmTimelineTime(clip, 8)) < 1e-8)
  assert.ok(Math.abs(result[0].end - rhythmTimelineTime(clip, 18)) < 1e-8)
  assert.ok(Math.abs(result[0].sourceEnd - 18) < 1e-8)
})

test('源静音与局部静止的重叠按实际边界区分，不把整段标成静止', () => {
  const { project } = fixture()
  const result = rhythmCandidates(project, values(detected(12, 32, 'silence'), detected(16, 20)), defaults)
  assert.deepEqual(result.map(item => [item.start, item.end, item.evidence.map(evidence => evidence.kind)]), [[10, 12, ['silence']], [12, 14, ['freeze', 'silence']], [14, 20, ['silence']]])
  assert.equal(result[0].evidence[0].description, '源声音持续低于 -50 dB')
  assert.equal(rhythmSelectedDuration(result), 10)
})

test('达到最短持续时长的连续检测重叠后仍保留全部证据切片', () => {
  const { project } = fixture()
  Object.assign(project.tracks[1].clips[0], { start: 0, trimIn: 0, trimOut: 10, speed: 1 })
  const result = rhythmCandidates(project, values(detected(0, 2), detected(1, 3, 'silence'), detected(5, 6, 'black')), { ...defaults, minimum: 2 })
  assert.deepEqual(result.map(item => [item.start, item.end, item.evidence.map(evidence => evidence.kind)]), [[0, 1, ['freeze']], [1, 2, ['freeze', 'silence']], [2, 3, ['silence']]])
  assert.equal(rhythmSelectedDuration(result), 3)
  assert.equal(result.some(item => item.evidence.some(evidence => evidence.kind === 'black')), false, '独立不足最短时长的检测应排除')
})

test('重叠检测先按裁切变速后的连续区间判断时长，再保留较短的依据切片', () => {
  const { project } = fixture()
  const result = rhythmCandidates(project, values(detected(10, 16), detected(14, 18, 'silence'), detected(30, 35, 'black')), { ...defaults, minimum: 2 })
  assert.deepEqual(result.map(item => [item.start, item.end, item.evidence.map(evidence => evidence.kind)]), [[10, 11, ['freeze']], [11, 12, ['freeze', 'silence']], [12, 13, ['silence']]])
  assert.equal(rhythmSelectedDuration(result), 3)
  assert.equal(result.some(item => item.evidence.some(evidence => evidence.kind === 'black')), false, '源区间虽长，但裁切变速后仅一秒，应排除')
})

test('持续阈值使用变速后的时间，重复检测结果带源参照信息', () => {
  const { project } = fixture()
  assert.equal(rhythmCandidates(project, values(detected(12, 14)), { ...defaults, minimum: 2 }).length, 0)
  const result = rhythmCandidates(project, new Map([['source', { repeatedIntervals: [{ start: 16, end: 24, referenceStart: 2, confidence: .96 }] }]]), { ...defaults, minimum: 2 })
  assert.equal(result[0].evidence[0].kind, 'repeat')
  assert.equal(result[0].evidence[0].confidence, .96)
  assert.match(result[0].evidence[0].description, /00:02\.000/)
})

test('检测排除隐藏视频、主动定格与内置装饰素材，保留有透明度动画的画面', () => {
  let { project, asset, clip } = fixture()
  const original = { trimIn: 0, trimOut: 4, speed: 1, volume: 1 }
  project.tracks[1].clips.push({ ...clip, id: 'freeze', start: 30, freezeFrame: { sourceTime: 1, original } }, { ...clip, id: 'transparent', start: 30, opacity: 0 }, { ...clip, id: 'animated', start: 30, opacity: 0, keyframes: { opacity: [{ time: 1, value: 1 }] } })
  const builtIn = { ...asset, id: 'decoration', libraryRole: 'watermark' }
  project.assets.push(builtIn)
  project.tracks[1].clips.push({ ...clip, id: 'library', assetId: builtIn.id })
  const hidden = createTrack('video'); hidden.muted = true; hidden.clips.push({ ...clip, id: 'hidden' }); project.tracks.push(hidden)
  assert.deepEqual(rhythmVideoEntries(project).map(entry => entry.clip.id), ['video-a', 'animated'])
})

test('候选显示同期字幕、配音、转场与锁轨，检测本身不改工程', () => {
  const { project, clip } = fixture()
  project.tracks[1].locked = true
  project.tracks[0].clips.push(createTextClip(project, { id: 'text', start: 12, trimOut: 2, text: '正在解释重要信息' }))
  project.tracks[2].clips.push({ ...clip, id: 'speech', start: 12, trimIn: 0, trimOut: 2, speed: 1, speech: { text: '重要信息', voiceId: 'voice', rate: 1 } })
  const transition = createTrack('transition'); transition.clips.push({ ...clip, id: 'transition', start: 12, trimIn: 0, trimOut: 2, speed: 1 }); project.tracks.push(transition)
  const before = structuredClone(project)
  const result = rhythmCandidates(project, values(detected(16, 20)), defaults)
  assert.deepEqual(result[0].context, ['所在轨道已锁定', '同期有字幕 / 标注', '同期有配音', '同期有转场'])
  assert.deepEqual(project, before)
})

test('多个画面叠加的候选时长按时间线并集统计，不虚报节省时间', () => {
  assert.equal(rhythmSelectedDuration([{ start: 3, end: 8 }, { start: 1, end: 4 }, { start: 5, end: 6 }, { start: 10, end: 13 }, { start: 13, end: 15 }]), 12)
  assert.equal(rhythmSelectedDuration([]), 0)
})

test('所有素材仅分析一次，最小源时长根据较慢片段换算并报告真实素材进度', async () => {
  let { project, asset } = fixture()
  project = addClip(project, project.tracks[1].id, createClip(asset, project, { id: 'slow', start: 30, trimIn: 20, trimOut: 30, speed: .5 }))
  const calls = [], progress = [], controller = new AbortController()
  const report = await analyzeRhythm(project, { ...defaults, minimum: 2 }, async (name, args, options) => {
    calls.push({ name, args }); options.onProgress({ stage: '正在检测' })
    return { data: { intervals: [detected(20, 24)], detectors: ['freeze'], repetitionScope: { truncated: true } } }
  }, { signal: controller.signal, onProgress: update => progress.push(update) })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].name, 'open_media_asset_detect_idle')
  assert.equal(calls[0].args.minDuration, 1)
  assert.equal(report.clipCount, 2)
  assert.equal(report.assetCount, 1)
  assert.deepEqual(report.noAudioAssets, [asset.name])
  assert.equal(report.repetitionLimited, true)
  assert.deepEqual(progress.map(update => update.progress), [0, 0, 1])
  assert.deepEqual(report.candidates.map(item => item.end - item.start), [2, 8])
})

test('曲线变速的慢速部分决定分析源阈值，防止漏掉时间线长等待', async () => {
  const { project, clip } = fixture()
  clip.speedRamp = { points: [{ position: 0, speed: .1 }, { position: 1, speed: 2 }], easing: 'linear', preservePitch: true }
  project.tracks[1].clips[0] = clip
  let actual
  await analyzeRhythm(project, { ...defaults, minimum: 2 }, async (_name, args) => { actual = args.minDuration; return { intervals: [] } }, { signal: new AbortController().signal, onProgress: () => {} })
  assert.equal(actual, Math.max(.05, Math.min(...speedSegments(clip).map(segment => segment.speed)) * 2))
})

test('取消会终止后续素材，不接受取消后才返回的检测结果', async () => {
  const { project } = fixture(), controller = new AbortController()
  let calls = 0
  await assert.rejects(analyzeRhythm(project, defaults, async () => { calls++; controller.abort(); return { intervals: [detected(12, 18)] } }, { signal: controller.signal, onProgress: () => {} }), { name: 'AbortError' })
  assert.equal(calls, 1)
})

test('单个素材失败明确返回错误，其他素材仍能完成分析', async () => {
  let { project, asset } = fixture()
  const second = { ...asset, id: 'second', name: '其他视频.mp4' }
  project = addAsset(project, second)
  project = addClip(project, project.tracks[1].id, createClip(second, project, { id: 'second-clip', start: 30, trimOut: 5 }))
  const report = await analyzeRhythm(project, defaults, async (_name, args) => { if (args.assetId === 'source') throw new Error('文件不可读取'); return { intervals: [detected(1, 4)], detectors: ['freeze', 'silence'] } }, { signal: new AbortController().signal, onProgress: () => {} })
  assert.deepEqual(report.errors, ['操作演示.mp4：文件不可读取'])
  assert.equal(report.candidates.length, 1)
  assert.equal(report.candidates[0].clipId, 'second-clip')
})

test('标记一次提交、保留原有标记与所有轨道，重复添加幂等并可整体撤销', () => {
  const { project } = fixture()
  project.markers = [{ id: 'existing', time: 0, label: '开始', kind: 'chapter' }]
  const before = structuredClone(project), candidates = rhythmCandidates(project, values(detected(14, 18), detected(22, 26)), defaults)
  const report = reportFor(project, candidates)
  const result = addRhythmMarkers(project, report, candidates.map(item => item.id))
  assert.equal(result.markers.length, 3)
  assert.deepEqual(result.tracks, project.tracks)
  assert.deepEqual(result.markers[0], project.markers[0])
  assert.equal(result.markers[1].kind, 'review')
  assert.match(result.markers[1].label, /00:11\.000–00:13\.000/)
  assert.equal(addRhythmMarkers(result, report, candidates.map(item => item.id)), result)
  assert.deepEqual(undoHistory(commitHistory(createHistory(project), result)).present, before)
  assert.deepEqual(project, before)
})

test('工程源、裁切或时间改变使结果失效，而标记与选择变化不影响分析', () => {
  const { project } = fixture(), report = reportFor(project, rhythmCandidates(project, values(detected(14, 18)), defaults))
  const changed = structuredClone(project)
  changed.tracks[1].clips[0].start++
  assert.throws(() => addRhythmMarkers(changed, report, [report.candidates[0].id]), /重新分析/)
  changed.tracks[1].clips[0].start--
  changed.assets[0].nativePath = '/new/file.mp4'
  assert.notEqual(rhythmSignature(changed), report.signature)
  const same = structuredClone(project); same.markers = [{ id: 'new-marker', time: 0, label: '新标记', kind: 'review' }]
  assert.equal(rhythmSignature(same), report.signature)
  assert.throws(() => addRhythmMarkers(project, report, ['stale-id']), /失效/)
})

test('标记数量上限拒绝整个变更，不会留下部分结果', () => {
  const { project } = fixture()
  project.markers = Array.from({ length: 1000 }, (_, index) => ({ id: `marker-${index}`, time: 0, label: `标记${index}`, kind: 'review' }))
  const report = reportFor(project, rhythmCandidates(project, values(detected(14, 18)), defaults)), before = structuredClone(project)
  assert.throws(() => addRhythmMarkers(project, report, [report.candidates[0].id]), /1000/)
  assert.deepEqual(project, before)
})

test('异常区间与非法检测参数不会生成误导候选', async () => {
  const { project } = fixture()
  assert.equal(rhythmCandidates(project, values(detected(NaN, 17), detected(16, Infinity), detected(20, 10), detected(-2, 30), detected(12, 18, 'unknown')), defaults).length, 0)
  assert.throws(() => rhythmCandidates(project, values(), { ...defaults, minimum: NaN }), /0.5–60/)
  await assert.rejects(analyzeRhythm(project, { ...defaults, noiseDb: Infinity }, async () => {}, { signal: new AbortController().signal, onProgress: () => {} }), /-80 至 -10/)
  assert.equal(rhythmTime(59.9996), '01:00.000')
})
