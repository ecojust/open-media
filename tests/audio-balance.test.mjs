import test from 'node:test'
import assert from 'node:assert/strict'
import { createClip, createProject, createTrack, validateProject } from '../src/core/project.ts'
import { prepareAudioBalance, musicDuckingKeyframes, ownsDuckingKeyframes } from '../src/core/audio-balance.ts'
import { animatedClipAt } from '../src/core/visual-animation.ts'
import { findClip } from '../src/core/timeline.ts'

function fixture() {
  const project = createProject('声音平衡')
  const asset = { id: 'voice', name: '旁白', kind: 'audio', url: 'blob:voice', nativePath: '/voice.wav', duration: 4, width: 0, height: 0, size: 2000, mime: 'audio/wav' }
  const music = { ...asset, id: 'music', name: '背景音乐', duration: 20 }
  project.assets.push(asset, music)
  const speech = createTrack('audio', '旁白'), background = createTrack('audio', '背景音乐')
  speech.id = 'speech'; background.id = 'background'
  speech.clips.push(createClip(asset, project, { id: 'one', start: 2, volume: .5 }), createClip(asset, project, { id: 'two', start: 10, volume: 1 }))
  background.clips.push(createClip(music, project, { id: 'bed', volume: .7 }))
  project.tracks.push(speech, background)
  return project
}
const options = { speechTrackIds: ['speech'], musicTrackIds: ['background'] }
function context(project, controller = new AbortController()) { return { project, revision: 1, signal: controller.signal, source: 'gui', blobs: new Map(), onProgress() {} } }
function analyze(project, calls = []) { return async (id, ctx) => {
  calls.push(id)
  const clip = findClip(project, id).clip, i = -20 + 20 * Math.log10(clip.volume), tp = -10 + 20 * Math.log10(clip.volume)
  ctx.onProgress({ stage: '真实分析', progress: .4 })
  return { data: { integratedLufs: i, truePeakDbtp: tp }, accept: async () => {}, discard: async () => {} }
} }
test('声音平衡原子准备，不改原项目与素材，旁白和音乐可一起撤销', async () => {
  const project = fixture(), before = structuredClone(project), updates = []
  const result = await prepareAudioBalance(project, options, { ...context(project), onProgress: update => updates.push(update) }, analyze(project))
  assert.deepEqual(project, before)
  assert.deepEqual(result.project.assets, project.assets)
  assert.equal(result.data.normalizedCount, 2); assert.equal(result.data.duckedCount, 1)
  assert.ok(updates.some(update => update.stage.includes('1/2') && update.progress > 0 && update.progress < 1))
  assert.equal(updates.at(-1).progress, 1)
  const bed = findClip(result.project, 'bed').clip
  assert.ok(ownsDuckingKeyframes(bed))
  assert.ok(animatedClipAt(bed, 3).volume < .2)
  assert.equal(animatedClipAt(bed, 8).volume, .7)
})
test('重复应用按当前音量重新测量且自动曲线替换，不会叠加压低', async () => {
  const project = fixture(), first = await prepareAudioBalance(project, options, context(project), analyze(project))
  const second = await prepareAudioBalance(first.project, options, context(first.project), analyze(first.project))
  for (const id of ['one', 'two']) assert.ok(Math.abs(findClip(first.project, id).clip.volume - findClip(second.project, id).clip.volume) < 1e-10)
  assert.deepEqual(findClip(first.project, 'bed').clip, findClip(second.project, 'bed').clip)
  assert.equal(second.data.normalizedCount, 0)
})
test('预检查保护锁定人声与音乐轨，不启动任何分析', async () => {
  for (const id of ['speech', 'background']) {
    const project = fixture(), calls = []; project.tracks.find(track => track.id === id).locked = true
    await assert.rejects(prepareAudioBalance(project, options, context(project), analyze(project, calls)), /锁定/)
    assert.deepEqual(calls, [])
  }
})
test('只降低音乐可以读取锁定人声，但不允许修改锁定音乐', async () => {
  const project = fixture(); project.tracks.find(track => track.id === 'speech').locked = true
  const result = await prepareAudioBalance(project, { ...options, normalize: false }, context(project), async () => { throw Error('should not measure') })
  assert.equal(result.data.duckedCount, 1)
})
test('手动音量曲线受到保护，包括修改过的自动曲线', async () => {
  const project = fixture(), first = await prepareAudioBalance(project, options, context(project), analyze(project))
  findClip(first.project, 'bed').clip.keyframes.volume[1].value += .01
  await assert.rejects(prepareAudioBalance(first.project, options, context(first.project), analyze(first.project)), /手动音量/)
})
test('中途分析失败或取消没有部分工程变更，并丢弃未接收结果', async () => {
  const project = fixture(), before = structuredClone(project), controller = new AbortController(), cleaned = []
  await assert.rejects(prepareAudioBalance(project, options, context(project, controller), async (id) => {
    if (id === 'two') controller.abort()
    return { data: { integratedLufs: -20, truePeakDbtp: -5 }, discard: () => cleaned.push(id) }
  }), /abort/i)
  assert.deepEqual(project, before); assert.deepEqual(cleaned, ['two'])
})
test('真峰值和200%音量上限限制增益，并诚实报告未达到目标的片段', async () => {
  const project = fixture()
  const result = await prepareAudioBalance(project, { ...options, ducking: false }, context(project), async id => ({ data: { integratedLufs: -30, truePeakDbtp: id === 'one' ? -.5 : -25 } }))
  const a = result.data.measurements[0], b = result.data.measurements[1]
  assert.equal(a.estimatedPeak, -1); assert.ok(a.volume < .5)
  assert.equal(b.volume, 2); assert.equal(result.data.limitedCount, 2)
})
test('静音不能伪造测量，缺失测量不能修改工程', async () => {
  const project = fixture()
  const silent = await prepareAudioBalance(project, { ...options, ducking: false }, context(project), async () => ({ data: { silent: true } }))
  assert.equal(silent.data.skipped.length, 2); assert.equal(silent.data.normalizedCount, 0)
  await assert.rejects(prepareAudioBalance(project, options, context(project), async () => ({ data: { integratedLufs: null, truePeakDbtp: null } })), /有效的响度/)
})
test('自动压低处理片段起点、动画偏移和截断恢复区间', () => {
  const project = fixture(), clip = findClip(project, 'bed').clip
  clip.animationOffset = 7; clip.trimOut = 3
  const frames = musicDuckingKeyframes(clip, [{ start: .5, end: 2.8 }], 12, .15, .6)
  assert.equal(frames[0].time, 7); assert.equal(frames.at(-1).time, 10)
  assert.ok(frames.at(-1).value < clip.volume)
  clip.keyframes = { volume: frames }
  assert.ok(animatedClipAt(clip, 1).volume < .2)
})
test('短停顿保持压低，长停顿恢复；片段从人声中间开始也保持压低', () => {
  const clip = findClip(fixture(), 'bed').clip
  clip.keyframes = { volume: musicDuckingKeyframes(clip, [{ start: -2, end: 2 }, { start: 2.5, end: 4 }, { start: 10, end: 12 }]) }
  assert.ok(animatedClipAt(clip, 0).volume < .2)
  assert.ok(animatedClipAt(clip, 2.3).volume < .2)
  assert.equal(animatedClipAt(clip, 7).volume, .7)
})
test('人声移走后重新应用可清除旧自动压低，而非遗留失效关键帧', async () => {
  const project = fixture(), first = await prepareAudioBalance(project, options, context(project), analyze(project))
  first.project.tracks.find(track => track.id === 'speech').clips.forEach(clip => { clip.start += 100 })
  const second = await prepareAudioBalance(first.project, { ...options, normalize: false }, context(first.project), analyze(first.project))
  assert.equal(findClip(second.project, 'bed').clip.keyframes, undefined)
  assert.equal(findClip(second.project, 'bed').clip.audioBalance, undefined)
  assert.equal(second.data.restoredCount, 1)
})
test('保存打开保留自动曲线归属，非法归属和非音频属性被拒绝', async () => {
  const project = fixture(), result = await prepareAudioBalance(project, options, context(project), analyze(project))
  const reopened = validateProject(JSON.parse(JSON.stringify(result.project)), { trusted: true })
  assert.ok(ownsDuckingKeyframes(findClip(reopened, 'bed').clip))
  findClip(reopened, 'bed').clip.audioBalance.ducking.keyframes[0].value = 9
  assert.throws(() => validateProject(reopened, { trusted: true }), /关键帧值/)
})
test('用户自定义音量关键帧和变速人声拒绝自动归一化', async () => {
  const project = fixture(); findClip(project, 'one').clip.keyframes = { volume: [{ time: 0, value: .5 }] }
  await assert.rejects(prepareAudioBalance(project, options, context(project), analyze(project)), /变速或音量关键帧/)
})
test('过多分散人声区间在分析前拒绝，不截断关键帧或留下半成品', async () => {
  const project = fixture(), bed = findClip(project, 'bed').clip
  bed.trimOut = 300
  assert.throws(() => musicDuckingKeyframes(bed, Array.from({ length: 50 }, (_, index) => ({ start: index * 5 + 1, end: index * 5 + 2 }))), /分割/)
})
