<script setup lang="ts">
import { onBeforeUnmount, shallowRef } from 'vue'
import CaptureSelectionOverlay from './CaptureSelectionOverlay.vue'
import type { CaptureSelection, CaptureSelectionContext } from '../core/capture-selection'
import { takeBrowserScreenshot, type BrowserScreenshotResult, type BrowserScreenshotSelectionRequest } from '../core/screenshot'

const picker = shallowRef<{ context: CaptureSelectionContext; imageUrl: string }>()
let finishChoice: ((selection: CaptureSelection | null) => void) | undefined
let controller: AbortController | undefined
let destroyed = false
function chooseSource({ imageUrl, source, signal }: BrowserScreenshotSelectionRequest, onConfirm?: () => void): Promise<CaptureSelection | null> {
  const sourceId = 'screen:browser-screenshot'
  const { width, height } = source
  return new Promise(resolve => {
    const complete = (selection: CaptureSelection | null) => {
      signal.removeEventListener('abort', abort)
      picker.value = undefined
      finishChoice = undefined
      resolve(selection)
      if (selection && !signal.aborted && !destroyed) onConfirm?.()
    }
    const abort = () => complete(null)
    finishChoice = complete
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted || destroyed) { abort(); return }
    picker.value = {
      imageUrl,
      context: {
        requestId: crypto.randomUUID(), displayId: sourceId,
        display: { id: sourceId, name: source.label, logicalWidth: width, logicalHeight: height, pixelWidth: width, pixelHeight: height },
        targets: [{ id: sourceId, name: source.label, kind: 'screen', rect: { x: 0, y: 0, width, height }, sourceWidth: width, sourceHeight: height }],
        availableModes: ['region', 'screen'], preferences: { mode: 'region', sourceId, purpose: 'screenshot' },
      },
    }
  })
}
async function capture(signal?: AbortSignal, onConfirm?: (content: Promise<Blob>) => void): Promise<BrowserScreenshotResult> {
  if (controller) throw new Error('已有截屏正在进行，请先完成或取消。')
  if (destroyed || signal?.aborted) throw new DOMException('已取消截屏。', 'AbortError')
  const abort = new AbortController()
  controller = abort
  const cancel = () => abort.abort()
  signal?.addEventListener('abort', cancel, { once: true })
  const result = takeBrowserScreenshot({ signal: abort.signal, chooseSource: request => chooseSource(request, () => onConfirm?.(result.then(value => value.blob))) })
  try { return await result }
  finally {
    signal?.removeEventListener('abort', cancel)
    finishChoice?.(null)
    if (controller === abort) controller = undefined
  }
}
function cancel(): void { controller?.abort(); finishChoice?.(null) }
onBeforeUnmount(() => { destroyed = true; cancel() })
defineExpose({ capture, cancel })
</script>

<template>
  <Teleport to="body">
    <CaptureSelectionOverlay v-if="picker" :context="picker.context" purpose="screenshot" embedded @confirm="finishChoice?.($event)" @cancel="finishChoice?.(null)">
      <template #background><img :src="picker.imageUrl" alt="待截屏来源预览" draggable="false" style="display:block;width:100%;height:100%;object-fit:fill" /></template>
    </CaptureSelectionOverlay>
  </Teleport>
</template>
