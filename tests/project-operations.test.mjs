import test from 'node:test'
import assert from 'node:assert/strict'
import { createProject, cloneProject } from '../src/core/project.ts'
import { executeTimelineBatch, setTimelineMarkers } from '../src/core/project-operations.ts'
import { executeProjectTool } from '../src/core/mcp-tools.ts'

const operation = (tool, args) => ({ tool: `open_media_${tool}`, arguments: args })
const context = { revision: 4, execute: executeProjectTool }
test('批量按隔离副本顺序执行，返回唯一最终项目及每步结果', () => {
  const source = createProject('原项目'), original = cloneProject(source)
  const result = executeTimelineBatch(source, { expectedRevision: 4, operations: [operation('project_update', { patch: { title: '批量完成' } }), operation('track_update', { trackId: source.tracks[0].id, patch: { name: '已更新' } })] }, context)
  assert.equal(result.project.title, '批量完成')
  assert.equal(result.project.tracks[0].name, '已更新')
  assert.equal(result.data.results.length, 2)
  assert.deepEqual(source, original)
})
test('后续操作错误不暴露任何中间项目；dryRun不返回可提交项目或selection', () => {
  const source = createProject(), original = cloneProject(source)
  assert.throws(() => executeTimelineBatch(source, { operations: [operation('project_update', { patch: { title: '不能写入' } }), operation('clip_remove', { clipId: 'missing' })] }, context), /第 2 项.*全部修改均未写入/)
  assert.deepEqual(source, original)
  const preview = executeTimelineBatch(source, { dryRun: true, operations: [operation('project_update', { patch: { title: '预检' } })] }, context)
  assert.equal(preview.project, undefined); assert.equal(preview.selection, undefined)
  assert.equal(preview.data.dryRun, true); assert.equal(preview.data.valid, true)
  assert.deepEqual(source, original)
})
test('revision冲突、嵌套和外部操作在执行器调用前拒绝', () => {
  const source = createProject(); let called = 0
  const ctx = { revision: 4, execute: () => { called++; throw new Error('不可调用') } }
  assert.throws(() => executeTimelineBatch(source, { expectedRevision: 3, operations: [operation('project_update', { patch: { title: 'x' } })] }, ctx), /版本已变化/)
  for (const name of ['timeline_batch_edit', 'speech_generate', 'asset_import', 'project_snapshot']) {
    assert.throws(() => executeTimelineBatch(source, { operations: [operation('project_update', { patch: { title: 'x' } }), operation(name, {})] }, ctx), /不是可批量执行/)
  }
  assert.throws(() => executeTimelineBatch(source, { operations: [operation('project_update', { expectedRevision: 2, patch: { title: 'x' } })] }, ctx), /版本已变化/)
  assert.equal(called, 0)
})
test('即使执行器错误原地修改后抛错，也不污染源项目；异步执行器拒绝', () => {
  const source = createProject(), original = cloneProject(source)
  assert.throws(() => executeTimelineBatch(source, { operations: [operation('project_update', {})] }, { revision: 1, execute(project) { project.title = '污染'; throw new Error('失败') } }), /失败/)
  assert.deepEqual(source, original)
  assert.throws(() => executeTimelineBatch(source, { operations: [operation('project_update', {})] }, { revision: 1, execute: () => Promise.resolve({ project: source }) }), /必须同步/)
})
test('标记排序、ID分配和原子替换；拒绝重复ID和越界字段', () => {
  const source = createProject()
  const result = setTimelineMarkers(source, { markers: [{ time: 8, label: '检查', kind: 'review' }, { id: 'chapter-one', time: 0, label: ' 第一章 ', kind: 'chapter', color: '#33aaff' }] })
  assert.equal(result.project.markers.length, 2); assert.equal(result.project.markers[0].label, '第一章')
  assert.match(result.project.markers[1].id, /^marker-/); assert.equal(source.markers, undefined)
  assert.deepEqual(setTimelineMarkers(result.project, { markers: [] }).project.markers, [])
  const bad = [{ id: 'same', time: 0, label: 'A', kind: 'chapter' }, { id: 'same', time: 1, label: 'B', kind: 'review' }]
  assert.throws(() => setTimelineMarkers(source, { markers: bad }), /重复/)
  for (const patch of [{ time: -1 }, { time: Infinity }, { time: 86401 }, { label: ' ' }, { color: 'red' }, { kind: 'other' }]) assert.throws(() => setTimelineMarkers(source, { markers: [{ time: 1, label: '点', kind: 'highlight', ...patch }] }))
})
