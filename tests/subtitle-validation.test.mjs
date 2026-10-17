import assert from 'node:assert/strict'
import test from 'node:test'
import { createProject, createTextClip, createTrack } from '../src/core/project.ts'
import { DEFAULT_SUBTITLE_TEXT, subtitleIssue, trackSubtitleIssues } from '../src/core/subtitle-validation.ts'

test('subtitle validation identifies blank and both generated placeholders without rejecting real text', () => {
  const project = createProject(), track = createTrack('text')
  for (const text of ['', ' \n\t ', '\u200B\u2060\uFEFF']) {
    assert.equal(subtitleIssue(track, createTextClip(project, { text }))?.reason, 'empty')
  }
  for (const text of [DEFAULT_SUBTITLE_TEXT, '双击编辑字幕', `  ${DEFAULT_SUBTITLE_TEXT}\n`]) {
    assert.equal(subtitleIssue(track, createTextClip(project, { text }))?.reason, 'placeholder')
  }
  for (const text of ['字幕', '文字', '请在这里输入字幕，然后继续。', '0', '完整的字幕内容']) {
    assert.equal(subtitleIssue(track, createTextClip(project, { text })), undefined)
  }
})

test('track warnings follow timeline order, exclude watermarks, and update after edits', () => {
  const project = createProject(), track = createTrack('text')
  track.clips = [
    createTextClip(project, { id: 'late', text: '', start: 50 }),
    createTextClip(project, { id: 'watermark', text: '', textRole: 'watermark', start: 0 }),
    createTextClip(project, { id: 'early', text: DEFAULT_SUBTITLE_TEXT, start: 1 }),
  ]
  assert.deepEqual(trackSubtitleIssues(track).map(issue => issue.clipId), ['early', 'late'])
  track.clips[2].text = '已输入实际字幕'
  assert.deepEqual(trackSubtitleIssues(track).map(issue => issue.clipId), ['late'])
  track.clips[0].text = '这条也完成了'
  assert.deepEqual(trackSubtitleIssues(track), [])
  const legacy = createTrack('text', '文字水印轨道')
  const clip = createTextClip(project, { text: '' }); delete clip.textRole
  assert.equal(subtitleIssue(legacy, clip), undefined)
  assert.equal(subtitleIssue(createTrack('audio'), createTextClip(project, { text: '' })), undefined)
})
