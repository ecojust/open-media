<script setup lang="ts">
import Icon from './Icon.vue'

withDefaults(defineProps<{ directory: string; loading: boolean; disabled?: boolean }>(), { disabled: false })
const emit = defineEmits<{ refresh: []; reveal: [] }>()
</script>

<template>
  <div class="video-library-actions" data-testid="video-library-actions">
    <button type="button" :disabled="loading || disabled" aria-label="刷新本机视频列表" title="刷新视频列表" @click="emit('refresh')"><Icon name="refresh" :size="14" :class="{ spinning: loading }" /></button>
    <button type="button" :disabled="!directory" aria-label="打开录屏保存目录" title="打开录屏保存目录" @click="emit('reveal')"><Icon name="folder" :size="15" /></button>
  </div>
</template>

<style scoped>
.video-library-actions{display:flex;align-items:center;gap:2px;flex:none}
.video-library-actions>button{display:flex;align-items:center;justify-content:center;width:24px;height:24px;min-height:24px;padding:3px;border:0;background:transparent;border-radius:4px;color:var(--ui-muted,#8995a9);cursor:pointer}
.video-library-actions>button:hover:not(:disabled){background:var(--ui-hover,#edf2ff);color:var(--ui-accent,#3267f6)}
.video-library-actions>button:disabled{opacity:.4;cursor:not-allowed}
.video-library-actions>button:focus-visible{outline:2px solid var(--ui-accent,#3267f6);outline-offset:1px}
.spinning{animation:video-library-spin 1s linear infinite}
@keyframes video-library-spin{to{transform:rotate(360deg)}}
@media(prefers-reduced-motion:reduce){.spinning{animation:none}}
</style>
