import test from 'node:test'
import assert from 'node:assert/strict'
import { createProject, validateProject } from '../src/core/project.ts'
import { prepareMotionStyleTool } from '../src/core/motion-style-service.ts'
import { isSharedEditorTool, prepareEditorTool } from '../src/core/editor-tool-service.ts'
import { projectSourceAssets } from '../src/core/editor-assets.ts'

const tool = 'open_media_motion_compose'
const png = () => new Blob([Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10])], { type: 'image/png' })
function fixture() {
  const project = createProject('素材风格编排', { width: 1280, height: 720 })
  project.assets.push({ id: 'photo', name: '照片.png', kind: 'image', mime: 'image/png', url: 'blob:original-photo', width: 1200, height: 800, duration: 0, size: 2048 })
  return project
}
const options = () => ({ styleId: 'flat-pop', scenes: [{ assetId: 'photo', heading: '观察细节', caption: '保留可编辑图层', duration: 4 }] })
function context(project, controller = new AbortController()) {
  return { project, revision: 3, source: 'gui', blobs: new Map(), signal: controller.signal, onProgress() {} }
}
function dependencies(overrides = {}) {
  const calls = [], revoked = []
  let serial = 0
  const imported = (name, size, native = false) => ({ id: `art-${++serial}`, name, kind: 'image', mime: 'image/png', url: `blob:art-${serial}`, width: 1280, height: 720, duration: 0, size, ...(native ? { nativePath: `/media/art-${serial}.png` } : {}) })
  return {
    calls, revoked,
    async renderArt(...args) { calls.push(['render', ...args]); return { background: png(), decoration: png() } },
    isDesktop: () => false,
    async importBrowser(file) { calls.push(['browser', file]); return imported(file.name, file.size) },
    async importNative(bytes, name) { calls.push(['native', bytes, name]); return imported(name, bytes.byteLength, true) },
    revokeAsset(asset) { revoked.push(asset.id) },
    ...overrides,
  }
}

test('catalog and dry-run are side-effect free and need no drawing or native runtime', async () => {
  const project = fixture(), before = structuredClone(project), deps = dependencies({ renderArt() { throw Error('must not render') } })
  const list = await prepareMotionStyleTool('open_media_motion_style_list', {}, context(project), deps)
  assert.equal(list.data.total, 15); assert.equal(list.data.items.length, 15)
  list.data.items[0].name = 'changed'
  const again = await prepareMotionStyleTool('open_media_motion_style_list', {}, context(project), deps)
  assert.notEqual(again.data.items[0].name, 'changed')
  const prepared = await prepareMotionStyleTool(tool, { ...options(), dryRun: true, expectedRevision: 3, expectedProjectId: project.id }, context(project), deps)
  assert.equal(prepared.data.dryRun, true); assert.equal(prepared.data.scenes.length, 1)
  assert.equal(prepared.project, undefined); assert.equal(prepared.assets, undefined)
  assert.deepEqual(project, before); assert.deepEqual(deps.calls, [])
})

test('invalid input, project drift and stale revisions reject before artwork is created', async () => {
  const project = fixture(), before = structuredClone(project), deps = dependencies()
  for (const args of [
    { ...options(), styleId: 'unknown-style' },
    { ...options(), scenes: [{ assetId: 'missing', duration: 4 }] },
    { ...options(), dryRun: 'yes' },
    { ...options(), arbitraryCode: 'ignored' },
    { ...options(), expectedProjectId: 'other-project' },
    { ...options(), expectedRevision: 2 },
  ]) await assert.rejects(prepareMotionStyleTool(tool, args, context(project), deps))
  await assert.rejects(prepareMotionStyleTool(tool, options(), { ...context(project), assertCurrent() { throw Error('project switched') } }, deps), /project switched/)
  assert.deepEqual(project, before); assert.deepEqual(deps.calls, [])
})

test('browser preparation owns both artwork blobs and returns one detached editable project', async () => {
  const project = fixture(), before = structuredClone(project), deps = dependencies(), progress = []
  const prepared = await prepareMotionStyleTool(tool, options(), { ...context(project), onProgress(update) { progress.push(update) } }, deps)
  assert.deepEqual(project, before)
  assert.equal(prepared.assets.length, 2)
  assert.equal(deps.calls.filter(call => call[0] === 'browser').length, 2)
  assert.equal(deps.calls.filter(call => call[0] === 'native').length, 0)
  assert.deepEqual(deps.calls[0].slice(-2), [1280, 720])
  for (const entry of prepared.assets) {
    assert.equal(entry.blob.type, 'image/png')
    assert.ok(prepared.project.assets.some(asset => asset.id === entry.asset.id))
    assert.ok(prepared.project.tracks.some(track => track.clips.some(clip => clip.assetId === entry.asset.id)))
  }
  assert.ok(prepared.project.tracks.some(track => track.clips.some(clip => clip.text === '观察细节')))
  assert.equal(prepared.data.sceneCount, 1); assert.equal(prepared.data.dryRun, false)
  assert.deepEqual(prepared.data.selection, prepared.selection)
  validateProject(prepared.project, { trusted: true })
  assert.equal(progress.at(-1).progress, 1)
  await prepared.accept()
  await prepared.discard()
  assert.deepEqual(deps.revoked, [])
})

test('native preparation sends PNG bytes through native import and preserves native paths', async () => {
  const project = fixture(), deps = dependencies({ isDesktop: () => true })
  const prepared = await prepareMotionStyleTool(tool, options(), context(project), deps)
  assert.equal(deps.calls.filter(call => call[0] === 'browser').length, 0)
  const imports = deps.calls.filter(call => call[0] === 'native')
  assert.equal(imports.length, 2)
  assert.ok(imports.every(call => call[1] instanceof Uint8Array && call[2].endsWith('.png')))
  assert.ok(prepared.assets.every(({ asset }) => asset.nativePath))
  await prepared.discard()
  await prepared.discard()
  assert.deepEqual(deps.revoked, ['art-1', 'art-2'])
})

test('generated artwork stays in its own library category after save data is reloaded', async () => {
  const project = fixture(), prepared = await prepareMotionStyleTool(tool, options(), context(project), dependencies())
  const reopened = validateProject(JSON.parse(JSON.stringify(prepared.project)), { trusted: true })
  assert.ok(prepared.assets.every(({ asset }) => asset.libraryRole === 'motion-style'))
  assert.deepEqual(reopened.assets.filter(asset => asset.libraryRole === 'motion-style').map(asset => asset.id), prepared.assets.map(({ asset }) => asset.id))
  assert.deepEqual(projectSourceAssets(prepared.project).map(asset => asset.id), ['photo'])
  assert.deepEqual(projectSourceAssets(reopened).map(asset => asset.id), ['photo'])
  assert.equal(reopened.assets.find(asset => asset.id === 'photo').libraryRole, undefined)
  await prepared.discard()
})

test('pre-cancelled and cancelled artwork generation never import assets or change the project', async () => {
  const project = fixture(), before = structuredClone(project), controller = new AbortController(), deps = dependencies()
  controller.abort()
  await assert.rejects(prepareMotionStyleTool(tool, options(), context(project, controller), deps), { name: 'AbortError' })
  assert.deepEqual(deps.calls, [])
  const during = new AbortController()
  deps.renderArt = async () => { during.abort(); return { background: png(), decoration: png() } }
  await assert.rejects(prepareMotionStyleTool(tool, options(), context(project, during), deps), { name: 'AbortError' })
  assert.deepEqual(deps.calls, []); assert.deepEqual(deps.revoked, []); assert.deepEqual(project, before)
})

test('late import completion after cancellation is reclaimed instead of leaking its object URL', async () => {
  const project = fixture(), before = structuredClone(project), controller = new AbortController(), deps = dependencies()
  const importBrowser = deps.importBrowser
  deps.importBrowser = async file => { const asset = await importBrowser(file); controller.abort(); return asset }
  await assert.rejects(prepareMotionStyleTool(tool, options(), context(project, controller), deps), { name: 'AbortError' })
  assert.deepEqual(deps.revoked, ['art-1'])
  assert.equal(deps.calls.filter(call => call[0] === 'browser').length, 1)
  assert.deepEqual(project, before)
})

test('partial import failure and revision drift reclaim all previously owned artwork', async () => {
  const project = fixture(), before = structuredClone(project), deps = dependencies()
  const importBrowser = deps.importBrowser
  let count = 0
  deps.importBrowser = async file => { if (++count === 2) throw Error('cannot decode decoration'); return importBrowser(file) }
  await assert.rejects(prepareMotionStyleTool(tool, options(), context(project), deps), /cannot decode decoration/)
  assert.deepEqual(deps.revoked, ['art-1'])
  const driftDeps = dependencies(), original = driftDeps.importBrowser
  let changed = false
  driftDeps.importBrowser = async file => { const asset = await original(file); changed = true; return asset }
  await assert.rejects(prepareMotionStyleTool(tool, options(), { ...context(project), assertCurrent() { if (changed) throw Error('project changed') } }, driftDeps), /project changed/)
  assert.deepEqual(driftDeps.revoked, ['art-1']); assert.deepEqual(project, before)
})

test('invalid artwork or metadata cannot prepare a malformed project', async () => {
  const project = fixture(), before = structuredClone(project)
  const empty = dependencies({ async renderArt() { return { background: new Blob([], { type: 'image/png' }), decoration: png() } } })
  await assert.rejects(prepareMotionStyleTool(tool, options(), context(project), empty), /有效图片/)
  assert.equal(empty.calls.length, 0)
  const invalid = dependencies(), importer = invalid.importBrowser
  invalid.importBrowser = async file => ({ ...await importer(file), width: 0 })
  await assert.rejects(prepareMotionStyleTool(tool, options(), context(project), invalid), /导入失败/)
  assert.deepEqual(invalid.revoked, ['art-1']); assert.deepEqual(project, before)
})

test('host rejection discards all art URLs, including distinct blob source URLs', async () => {
  const project = fixture(), deps = dependencies(), importer = deps.importBrowser
  const sourceUrls = [], originalRevoke = URL.revokeObjectURL
  deps.importBrowser = async file => ({ ...await importer(file), sourceUrl: URL.createObjectURL(png()) })
  URL.revokeObjectURL = url => { sourceUrls.push(url); originalRevoke.call(URL, url) }
  try {
    const prepared = await prepareMotionStyleTool(tool, options(), context(project), deps)
    await prepared.discard(); await prepared.discard()
    assert.deepEqual(deps.revoked, ['art-1', 'art-2'])
    assert.equal(sourceUrls.length, 2)
    assert.deepEqual(sourceUrls, prepared.assets.map(({ asset }) => asset.sourceUrl))
  } finally { URL.revokeObjectURL = originalRevoke }
})

test('shared GUI runner advertises the feature and validates its published arguments before work', async () => {
  const project = fixture()
  assert.equal(isSharedEditorTool(tool), true)
  assert.equal(isSharedEditorTool('open_media_motion_style_list'), true)
  const prepared = await prepareEditorTool(tool, { ...options(), dryRun: true, expectedRevision: 3 }, context(project))
  assert.equal(prepared.project, undefined); assert.equal(prepared.data.dryRun, true)
  await assert.rejects(prepareEditorTool(tool, { ...options(), dryRun: true, expectedRevision: 2 }, context(project)), /revision/)
  await assert.rejects(prepareEditorTool(tool, { ...options(), dryRun: true, arbitraryCode: 'must reject' }, context(project)))
})
