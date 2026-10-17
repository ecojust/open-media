<script setup lang="ts">
import { ref, watch } from 'vue'
import { newId } from '../core/project'

const props = defineProps<{ projectId: string; clipId: string; modelValue: string; label: string }>()
const emit = defineEmits<{ edit: [change: { projectId: string; clipId: string; text: string; historyGroup: string }] }>()
// This component is keyed by project and clip, so late IME events keep their original target.
const projectId = props.projectId, clipId = props.clipId
const draft = ref(props.modelValue)
let composing = false, historyGroup = '', lastInput = 0, submitted = props.modelValue

watch(() => props.modelValue, value => { submitted = value; if (!composing) draft.value = value })
function beginEdit(): void { historyGroup = newId('text-edit'); lastInput = 0 }
function startComposition(): void { composing = true }
function saveInput(event: Event): void {
  if (composing || (event instanceof InputEvent && event.isComposing)) return
  const text = (event.target as HTMLTextAreaElement).value
  draft.value = text
  if (text === submitted) return
  const now = performance.now()
  if (!historyGroup || lastInput && now - lastInput > 1200) historyGroup = newId('text-edit')
  lastInput = now
  submitted = text
  emit('edit', { projectId, clipId, text, historyGroup })
}
function finishComposition(event: CompositionEvent): void { composing = false; saveInput(event) }
function finishEdit(event: FocusEvent): void {
  saveInput(event)
  if (!composing) historyGroup = ''
}
</script>

<template>
  <textarea v-model="draft" rows="3" maxlength="20000" :aria-label="label" data-testid="clip-text-content" @focus="beginEdit" @input="saveInput" @compositionstart="startComposition" @compositionend="finishComposition" @blur="finishEdit" />
</template>
