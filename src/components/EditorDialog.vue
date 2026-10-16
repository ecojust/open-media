<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import Icon from './Icon.vue'

const props = defineProps<{ open: boolean; title: string; icon: string; busy?: boolean; wide?: boolean; returnFocus?: HTMLElement | null }>()
const emit = defineEmits<{ close: [] }>()
const dialog = ref<HTMLDialogElement | null>(null)
let opener: HTMLElement | null = null
const pointerStartedOutside = ref(false)

function syncOpen(): void {
  const element = dialog.value
  if (!element) return
  if (props.open && !element.open) {
    opener = props.returnFocus || (document.activeElement instanceof HTMLElement ? document.activeElement : null)
    element.showModal()
  } else if (!props.open && element.open) {
    element.close()
    void nextTick(() => { if (!props.open && opener?.isConnected) opener.focus({ preventScroll: true }) })
  }
}
function requestClose(): void { if (!props.busy) emit('close') }
function outside(event: MouseEvent): boolean {
  const element = dialog.value
  if (!element || event.target !== element) return false
  const rect = element.getBoundingClientRect()
  return event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom
}
function backdropClick(event: MouseEvent): void {
  if (pointerStartedOutside.value && outside(event)) requestClose()
  pointerStartedOutside.value = false
}
watch(() => props.open, syncOpen, { flush: 'post' })
onMounted(syncOpen)
onBeforeUnmount(() => { dialog.value?.close() })
</script>

<template>
  <dialog ref="dialog" class="editor-dialog" :class="{ wide }" role="dialog" :aria-modal="open ? true : undefined" :aria-label="title" @cancel.prevent="requestClose" @pointerdown="pointerStartedOutside = outside($event)" @click="backdropClick">
    <header class="editor-dialog-heading"><Icon :name="icon" :size="18" /><h2>{{ title }}</h2><button autofocus type="button" :aria-label="`关闭${title}`" :title="busy ? '请先完成或取消生成' : '关闭'" :disabled="busy" @click="requestClose"><Icon name="close" :size="18" /></button></header>
    <div class="editor-dialog-content"><slot /></div>
    <p v-if="busy" class="editor-dialog-hint" role="status">请先完成或取消生成，再关闭弹窗。</p>
    <footer v-if="$slots.footer" class="editor-dialog-footer"><slot name="footer" /></footer>
  </dialog>
</template>

<style scoped>
.editor-dialog{box-sizing:border-box;width:min(480px,calc(100vw - 24px));max-width:none;max-height:calc(100dvh - 24px);margin:auto;padding:0;overflow:hidden;border:1px solid var(--ed-border);border-radius:12px;background:var(--ed-panel);color:var(--ed-text);box-shadow:0 20px 80px #0004;font:inherit;line-height:1.5}
.editor-dialog[open]{display:flex;flex-direction:column}
.editor-dialog.wide{width:min(680px,calc(100vw - 24px))}
.editor-dialog::backdrop{background:#10162670}
.editor-dialog-heading{display:flex;align-items:center;gap:9px;padding:13px 16px;border-bottom:1px solid var(--ed-border);flex-shrink:0}
.editor-dialog-heading>svg{color:var(--ed-accent);flex-shrink:0}
.editor-dialog-heading h2{font-size:14px;font-weight:600;margin:0;flex:1}
.editor-dialog-heading button{display:flex;align-items:center;justify-content:center;width:30px;height:30px;padding:0;border:0;border-radius:6px;background:transparent;color:var(--ed-muted);cursor:pointer}
.editor-dialog-heading button:hover:not(:disabled){background:var(--ed-bg);color:var(--ed-text)}
.editor-dialog-heading button:focus-visible{outline:2px solid var(--ed-accent);outline-offset:2px}
.editor-dialog-heading button:disabled{opacity:.4;cursor:not-allowed}
.editor-dialog-content{overflow:auto;min-height:0;overscroll-behavior:contain;scrollbar-width:thin;scrollbar-color:var(--ed-border) transparent}
.editor-dialog-hint{margin:0;padding:10px 16px;font-size:11px;color:var(--ed-muted);border-top:1px solid var(--ed-border);flex-shrink:0}
.editor-dialog-footer{display:flex;justify-content:flex-end;padding:10px 16px;border-top:1px solid var(--ed-border);flex-shrink:0}
</style>
