// The editor host adapter uses the same project/history implementation as the UI.
// Native invoke is forwarded to real Rust file/media functions by the verifier.
import { createMcpAutomation } from '/src/core/mcp-automation.ts'
import { serializeMcpError } from '/src/core/mcp-response.ts'
import { createProject } from '/src/core/project.ts'
import { createHistory, commitHistory, undoHistory, redoHistory } from '/src/core/timeline.ts'
import { prepareNativeProjectArchive } from '/src/native-project-files.ts'
import { saveMcpProjectFile } from '/src/native-mcp-files.ts'

export function installProtocolEditor() {
  let history = createHistory(createProject('协议端到端工程', { width: 640, height: 360, fps: 30 }))
  let revision = 0, dirty = false, target, busy = false
  let playback = { time: 0, playing: false, selectedClipId: '' }
  const commits = [], blobs = new Map(), announcements = []
  window.__TAURI_INTERNALS__ = {
    invoke: (command, args) => window.protocolNativeInvoke(command, args),
    convertFileSrc: path => `${location.origin}/__protocol_asset__?path=${encodeURIComponent(path)}`,
  }
  const controller = createMcpAutomation({
    getProject: () => history.present, getRevision: () => revision, isBusy: () => false,
    getBlobs: () => blobs, getSaveTarget: () => target,
    commit(project, label, expected) {
      if (expected.projectId !== history.present.id || expected.revision !== revision) return false
      history = commitHistory(history, project); revision++; dirty = true
      commits.push({ label, revision }); return true
    },
    async hydrate() { throw new Error('Project hydration is outside this protocol fixture.') },
    async didSave(project, value) { target = value; if (project.updatedAt === history.present.updatedAt) dirty = false },
    history(direction) { history = direction === 'undo' ? undoHistory(history) : redoHistory(history); revision++; dirty = true },
    getPlayback: () => structuredClone(playback),
    async setPlayback(patch) { playback = { ...playback, ...patch }; return structuredClone(playback) },
    ownAsset(asset, blob) { if (blob) blobs.set(asset.id, blob) },
    onBusy(value) { busy = value }, onJobsChanged() {}, announce(value) { announcements.push(value) },
  })
  return {
    // The local user chooses a destination before remote saves can use its native token.
    // This fixture crosses real native archive I/O without displaying a system picker.
    async saveLocally(path) {
      const project = await prepareNativeProjectArchive(history.present, { blobs })
      target = await saveMcpProjectFile(project, { path })
      dirty = false
      return { name: target.name, path: target.path }
    },
    async execute(request) {
      try { return { result: await controller.execute(request.tool, request.arguments), isError: false } }
      catch (cause) { return { result: serializeMcpError(cause), isError: true } }
    },
    inspect() { return { project: structuredClone(history.present), revision, commits: structuredClone(commits), undoCount: history.past.length, busy, dirty, announcements } },
    dispose: () => controller.dispose(),
  }
}
