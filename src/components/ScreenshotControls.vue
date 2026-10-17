<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import Icon from './Icon.vue'
import { browserScreenshotAvailable, DEFAULT_SCREENSHOT_SHORTCUT, screenshotShortcutFromEvent, screenshotShortcutLabel, screenshotShortcutValidationError } from '../core/screenshot'

const props = withDefaults(defineProps<{ native: boolean; shortcut: string | null; busy?: boolean; disabled?: boolean; error?: string; configuring?: boolean }>(), { busy: false, disabled: false, error: '', configuring: false })
const emit = defineEmits<{ capture: []; 'shortcut-change': [shortcut: string | null] }>()
const editing = ref(false)
const hint = ref('')
const editor = ref<HTMLButtonElement>()
const unavailable = computed(() => !props.native && !browserScreenshotAvailable())
const locked = computed(() => props.disabled || props.busy || props.configuring)
watch(locked, value => { if (value) editing.value = false })
function beginEdit(): void {
  if (locked.value || unavailable.value) return
  editing.value = true
  hint.value = ''
  void nextTick(() => editor.value?.focus())
}
function keydown(event: KeyboardEvent): void {
  if (!editing.value) return
  if (event.key === 'Tab') { editing.value = false; hint.value = ''; return }
  event.preventDefault()
  event.stopPropagation()
  if (event.key === 'Escape') { editing.value = false; hint.value = ''; return }
  if (event.key === 'Backspace' || event.key === 'Delete') { editing.value = false; hint.value = ''; emit('shortcut-change', null); return }
  if (['Control', 'Alt', 'Shift', 'Meta'].includes(event.key)) return
  const shortcut = screenshotShortcutFromEvent(event)
  if (!shortcut) { hint.value = '请使用 Ctrl、Command 或 Alt，搭配字母、数字或 F1–F20。'; return }
  const conflict = screenshotShortcutValidationError(shortcut)
  if (conflict) { hint.value = conflict; return }
  editing.value = false
  hint.value = ''
  emit('shortcut-change', shortcut)
}
</script>

<template>
  <section class="screenshot-controls" data-testid="screenshot-controls" aria-label="截屏设置">
    <p>选择范围后，自动打开图片转换并载入截屏。</p>
    <div class="screenshot-shortcut-row">
      <span>快捷键</span>
      <button ref="editor" class="shortcut-editor" :class="{ listening: editing }" type="button" data-shortcut-editor data-testid="screenshot-shortcut" :disabled="locked || unavailable" :aria-label="editing ? '请按新的截屏快捷键，Esc 取消' : `修改截屏快捷键，当前${screenshotShortcutLabel(shortcut)}`" :aria-pressed="editing" @click="beginEdit" @keydown="keydown" @blur="editing = false">
        <span v-if="editing">按下组合键…</span><kbd v-else>{{ screenshotShortcutLabel(shortcut) }}</kbd>
      </button>
    </div>
    <p class="shortcut-scope">{{ unavailable ? '此浏览器不支持截屏，请使用桌面端。' : native ? '应用运行时全局生效，切换窗口后也可使用。' : '仅在此网页获得焦点时生效。' }}</p>
    <div class="shortcut-options">
      <button type="button" :disabled="locked || unavailable || shortcut === DEFAULT_SCREENSHOT_SHORTCUT" @click="emit('shortcut-change', DEFAULT_SCREENSHOT_SHORTCUT)">恢复默认</button>
      <button type="button" :disabled="locked || unavailable || !shortcut" @click="emit('shortcut-change', null)">停用快捷键</button>
    </div>
    <p v-if="hint" class="shortcut-error" role="status">{{ hint }}</p>
    <p v-if="error" class="shortcut-error" role="alert">{{ error }}</p>
    <p v-if="disabled" role="status">当前操作结束后，即可截屏和修改快捷键。</p>
    <button class="screenshot-start" type="button" data-testid="screenshot-start" :disabled="locked || unavailable" @click="emit('capture')"><Icon :name="busy ? 'clock' : 'camera'" :size="16" />{{ busy ? '正在截屏…' : '立即截屏' }}</button>
  </section>
</template>

<style scoped>
.screenshot-controls{display:grid;gap:12px;min-width:0;padding:16px;color:var(--ui-text,#253044)}.screenshot-controls p{margin:0;color:var(--ui-muted,#7c8492);font-size:11px;line-height:1.7}.screenshot-shortcut-row{display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:11px}.shortcut-editor{min-width:126px;min-height:var(--ui-control-height,32px);justify-content:center;border:1px solid var(--ui-border,#e5e8f0);border-radius:6px;background:var(--ui-surface-2,#f7f8fc);color:inherit;padding:4px 8px;font-size:11px}.shortcut-editor kbd{font:inherit;font-weight:600;white-space:nowrap}.shortcut-editor.listening{border-color:var(--ui-accent,#6257db);color:var(--ui-accent,#6257db)}.shortcut-editor:focus-visible{outline:2px solid var(--ui-accent,#6257db);outline-offset:2px}.shortcut-options{display:flex;gap:12px}.shortcut-options button{border:0;padding:0;background:transparent;color:var(--ui-accent,#6257db);font-size:10px;min-height:24px}.screenshot-start{justify-content:center;gap:7px;min-height:var(--ui-control-height,32px);border:1px solid var(--ui-border,#e5e8f0);border-radius:6px;background:var(--ui-surface-2,#f7f8fc);color:var(--ui-text,#253044);font-size:11px}.screenshot-controls .shortcut-error{color:var(--ui-danger,#c34e59)}.screenshot-controls button:disabled{opacity:.45;cursor:not-allowed}
</style>
