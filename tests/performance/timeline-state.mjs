import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { ref, shallowRef, computed, watch, nextTick, isReactive } from 'vue'
import { createProject, createTextClip, validateProject } from '../../src/core/project.ts'
import { updateClip } from '../../src/core/timeline.ts'

// Run separately from browser/encoder benchmarks to avoid CPU contention.
// This isolates immutable editing plus reactive notification, not UI frame time.
function fixture(count) {
  const project = createProject(`时间线 ${count} 片段`)
  for (let index = 0; index < count; index++) {
    project.tracks[0].clips.push(createTextClip(project, {
      id: `clip-${index}`, name: `字幕 ${index}`, text: `第 ${index} 段功能讲解字幕`,
      start: index * 2, trimOut: 1.5,
      keyframes: { opacity: [{ time: 0, value: 0, easing: 'linear' }, { time: 0.25, value: 1, easing: 'linear' }] },
    }))
  }
  return validateProject(project, { trusted: true })
}

function summarize(values) {
  const sorted = [...values].sort((left, right) => left - right)
  return {
    medianMs: sorted[Math.floor(sorted.length / 2)],
    p95Ms: sorted[Math.floor(sorted.length * 0.95)],
    maximumMs: sorted.at(-1),
  }
}

async function measure(project, optimized, iterations) {
  const working = optimized ? shallowRef(null) : ref(null)
  const active = computed(() => working.value || project)
  const originalX = project.tracks[0].clips[0].x
  let notifications = 0
  const stop = watch(active, () => { notifications++ }, optimized ? undefined : { deep: true })
  const edits = [], states = [], full = []
  try {
    for (let index = 0; index < iterations + 2; index++) {
      const start = performance.now()
      const next = updateClip(project, 'clip-0', { x: index + 1, y: index + 2 })
      const edited = performance.now()
      working.value = next
      await nextTick()
      const end = performance.now()
      assert.equal(active.value.tracks[0].clips[0].x, index + 1)
      assert.equal(project.tracks[0].clips[0].x, originalX, '临时拖动不可修改原始工程')
      assert.equal(isReactive(active.value), !optimized)
      if (index >= 2) {
        edits.push(edited - start)
        states.push(end - edited)
        full.push(end - start)
      }
    }
    assert.equal(notifications, iterations + 2, '每次替换工程都必须通知预览')
    return { notifications, updateClip: summarize(edits), watcher: summarize(states), completeUpdate: summarize(full) }
  } finally { stop() }
}

const report = {
  environment: { node: process.version, platform: process.platform, arch: process.arch },
  scope: 'Immutable editing and reactive-state microbenchmark; excludes browser layout, preview rendering and native desktop overhead.',
  iterations: 15,
  warmupIterations: 2,
  sizes: {},
}
for (const count of [70, 1000, 5000]) {
  const project = fixture(count)
  report.sizes[count] = {
    before: await measure(project, false, report.iterations),
    after: await measure(project, true, report.iterations),
  }
}
if (process.env.OPEN_MEDIA_PERFORMANCE_REPORT) {
  await mkdir(process.env.OPEN_MEDIA_PERFORMANCE_REPORT, { recursive: true })
  await writeFile(path.join(process.env.OPEN_MEDIA_PERFORMANCE_REPORT, 'timeline-state.json'), JSON.stringify(report, null, 2))
}
console.log(JSON.stringify(report, null, 2))
