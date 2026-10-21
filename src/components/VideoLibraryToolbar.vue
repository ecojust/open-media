<script setup lang="ts">
import Icon from './Icon.vue'

withDefaults(defineProps<{ loading: boolean; preparing?: boolean; error?: string; warnings?: string[]; loadingLabel?: string }>(), { preparing: false, error: '', warnings: () => [], loadingLabel: '正在读取目录视频…' })
</script>

<template>
  <div v-if="loading || preparing || error || warnings.length" class="video-library-toolbar" data-testid="video-library-toolbar" :aria-busy="loading || preparing">
    <span v-if="loading || preparing" class="video-library-status" role="status">{{ loading ? loadingLabel : '正在准备当前视频预览…' }}</span>
    <p v-if="error" class="video-library-error" role="alert"><Icon name="alert" :size="12" /><span>{{ error }}</span></p>
    <details v-if="warnings.length" class="video-library-warnings"><summary>部分文件已跳过（{{ warnings.length }}）</summary><ul><li v-for="(warning, index) in warnings" :key="index">{{ warning }}</li></ul></details>
  </div>
</template>

<style scoped>
.video-library-toolbar>*{flex-shrink:0}
.video-library-toolbar{display:flex;flex-direction:column;gap:3px;min-width:0;flex-shrink:0;margin:0 0 10px;padding:6px 8px;border:1px solid var(--ui-line,#e4e9f2);border-radius:7px;background:var(--ui-surface-2,#f4f6fb);color:var(--ui-text,#263044);font-size:10px;line-height:1.5}
.video-library-status{font-size:9px;color:var(--ui-muted,#8995a9)}
.video-library-error{display:flex;align-items:flex-start;gap:5px;margin:0;color:var(--ui-danger,#dc4657);font-size:10px;overflow-wrap:anywhere}
.video-library-error>svg{flex:none;margin-top:2px}.video-library-error>span{min-width:0}
.video-library-warnings{font-size:9px;color:var(--ui-muted,#8995a9)}.video-library-warnings summary{cursor:pointer;padding-block:2px}.video-library-warnings ul{padding-left:15px;margin:5px 0;max-height:105px;overflow:auto;overflow-wrap:anywhere}.video-library-warnings li+li{margin-top:4px}
</style>
