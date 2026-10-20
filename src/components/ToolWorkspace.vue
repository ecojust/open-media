<script setup lang="ts">
import Icon from './Icon.vue'

withDefaults(defineProps<{
  title: string
  icon: string
  description: string
  libraryLabel?: string
  settingsLabel?: string
}>(), { libraryLabel: '素材与任务', settingsLabel: '参数设置' })
</script>

<template>
  <section class="tool-workspace" :aria-label="title">
    <header class="tool-workspace-header">
      <div class="tool-workspace-heading">
        <div class="tool-workspace-title-row"><h1><Icon :name="icon" :size="20"/>{{ title }}</h1><slot name="title-actions"/></div>
        <p>{{ description }}</p>
      </div>
      <div v-if="$slots.actions" class="tool-workspace-actions"><slot name="actions"/></div>
    </header>
    <div class="tool-workspace-body">
      <aside class="tool-workspace-panel tool-workspace-library" :aria-label="libraryLabel"><slot name="library"/></aside>
      <div class="tool-workspace-panel tool-workspace-main"><slot/></div>
      <aside class="tool-workspace-panel tool-workspace-settings" :aria-label="settingsLabel"><slot name="settings"/></aside>
    </div>
    <slot name="overlays"/>
  </section>
</template>

<style scoped>
.tool-workspace{container-type:inline-size;container-name:tool-workspace;display:flex;flex:1;flex-direction:column;width:100%;height:100%;min-width:0;min-height:0;padding:0;overflow:hidden;color:var(--ui-text);background:var(--ui-bg)}
.tool-workspace-header{display:flex;flex:none;align-items:center;justify-content:space-between;gap:16px;min-height:74px;padding:11px 20px;border-bottom:1px solid var(--ui-line);background:var(--ui-surface)}
.tool-workspace-heading{min-width:0}.tool-workspace-heading h1{display:flex;align-items:center;gap:9px;margin:0;font-size:18px;line-height:24px;font-weight:600;letter-spacing:-.3px}.tool-workspace-heading h1 svg{color:var(--ui-accent)}
.tool-workspace-title-row{display:flex;align-items:center;gap:8px;min-width:0;min-height:32px}
.tool-workspace-heading p{margin:4px 0 0;font-size:11px;line-height:17px;color:var(--ui-muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tool-workspace-actions{display:flex;align-items:center;justify-content:flex-end;gap:8px;flex-wrap:wrap;flex-shrink:0}.tool-workspace-actions :deep(button){min-height:var(--ui-control-height);font-size:11px;white-space:nowrap}
.tool-workspace-body{flex:1;min-height:0;min-width:0;display:grid;grid-template-columns:220px minmax(0,1fr) 280px;gap:12px;padding:16px;overflow:hidden;align-items:stretch}
.tool-workspace-panel{min-width:0;min-height:0;border:1px solid var(--ui-line);border-radius:10px;background:var(--ui-surface);overflow:auto;overscroll-behavior:contain;scrollbar-gutter:stable;scrollbar-width:thin}
.tool-workspace-library,.tool-workspace-settings{padding:14px}.tool-workspace-main{padding:14px;display:flex;flex-direction:column;gap:14px}.tool-workspace-main :deep(> *){flex-shrink:0;min-width:0}
.tool-workspace .tool-workspace-library :deep(h2),.tool-workspace .tool-workspace-settings :deep(h2){font-size:13px;font-weight:600}.tool-workspace-panel :deep(input:not([type=range],[type=checkbox],[type=radio],[type=color])),.tool-workspace-panel :deep(select){min-height:var(--ui-control-height);font-size:var(--ui-control-font-size)}
@container tool-workspace (max-width:1039px){
  .tool-workspace-body{grid-template-columns:minmax(0,1fr) 280px;grid-template-rows:minmax(100px,170px) minmax(0,1fr)}
  .tool-workspace-library{grid-column:1/-1;grid-row:1}.tool-workspace-main{grid-column:1;grid-row:2}.tool-workspace-settings{grid-column:2;grid-row:2}
}
@container tool-workspace (max-width:719px){
  .tool-workspace-header{align-items:flex-start;padding:12px;gap:10px;flex-wrap:wrap}.tool-workspace-heading{flex:1 1 220px}.tool-workspace-heading p{white-space:normal}.tool-workspace-actions{justify-content:flex-start}
  .tool-workspace-body{display:flex;flex-direction:column;overflow-y:auto;padding:12px;gap:12px}
  .tool-workspace-library{flex:0 0 auto;max-height:180px}.tool-workspace-main,.tool-workspace-settings{flex:0 0 auto;overflow:visible}
}
</style>
