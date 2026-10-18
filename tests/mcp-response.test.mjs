import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { McpBusyError, mcpBlockingJob, mcpJobResponse, mcpSynchronousResponse, serializeMcpError } from '../src/core/mcp-response.ts'
import { mediaToolError } from '../src/core/media-tool-error.ts'
import { isProjectTool } from '../src/core/mcp-tools.ts'

const job = { id: 'job-123', kind: 'editor-tool', tool: 'open_media_timeline_get_frame', name: '取帧', stage: '原生合成', state: 'running', cancelable: true }
test('job contracts preserve old fields and provide executable polling and cancellation links', () => {
  const result = mcpJobResponse(job)
  assert.equal(result.id, result.jobId)
  assert.equal(result.state, result.status)
  assert.equal(result.execution, 'asynchronous')
  assert.equal(result.final, false)
  assert.deepEqual(result.poll, { tool: 'open_media_job_get', arguments: { id: job.id } })
  assert.deepEqual(result.cancel, { tool: 'open_media_job_cancel', arguments: { id: job.id } })
  for (const state of ['completed', 'failed', 'cancelled']) {
    const terminal = mcpJobResponse({ ...job, state, result: { artifact: 'png' } })
    assert.equal(terminal.final, true)
    assert.equal(terminal.pollAfterMs, 0)
    assert.equal(terminal.cancel, null)
    assert.deepEqual(terminal.result, { artifact: 'png' })
  }
  assert.equal(mcpJobResponse({ ...job, cancelling: true }).cancel, null)
  assert.equal(mcpJobResponse({ ...job, cancelable: false }).cancel, null)
  assert.deepEqual(mcpSynchronousResponse({ revision: 7 }), { revision: 7, responseType: 'result', execution: 'synchronous', final: true })
  assert.equal(mcpSynchronousResponse(result), result)
  const list = [result]
  assert.equal(mcpSynchronousResponse(list), list)
})

test('busy errors identify the blocking job without claiming local operations have remote IDs', () => {
  const error = serializeMcpError(new McpBusyError(mcpBlockingJob(job)))
  assert.equal(error.code, 'PROJECT_BUSY')
  assert.equal(error.retryable, true)
  assert.equal(error.blockingJob.jobId, job.id)
  assert.equal(error.blockingJob.tool, job.tool)
  assert.equal(error.blockingJob.stage, job.stage)
  assert.deepEqual(error.blockingJob.cancel, mcpJobResponse(job).cancel)
  const local = serializeMcpError(new McpBusyError({ jobId: null, kind: 'gui-tool', source: 'local', state: 'running', cancelable: false, poll: null, cancel: null }))
  assert.equal(local.blockingJob.jobId, null)
  assert.equal(local.blockingJob.cancel, null)
})

test('media errors retain precise stage and safe asset context without serializing private exception data', () => {
  const inner = mediaToolError('素材准备', new Error('素材已丢失'), { resource: { assetId: 'asset-1', name: '片头.mp4', nativePath: '/private/movie.mp4', url: 'asset://secret' } })
  const outer = mediaToolError('时间线取帧', inner, { relatedResources: [{ assetId: 'asset-2', name: '背景.mov', nativePath: '/private/background.mov' }], context: { time: 1.2, width: 640, nativePath: '/private/project' } })
  const result = serializeMcpError(outer)
  assert.equal(result.code, 'MEDIA_TOOL_FAILED')
  assert.equal(result.details.stage, '素材准备')
  assert.deepEqual(result.details.resource, { assetId: 'asset-1', name: '片头.mp4' })
  assert.deepEqual(result.details.relatedResources, [{ assetId: 'asset-2', name: '背景.mov' }])
  assert.deepEqual(result.details.context, { time: 1.2, width: 640 })
  assert.equal(JSON.stringify(result).includes('/private/'), false)
  assert.equal(JSON.stringify(result).includes('asset://'), false)
  assert.equal(serializeMcpError(new DOMException('已取消', 'AbortError')).code, 'CANCELLED')
})

test('every advertised tool exposes its execution contract and split catalogs match tools/list', () => {
  const catalog = JSON.parse(readFileSync(new URL('../src/mcp-tools.json', import.meta.url)))
  const byName = new Map(catalog.map(tool => [tool.name, tool]))
  for (const tool of catalog) {
    const contract = tool._meta?.['openmedia/execution']
    assert.ok(contract, tool.name)
    assert.match(tool.description, /执行方式：/)
    if (isProjectTool(tool.name)) assert.equal(contract.mode, 'synchronous', tool.name)
    if (contract.responseType === 'job') {
      assert.equal(contract.pollingTool, 'open_media_job_get')
      assert.equal(contract.cancelTool, 'open_media_job_cancel')
      assert.equal(contract.resultField, 'result')
    }
  }
  assert.deepEqual(byName.get('open_media_speech_model')._meta['openmedia/execution'].asynchronousWhen.action, ['download', 'repair'])
  for (const name of ['timeline_get_frame', 'timeline_batch_edit', 'export_validate']) assert.equal(byName.get(`open_media_${name}`)._meta['openmedia/execution'].mode, 'asynchronous')
  for (const file of readdirSync(new URL('../src', import.meta.url)).filter(name => /^mcp-.+-tools\.json$/.test(name))) {
    for (const tool of JSON.parse(readFileSync(new URL(`../src/${file}`, import.meta.url)))) assert.deepEqual(tool, byName.get(tool.name), `${file}: ${tool.name}`)
  }
})
