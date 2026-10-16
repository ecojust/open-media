<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import Icon from './Icon.vue'
import { getRuntimeStatus, selectRuntime, type RuntimeStatus } from '../native'

const props = withDefaults(defineProps<{ disabled?: boolean }>(), { disabled: false })
const runtime = ref<RuntimeStatus>()
const checking = ref(false)
const expanded = ref(false)
const actionError = ref('')
let destroyed = false

async function check() {
  if (checking.value) return
  checking.value = true
  actionError.value = ''
  try {
    const result = await getRuntimeStatus()
    if (!destroyed) runtime.value = result
  } catch (cause) {
    if (!destroyed) runtime.value = { ready: false, error: cause instanceof Error ? cause.message : String(cause) }
  } finally { checking.value = false }
}
async function choose() {
  if (checking.value || props.disabled) return
  checking.value = true
  actionError.value = ''
  try {
    const result = await selectRuntime()
    if (!destroyed) runtime.value = result
    window.dispatchEvent(new Event('open-media:runtime-changed'))
  } catch (cause) {
    if (!destroyed) actionError.value = cause instanceof Error ? cause.message : String(cause)
  } finally { checking.value = false }
}
function refresh() { void check() }
onMounted(() => { window.addEventListener('open-media:runtime-changed', refresh); void check() })
onBeforeUnmount(() => { destroyed = true; window.removeEventListener('open-media:runtime-changed', refresh) })
</script>

<template>
  <details class="runtime-check" :open="expanded" @toggle="expanded = ($event.target as HTMLDetailsElement).open">
    <summary>
      <Icon :name="checking ? 'refresh' : runtime?.ready ? 'check' : 'alert'" :size="15" :class="{ checking, ready: runtime?.ready, unavailable: runtime && !runtime.ready }" />
      <span>媒体处理检查</span>
      <small role="status">{{ checking ? '检查中…' : runtime?.ready ? '已就绪' : runtime ? '未就绪' : '待检查' }}</small>
      <Icon :name="expanded ? 'chevron-up' : 'chevron-down'" :size="13" />
    </summary>
    <div class="runtime-check-content">
      <p v-if="runtime?.ready">编码工具已就绪，可以处理和导出媒体。</p>
      <p v-else>编码工具尚未就绪，请重新检查或选择本机编码工具。</p>
      <p v-if="actionError || runtime?.error" class="runtime-check-error" role="alert">{{ actionError || runtime?.error }}</p>
      <p v-if="runtime?.source" class="runtime-check-source" :title="runtime.source">{{ runtime.source }}</p>
      <div class="runtime-check-actions">
        <button type="button" :disabled="checking || disabled" @click="check"><Icon name="refresh" :size="13" />重新检查</button>
        <button type="button" :disabled="checking || disabled" @click="choose"><Icon name="folder" :size="13" />选择工具</button>
      </div>
    </div>
  </details>
</template>

<style scoped>
.runtime-check{grid-column:1/-1;min-width:0;border:1px solid var(--ui-border,var(--ui-line,#e5e8f0));border-radius:7px;background:var(--ui-surface-2,var(--ui-bg,#f7f8fc));font-size:11px;color:var(--ui-text,#253044)}
summary{display:flex;align-items:center;gap:6px;min-height:34px;padding:7px 9px;box-sizing:border-box;list-style:none;cursor:pointer;user-select:none}
summary::-webkit-details-marker{display:none}summary>svg{flex-shrink:0}summary>span{font-weight:500}summary>small{margin-left:auto;white-space:nowrap;font-size:10px;color:var(--ui-muted,#7c8492)}
summary:focus-visible,button:focus-visible{outline:2px solid var(--ui-accent,#6257db);outline-offset:3px}.ready{color:var(--ui-success,#31966b)}.unavailable{color:var(--ui-danger,#c34e59)}
.runtime-check-content{border-top:1px solid var(--ui-border,var(--ui-line,#e5e8f0));padding:10px;display:grid;gap:9px}.runtime-check-content p{margin:0;font-size:10px;line-height:1.7;color:var(--ui-muted,#7c8492);overflow-wrap:anywhere}.runtime-check-content .runtime-check-error{color:var(--ui-danger,#c34e59)}.runtime-check-source{font-family:monospace}
.runtime-check-actions{display:flex;gap:6px;flex-wrap:wrap}.runtime-check-actions button{display:flex;align-items:center;justify-content:center;gap:5px;flex:1;min-height:30px;white-space:nowrap;padding:5px 7px;border:1px solid var(--ui-border,var(--ui-line,#e5e8f0));border-radius:5px;background:var(--ui-panel,#fff);color:inherit;font:inherit;font-size:10px;cursor:pointer}.runtime-check-actions button:disabled{opacity:.45;cursor:not-allowed}.checking{animation:runtime-check-spin 1s linear infinite}@keyframes runtime-check-spin{to{transform:rotate(360deg)}}@media(prefers-reduced-motion:reduce){.checking{animation:none}}
</style>
