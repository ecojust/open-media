import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { voiceCategory, voiceSearchText, voiceStyle, voiceTypeLabel } from '../src/core/voice-catalog.ts'
import { VOICE_PROFILES, VOICE_PROFILE_SOURCE } from '../src/core/voice-profiles.ts'

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
