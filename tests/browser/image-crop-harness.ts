import { createApp, h, ref } from 'vue'
import ImageCropEditor from '../../src/components/ImageCropEditor.vue'
import type { ImageCrop } from '../../src/core/image-crop'
import '../../src/style.css'

export function mountImageCropTest(): void {
  const image = document.createElement('canvas')
  image.width = 640
  image.height = 480
  const context = image.getContext('2d')!
  context.fillStyle = '#f33'; context.fillRect(0, 0, 320, 480)
  context.fillStyle = '#36f'; context.fillRect(320, 0, 320, 480)
  const source = image.toDataURL()
  const crop = ref<ImageCrop | undefined>(), disabled = ref(false), theme = ref('light')
  ;(window as unknown as { cropHarness: unknown }).cropHarness = { crop, disabled, theme }
  createApp({ setup: () => () => h('main', { class: 'app-shell', 'data-theme': theme.value, style: 'height:auto;max-width:760px;margin:20px auto' }, h(ImageCropEditor, { source, width: 640, height: 480, modelValue: crop.value, disabled: disabled.value, 'onUpdate:modelValue': (value: ImageCrop | undefined) => { crop.value = value } })) }).mount('#app')
}
