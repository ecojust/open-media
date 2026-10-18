<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onDeactivated, ref, shallowRef } from 'vue'
import Icon from './Icon.vue'
import type { MediaAsset } from '../core/types'
import { revealMediaAsset } from '../native'

const props = defineProps<{ native: boolean }>()
const emit = defineEmits<{ error: [message: string] }>()
const selected = ref<MediaAsset>()
const menu = ref<HTMLElement>()
const portal = shallowRef<HTMLElement | string>('body')
const position = ref({ x: 0, y: 0 })
const enabled = computed(() => props.native && Boolean(selected.value?.nativePath))
const unavailable = computed(() => props.native ? '此素材没有可用的本地位置' : '仅桌面端可打开所在文件夹')
let anchor: HTMLElement | undefined
let menuGeneration = 0

function close(restoreFocus = false): void {
  ++menuGeneration
  selected.value = undefined
  document.removeEventListener('pointerdown', outside, true)
  document.removeEventListener('keydown', keyboard, true)
  window.removeEventListener('resize', dismissForViewportChange)
  window.removeEventListener('scroll', dismissForViewportChange, true)
  if (restoreFocus && anchor?.isConnected) anchor.focus({ preventScroll: true })
}
function dismiss(): void { close() }
function dismissForViewportChange(): void {
  close(Boolean(menu.value?.contains(document.activeElement)))
}
function outside(event: PointerEvent): void { if (!menu.value?.contains(event.target as Node)) close() }
function keyboard(event: KeyboardEvent): void {
  if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true) }
  else if (event.key === 'Tab') close()
}
async function open(event: MouseEvent | KeyboardEvent, asset: MediaAsset): Promise<void> {
  event.preventDefault()
  event.stopPropagation()
  close()
  const generation = menuGeneration
  anchor = event.currentTarget as HTMLElement
  portal.value = anchor.closest<HTMLElement>('.app-shell') ?? 'body'
  const mouse = event instanceof MouseEvent && (event.clientX !== 0 || event.clientY !== 0)
  document.addEventListener('pointerdown', outside, true)
  document.addEventListener('keydown', keyboard, true)
  window.addEventListener('resize', dismissForViewportChange)
  // Focusing or revealing a source may queue a scroll before either opening gesture.
  await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
  if (generation !== menuGeneration) return
  if (!anchor.isConnected) { close(); return }
  const rect = anchor.getBoundingClientRect()
  position.value = { x: mouse ? event.clientX : rect.left, y: mouse ? event.clientY : rect.bottom }
  selected.value = asset
  window.addEventListener('scroll', dismissForViewportChange, true)
  await nextTick()
  if (generation !== menuGeneration || !selected.value || !menu.value?.isConnected) return
  const bounds = menu.value.getBoundingClientRect()
  position.value = { x: Math.max(8, Math.min(position.value.x, window.innerWidth - bounds.width - 8)), y: Math.max(8, Math.min(position.value.y, window.innerHeight - bounds.height - 8)) }
  const focusTarget = menu.value.querySelector<HTMLElement>('button:not(:disabled)') ?? menu.value
  focusTarget.focus({ preventScroll: true })
}
async function reveal(): Promise<void> {
  const asset = selected.value
  if (!asset || !enabled.value) return
  close(true)
  try { await revealMediaAsset(asset) }
  catch (cause) { emit('error', cause instanceof Error ? cause.message : typeof cause === 'string' ? cause : '无法打开素材所在文件夹') }
}
onDeactivated(dismiss)
onBeforeUnmount(dismiss)
defineExpose({ open, close })
</script>

<template>
  <Teleport :to="portal">
    <div v-if="selected" ref="menu" class="media-asset-menu" role="menu" aria-label="视频素材操作" tabindex="-1" :style="{ left: `${position.x}px`, top: `${position.y}px` }" @contextmenu.prevent>
      <span class="media-asset-menu-name" :title="selected.name">{{ selected.name }}</span>
      <button role="menuitem" :disabled="!enabled" :title="enabled ? '打开素材所在文件夹' : unavailable" @click="reveal"><Icon name="folder" :size="16"/>打开所在文件夹</button>
      <small v-if="!enabled">{{ unavailable }}</small>
    </div>
  </Teleport>
</template>

<style scoped>
.media-asset-menu{position:fixed;z-index:1000;min-width:190px;max-width:min(300px,calc(100vw - 16px));padding:6px;border:1px solid var(--ui-border,#dfe3eb);border-radius:9px;background:var(--ui-panel,#fff);color:var(--ui-text,#253044);box-shadow:0 10px 30px #0003;font-size:12px;outline:none}.media-asset-menu-name{display:block;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding:7px 9px;color:var(--ui-muted,#7c8492);font-size:10px}.media-asset-menu button{display:flex;align-items:center;gap:8px;width:100%;padding:9px;border:0;border-radius:5px;background:transparent;color:inherit;text-align:left;font:inherit;cursor:pointer}.media-asset-menu button:hover:not(:disabled),.media-asset-menu button:focus-visible{background:color-mix(in srgb,var(--ui-accent,#6257db) 12%,transparent);outline:none}.media-asset-menu button:disabled{opacity:.45;cursor:not-allowed}.media-asset-menu small{display:block;padding:5px 9px 7px;color:var(--ui-muted,#7c8492);font-size:10px}
</style>
