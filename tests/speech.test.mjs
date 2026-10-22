import test from 'node:test'
import assert from 'node:assert/strict'
import { createClip, createProject, createTextClip, createTrack, MAX_ASSETS, MAX_CLIPS, MAX_TRACKS, MAX_PROJECT_DURATION, validateProject } from '../src/core/project.ts'
import { addAsset, addClip, addTrack, clipDuration, commitHistory, createHistory, deleteClip, duplicateClip, findClip, moveClip, redoHistory, removeTrack, setTrack, splitClip, undoHistory, updateClip } from '../src/core/timeline.ts'
import { alignTextToSpeech, applySpeechResults, planSpeech, validateSpeechPlanCapacity } from '../src/core/speech.ts'
import { exportProjectFile, importProjectFile } from '../src/core/project-file.ts'

function audio(id, duration = 4, overrides = {}) {
  return { id, name: `${id}.wav`, kind: 'audio', url: `blob:${id}`, duration, width: 0, height: 0, size: 100, mime: 'audio/wav', ...overrides }
}

function fixture() {
  let project = createProject('文字配音')
  const text = createTextClip(project, { id: 'text-first', text: ' 第一段文字。 ', start: 2, trimIn: 1, trimOut: 11, speed: 2, fadeIn: 3, fadeOut: 4 })
  const second = createTextClip(project, { id: 'text-second', text: '第二段文字。', start: 8, trimOut: 3 })
  const music = audio('background-music', 30)
  project = addAsset(project, music)
  project = addClip(project, project.tracks.find(track => track.kind === 'audio').id, createClip(music, project, { id: 'music-clip', start: 1 }))
  project = addClip(project, project.tracks.find(track => track.kind === 'text').id, text)
  project = addClip(project, project.tracks.find(track => track.kind === 'text').id, second)
  return { project, text, second, music }
}

function result(project, clipId, assetId, duration = 4) {
  const [source] = planSpeech(project, [clipId]).sources
  return { source, asset: audio(assetId, duration), voiceId: 'voice-local-1', rate: 1 }
}

test('批量计划按字幕起点排列，空白、锁定与非字幕片段有明确跳过原因', () => {
  let { project, text, second } = fixture()
  project = addClip(project, project.tracks.find(track => track.kind === 'text').id, createTextClip(project, { id: 'blank-text', text: ' \n  ' }))
  const plan = planSpeech(project, [second.id, text.id, text.id, 'blank-text', 'music-clip', 'missing'])
  assert.deepEqual(plan.sources.map((source) => source.clipId), [text.id, second.id])
  assert.equal(plan.sources[0].text, '第一段文字。')
  assert.equal(plan.sources[0].duration, 5)
  assert.equal(plan.skipped.length, 3)
  assert.match(plan.skipped[0].reason, /为空/)
  assert.match(plan.skipped[1].reason, /不存在/)
  const locked = setTrack(project, project.tracks.find(track => track.kind === 'text').id, { locked: true })
  assert.equal(planSpeech(locked).sources.length, 0)
  assert.match(planSpeech(locked).skipped[0].reason, /锁定/)
  assert.deepEqual(planSpeech(project, []).sources, [])
})

test('真实音频时长确定字幕长度和配音起点，音乐及其它素材保持原样', () => {
  const { project, text, second } = fixture()
  const before = structuredClone(project)
  const applied = applySpeechResults(project, [result(project, text.id, 'speech-first', 2.75)])
  assert.deepEqual(project, before)
  const caption = findClip(applied.project, text.id).clip
  const speech = findClip(applied.project, applied.audioClipIds[0])
  assert.equal(caption.start, 2)
  assert.equal(caption.trimIn, 0)
  assert.equal(caption.speed, 1)
  assert.equal(clipDuration(caption), 2.75)
  assert.equal(caption.fadeIn, 2.75)
  assert.equal(caption.fadeOut, 2.75)
  assert.equal(speech.clip.start, 2)
  assert.equal(clipDuration(speech.clip), 2.75)
  assert.equal(speech.clip.speech.textClipId, text.id)
  assert.equal(speech.clip.speech.text, '第一段文字。')
  assert.notEqual(speech.track.id, project.tracks.find(track => track.kind === 'audio').id)
  assert.deepEqual(findClip(applied.project, 'music-clip'), findClip(project, 'music-clip'))
  assert.deepEqual(findClip(applied.project, second.id).clip, second)
  assert.deepEqual(applied.overlaps, [])
})

test('保留字幕时长选项不会截掉合成语音，单独对齐采用音频裁剪和变速后的实际时序', () => {
  const { project, text } = fixture()
  const applied = applySpeechResults(project, [result(project, text.id, 'speech-first', 12)], { alignText: false })
  assert.deepEqual(findClip(applied.project, text.id).clip, text)
  assert.equal(clipDuration(findClip(applied.project, applied.audioClipIds[0]).clip), 12)
  const moved = updateClip(applied.project, applied.audioClipIds[0], { start: 4, trimIn: 2, trimOut: 10, speed: 2 })
  const aligned = alignTextToSpeech(moved, [text.id])
  assert.equal(findClip(aligned.project, text.id).clip.start, 4)
  assert.equal(clipDuration(findClip(aligned.project, text.id).clip), 4)
  assert.deepEqual(findClip(aligned.project, applied.audioClipIds[0]).clip, findClip(moved, applied.audioClipIds[0]).clip)
  const changed = updateClip(moved, text.id, { text: '已经修改。' })
  assert.throws(() => alignTextToSpeech(changed, [text.id]), /文字已更改/)
})

test('重叠的批量配音保留各自起点、使用独立轨道并返回冲突时段', () => {
  const { project, text, second } = fixture()
  const applied = applySpeechResults(project, [result(project, text.id, 'speech-first', 9), result(project, second.id, 'speech-second', 4)])
  const [firstAudio, secondAudio] = applied.audioClipIds.map((id) => findClip(applied.project, id))
  assert.equal(firstAudio.clip.start, 2)
  assert.equal(secondAudio.clip.start, 8)
  assert.notEqual(firstAudio.track.id, secondAudio.track.id)
  assert.equal(findClip(applied.project, second.id).clip.start, 8)
  assert.deepEqual(applied.overlaps.map(({ start, end, kind }) => ({ start, end, kind })), [{ start: 8, end: 11, kind: 'text' }, { start: 8, end: 11, kind: 'speech' }])
  assert.equal(findClip(applied.project, 'music-clip').clip.start, 1)
})

test('重新生成替换关联片段且保留旧资源，批量提交可一次撤销和重做', () => {
  const { project, text, second } = fixture()
  const initial = applySpeechResults(project, [result(project, text.id, 'speech-first', 3), result(project, second.id, 'speech-second', 2)])
  const muted = setTrack(initial.project, findClip(initial.project, initial.audioClipIds[0]).track.id, { muted: true })
  const next = applySpeechResults(muted, [result(muted, text.id, 'speech-replaced', 2)])
  assert.equal(findClip(next.project, initial.audioClipIds[0]), undefined)
  assert.ok(findClip(next.project, initial.audioClipIds[1]))
  assert.equal(next.project.assets.some((asset) => asset.id === 'speech-first'), true)
  assert.equal(findClip(next.project, next.audioClipIds[0]).track.muted, true)
  let history = createHistory(project)
  history = commitHistory(history, initial.project)
  assert.deepEqual(undoHistory(history).present, project)
  assert.deepEqual(redoHistory(undoHistory(history)).present, initial.project)
  history = commitHistory(history, next.project)
  assert.deepEqual(undoHistory(history).present, initial.project)
})

test('异步过期结果、锁定轨道和非法音频均原子拒绝', () => {
  const { project, text, second } = fixture()
  const first = result(project, text.id, 'speech-first')
  const secondResult = result(project, second.id, 'speech-second')
  for (const patch of [{ text: '新文字。' }, { start: 5 }, { trimOut: 9 }, { speed: 3 }]) {
    const changed = updateClip(project, text.id, patch)
    const before = structuredClone(changed)
    assert.throws(() => applySpeechResults(changed, [secondResult, first]), /已更改/)
    assert.deepEqual(changed, before)
  }
  const alternate = createTrack('text')
  const moved = moveClip(addTrack(project, alternate), text.id, alternate.id, text.start)
  assert.throws(() => applySpeechResults(moved, [first]), /已更改/)
  assert.throws(() => applySpeechResults(project, [first, first]), /重复/)
  assert.throws(() => applySpeechResults(project, [{ ...first, asset: { ...first.asset, size: 0 } }]), /可用/)
  assert.throws(() => applySpeechResults(project, [{ ...first, asset: { ...first.asset, duration: NaN } }]), /时长无效/)
  const applied = applySpeechResults(project, [first])
  const locked = setTrack(applied.project, findClip(applied.project, applied.audioClipIds[0]).track.id, { locked: true })
  assert.match(planSpeech(locked, [text.id]).skipped[0].reason, /配音轨道已锁定/)
  assert.throws(() => alignTextToSpeech(locked), /锁定/)
  assert.throws(() => applySpeechResults(locked, [result(applied.project, text.id, 'replacement')]), /锁定/)
  assert.throws(() => deleteClip(locked, text.id), /解锁/)
  assert.throws(() => splitClip(locked, text.id, 3), /解锁/)
  assert.throws(() => removeTrack(locked, project.tracks.find(track => track.kind === 'text').id), /解锁/)
})

test('配音绑定导入必须指向唯一字幕，数据类型和语速受校验', () => {
  const { project, text } = fixture()
  const applied = applySpeechResults(project, [result(project, text.id, 'speech-first')])
  assert.deepEqual(findClip(validateProject(applied.project), applied.audioClipIds[0]).clip.speech, findClip(applied.project, applied.audioClipIds[0]).clip.speech)
  for (const patch of [{ textClipId: 'missing' }, { textClipId: 'music-clip' }, { text: '' }, { rate: 0 }, { rate: Infinity }, { voiceId: '' }]) {
    const invalid = structuredClone(applied.project)
    Object.assign(findClip(invalid, applied.audioClipIds[0]).clip.speech, patch)
    assert.throws(() => validateProject(invalid))
  }
  const duplicate = structuredClone(applied.project)
  const original = findClip(duplicate, applied.audioClipIds[0])
  original.track.clips.push({ ...original.clip, id: 'duplicate-speech' })
  assert.throws(() => validateProject(duplicate), /多个配音/)
  const wrongTrack = structuredClone(applied.project)
  findClip(wrongTrack, text.id).clip.speech = { text: '字幕', voiceId: 'voice', rate: 1 }
  assert.throws(() => validateProject(wrongTrack), /只能用于音频/)
})

test('删除和分割字幕保留已生成语音，复制和分割语音解除副本绑定', () => {
  const { project, text } = fixture()
  const applied = applySpeechResults(project, [result(project, text.id, 'speech-first')])
  const audioId = applied.audioClipIds[0]
  const removed = deleteClip(applied.project, text.id)
  assert.equal(findClip(removed, audioId).clip.speech.textClipId, undefined)
  assert.equal(findClip(removed, audioId).clip.speech.text, '第一段文字。')
  assert.equal(findClip(removeTrack(applied.project, project.tracks.find(track => track.kind === 'text').id), audioId).clip.speech.textClipId, undefined)
  assert.equal(findClip(splitClip(applied.project, text.id, 3), audioId).clip.speech.textClipId, undefined)
  const duplicated = duplicateClip(applied.project, audioId)
  const voices = duplicated.tracks.flatMap((track) => track.clips.filter((clip) => clip.speech))
  assert.equal(voices.length, 2)
  assert.equal(voices.filter((clip) => clip.speech.textClipId === text.id).length, 1)
  const split = splitClip(applied.project, audioId, 3)
  assert.equal(split.tracks.flatMap((track) => track.clips.filter((clip) => clip.speech?.textClipId)).length, 0)
  assert.equal(findClip(applied.project, audioId).clip.speech.textClipId, text.id)
})

test('配音真实波形字节随便携项目保存并恢复绑定', async () => {
  let project = createProject('可携带配音')
  const text = createTextClip(project, { text: '可保存的配音', id: 'portable-text' })
  project = addClip(project, project.tracks.find(track => track.kind === 'text').id, text)
  const samples = 8000
  const bytes = new Uint8Array(44 + samples * 2)
  const view = new DataView(bytes.buffer)
  for (const [offset, value] of [[0, 'RIFF'], [8, 'WAVE'], [12, 'fmt '], [36, 'data']]) for (let i = 0; i < value.length; i++) bytes[offset + i] = value.charCodeAt(i)
  view.setUint32(4, bytes.length - 8, true); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true)
  view.setUint32(24, 8000, true); view.setUint32(28, 16000, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true); view.setUint32(40, samples * 2, true)
  for (let i = 0; i < samples; i++) view.setInt16(44 + i * 2, Math.sin(i * 2 * Math.PI * 220 / 8000) * 12000, true)
  const blob = new Blob([bytes], { type: 'audio/wav' })
  const url = URL.createObjectURL(blob)
  try {
    const output = result(project, text.id, 'portable-speech', 1)
    output.asset = audio('portable-speech', 1, { url, size: blob.size })
    const applied = applySpeechResults(project, [output])
    const imported = await importProjectFile(await exportProjectFile(applied.project))
    try {
      assert.deepEqual(new Uint8Array(await imported.blobs.get('portable-speech').arrayBuffer()), bytes)
      assert.equal(findClip(imported.project, applied.audioClipIds[0]).clip.speech.textClipId, text.id)
      assert.equal(clipDuration(findClip(imported.project, text.id).clip), 1)
    } finally { imported.revoke() }
  } finally { URL.revokeObjectURL(url) }
})

test('合成上限按 Unicode 码点计数，超长字幕在批量开始前明确跳过', () => {
  let project = createProject('字符上限')
  const trackId = project.tracks.find(track => track.kind === 'text').id
  project = addClip(project, trackId, createTextClip(project, { id: 'max-text', text: '\u{20000}'.repeat(4000) }))
  project = addClip(project, trackId, createTextClip(project, { id: 'long-text', text: '字'.repeat(4001) }))
  const plan = planSpeech(project)
  assert.deepEqual(plan.sources.map((source) => source.clipId), ['max-text'])
  assert.equal(plan.skipped.length, 1)
  assert.equal(plan.skipped[0].clipId, 'long-text')
  assert.match(plan.skipped[0].reason, /4000/)
})

test('批量预检明确拒绝超过素材槽的整批计划，不会静默削减或修改项目', () => {
  const { project, text, second } = fixture()
  project.assets.push(...Array.from({ length: MAX_ASSETS - 2 }, (_, index) => audio(`unused-${index}`, 1)))
  const before = structuredClone(project)
  const plan = planSpeech(project)
  assert.equal(plan.sources.length, 2)
  assert.throws(() => validateSpeechPlanCapacity(project, plan), /目前还可添加 1 个，本次需要 2 个/)
  assert.deepEqual(project, before)
  assert.doesNotThrow(() => validateSpeechPlanCapacity(project, planSpeech(project, [text.id])))
  const first = applySpeechResults(project, [result(project, text.id, 'last-slot')]).project
  assert.throws(() => validateSpeechPlanCapacity(first, planSpeech(first, [second.id])), /目前还可添加 0 个/)
  assert.throws(() => validateSpeechPlanCapacity(first, planSpeech(first, [text.id])), /目前还可添加 0 个/)
})

test('预检检查新增片段容量，并将替换旧配音按一个片段计数', () => {
  const { project, text } = fixture()
  const clip = findClip(project, 'music-clip').clip
  project.tracks.find(track => track.kind === 'audio').clips.push(...Array.from({ length: MAX_CLIPS - 4 }, (_, index) => ({ ...clip, id: `extra-${index}` })))
  assert.equal(project.tracks.reduce((count, track) => count + track.clips.length, 0), MAX_CLIPS - 1)
  assert.throws(() => validateSpeechPlanCapacity(project, planSpeech(project)), /片段.*数量限制/)
  const applied = applySpeechResults(project, [result(project, text.id, 'last-clip')])
  assert.doesNotThrow(() => validateSpeechPlanCapacity(applied.project, planSpeech(applied.project, [text.id])))
})

test('预检已满轨道和同一起点的最少需求，逐条已知时长继续检查真实容量', () => {
  const { project, text, second } = fixture()
  project.tracks.push(...Array.from({ length: MAX_TRACKS - project.tracks.length - 1 }, () => createTrack('video')))
  const plan = planSpeech(project)
  assert.doesNotThrow(() => validateSpeechPlanCapacity(project, plan))
  assert.throws(() => validateSpeechPlanCapacity(project, plan, new Map([[text.id, 9]])), /100 条轨道/)
  const atSameStart = updateClip(project, second.id, { start: text.start })
  assert.throws(() => validateSpeechPlanCapacity(atSameStart, planSpeech(atSameStart)), /100 条轨道/)
  project.tracks.push(createTrack('video'))
  assert.throws(() => validateSpeechPlanCapacity(project, planSpeech(project, [text.id])), /100 条轨道/)
})

test('实际配音长度超过24小时边界时及时拒绝，未知长度不假定为长音频', () => {
  let project = createProject('时间线末尾')
  const text = createTextClip(project, { id: 'end-text', text: '结束', start: MAX_PROJECT_DURATION - 2, trimOut: 1 })
  project = addClip(project, project.tracks.find(track => track.kind === 'text').id, text)
  const plan = planSpeech(project)
  assert.doesNotThrow(() => validateSpeechPlanCapacity(project, plan))
  assert.doesNotThrow(() => validateSpeechPlanCapacity(project, plan, new Map([[text.id, 2]])))
  assert.throws(() => validateSpeechPlanCapacity(project, plan, new Map([[text.id, 2.1]])), /超出 24 小时/)
  assert.throws(() => applySpeechResults(project, [result(project, text.id, 'overflow', 2.1)]), /超出 24 小时/)
})
