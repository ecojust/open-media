import test from 'node:test'
import assert from 'node:assert/strict'
import { createClip, createProject, createSubtitleClip, validateProject } from '../src/core/project.ts'
import { activeClips, projectDuration, renderDuration, setTrack, createHistory, commitHistory, undoHistory, redoHistory } from '../src/core/timeline.ts'
import { addTransition, transitionVisualAt, findTransitionCut } from '../src/core/transitions.ts'
import { visibleVisualClips } from '../src/core/preview-position.ts'
import { audioPreviewProject, inspectExportStructure, previewRange } from '../src/core/editor-preview-tools.ts'
import { executeProjectTool, inspectMcpProject, validateMcpToolArguments } from '../src/core/mcp-tools.ts'

function fixture() {
  const project = createProject('轨道参与合成', { width: 320, height: 180, fps: 20 })
  const video = { id: 'video', name: '视频.mp4', kind: 'video', url: 'blob:video', duration: 20, width: 320, height: 180, size: 100, mime: 'video/mp4' }
  const audio = { ...video, id: 'audio', name: '音频.wav', kind: 'audio', url: 'blob:audio', width: 0, height: 0, mime: 'audio/wav' }
  project.assets.push(video, audio)
  project.tracks[1].clips.push(createClip(video, project, { id: 'first', trimOut: 4 }), createClip(video, project, { id: 'second', start: 4, trimIn: 4, trimOut: 8 }))
  project.tracks[2].clips.push(createClip(audio, project, { id: 'voice', trimOut: 12 }))
  project.tracks[0].clips.push(createSubtitleClip(project, { id: 'caption', text: '画面说明', trimOut: 10 }))
  return project
}

test('hidden track state persists, keeps editing bounds and restores with undo without changing mute or clips', () => {
  const source = fixture(), trackId = source.tracks[2].id
  let project = setTrack(source, trackId, { hidden: true, muted: true })
  assert.equal(projectDuration(project), 12)
  assert.equal(renderDuration(project), 10)
  assert.equal(validateProject(JSON.parse(JSON.stringify(project))).tracks[2].hidden, true)
  assert.deepEqual(project.tracks[2].clips, source.tracks[2].clips)
  assert.equal(activeClips(project, 1).some(item => item.track.id === trackId), false)
  const history = commitHistory(createHistory(source), project)
  assert.equal(undoHistory(history).present.tracks[2].hidden, undefined)
  assert.equal(redoHistory(undoHistory(history)).present.tracks[2].hidden, true)
  project = setTrack(project, trackId, { hidden: false })
  assert.equal(renderDuration(project), 12)
  assert.equal(project.tracks[2].muted, true)
  assert.equal(project.tracks[2].clips[0].volume, source.tracks[2].clips[0].volume)
  assert.throws(() => validateProject({ ...source, tracks: source.tracks.map(track => ({ ...track, hidden: 'true' })) }), /开关/)
})

test('hidden visuals cannot be hit-tested and hidden transitions retain bindings for reactivation', () => {
  const source = fixture(), videoId = source.tracks[1].id
  let project = addTransition(source, 4, 'fade', 2, videoId)
  const transitionId = project.tracks.find(track => track.kind === 'transition').id
  const effect = transitionVisualAt(project, 'first', 3.5)
  assert.ok(effect)
  project = setTrack(project, transitionId, { hidden: true })
  assert.equal(transitionVisualAt(project, 'first', 3.5), undefined)
  project = setTrack(project, transitionId, { hidden: false })
  assert.deepEqual(transitionVisualAt(project, 'first', 3.5), effect)
  project = setTrack(project, videoId, { hidden: true })
  assert.equal(findTransitionCut(project, 4), undefined)
  assert.equal(transitionVisualAt(project, 'first', 3.5), undefined)
  assert.equal(visibleVisualClips(project, 1).some(item => item.track.id === videoId), false)
  assert.equal(project.tracks.find(track => track.id === transitionId).clips.length, 1)
  project = setTrack(project, videoId, { hidden: false })
  assert.deepEqual(transitionVisualAt(project, 'first', 3.5), effect)
})

test('render bounds, export inspection and audio previews consistently exclude hidden tracks', () => {
  let project = fixture()
  project = setTrack(project, project.tracks[0].id, { hidden: true })
  project = setTrack(project, project.tracks[2].id, { hidden: true })
  project.tracks[0].clips[0].text = ''
  assert.equal(renderDuration(project), 8)
  assert.deepEqual(previewRange(project, {}), { start: 0, end: 8 })
  assert.throws(() => previewRange(project, { start: 0, end: 12 }), /预览范围/)
  assert.equal(inspectExportStructure(project).some(issue => issue.code === 'subtitle_empty'), false)
  assert.throws(() => audioPreviewProject(project, { mode: 'solo', trackIds: [project.tracks[2].id] }), /不存在|不含音频/)
  assert.throws(() => audioPreviewProject(project, { mode: 'solo', clipIds: ['voice'] }), /不存在|不含音频/)
  project = setTrack(project, project.tracks[1].id, { hidden: true })
  assert.equal(renderDuration(project), 0)
  assert.equal(projectDuration(project), 12)
  assert.ok(inspectExportStructure(project).some(issue => issue.code === 'empty_timeline'))
  assert.throws(() => audioPreviewProject(project, {}), /没有可听/)
})

test('MCP exposes independent hidden control and reports both editing and rendering duration', () => {
  const project = fixture(), trackId = project.tracks[2].id
  const args = { trackId, patch: { hidden: true } }
  validateMcpToolArguments('open_media_track_update', args)
  const result = executeProjectTool(project, 'open_media_track_update', args)
  assert.equal(result.project.tracks[2].hidden, true)
  assert.equal(result.project.tracks[2].muted, false)
  const exposed = inspectMcpProject(result.project)
  assert.equal(exposed.duration, 12)
  assert.equal(exposed.renderDuration, 10)
  assert.throws(() => validateMcpToolArguments('open_media_track_update', { trackId, patch: { hidden: 'yes' } }), /开关值/)
})
