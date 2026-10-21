// Shared IPC boundary fixture. Project ownership, copies and durable metadata
// are modeled separately from the real application state and undo history.
async function installManagedProjectBridge(page) {
  await page.addInitScript(() => {
    const state = window.managedProjectFixture = { projects: new Map(), files: new Map(), uploads: new Map(), calls: [], nextId: 1, holdNextPrepare: false }
    window.managedProjectFileUrl = path => state.files.get(path)?.url || path
    window.managedProjectCommand = async (command, args = {}, options = {}) => {
      if (!['ensure_project_media', 'save_managed_project', 'list_managed_projects', 'load_managed_project', 'remove_managed_project_draft', 'project_asset_begin', 'project_asset_write', 'project_asset_finish', 'project_asset_cancel'].includes(command)) return { handled: false }
      state.calls.push({ command, args: structuredClone(args) })
      const result = value => ({ handled: true, value })
      if (command === 'project_asset_begin') {
        const id = `upload-${state.nextId++}`
        state.uploads.set(id, { name: args.name, size: args.size, chunks: [], received: 0 })
        return result({ id })
      }
      if (command === 'project_asset_write') {
        const bytes = new Uint8Array(args), offset = Number(new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getBigUint64(0, true))
        const upload = state.uploads.get(options.headers['x-upload-id'])
        if (!upload || offset !== upload.received || bytes.byteLength <= 8) throw Error('Invalid asset chunk')
        upload.chunks.push(bytes.slice(8)); upload.received += bytes.byteLength - 8
        return result(null)
      }
      if (command === 'project_asset_cancel') { state.uploads.delete(args.id); return result(null) }
      if (command === 'project_asset_finish') {
        const upload = state.uploads.get(args.id)
        if (!upload || upload.received !== upload.size) throw Error('Incomplete asset upload')
        const mime = /\.png$/i.test(upload.name) ? 'image/png' : /\.wav$/i.test(upload.name) ? 'audio/wav' : 'application/octet-stream'
        const url = await new Promise((resolve, reject) => {
          const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = () => reject(reader.error)
          reader.readAsDataURL(new Blob(upload.chunks, { type: mime }))
        })
        const nativePath = `/fixture/staged/${args.id}/${upload.name}`
        const asset = { id: args.id, name: upload.name, nativePath, url, mime, kind: mime.startsWith('image/') ? 'image' : 'audio', size: upload.size, duration: 0, width: 1, height: 1 }
        state.files.set(nativePath, asset); state.uploads.delete(args.id)
        return result(structuredClone(asset))
      }
      if (command === 'ensure_project_media') {
        const directory = `/fixture/projects/${args.projectId}`
        const assets = args.assets.map(asset => {
          if (!asset.nativePath || !(asset.size > 0)) throw Error('Project media must be materialized before copying')
          const nativePath = asset.nativePath.startsWith(`${directory}/assets/`) ? asset.nativePath : `${directory}/assets/${asset.id}-${asset.name}`
          const original = state.files.get(asset.nativePath)
          state.files.set(nativePath, { ...structuredClone(asset), nativePath, url: original?.url || asset.url })
          return { assetId: asset.id, nativePath, size: asset.size }
        })
        if (state.holdNextPrepare) {
          state.holdNextPrepare = false
          await new Promise(resolve => { state.releasePrepare = () => { state.releasePrepare = undefined; resolve() } })
        }
        return result({ directory, assets })
      }
      if (command === 'save_managed_project') {
        const project = structuredClone(args.project), directory = `/fixture/projects/${project.id}`, savedAt = new Date().toISOString()
        for (const asset of project.assets) {
          if (!asset.nativePath?.startsWith(`${directory}/assets/`) || !state.files.has(asset.nativePath)) throw Error('Saving a project with unowned media')
          asset.url = ''; delete asset.sourceUrl
        }
        state.projects.set(project.id, { project, duration: args.duration, savedAt })
        return result({ directory, savedAt })
      }
      if (command === 'list_managed_projects') return result([...state.projects.values()].map(({ project, duration }) => ({ id: project.id, title: project.title, width: project.width, height: project.height, updatedAt: project.updatedAt, duration, assetCount: project.assets.length })).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)))
      if (command === 'load_managed_project') {
        const stored = state.projects.get(args.projectId)
        if (!stored) throw Error('Unknown managed project')
        return result(structuredClone(stored.project))
      }
      state.projects.delete(args.projectId)
      return result(null)
    }
  })
}

module.exports = { installManagedProjectBridge }
