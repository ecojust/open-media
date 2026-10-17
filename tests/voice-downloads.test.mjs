import test from 'node:test'
import assert from 'node:assert/strict'
import { voiceReady, voiceDownloading, voiceUnsupported, voiceRuntimeLabel, voiceDownloadProgress, voiceDownloadSize, voiceModelSize, voiceSourceOrigin, voiceDownloadSources } from '../src/core/voice-downloads.ts'

const voice = { id: 'f5_zh_female', name: 'F5-TTS v1 Base FP32', language: 'zh-CN', gender: 'female', modelSize: 1_402_816_013, runtimeSize: 800_000_000, downloadSize: 2_202_816_013, status: 'ready' }

test('a downloaded model stays unavailable until its platform runtime is verified', () => {
  assert.equal(voiceReady({ ...voice, runtimeStatus: 'ready' }), true)
  assert.equal(voiceReady({ id: 'bundled', name: '内置', language: 'zh-CN', status: 'bundled' }), true)
  for (const runtimeStatus of ['not-downloaded', 'downloading', 'verifying', 'failed', 'unsupported']) {
    assert.equal(voiceReady({ ...voice, runtimeStatus }), false, runtimeStatus)
  }
  for (const status of ['not-downloaded', 'downloading', 'verifying', 'failed', 'unsupported']) {
    assert.equal(voiceReady({ ...voice, status, runtimeStatus: 'ready' }), false, status)
  }
  assert.equal(voiceReady(undefined), false)
})

test('runtime download and verification keep polling active and unsupported platforms stay explicit', () => {
  for (const runtimeStatus of ['downloading', 'verifying']) assert.equal(voiceDownloading({ ...voice, runtimeStatus }), true)
  for (const runtimeStatus of ['not-downloaded', 'ready', 'failed', 'unsupported']) assert.equal(voiceDownloading({ ...voice, runtimeStatus }), false)
  assert.equal(voiceUnsupported({ ...voice, status: 'unsupported' }), true)
  assert.equal(voiceUnsupported({ ...voice, runtimeStatus: 'unsupported' }), true)
  assert.equal(voiceRuntimeLabel({ ...voice, runtimeStatus: 'ready' }), '运行组件 · 800 MB · 已就绪')
  assert.equal(voiceRuntimeLabel({ ...voice, runtimeStatus: 'unsupported', runtimeSize: undefined }), '运行组件 · 当前平台不可用')
})

test('installed shared runtime is excluded from download button size without changing total progress', () => {
  assert.equal(voiceDownloadSize({ ...voice, runtimeStatus: 'not-downloaded' }), 2_202_816_013)
  assert.equal(voiceDownloadSize({ ...voice, runtimeStatus: 'ready' }), 1_402_816_013)
  assert.equal(voiceModelSize(voiceDownloadSize({ ...voice, runtimeStatus: 'ready' })), '1.4 GB')
  assert.equal(voiceDownloadProgress({ ...voice, downloadedBytes: 1_101_408_007 }), 50)
  assert.equal(voiceDownloadProgress({ ...voice, downloadedBytes: 9_000_000_000 }), 100)
  assert.equal(voiceDownloadProgress({ ...voice, downloadedBytes: -10 }), 0)
  assert.equal(voiceDownloadProgress({ ...voice, downloadSize: Number.NaN }), 0)
  assert.equal(voiceDownloadSize({ ...voice, downloadSize: Number.NaN }), undefined)
})

test('download source links expose only distinct HTTPS origins and never credentials or executable URLs', () => {
  assert.deepEqual(voiceDownloadSources({ ...voice, downloadSources: ['https://huggingface.co/model', 'https://huggingface.co', 'https://hf-mirror.com/path', 'javascript:alert(1)', 'http://insecure.example', 'https://user:secret@example.com', 'invalid'] }), ['https://huggingface.co', 'https://hf-mirror.com'])
  assert.equal(voiceSourceOrigin('https://hf-mirror.com/path?token=untrusted'), 'https://hf-mirror.com')
  assert.equal(voiceSourceOrigin(undefined), '')
  assert.deepEqual(voiceDownloadSources(voice), [])
})
