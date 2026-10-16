import { createApp, h, ref } from 'vue'
import ConvertWorkspace from '../../src/components/ConvertWorkspace.vue'
import { importMediaFile } from '../../src/core/media-import'

export async function mountConversionTest(): Promise<void> {
  const canvas = document.createElement('canvas')
  canvas.width = 160
  canvas.height = 90
  const context = canvas.getContext('2d')!
  context.fillStyle = '#f14354'
  context.fillRect(0, 0, 160, 90)
  const blob = await new Promise<Blob>(resolve => canvas.toBlob(value => resolve(value!), 'image/png'))
  const assets = ref(await Promise.all([
    importMediaFile(new File([blob], '示例图.png', { type: 'image/png' })),
    importMediaFile(new File([blob], '示例图.png', { type: 'image/png' })),
  ]))
  document.head.insertAdjacentHTML('beforeend', '<style>html,body,#test-root{margin:0;height:100%;font-family:sans-serif}*{box-sizing:border-box}button,input,select{font:inherit}</style>')
  document.body.innerHTML = '<div id="test-root"></div>'
  createApp({ render: () => h(ConvertWorkspace, { assets: assets.value, mode: 'image', native: false, onResult: asset => assets.value.push(asset) }) }).mount('#test-root')
}
