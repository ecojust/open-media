import { createApp, h, ref } from 'vue'
import ImageCropEditor from '../../src/components/ImageCropEditor.vue'
import type { ImageCrop } from '../../src/core/image-crop'
import type { ImageAnnotation } from '../../src/core/image-annotations'
import '../../src/style.css'

export function mountImageCropTest(): void {
  const image = document.createElement('canvas')
  image.width = 640
  image.height = 480
  const context = image.getContext('2d')!
  context.fillStyle = '#f33'; context.fillRect(0, 0, 320, 480)
  context.fillStyle = '#36f'; context.fillRect(320, 0, 320, 480)
  const source = image.toDataURL()
  const crop = ref<ImageCrop | undefined>(), disabled = ref(false), theme = ref('light'), docked = ref(false)
  const width = ref(640), height = ref(480), annotations = ref<ImageAnnotation[]>([])
  const editor = ref<InstanceType<typeof ImageCropEditor>>(), properties = ref<HTMLElement>()
  ;(window as unknown as { cropHarness: unknown }).cropHarness = { crop, disabled, theme, docked, editor, width, height, annotations }
  createApp({ setup: () => () => h('main', { class: 'app-shell', 'data-theme': theme.value, style: 'height:760px;max-width:760px;margin:20px auto;display:flex;min-width:0' }, [
    h(ImageCropEditor, { ref: editor, source, width: width.value, height: height.value, annotations: annotations.value, propertiesTarget: docked.value ? properties.value : undefined, modelValue: crop.value, disabled: disabled.value, 'onUpdate:modelValue': (value: ImageCrop | undefined) => { crop.value = value } }),
    h('aside', { ref: properties, 'data-testid': 'crop-properties-target', style: docked.value ? 'width:240px;flex:none;padding:14px' : 'display:none' }),
  ]) }).mount('#app')
}
