<script setup lang="ts">
import ToolWorkspace from './ToolWorkspace.vue'

defineProps<{ mode: 'image' | 'video' }>()
</script>

<template>
  <ToolWorkspace v-if="mode === 'video'" class="convert-workspace video-convert-workspace" title="视频转换" icon="convert" description="转换格式、压缩画质或提取音频。" library-label="视频素材库" settings-label="输出参数">
    <template #actions><slot name="actions" /></template>
    <template #library><slot name="library" /></template>
    <template #default><slot /></template>
    <template #settings><slot name="settings" /></template>
    <template #overlays><slot name="overlays" /></template>
  </ToolWorkspace>
  <section v-else class="convert-workspace image-convert-workspace">
    <header class="convert-toolbar">
      <div><h1>图片编辑</h1><p>文字标注、自由绘制、裁剪与格式导出</p></div>
      <slot name="actions" />
    </header>
    <div class="convert-layout"><slot name="library" /><slot /><slot name="settings" /></div>
    <slot name="overlays" />
  </section>
</template>

<style scoped>
.image-convert-workspace{display:flex;flex-direction:column;height:100%;min-height:0;color:var(--ui-text,#e5e7ef);background:var(--ui-bg,#11131b)}
.convert-toolbar{display:flex;align-items:center;gap:16px;justify-content:space-between;padding:18px 24px;border-bottom:1px solid var(--ui-line,#2a2d3a)}
.convert-toolbar h1{font-size:18px;margin:0 0 5px;font-weight:650}.convert-toolbar p{font-size:12px;margin:0;color:var(--ui-muted,#959aad)}
.convert-layout{display:grid;grid-template-columns:220px minmax(220px,1fr) 268px;flex:1;min-height:0;overflow:hidden}
@media(max-width:1100px){.convert-layout{grid-template-columns:180px minmax(180px,1fr) 240px}}
@media(max-width:800px){.convert-layout{grid-template-columns:minmax(240px,1fr) 240px;grid-template-rows:auto 1fr;overflow:auto}.convert-toolbar{padding:14px 16px}}
@media(max-width:560px){.convert-layout{display:flex;flex-direction:column;overflow:auto}.convert-toolbar h1{font-size:16px}.convert-toolbar p{font-size:10px}.convert-toolbar{gap:8px;padding:12px}.convert-toolbar :deep(.convert-button){font-size:11px;padding:8px}}
</style>
