<script setup lang="ts">
import Icon from './Icon.vue'

withDefaults(defineProps<{ directory: string; loading: boolean; preparing?: boolean; error?: string; warnings?: string[]; disabled?: boolean; description?: string }>(), { preparing: false, error: '', warnings: () => [], disabled: false, description: '项目与本机视频 · 最近视频在前' })
const emit = defineEmits<{ refresh: []; reveal: [] }>()
</script>

<template>
  <div class="video-library-toolbar" data-testid="video-library-toolbar" :aria-busy="loading || preparing">
    <div class="video-library-heading"><strong>录屏保存目录</strong><button type="button" :disabled="loading || disabled" aria-label="刷新本机视频列表" title="刷新视频列表" @click="emit('refresh')"><Icon name="refresh" :size="14" :class="{ spinning: loading }" /></button><button type="button" :disabled="!directory" aria-label="打开录屏保存目录" title="打开录屏保存目录" @click="emit('reveal')"><Icon name="folder" :size="15" /></button></div>
    <span class="video-library-path" :title="directory" data-testid="video-library-directory">{{ directory || (loading ? '正在读取保存位置…' : '尚未读取保存位置') }}</span>
    <span class="video-library-status" role="status">{{ loading ? '正在读取目录视频…' : preparing ? '正在准备当前视频预览…' : description }}</span>
    <p v-if="error" class="video-library-error" role="alert"><Icon name="alert" :size="12" /><span>{{ error }}</span></p>
    <details v-if="warnings.length" class="video-library-warnings"><summary>部分文件已跳过（{{ warnings.length }}）</summary><ul><li v-for="(warning, index) in warnings" :key="index">{{ warning }}</li></ul></details>
  </div>
</template>

<style scoped>
.video-library-toolbar>*{flex-shrink:0}
.video-library-toolbar{display:flex;flex-direction:column;gap:3px;min-width:0;flex-shrink:0;margin:0 0 10px;padding:8px 9px;border:1px solid var(--ui-line,#e4e9f2);border-radius:7px;background:var(--ui-surface-2,#f4f6fb);color:var(--ui-text,#263044);font-size:10px;line-height:1.5}.video-library-heading{display:flex;align-items:center;gap:3px}.video-library-heading>strong{font-size:10px;font-weight:600;flex:1;min-width:0}.video-library-heading>button{display:flex;align-items:center;justify-content:center;width:24px;height:24px;min-height:24px;padding:3px;border:0;background:transparent;border-radius:4px;color:var(--ui-muted,#8995a9);cursor:pointer}.video-library-heading>button:hover:not(:disabled){background:var(--ui-hover,#edf2ff);color:var(--ui-accent,#3267f6)}.video-library-heading>button:disabled{opacity:.4;cursor:not-allowed}.video-library-heading>button:focus-visible{outline:2px solid var(--ui-accent,#3267f6);outline-offset:1px}.video-library-path{display:block;max-width:100%;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--ui-muted,#8995a9);font-size:9px}.video-library-status{font-size:9px;color:var(--ui-muted,#8995a9);min-height:14px}.video-library-error{display:flex;align-items:flex-start;gap:5px;margin:3px 0 0;color:var(--ui-danger,#dc4657);font-size:10px;overflow-wrap:anywhere}.video-library-error>svg{flex:none;margin-top:2px}.video-library-error>span{min-width:0}.video-library-warnings{font-size:9px;color:var(--ui-muted,#8995a9)}.video-library-warnings summary{cursor:pointer;padding-block:2px}.video-library-warnings ul{padding-left:15px;margin:5px 0;max-height:105px;overflow:auto;overflow-wrap:anywhere}.video-library-warnings li+li{margin-top:4px}.spinning{animation:video-library-spin 1s linear infinite}@keyframes video-library-spin{to{transform:rotate(360deg)}}@media(prefers-reduced-motion:reduce){.spinning{animation:none}}
</style>
