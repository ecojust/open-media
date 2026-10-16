import { createApp } from 'vue'
import './style.css'

if (new URLSearchParams(location.search).has('capture-picker')) {
  document.documentElement.dataset.capturePicker = 'true'
  document.documentElement.style.background = 'transparent'
  document.body.style.background = 'transparent'
  const { default: CaptureSelectionOverlay } = await import('./components/CaptureSelectionOverlay.vue')
  createApp(CaptureSelectionOverlay).mount('#app')
} else {
  const { default: App } = await import('./App.vue')
  createApp(App).mount('#app')
}
