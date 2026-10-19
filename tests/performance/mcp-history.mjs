/**
 * Isolated controller benchmark: 30 completed image jobs with 512 KiB payloads.
 * The media boundary is synthetic; job storage, snapshots and protocol are real.
 * Run separately from media/browser benchmarks:
 * node --experimental-strip-types tests/performance/mcp-history.mjs
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { availableParallelism, cpus, release, totalmem } from 'node:os'
import { performance } from 'node:perf_hooks'
import { createProject } from '../../src/core/project.ts'

const boundaries = {
  '../../src/native.ts': ['acceptSpeechJobs', 'beginSpeechJob', 'beginSpeechModelDownload', 'cancelMediaJob', 'cancelSpeechJob', 'cancelSpeechModelDownload', 'discardSpeechJob', 'getMediaJobs', 'getSpeechJob', 'getSpeechStatus', 'repairSpeechModel', 'revealMediaJobOutput'],
  '../../src/native-mcp-files.ts': ['beginMcpMediaJob', 'importMcpMediaPaths', 'openMcpProjectFile', 'saveMcpProjectFile'],
  '../../src/core/native-project.ts': ['prepareNativeProject'],
  '../../src/core/project-file.ts': ['exportProjectFile', 'importProjectFile'],
  '../../src/core/mcp-materials.ts': ['listMcpMaterials', 'prepareMcpMaterial'],
  '../../src/core/editor-preview-tools.ts': ['preparePreviewTool'],
}
const modules = new Map(Object.entries(boundaries).map(([file, names]) => [new URL(file, import.meta.url).href, names]))
registerHooks({ load(url, context, nextLoad) {
  const names = modules.get(url)
  if (!names) return nextLoad(url, context)
  return { format: 'module', shortCircuit: true, source: names.map(name => `export function ${name}(...args) { return globalThis.__mcpHistoryPerformanceIo('${name}', args) }`).join('\n') }
} })

const { createMcpAutomation } = await import('../../src/core/mcp-automation.ts')
const project = createProject('任务历史性能测试'), blobs = new Map()
const framePayload = 'AQID'.repeat(128 * 1024), historyCount = 30, iterations = 20
let busy = false, frameId = 0
globalThis.__mcpHistoryPerformanceIo = (name) => {
  assert.equal(name, 'preparePreviewTool', 'This benchmark must not invoke native media or speech')
  return { data: { artifactId: `synthetic-frame-${++frameId}`, base64: framePayload, width: 1280, height: 720, time: 1 } }
}
const unexpected = () => { throw new Error('Unexpected project mutation') }
const controller = createMcpAutomation({
  getProject: () => project, getRevision: () => 1, isBusy: () => busy, isDirty: () => false,
  getBlobs: () => blobs, getSaveTarget: () => undefined,
  commit: unexpected, adopt: unexpected, hydrate: unexpected, didSave: unexpected, didOpen: unexpected,
  history: unexpected, getPlayback: () => ({ time: 1, playing: false, selectedClipId: '' }),
  setPlayback: unexpected, ownAsset: unexpected,
  onBusy: value => { busy = value }, onJobsChanged() {}, announce() {},
})

try {
  const ids = []
  for (let index = 0; index < historyCount; index++) {
    const job = await controller.execute('open_media_timeline_get_frame', { time: 1, width: 1280 })
    ids.push(job.id)
    const deadline = performance.now() + 5000
    while (busy) {
      assert.ok(performance.now() < deadline, 'Synthetic frame job did not settle')
      await new Promise(resolve => setImmediate(resolve))
    }
  }

  const summaries = controller.summaries()
  assert.equal(summaries.length, historyCount)
  for (const job of summaries) {
    assert.equal(Object.hasOwn(job, 'result'), false)
    assert.equal(job.state, 'completed')
    assert.equal(job.cancelable, false)
  }
  summaries[0].poll.arguments.id = 'external-change'
  const full = await controller.execute('open_media_job_get', { id: ids[0] })
  assert.equal(full.result.base64, framePayload)
  assert.equal(full.poll.arguments.id, ids[0])
  const list = await controller.execute('open_media_job_list', {})
  assert.ok(list.every(job => job.result.base64 === framePayload))
  list[0].result.artifactId = 'external-change'
  assert.notEqual((await controller.execute('open_media_job_get', { id: list[0].id })).result.artifactId, 'external-change')

  const paths = [
    { label: 'full-history-previous-ui-path', read: () => controller.list(), timings: [] },
    { label: 'status-summary-current-ui-path', read: () => controller.summaries(), timings: [] },
  ]
  for (let warmup = 0; warmup < 3; warmup++) for (const path of paths) path.read()
  for (let sample = 0; sample < iterations; sample++) {
    // Alternate order to avoid consistently charging garbage collection to one path.
    for (const path of sample % 2 ? paths : [...paths].reverse()) {
      const started = performance.now(), jobs = path.read()
      path.timings.push(performance.now() - started)
      assert.equal(jobs.length, historyCount)
    }
  }
  const readLimit = name => { try { return readFileSync(`/sys/fs/cgroup/${name}`, 'utf8').trim() } catch { return undefined } }
  const report = {
    environment: { node: process.version, platform: process.platform, arch: process.arch, osRelease: release(), cpu: cpus()[0]?.model, availableParallelism: availableParallelism(), totalMemory: totalmem(), cpuQuota: readLimit('cpu.max'), memoryLimit: readLimit('memory.max') },
    scenario: { boundary: 'synthetic PNG payload; real controller and protocol', historyCount, payloadBytesPerJob: framePayload.length, iterations },
    results: paths.map(path => {
      const samples = [...path.timings].sort((a, b) => a - b)
      return { label: path.label, medianMs: samples[Math.floor(samples.length / 2)], p95Ms: samples[Math.ceil(samples.length * .95) - 1], maxMs: samples.at(-1), serializedBytes: JSON.stringify(path.read()).length }
    }),
    assertions: { summariesOmitResult: true, fullProtocolRetainsResults: true, returnedResultsAreIsolated: true },
  }
  console.log(JSON.stringify(report, null, 2))
} finally { await controller.dispose(); delete globalThis.__mcpHistoryPerformanceIo }
