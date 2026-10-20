import { createApp, h, KeepAlive, ref } from 'vue'
import ImageCanvasViewport from '../../src/components/ImageCanvasViewport.vue'
import type { ImageCanvasView } from '../../src/core/image-canvas-viewport'
import '../../src/style.css'

export function mountImageCanvasViewportTest(): void {
  const width = ref(1600), height = ref(1000), readonly = ref(false), disabled = ref(false)
  const size = ref(760), view = ref<ImageCanvasView>(), edits = ref(0), handleEdits = ref(0), viewport = ref<InstanceType<typeof ImageCanvasViewport>>()
  const shown = ref(true), modal = ref(false), modalClicks = ref(0), unhandledKeys = ref<string[]>([])
  window.addEventListener('keydown', event => { unhandledKeys.value.push(event.code) })
  ;(window as unknown as { imageViewportHarness: unknown }).imageViewportHarness = { width, height, readonly, disabled, size, view, edits, handleEdits, viewport, shown, modal, modalClicks, unhandledKeys }
  createApp({ setup: () => () => h('main', { class: 'app-shell', style: `height:500px;width:min(${size.value}px,100vw);margin:20px auto;display:flex` }, [
    h(KeepAlive, null, { default: () => shown.value ? h(ImageCanvasViewport, { ref: viewport, width: width.value, height: height.value, readonly: readonly.value, disabled: disabled.value, rulers: true, 'onView-change': (value: ImageCanvasView) => { view.value = value } }, {
      default: () => [h('canvas', { width: 320, height: 200, tabindex: 0, 'data-testid': 'editable-source', style: 'background:linear-gradient(135deg,#5b8ef355,#32d2ba55)', onPointerdown: () => { edits.value++ } }), h('textarea', { 'aria-label': '画布文字', style: 'position:absolute;left:500px;top:450px;width:300px;height:80px' }), h('button', { 'data-testid': 'source-resize-handle', style: 'position:absolute;left:150px;top:150px;width:20px;height:20px;padding:0', onPointerdown: () => { handleEdits.value++ }, onClick: () => { handleEdits.value += 10 } })],
    }) : null }),
    h('button', { 'data-testid': 'external-tool', style: 'position:fixed;left:10px;top:550px' }, '属性'),
    h('input', { 'aria-label': '外部属性', style: 'position:fixed;left:100px;top:550px;width:150px' }),
    modal.value ? h('section', { role: 'dialog', 'aria-modal': 'true', style: 'position:fixed;inset:100px;z-index:50;background:white' }, h('button', { 'data-testid': 'modal-action', onClick: () => { modalClicks.value++ } }, '确认')) : null,
  ]) }).mount('#app')
}
