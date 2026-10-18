<script setup lang="ts">
import Icon from '../Icon.vue'
defineProps<{ busy: boolean; cancelling: boolean; cancelable?: boolean; stage: string; percent?: number; error?: string; notice?: string }>()
defineEmits<{ cancel: [] }>()
</script>
<template>
  <div class="et-status" aria-live="polite">
    <template v-if="busy"><div class="et-status-row"><span role="status">{{ stage || '正在处理…' }}</span><span v-if="percent !== undefined">{{ percent }}%</span></div><progress :value="percent" max="100" aria-label="工具处理进度" /><button type="button" :disabled="cancelling || cancelable === false" @click="$emit('cancel')"><Icon name="close" :size="13" />{{ cancelable === false ? '正在完成' : cancelling ? '正在取消' : '取消处理' }}</button></template>
    <p v-else-if="error" class="et-error" role="alert"><Icon name="alert" :size="14" />{{ error }}</p>
    <p v-else-if="notice" class="et-notice" role="status"><Icon name="check" :size="14" />{{ notice }}</p>
  </div>
</template>
<style src="./editor-tools.css"></style>
