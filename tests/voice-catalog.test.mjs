import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { compactVoiceCatalog, voiceActionName, voiceCategory, voiceComputeLabel, voiceModelName, voiceRecommendedMemoryGb, voiceSearchText, voiceStyle, voiceTypeLabel } from '../src/core/voice-catalog.ts'
import { VOICE_PROFILES, VOICE_PROFILE_SOURCE } from '../src/core/voice-profiles.ts'
import { VOICE_GROUPS } from '../src/core/voice-groups.ts'

const lock = JSON.parse(await readFile(new URL('../scripts/speech-runtime.lock.json', import.meta.url), 'utf8'))
const { voices } = lock

test('内置目录只包含真实中英女声，不把变速或旧模型声音列为新音色', () => {
  assert.equal(voices.length, 1)
  assert.equal(VOICE_PROFILE_SOURCE.archiveSha256, lock.sources.find(source => source.id === 'model').sha256)
  assert.deepEqual(Object.keys(VOICE_PROFILES), ['matcha_zh_en_female'])
  assert.deepEqual(voices.map(voice => voice.id), ['matcha_zh_en_female'])
  const voice = voices[0]
  assert.equal(voice.speakerId, 0)
  assert.equal(VOICE_PROFILES[voice.id].speakerId, voice.speakerId)
  assert.equal(voiceCategory(voice), 'zh-en-female')
  assert.equal(voiceStyle(voice).label, '温柔')
  assert.equal(voiceStyle(voice).portrait, 7)
  assert.equal(voiceTypeLabel(voice), '中文 / 英语 · 女声')
  assert.equal(VOICE_GROUPS.length, 1)
  assert.deepEqual(VOICE_GROUPS[0].members, [voice.id])
  assert.equal(VOICE_GROUPS[0].representative, voice.id)
  assert.equal(VOICE_GROUPS[0].category, voiceCategory(voice))
})

test('中英女声可通过语言、音色、名称和标识搜索', () => {
  const voice = voices[0]
  for (const query of ['中文', '英语', '温柔', 'matcha_zh_en_female']) assert.ok(voiceSearchText(voice).includes(query))
  assert.equal(voiceCategory({ ...voice, language: 'zh_CN' }), 'zh-en-female')
})

test('旧选择回退到当前可用目录，不能保留不存在的声音或改写源数据', () => {
  const snapshot = structuredClone(voices)
  for (const selectedId of ['zf_001', 'zm_013', 'bf_vale', 'missing', 'matcha_zh_en_female']) {
    assert.deepEqual(compactVoiceCatalog(voices, selectedId), voices)
    assert.equal(compactVoiceCatalog(voices, selectedId)[0], voices[0])
  }
  assert.deepEqual(voices, snapshot)
  assert.deepEqual(compactVoiceCatalog([]), [])
  assert.deepEqual(compactVoiceCatalog([voices[0], voices[0]]), voices)
})

test('未知声音保留自身语言性别，不套用旧模型或中英女声的特征', () => {
  for (const voice of [
    { id: 'zf_001', name: '历史声音', language: 'zh-CN', gender: 'female' },
    { id: 'matcha_zh_en_female', name: '其他声音', language: 'zh-CN', gender: 'male' },
  ]) assert.equal(voiceStyle(voice).id, 'natural')
  const english = { id: 'custom-en', name: '自定义声音', language: 'en_GB', gender: 'female' }
  assert.equal(voiceCategory(english), 'en-female')
  assert.match(voiceTypeLabel(english), /英式英语/)
  const other = { id: 'custom-fr', name: '其他语言', language: 'fr-FR', gender: 'female' }
  assert.equal(voiceStyle(other).label, '通用')
  assert.equal(voiceStyle(other).portrait, 11)
  assert.match(voiceTypeLabel(other), /法语/)
  assert.deepEqual(compactVoiceCatalog([other, english]), [other, english])
})


test('three optional Chinese models keep distinct cards, voice IDs and portraits', () => {
  const optional = [
    { id: 'zipvoice_zh_female', name: 'ZipVoice Distill FP32', language: 'zh-CN', gender: 'female' },
    { id: 'f5_zh_female', name: 'F5-TTS v1 Base FP32', language: 'zh-CN', gender: 'female' },
    { id: 'qwen3_serena', name: 'Qwen3-TTS 1.7B BF16 · Serena', language: 'zh-CN', gender: 'female' },
  ]
  const catalog = [...voices, ...optional]
  assert.deepEqual(compactVoiceCatalog(catalog), catalog)
  assert.deepEqual(compactVoiceCatalog(catalog, 'f5_zh_female'), catalog)
  assert.equal(new Set(catalog.map(voice => voiceStyle(voice).portrait)).size, 4)
  for (const voice of optional) {
    assert.equal(voiceCategory(voice), 'zh-female')
    assert.equal(voiceTypeLabel(voice), '中文 · 女声')
    assert.ok(voiceSearchText(voice).includes(voice.name.toLowerCase()))
    assert.equal(voiceStyle({ ...voice, gender: 'male' }).id, 'natural', 'do not assign female profiles to a different voice')
  }
})


test('model labels replace legacy voice names while retaining searchable aliases', () => {
  const cases = [
    [voices[0], 'Matcha 中英', 4],
    [{ id: 'zipvoice_zh_female', name: '自然女声', language: 'zh-CN', gender: 'female' }, 'ZipVoice Distill FP32', 8],
    [{ id: 'f5_zh_female', name: '自然女声', language: 'zh-CN', gender: 'female' }, 'F5-TTS v1 Base FP32', 8],
    [{ id: 'qwen3_serena', name: 'Qwen3-TTS 1.7B BF16 · Serena', language: 'zh-CN', gender: 'female' }, 'Qwen3-TTS 1.7B BF16', 16],
    [{ id: 'zipvoice_zh_male', name: 'ZipVoice 中文男声', language: 'zh-CN', gender: 'male' }, 'ZipVoice Distill FP32', 8],
    [{ id: 'f5_zh_male', name: 'F5 中文男声', language: 'zh-CN', gender: 'male' }, 'F5-TTS v1 Base FP32', 8],
    [{ id: 'qwen3_uncle_fu', name: 'Qwen3-TTS 1.7B BF16 · Uncle_Fu', language: 'zh-CN', gender: 'male' }, 'Qwen3-TTS 1.7B BF16', 16],
  ]
  for (const [voice, name, memoryGb] of cases) {
    assert.equal(voiceModelName(voice), name)
    assert.ok(voiceSearchText(voice).includes(name.toLowerCase()))
    assert.ok(voiceSearchText(voice).includes(voice.name.toLowerCase()))
    assert.equal(voiceRecommendedMemoryGb(voice), memoryGb)
  }
  const custom = { id: 'custom', name: '自定义模型' }
  assert.equal(voiceModelName(custom), '自定义模型')
  assert.equal(voiceRecommendedMemoryGb(custom), undefined, 'unknown engines have no invented hardware recommendation')
  assert.equal(voiceComputeLabel(custom), undefined, 'unknown engines have no invented device support')
})

test('运行设备说明统一GPU优先与CPU自动回退，不承诺固定显存', () => {
  for (const id of ['matcha_zh_en_female', 'zipvoice_zh_female', 'zipvoice_zh_male']) {
    assert.equal(voiceComputeLabel({ id }), '优先可用 GPU · CPU 自动回退')
  }
  for (const id of ['f5_zh_female', 'f5_zh_male', 'qwen3_serena', 'qwen3_uncle_fu']) {
    assert.equal(voiceComputeLabel({ id }), '优先可用 GPU · CPU 自动回退')
  }
})

test('男声保留独立音色和男性头像，不与同模型女声合并', () => {
  const pairs = [
    ['zipvoice_zh_female', 'zipvoice_zh_male', 'zipvoice-distill-fp32', 0],
    ['f5_zh_female', 'f5_zh_male', 'f5-v1-base-fp32', 2],
    ['qwen3_serena', 'qwen3_uncle_fu', 'qwen3-tts-1.7b-serena', 1],
  ]
  const optional = pairs.flatMap(([female, male, modelId]) => [
    { id: female, name: female, language: 'zh-CN', gender: 'female', modelId },
    { id: male, name: male, language: 'zh-CN', gender: 'male', modelId },
  ])
  const catalog = [...voices, ...optional]
  assert.equal(catalog.length, 7)
  assert.deepEqual(compactVoiceCatalog(catalog, 'qwen3_uncle_fu'), catalog)
  assert.equal(new Set(catalog.map(voice => voiceStyle(voice).portrait)).size, 7)
  for (const [femaleId, maleId, , portrait] of pairs) {
    const female = optional.find(voice => voice.id === femaleId), male = optional.find(voice => voice.id === maleId)
    assert.equal(voiceCategory(male), 'zh-male')
    assert.equal(voiceTypeLabel(male), '中文 · 男声')
    assert.equal(voiceStyle(male).portrait, portrait)
    assert.ok(voiceSearchText(male).includes('男声'))
    assert.equal(voiceModelName(male), voiceModelName(female))
    assert.equal(voiceActionName(female), voiceModelName(female), '女声原操作名称保持兼容')
    assert.equal(voiceActionName(male), `${voiceModelName(male)} · 男声`)
    assert.notEqual(voiceActionName(male), voiceActionName(female))
    assert.ok(voiceStyle({ ...male, gender: 'female' }).portrait >= 4, '不可把男声头像分配给其他性别')
  }
})
