import test from 'node:test'
import assert from 'node:assert/strict'

async function settingsModule(saved) {
  const values = new Map(saved === undefined ? [] : [['open-media:speech-settings', JSON.stringify(saved)]])
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
  } })
  try {
    const settings = await import(`../src/core/speech-settings.ts?selected-voice=${crypto.randomUUID()}`)
    return { settings, values }
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'localStorage', descriptor)
    else delete globalThis.localStorage
  }
}

test('the bundled default is shared before any speech panel is opened', async () => {
  for (const saved of [undefined, { voiceId: '', rate: 1.25, alignText: false }]) {
    const { settings } = await settingsModule(saved)
    assert.equal(settings.getSpeechSettings().voiceId, 'matcha_zh_en_female')
    assert.equal(settings.resolveMcpSpeechVoice(), 'matcha_zh_en_female')
    assert.equal(settings.getSpeechSettings().rate, saved?.rate ?? 1)
  }
})

test('a saved optional voice stays selected on restart without inspecting other downloaded models', async () => {
  const saved = { voiceId: 'qwen3_uncle_fu', rate: .95, alignText: true }
  const { settings } = await settingsModule(saved)
  assert.deepEqual(settings.getSpeechSettings(), saved)
  assert.equal(settings.resolveMcpSpeechVoice(), saved.voiceId)
  assert.throws(() => settings.resolveMcpSpeechVoice('matcha_zh_en_female'), /用户当前选中/)
  assert.deepEqual(settings.getSpeechSettings(), saved)
})

test('MCP cannot change the voice through settings while speed and alignment remain configurable', async () => {
  const { settings } = await settingsModule({ voiceId: 'f5_zh_male', rate: 1, alignText: true })
  assert.throws(() => settings.validateMcpSpeechSettings({ voiceId: 'f5_zh_female' }), /用户当前选中/)
  assert.throws(() => settings.validateMcpSpeechSettings({ voiceId: '' }), /用户当前选中/)
  assert.throws(() => settings.resolveMcpSpeechVoice(null), /用户当前选中/)
  assert.deepEqual(settings.validateMcpSpeechSettings({ voiceId: 'f5_zh_male', rate: 1.2, alignText: false }), { voiceId: 'f5_zh_male', rate: 1.2, alignText: false })
  settings.updateSpeechSettings({ voiceId: 'f5_zh_female' })
  assert.equal(settings.resolveMcpSpeechVoice(), 'f5_zh_female')
  assert.throws(() => settings.assertMcpSpeechVoice('f5_zh_male'), /已经变化/)
})
