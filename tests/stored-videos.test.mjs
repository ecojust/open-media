import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import * as vue from 'vue'
import { mergeStoredVideoAssets, recentVideoAssets, videoAssetKey } from '../src/core/video-assets.ts'

const source = readFileSync(new URL('../src/core/stored-videos.ts', import.meta.url), 'utf8')
const compiled = ts.transpileModule(`${source.replace(/^import .*$/gm, '').replace('export function useStoredVideos', 'function useStoredVideos')}\nreturn useStoredVideos`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText

function video(id, extra = {}) {
  return { id, name: `${id}.mp4`, kind: 'video', url: `asset://localhost/${id}.mp4`, nativePath: `/recordings/${id}.mp4`, size: 1000, duration: 12, width: 1280, height: 720, mime: 'video/mp4', addedAt: '2026-10-19T10:00:00Z', ...extra }
}
function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
async function settle() { for (let i = 0; i < 6; i++) await Promise.resolve(); await vue.nextTick() }
function harness(options = {}) {
  const projectAssets = vue.shallowRef(options.projectAssets ?? []), enabled = vue.ref(options.enabled ?? true)
  const mounted = [], activated = [], deactivated = [], unmounted = [], listeners = new Map()
  const calls = { scans: 0, reveal: 0, previews: [] }
  const injected = {
    computed: vue.computed, ref: vue.ref, shallowRef: vue.shallowRef, watch: vue.watch,
    onMounted: callback => mounted.push(callback), onActivated: callback => activated.push(callback),
    onDeactivated: callback => deactivated.push(callback), onBeforeUnmount: callback => unmounted.push(callback),
    mergeStoredVideoAssets, recentVideoAssets, videoAssetKey,
    listStoredVideos: async () => { calls.scans++; return options.list ? options.list() : { directory: '/recordings', assets: [], warnings: [] } },
    openMediaLibraryDirectory: async () => { calls.reveal++; return options.reveal?.() },
    prepareStoredVideoPreview: async asset => { calls.previews.push(asset); return options.preview ? options.preview(asset) : { ...asset, url: `asset://localhost/preview-${asset.id}.mp4`, sourceUrl: asset.url } },
    window: {
      addEventListener: (name, listener) => { const group = listeners.get(name) ?? new Set(); group.add(listener); listeners.set(name, group) },
      removeEventListener: (name, listener) => { listeners.get(name)?.delete(listener) },
    },
  }
  const useStoredVideos = new Function(...Object.keys(injected), compiled)(...Object.values(injected))
  const scope = vue.effectScope()
  const state = scope.run(() => useStoredVideos(() => projectAssets.value, () => enabled.value))
  let disposed = false
  return {
    state, projectAssets, enabled, calls, listeners,
    mount: () => mounted.forEach(callback => callback()),
    activate: () => activated.forEach(callback => callback()),
    deactivate: () => deactivated.forEach(callback => callback()),
    focus: () => { for (const callback of listeners.get('focus') ?? []) callback() },
    watchSelection: selection => scope.run(() => vue.watch(() => state.assets.value.find(asset => asset.id === selection.value), asset => { if (asset) void state.preparePreview(asset) }, { immediate: true })),
    dispose() { if (!disposed) { disposed = true; unmounted.forEach(callback => callback()); scope.stop() } },
  }
}

test('shared directory and project videos merge without mutating or duplicating project assets', async () => {
  const local = video('project-recording', { nativePath: '/recordings/shared.mp4', name: '工程内名称', url: 'asset://localhost/project-preview.mp4', addedAt: '2026-10-18T08:00:00Z' })
  const stored = video('directory-recording', { nativePath: '/recordings/shared.mp4', addedAt: '2026-10-19T11:00:00Z' })
  const unrelated = video('other'), image = { ...video('picture'), kind: 'image' }
  const original = structuredClone([local, image])
  const h = harness({ projectAssets: [local, image], list: async () => ({ directory: '/recordings', assets: [stored, unrelated], warnings: ['一个文件暂时无法读取'] }) })
  try {
    h.mount(); await h.state.refresh()
    assert.equal(h.calls.scans, 1, 'mount and explicit refresh share the pending scan')
    assert.equal(h.state.assets.value.length, 2)
    assert.equal(h.state.assets.value[0].id, local.id)
    assert.equal(h.state.assets.value[0].name, local.name)
    assert.equal(h.state.assets.value[0].addedAt, stored.addedAt)
    assert.equal(h.state.directory.value, '/recordings')
    assert.deepEqual(h.state.warnings.value, ['一个文件暂时无法读取'])
    assert.deepEqual(h.projectAssets.value, original)
    assert.equal(h.calls.previews.length, 0, 'listing does not eagerly convert every video')
  } finally { h.dispose() }
})

test('scan failures retain the previous directory and list, and a later successful refresh recovers', async () => {
  let scan = 0
  const h = harness({ list: async () => { if (++scan === 2) throw new Error('目录暂时无法访问'); return { directory: '/recordings', assets: [video(scan === 1 ? 'first' : 'newest')], warnings: [] } } })
  try {
    await h.state.refresh()
    assert.equal(h.state.assets.value[0].id, 'first')
    await h.state.refresh()
    assert.equal(h.state.assets.value[0].id, 'first')
    assert.equal(h.state.directory.value, '/recordings')
    assert.equal(h.state.error.value, '目录暂时无法访问')
    assert.equal(h.state.loading.value, false)
    await h.state.refresh()
    assert.equal(h.state.assets.value[0].id, 'newest')
    assert.equal(h.state.error.value, '')
  } finally { h.dispose() }
})

test('recordings view contains only scanned files and reuses project references without mixing library videos', async () => {
  const recording = video('saved-recording', { nativePath: '/recordings/session.mp4' })
  const imported = video('imported-video', { nativePath: '/media/imported.mp4' })
  const watermark = video('watermark', { nativePath: '/media/watermark.mp4', libraryRole: 'watermark' })
  let files = [video('directory-session', { nativePath: recording.nativePath })]
  const h = harness({ projectAssets: [recording, imported, watermark], list: async () => ({ directory: '/recordings', assets: files, warnings: [] }) })
  try {
    await h.state.refresh()
    assert.equal(h.state.assets.value.length, 3, 'existing consumers still receive the merged video list')
    assert.deepEqual(h.state.recordings.value.map(asset => asset.id), [recording.id])
    files = []
    await h.state.refresh()
    assert.deepEqual(h.state.recordings.value, [])
    assert.equal(h.projectAssets.value.length, 3, 'refresh cannot remove any project assets')
    h.enabled.value = false
    await settle()
    assert.deepEqual(h.state.recordings.value, [])
  } finally { h.dispose() }
})

test('browser-only mode never scans, opens the directory or creates native previews', async () => {
  const h = harness({ enabled: false, projectAssets: [video('project')] })
  try {
    h.mount(); h.activate(); h.focus()
    await h.state.refresh(); await h.state.reveal(); await h.state.preparePreview(h.projectAssets.value[0])
    assert.deepEqual(h.calls, { scans: 0, reveal: 0, previews: [] })
    assert.equal(h.state.assets.value[0].id, 'project')
    assert.equal(h.state.loading.value, false)
    assert.equal(h.state.preparing.value, false)
  } finally { h.dispose() }
})

test('only the selected video prepares a preview, concurrent requests deduplicate and revisits reuse it', async () => {
  const gate = deferred(), h = harness({ projectAssets: [video('first'), video('second')], preview: async asset => { if (asset.id === 'first') await gate.promise; return { ...asset, url: `asset://localhost/ready-${asset.id}.mp4`, sourceUrl: asset.url } } })
  const selected = vue.ref('first')
  try {
    h.watchSelection(selected)
    const first = h.state.preparePreview(h.projectAssets.value[0]), duplicate = h.state.preparePreview(h.projectAssets.value[0])
    assert.equal(first, duplicate)
    assert.deepEqual(h.calls.previews.map(asset => asset.id), ['first'])
    assert.equal(h.state.preparing.value, true)
    gate.resolve(); await first; await settle()
    assert.equal(h.state.preparing.value, false)
    assert.equal(h.state.assets.value.find(asset => asset.id === 'first').url, 'asset://localhost/ready-first.mp4')
    assert.equal(h.projectAssets.value[0].url, 'asset://localhost/first.mp4', 'preview overlays cannot mutate the project')
    selected.value = 'second'; await settle()
    assert.deepEqual(h.calls.previews.map(asset => asset.id), ['first', 'second'])
    selected.value = 'first'; await settle()
    assert.equal(h.calls.previews.length, 2)
    assert.equal(h.state.error.value, '')
  } finally { h.dispose() }
})

test('changed source fingerprints require a fresh preview without reusing an old rendered file', async () => {
  const h = harness({ projectAssets: [video('same')] })
  try {
    await h.state.preparePreview(h.projectAssets.value[0])
    assert.equal(h.calls.previews.length, 1)
    h.projectAssets.value = [video('same', { size: 2000, addedAt: '2026-10-19T12:00:00Z' })]
    assert.equal(h.state.assets.value[0].url, 'asset://localhost/same.mp4')
    await h.state.preparePreview(h.projectAssets.value[0])
    assert.equal(h.calls.previews.length, 2)
  } finally { h.dispose() }
})

test('unmount prevents late scan and preview results from landing and removes focus listeners', async () => {
  const scan = deferred(), preview = deferred()
  const h = harness({ projectAssets: [video('project')], list: () => scan.promise, preview: () => preview.promise })
  h.mount()
  const pendingScan = h.state.refresh(), pendingPreview = h.state.preparePreview(h.projectAssets.value[0])
  h.dispose()
  assert.equal(h.listeners.get('focus').size, 0)
  h.focus()
  scan.resolve({ directory: '/late-recordings', assets: [video('late')], warnings: ['old warning'] })
  preview.resolve({ ...video('project'), url: 'asset://localhost/late-preview.mp4' })
  await Promise.all([pendingScan, pendingPreview])
  assert.equal(h.state.directory.value, '')
  assert.deepEqual(h.state.warnings.value, [])
  assert.deepEqual(h.state.assets.value.map(asset => asset.id), ['project'])
  assert.equal(h.state.assets.value[0].url, 'asset://localhost/project.mp4')
  assert.equal(h.calls.scans, 1)
})

test('disabling ignores late scan and preview results while retaining project videos', async () => {
  const scan = deferred(), preview = deferred()
  const h = harness({ projectAssets: [video('project')], list: () => scan.promise, preview: () => preview.promise })
  try {
    const pendingScan = h.state.refresh(), pendingPreview = h.state.preparePreview(h.projectAssets.value[0])
    h.enabled.value = false; await settle()
    scan.resolve({ directory: '/late-recordings', assets: [video('late')], warnings: [] })
    preview.resolve({ ...video('project'), url: 'asset://localhost/late-preview.mp4' })
    await Promise.all([pendingScan, pendingPreview])
    assert.equal(h.state.directory.value, '')
    assert.equal(h.state.loading.value, false)
    assert.equal(h.state.assets.value.length, 1)
    assert.equal(h.state.assets.value[0].url, 'asset://localhost/project.mp4')
  } finally { h.dispose() }
})

test('a newly enabled scan wins over an older disabled request regardless of completion order', async () => {
  const old = deferred(), fresh = deferred()
  let count = 0
  const h = harness({ list: () => ++count === 1 ? old.promise : fresh.promise })
  try {
    const initial = h.state.refresh()
    h.enabled.value = false; await settle()
    h.enabled.value = true; await settle()
    const latest = h.state.refresh()
    fresh.resolve({ directory: '/fresh', assets: [video('fresh')], warnings: [] }); await latest
    old.resolve({ directory: '/old', assets: [video('old')], warnings: ['旧结果'] }); await initial
    assert.equal(h.state.directory.value, '/fresh')
    assert.deepEqual(h.state.assets.value.map(asset => asset.id), ['fresh'])
    assert.deepEqual(h.state.warnings.value, [])
    assert.equal(h.state.loading.value, false)
  } finally { h.dispose() }
})

test('a preview from an earlier enabled session cannot replace the current result or clear its pending state', async () => {
  const old = deferred(), fresh = deferred()
  let count = 0
  const h = harness({ projectAssets: [video('project')], preview: () => ++count === 1 ? old.promise : fresh.promise })
  try {
    const initial = h.state.preparePreview(h.projectAssets.value[0])
    h.enabled.value = false; await settle()
    assert.equal(h.state.preparing.value, false)
    h.enabled.value = true; await settle()
    const current = h.state.preparePreview(h.projectAssets.value[0])
    assert.equal(h.calls.previews.length, 2, 'new sessions must not reuse the invalidated promise')
    old.resolve({ ...video('project'), url: 'asset://localhost/old-session.mp4' }); await initial
    assert.equal(h.state.preparing.value, true, 'old completion cannot clear the new preview progress')
    assert.equal(h.state.assets.value[0].url, 'asset://localhost/project.mp4')
    fresh.resolve({ ...video('project'), url: 'asset://localhost/current-session.mp4' }); await current
    assert.equal(h.state.preparing.value, false)
    assert.equal(h.state.assets.value[0].url, 'asset://localhost/current-session.mp4')
  } finally { h.dispose() }
})

test('late previews for removed or replaced source files are not cached for later reuse', async () => {
  const missing = deferred(), replaced = deferred()
  let count = 0
  const original = video('project')
  const h = harness({ projectAssets: [original], preview: () => ++count === 1 ? missing.promise : replaced.promise })
  try {
    const first = h.state.preparePreview(original)
    h.projectAssets.value = []
    missing.resolve({ ...original, url: 'asset://localhost/removed.mp4' }); await first
    h.projectAssets.value = [original]
    assert.equal(h.state.assets.value[0].url, original.url)
    const second = h.state.preparePreview(original)
    assert.equal(h.calls.previews.length, 2)
    h.projectAssets.value = [{ ...original, size: 9000 }]
    replaced.resolve({ ...original, url: 'asset://localhost/replaced.mp4' }); await second
    assert.equal(h.state.assets.value[0].url, original.url)
    h.projectAssets.value = [original]
    assert.equal(h.state.assets.value[0].url, original.url, 'an old source fingerprint must not be cached after replacement')
  } finally { h.dispose() }
})

test('deactivated workspaces ignore late work and refresh when activated again', async () => {
  const old = deferred(), preview = deferred()
  let scans = 0
  const h = harness({ projectAssets: [video('project')], list: () => ++scans === 1 ? old.promise : Promise.resolve({ directory: '/active', assets: [video('active')], warnings: [] }), preview: () => preview.promise })
  try {
    h.mount()
    const pendingScan = h.state.refresh(), pendingPreview = h.state.preparePreview(h.projectAssets.value[0])
    h.deactivate()
    old.resolve({ directory: '/inactive', assets: [video('inactive')], warnings: [] })
    preview.resolve({ ...video('project'), url: 'asset://localhost/inactive-preview.mp4' })
    await Promise.all([pendingScan, pendingPreview])
    assert.equal(h.state.directory.value, '')
    assert.equal(h.state.assets.value.find(asset => asset.id === 'project').url, 'asset://localhost/project.mp4')
    h.focus(); await settle()
    assert.equal(h.calls.scans, 1)
    h.activate(); await h.state.refresh()
    assert.equal(h.state.directory.value, '/active')
  } finally { h.dispose() }
})

test('preview failures leave the original playable URL and allow retry, and directory-open errors are visible', async () => {
  let attempts = 0
  const h = harness({ projectAssets: [video('project')], preview: async asset => { if (++attempts === 1) throw new Error('预览创建失败'); return { ...asset, url: 'asset://localhost/recovered.mp4' } }, reveal: async () => { throw new Error('目录打开失败') } })
  try {
    await h.state.preparePreview(h.projectAssets.value[0])
    assert.equal(h.state.error.value, '预览创建失败')
    assert.equal(h.state.assets.value[0].url, 'asset://localhost/project.mp4')
    assert.equal(h.state.preparing.value, false)
    await h.state.preparePreview(h.projectAssets.value[0])
    assert.equal(h.state.assets.value[0].url, 'asset://localhost/recovered.mp4')
    await h.state.reveal()
    assert.equal(h.state.error.value, '目录打开失败')
    assert.equal(h.calls.reveal, 1)
  } finally { h.dispose() }
})
