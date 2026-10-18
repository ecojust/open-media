import { computed, onBeforeUnmount, ref, shallowRef } from 'vue'
import type { EditorToolRunner } from './types'

export function useEditorTool(runner: () => EditorToolRunner, notifyBusy: (busy: boolean) => void) {
  const busy = ref(false), cancelling = ref(false), cancelable = ref(true), stage = ref(''), error = ref(''), notice = ref('')
  const progress = ref<number>(), result = shallowRef<unknown>()
  let controller: AbortController | undefined, disposed = false
  const percent = computed(() => progress.value === undefined ? undefined : Math.round(Math.max(0, Math.min(1, progress.value)) * 100))
  async function execute(name: string, args: Record<string, unknown>, success = '处理完成'): Promise<unknown> {
    if (busy.value || disposed) return undefined
    const current = new AbortController()
    controller = current; busy.value = true; cancelling.value = false; cancelable.value = true
    error.value = ''; notice.value = ''; result.value = undefined; progress.value = undefined; stage.value = '正在准备…'
    notifyBusy(true)
    try {
      const value = await runner()(name, args, { signal: current.signal, onProgress: update => {
        if (disposed || current !== controller || current.signal.aborted && update.cancelable !== false) return
        stage.value = update.stage
        if (update.cancelable === false) { cancelable.value = false; cancelling.value = false }
        progress.value = Number.isFinite(update.progress) ? update.progress : undefined
      } })
      if (disposed || current !== controller || current.signal.aborted && cancelable.value) return undefined
      result.value = value; notice.value = success
      return value
    } catch (cause) {
      if (disposed || current !== controller) return undefined
      if (current.signal.aborted && cancelable.value) notice.value = '已取消'
      else error.value = cause instanceof Error ? cause.message : String(cause)
      return undefined
    } finally {
      if (current === controller) { controller = undefined; busy.value = false; cancelling.value = false; notifyBusy(false) }
    }
  }
  function cancel(): void { if (controller && cancelable.value && !cancelling.value) { cancelling.value = true; stage.value = '正在取消…'; controller.abort() } }
  onBeforeUnmount(() => { disposed = true; const pending = controller; controller = undefined; if (cancelable.value) pending?.abort(); if (busy.value) { busy.value = false; notifyBusy(false) } })
  return { busy, cancelling, cancelable, stage, error, notice, progress, percent, result, execute, cancel }
}
