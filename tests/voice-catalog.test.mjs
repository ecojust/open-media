import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { compactVoiceCatalog, voiceCategory, voiceSearchText, voiceStyle, voiceTypeLabel } from '../src/core/voice-catalog.ts'
import { VOICE_PROFILES, VOICE_PROFILE_SOURCE } from '../src/core/voice-profiles.ts'
import { VOICE_GROUPS, VOICE_GROUP_SOURCE } from '../src/core/voice-groups.ts'

const lock = JSON.parse(await readFile(new URL('../scripts/speech-runtime.lock.json', import.meta.url), 'utf8'))
const { voices } = lock

test('全部内置声音具有实际采样记录，类型与语言性别分类一致', () => {
  assert.equal(voices.length, 103)
  assert.equal(VOICE_PROFILE_SOURCE.archiveSha256, lock.sources.find(source => source.id === 'model').sha256, '更换模型后必须重新测量类型，不能套用旧声音的描述')
  assert.deepEqual(Object.keys(VOICE_PROFILES).sort(), voices.map(voice => voice.id).sort())
  for (const voice of voices) {
    const profile = VOICE_PROFILES[voice.id]
    assert.equal(profile.category, voiceCategory(voice), voice.id)
    assert.equal(profile.speakerId, voice.speakerId, `模型内声音编号不能改变：${voice.id}`)
    assert.ok(profile.pitchHz >= 65 && profile.pitchHz <= 480, voice.id)
    assert.ok(profile.durationSeconds > 1 && profile.durationSeconds < 15, voice.id)
    const style = voiceStyle(voice)
    assert.ok(style.label.length > 0)
    assert.equal(style.id, profile.style, voice.id)
    assert.ok(Number.isInteger(style.portrait) && style.portrait >= 0 && style.portrait < 12)
  }
})

test('声音搜索支持类型、语种、名称和原始标识，兼容地区分隔符', () => {
  const voice = voices.find(voice => voice.id === 'bf_vale')
  assert.equal(voiceStyle(voice).label, '成熟')
  assert.match(voiceSearchText(voice), /成熟/)
  assert.match(voiceSearchText(voice), /英式英语/)
  assert.match(voiceSearchText(voice), /bf_vale/)
  assert.equal(voiceCategory({ ...voice, language: 'en_GB' }), 'en-female')
  const bright = voices.find(voice => voiceStyle(voice).label === '清亮')
  assert.ok(bright)
  assert.match(voiceSearchText(bright), /清亮/)
})

test('未知声音和不匹配的元数据回退到自然类型，不凭编号编造风格', () => {
  for (const voice of [
    { id: 'unknown', name: '新声音', language: 'zh-CN', gender: 'female' },
    { id: 'zf_999', name: '新声音', language: 'zh-CN', gender: 'female' },
    { id: 'bf_vale', name: '另一声音', language: 'zh-CN', gender: 'male' },
  ]) assert.equal(voiceStyle(voice).id, 'natural')
  const other = { id: 'bf_vale', name: '其他语言', language: 'fr-FR', gender: 'female' }
  assert.equal(voiceStyle(other).label, '通用')
  assert.equal(voiceStyle(other).portrait, 11)
  assert.match(voiceTypeLabel(other), /法语/)
})

test('精简分组覆盖原始目录且不跨语种性别，每组只展示一个代表', () => {
  assert.equal(VOICE_GROUP_SOURCE.voiceWeightsSha256, VOICE_PROFILE_SOURCE.voiceWeightsSha256)
  const members = VOICE_GROUPS.flatMap(group => group.members)
  assert.deepEqual([...members].sort(), voices.map(voice => voice.id).sort())
  assert.equal(new Set(members).size, voices.length)
  for (const group of VOICE_GROUPS) {
    assert.ok(group.members.includes(group.representative))
    for (const id of group.members) {
      const voice = voices.find(item => item.id === id)
      assert.equal(voiceCategory(voice), group.category)
      assert.equal(voice.language.toLowerCase(), group.locale)
    }
  }
  const compact = compactVoiceCatalog(voices)
  assert.equal(compact.length, 25)
  assert.equal(compact.filter(voice => voiceCategory(voice) === 'zh-male').length, 10)
  assert.equal(compact.filter(voice => voiceCategory(voice) === 'zh-female').length, 12)
  assert.equal(compact.filter(voice => voiceCategory(voice) === 'en-female').length, 3)
  assert.ok(compact.some(voice => voice.id === 'zf_001'), '默认中文音色保持可见')
  assert.deepEqual(new Set(compact.map(voice => voice.id)), new Set(VOICE_GROUPS.map(group => group.representative)))
  assert.ok(compact.every(voice => voices.includes(voice)), '不能改写原始声音编号或对象')
})

test('展示分组与实际采样报告一致，每个成员直接满足代表相似度条件', async () => {
  const report = JSON.parse(await readFile(new URL('../docs/voice-groups/catalog.json', import.meta.url), 'utf8'))
  assert.equal(report.source.weightsSha256, VOICE_GROUP_SOURCE.voiceWeightsSha256)
  assert.equal(report.source.modelSha256, VOICE_PROFILE_SOURCE.modelSha256)
  assert.equal(report.source.silenceScale, VOICE_GROUP_SOURCE.silenceScale)
  assert.deepEqual(VOICE_GROUPS.map(group => group.representative), report.representativeIds)
  for (const group of VOICE_GROUPS) {
    const measured = report.groups.find(item => item.representativeId === group.representative)
    assert.deepEqual(group.members, measured.members)
    assert.deepEqual(measured.evidence.map(item => item.id), group.members)
    for (const item of measured.evidence) {
      assert.ok(item.weightCosine >= VOICE_GROUP_SOURCE.minimumWeightCosine, item.id)
      assert.ok(item.acousticDistance <= VOICE_GROUP_SOURCE.maximumAcousticDistance, item.id)
    }
  }
})

test('已选择的旧声音仍然可见，同组不再重复展示代表，原目录保持原样', () => {
  const snapshot = structuredClone(voices)
  for (const group of VOICE_GROUPS.filter(group => group.members.length > 1)) {
    const selectedId = group.members.find(id => id !== group.representative)
    const compact = compactVoiceCatalog(voices, selectedId)
    assert.equal(compact.length, 25)
    assert.equal(compact.find(voice => voice.id === selectedId), voices.find(voice => voice.id === selectedId))
    assert.ok(!compact.some(voice => voice.id === group.representative))
  }
  assert.deepEqual(voices, snapshot)
})

test('缺少默认代表时保留本组可用声音，不隐藏自定义或元数据不同的声音', () => {
  const group = VOICE_GROUPS.find(group => group.members.length > 1)
  const remaining = voices.filter(voice => voice.id !== group.representative)
  const fallback = compactVoiceCatalog(remaining).filter(voice => group.members.includes(voice.id))
  assert.equal(fallback.length, 1)
  assert.equal(fallback[0].id, group.members.find(id => id !== group.representative))
  assert.deepEqual(compactVoiceCatalog([fallback[0]]), fallback)
  const unknown = { id: 'custom-voice', name: '自定义声音', language: 'zh-CN', gender: 'male' }
  const differentGender = { ...voices.find(voice => voice.id === group.representative), gender: 'unknown' }
  const differentLocale = { ...differentGender, gender: 'female', language: 'ja-JP' }
  for (const extra of [unknown, differentGender, differentLocale]) {
    const source = [...remaining, extra]
    assert.ok(compactVoiceCatalog(source).includes(extra))
  }
  assert.deepEqual(compactVoiceCatalog([]), [])
  assert.deepEqual(compactVoiceCatalog([unknown, unknown]), [unknown])
  assert.deepEqual(compactVoiceCatalog([unknown], 'missing-id'), [unknown])
})
