import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { compactVoiceCatalog, voiceCategory, voiceSearchText, voiceStyle, voiceTypeLabel } from '../src/core/voice-catalog.ts'
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
