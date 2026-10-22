import test from 'node:test'
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { createProject, createClip, createSubtitleClip, createTrack } from '../src/core/project.ts'

const nativeUrl = new URL('../src/native.ts', import.meta.url).href
registerHooks({ load(url, context, nextLoad) {
  return url === nativeUrl ? { format: 'module', shortCircuit: true, source: 'export function importBlobAsset(){throw new Error("Test must supply the native import boundary")}' } : nextLoad(url, context)
} })
const { prepareNativeProject } = await import('../src/core/native-project.ts')

test('native composition preparation reads only used visible media and never rasterizes hidden subtitles', async () => {
  const blob = new Blob(['visible-image-bytes'], { type: 'image/png' }), url = URL.createObjectURL(blob)
  try {
    const project = createProject('隐藏素材无需准备'), imports = []
    const image = { id: 'visible', name: 'image.png', kind: 'image', url, duration: 0, width: 320, height: 180, size: blob.size, mime: 'image/png' }
    const hiddenVideo = { ...image, id: 'hidden-video', name: 'missing.mp4', kind: 'video', url: 'blob:missing-hidden-video', duration: 20, mime: 'video/mp4' }
    const hiddenAudio = { ...hiddenVideo, id: 'hidden-audio', name: 'missing.wav', kind: 'audio', width: 0, height: 0, url: 'blob:missing-hidden-audio', mime: 'audio/wav' }
    project.assets.push(image, hiddenVideo, hiddenAudio, { ...hiddenVideo, id: 'unused', url: 'blob:missing-unused' })
    project.tracks.find(track => track.kind === 'video').clips.push(createClip(image, project, { trimOut: 2 }))
    const hiddenTrack = { ...createTrack('video'), hidden: true, clips: [createClip(hiddenVideo, project)] }
    project.tracks.push(hiddenTrack)
    project.tracks.find(track => track.kind === 'audio').hidden = true
    project.tracks.find(track => track.kind === 'audio').clips.push(createClip(hiddenAudio, project))
    project.tracks.find(track => track.kind === 'text').hidden = true
    project.tracks.find(track => track.kind === 'text').clips.push(createSubtitleClip(project, { text: '不应栅格化的隐藏字幕' }))
    const prepared = await prepareNativeProject(project, undefined, { importAsset: async (bytes, name) => {
      imports.push({ bytes: new TextDecoder().decode(bytes), name })
      return { ...image, nativePath: '/prepared/image.png', url: 'asset://prepared' }
    } })
    assert.deepEqual(imports, [{ bytes: 'visible-image-bytes', name: 'image.png' }])
    assert.deepEqual(prepared.textAssets, {})
    assert.equal(prepared.project.assets[0].nativePath, '/prepared/image.png')
    assert.equal(prepared.project.assets[1].url, hiddenVideo.url)
    assert.equal(prepared.project.tracks.find(track => track.id === hiddenTrack.id).clips.length, 1)
    assert.equal(project.assets[0].nativePath, undefined, 'preparing output must not change editable project sources')
  } finally { URL.revokeObjectURL(url) }
})
