import { computed, shallowReadonly, shallowRef } from 'vue'
import type { AiJob, AiRequest, AiStatus } from './ai.ts'
import { beginAiGeneration, cancelAiJob, cancelAiModelDownload, downloadAiModel, getAiStatus, repairAiModel } from '../native-ai.ts'

// One model/task view for the entire application, independent of workspace mounts.
const snapshot = shallowRef<AiStatus>({ models: [], jobs: [], busy: false })
const error = shallowRef(''), refreshing = shallowRef(false)
const mutations = shallowRef(0)
let observers = 0, revision = 0, timer: ReturnType<typeof setTimeout> | undefined
let pending: Promise<void> | undefined
let needsRefresh = false
export const aiState = computed<AiStatus>(() => ({ ...snapshot.value, busy: snapshot.value.busy || mutations.value > 0 }))
export const aiServiceError = shallowReadonly(error), aiRefreshing = shallowReadonly(refreshing)
const text = (cause: unknown) => cause instanceof Error ? cause.message : String(cause)
function schedule(): void {
  clearTimeout(timer)
  if (observers || aiState.value.busy || needsRefresh) timer = setTimeout(() => { void refreshAi() }, aiState.value.busy || needsRefresh ? 1000 : 4000)
}
export function refreshAi(): Promise<void> {
  if (pending) return pending
  const expected = revision
  refreshing.value = true
  pending = getAiStatus(false).then(value => { if (expected === revision) { snapshot.value = value; error.value = ''; needsRefresh = false } })
    .catch(cause => { if (expected === revision) error.value = text(cause) })
    .finally(() => { pending = undefined; refreshing.value = false; schedule() })
  return pending
}
export function observeAi(): () => void {
  observers++
  void refreshAi()
  let active = true
  return () => { if (active) { active = false; observers--; schedule() } }
}
async function mutate<T>(action: () => Promise<T>): Promise<T> {
  mutations.value++
  revision++
  needsRefresh = true
  schedule()
  let actionError: string | undefined
  try { return await action() }
  catch (cause) { actionError = text(cause); throw cause }
  finally {
    const expected = ++revision
    needsRefresh = true
    // Mutation responses are snapshots taken at different times. Re-read after
    // completion instead of letting a late download response erase a newer job.
    // A read already in flight belongs to an older revision and must drain first.
    if (pending) await pending
    await refreshAi()
    mutations.value--
    if (actionError !== undefined && expected === revision) error.value = actionError
    schedule()
  }
}
export const installAiModel = (id: string, accepted: boolean) => mutate(() => downloadAiModel(id, accepted)).then(() => {})
export const stopAiModelDownload = (id: string) => mutate(() => cancelAiModelDownload(id)).then(() => {})
export const updateAiModel = (id: string, accepted: boolean) => mutate(() => repairAiModel(id, accepted)).then(() => {})
export function generateAi(request: AiRequest): Promise<AiJob> {
  return mutate(async () => {
    const job = await beginAiGeneration(request)
    snapshot.value = { ...snapshot.value, busy: snapshot.value.busy || job.state === 'running', jobs: [job, ...snapshot.value.jobs.filter(item => item.id !== job.id)] }
    error.value = ''
    return job
  })
}
export const stopAiJob = (id: string) => mutate(() => cancelAiJob(id))
export function aiBytes(value: number): string { return value >= 1e9 ? `${(value / 1e9).toFixed(2)} GB` : `${(value / 1e6).toFixed(1)} MB` }
export function aiDuration(seconds: number): string { const value = Math.max(0, Math.floor(seconds)); return value < 60 ? `${value} 秒` : `${Math.floor(value / 60)} 分 ${value % 60} 秒` }
export const aiProviderNames = { speech: '配音', image: '图像', video: '视频', music: '歌曲' }
export const aiModelStateNames = { 'not-downloaded': '待下载', downloading: '正在下载', verifying: '正在校验', ready: '已就绪', failed: '未完成', unsupported: '当前设备不支持', 'update-available': '可更新' }
