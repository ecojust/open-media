import test from 'node:test'
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { createProject, createClip } from '../src/core/project.ts'

const boundaries = new Map([
  [new URL('../src/native.ts', import.meta.url).href, ['isDesktop']],
  [new URL('../src/native-project-files.ts', import.meta.url).href, ['materializeProjectAsset', 'restoreNativeProjectAsset']],
  ['project-library-test:core', ['invoke', 'convertFileSrc']],
])
registerHooks({
  resolve(specifier, context, next) { return specifier === '@tauri-apps/api/core' ? { url: 'project-library-test:core', shortCircuit: true } : next(specifier, context) },
  load(url, context, next) {
    const names = boundaries.get(url)
    return names ? { format: 'module', shortCircuit: true, source: names.map(name => `export function ${name}(...args) { return globalThis.__projectLibraryIo.${name}(...args) }`).join('\n') } : next(url, context)
  },
})
const { prepareProjectMedia, isProjectMediaPrepared, saveManagedProject, listManagedProjects, loadManagedProject, removeManagedProjectDraft } = await import('../src/native-project-library.ts')
function fixture() {
  const calls = [], documents = new Map(), restored = [], savedTimes = new Map()
  const io = {
    isDesktop: () => true,
    convertFileSrc: path => `asset://${path}`,
    async materializeProjectAsset(projectId, asset, options) {
      options.signal?.throwIfAborted()
      return { ...asset, nativePath: asset.nativePath || `/temporary/${asset.id}.mp4` }
    },
    async restoreNativeProjectAsset(asset) { restored.push(asset); const value = { ...asset, url: `asset://${asset.nativePath}` }; delete value.sourceUrl; return value },
    async invoke(command, args) {
      calls.push({ command, args })
      if (command === 'ensure_project_media') return { directory: `/projects/${args.projectId}`, assets: args.assets.map(asset => ({ assetId: asset.id, nativePath: `/projects/${args.projectId}/assets/${asset.id}.mp4`, size: asset.size })) }
      if (command === 'save_managed_project') { const project = structuredClone(args.project); project.assets.forEach(asset => { asset.url = ''; delete asset.sourceUrl }); documents.set(project.id, project); const savedAt = '2026-10-21T23:15:12.345Z'; savedTimes.set(project.id, savedAt); return { directory: `/projects/${project.id}`, savedAt } }
      if (command === 'list_managed_projects') return [...documents.values()].map(project => ({ id: project.id, title: project.title, updatedAt: project.updatedAt, width: project.width, height: project.height, assetCount: project.assets.length, duration: 600 }))
      if (command === 'load_managed_project') return { ...structuredClone(documents.get(args.projectId)), localDraftSavedAt: savedTimes.get(args.projectId) }
      if (command === 'remove_managed_project_draft') { documents.delete(args.projectId); return }
      throw new Error(`Unexpected ${command}`)
    },
  }
  globalThis.__projectLibraryIo = io
  const project = createProject('独立工程')
  project.assets = [{ id: 'video-source', name: '录屏.mp4', kind: 'video', url: 'asset:///recording/source.mp4', nativePath: '/recording/source.mp4', duration: 600, width: 1920, height: 1080, size: 8 * 1024 ** 3, mime: 'video/mp4', provenance: { kind: 'url', sha256: 'a'.repeat(64), url: 'https://media.invalid/video.mp4', importedAt: 100 } }]
  project.tracks.find(track => track.kind === 'video').clips = [createClip(project.assets[0], project)]
  project.mcpMotion = { enabled: true, assetIds: [project.assets[0].id], styleId: '' }
  return { io, project, calls, documents, restored }
}

test('large native media is copied before acceptance without changing references or editable metadata', async () => {
  const { project, calls } = fixture(), before = structuredClone(project)
  assert.equal(isProjectMediaPrepared(project), false)
  const ready = await prepareProjectMedia(project)
  assert.deepEqual(project, before)
  assert.deepEqual(ready.tracks, before.tracks)
  assert.deepEqual(ready.mcpMotion, before.mcpMotion)
  assert.deepEqual(ready.assets[0].provenance, before.assets[0].provenance)
  assert.equal(ready.assets[0].nativePath, `/projects/${project.id}/assets/video-source.mp4`)
  assert.equal(ready.assets[0].url, `asset://${ready.assets[0].nativePath}`)
  assert.equal(ready.assets[0].size, 8 * 1024 ** 3)
  assert.equal(isProjectMediaPrepared(ready), true)
  assert.equal(isProjectMediaPrepared(project), false)
  ready.title = '已修改标题'
  await prepareProjectMedia(ready)
  assert.equal(calls.filter(call => call.command === 'ensure_project_media').length, 1, 'ordinary edits must not copy or transfer files again')
})

test('empty projects receive a native folder and additions invalidate only the preparation fast path', async () => {
  const { project, calls } = fixture(), originalAsset = project.assets[0]
  project.assets = []; project.tracks.forEach(track => { track.clips = [] })
  const ready = await prepareProjectMedia(project)
  assert.equal(isProjectMediaPrepared(ready), true)
  assert.deepEqual(calls[0].args.assets, [])
  ready.assets.push(originalAsset)
  assert.equal(isProjectMediaPrepared(ready), false)
  const added = await prepareProjectMedia(ready)
  assert.equal(isProjectMediaPrepared(added), true)
  await prepareProjectMedia(added, { verifyFiles: true })
  assert.equal(calls.length, 3)
})

test('late native results after cancellation cannot mark a project as accepted or mutate the source', async () => {
  const { project, io } = fixture(), before = structuredClone(project), controller = new AbortController()
  const invoke = io.invoke
  io.invoke = async (...args) => { const value = await invoke(...args); controller.abort(); return value }
  await assert.rejects(prepareProjectMedia(project, { signal: controller.signal }), { name: 'AbortError' })
  assert.deepEqual(project, before)
  assert.equal(isProjectMediaPrepared(project), false)
})

test('project switches reject late preparation results and missing files preserve the source', async () => {
  const { project, io } = fixture(), before = structuredClone(project)
  let current = true
  const invoke = io.invoke
  io.invoke = async (...args) => { const result = await invoke(...args); current = false; return result }
  await assert.rejects(prepareProjectMedia(project, { assertCurrent: () => { if (!current) throw new Error('工程已切换') } }), /工程已切换/)
  assert.deepEqual(project, before)
  io.invoke = async () => { throw new Error('素材“录屏.mp4”无法收录') }
  await assert.rejects(prepareProjectMedia(project), /无法收录/)
  assert.deepEqual(project, before)
})

test('owned assets retain durable native previews and replace transient previews before child cleanup', async () => {
  const first = fixture()
  first.project.assets[0].sourceUrl = first.project.assets[0].url
  first.project.assets[0].url = 'asset:///preview/compatible.mp4'
  const native = await prepareProjectMedia(first.project)
  assert.equal(native.assets[0].url, 'asset:///preview/compatible.mp4')
  assert.equal(native.assets[0].sourceUrl, `asset://${native.assets[0].nativePath}`)
  assert.equal(first.restored.length, 0)
  const second = fixture()
  second.project.assets[0].sourceUrl = 'blob:temporary-original'
  second.project.assets[0].url = 'blob:temporary-preview'
  const durable = await prepareProjectMedia(second.project)
  assert.equal(second.restored.length, 1)
  assert(!durable.assets[0].url.startsWith('blob:'))
  assert.equal(durable.assets[0].sourceUrl, undefined)
})

test('disk metadata supports a fresh load and history removal without deleting media', async () => {
  const { project, calls, restored } = fixture()
  project.updatedAt = '2026-10-20T13:00:00.000Z'
  await assert.rejects(saveManagedProject(project), /尚未收录/)
  const ready = await prepareProjectMedia(project)
  const saved = await saveManagedProject(ready)
  assert(saved.directory.endsWith(ready.id)); assert(Number.isFinite(Date.parse(saved.savedAt)))
  assert.equal(calls.find(call => call.command === 'save_managed_project').args.duration, 600)
  assert.equal((await listManagedProjects())[0].id, ready.id)
  let loadedSavedAt
  const loaded = await loadManagedProject(ready.id, { onSavedAt: value => { loadedSavedAt = value } })
  assert.equal(loadedSavedAt, saved.savedAt)
  assert.notEqual(loadedSavedAt, loaded.updatedAt)
  assert.equal(loaded.localDraftSavedAt, undefined, 'storage metadata must not change the project content or dirty state')
  assert.deepEqual(loaded.tracks, ready.tracks)
  assert.deepEqual(loaded.assets, ready.assets)
  assert.equal(restored.length, 1)
  assert.equal(isProjectMediaPrepared(loaded), true)
  await removeManagedProjectDraft(loaded.id)
  assert.deepEqual(await listManagedProjects(), [])
  assert.equal(isProjectMediaPrepared(loaded), false)
  assert(!calls.some(call => /delete.*asset|remove.*asset/.test(call.command)))
})

test('web preparation remains local and never calls native storage', async () => {
  const { project, io, calls } = fixture()
  io.isDesktop = () => false
  assert.deepEqual(await prepareProjectMedia(project), project)
  assert.equal(isProjectMediaPrepared(project), true)
  assert.deepEqual(await listManagedProjects(), [])
  await removeManagedProjectDraft(project.id)
  assert.deepEqual(calls, [])
})
