<script setup lang="ts">
import { buildInfo, formatBuildTime } from '../core/build-info'
import type { AiProvider } from '../core/ai'
import EditorDialog from './EditorDialog.vue'
import AiModelCenter from './AiModelCenter.vue'

defineProps<{ open: boolean; native: boolean; initialProvider?: AiProvider }>()
const emit = defineEmits<{ close: []; status: [message: string] }>()
const buildTime = formatBuildTime(buildInfo.builtAt)
</script>

<template>
  <EditorDialog :open="open" title="关于 Open Media" icon="info" wide class="app-info-dialog" @close="emit('close')">
    <div class="app-information">
      <div class="app-identity"><img src="/brand-mark.png" alt="" width="42" height="42"/><div><strong>Open Media</strong><p>录屏、剪辑、媒体编辑与本地创作</p></div></div>
      <dl>
        <div><dt>版本号</dt><dd>{{ buildInfo.version }}</dd></div>
        <div><dt>构建时间</dt><dd><template v-if="buildInfo.development">开发模式，尚未构建</template><time v-else :datetime="buildInfo.builtAt" :title="buildInfo.builtAt">{{ buildTime }}</time></dd></div>
        <div v-if="buildInfo.development"><dt>开发启动</dt><dd><time :datetime="buildInfo.builtAt" :title="buildInfo.builtAt">{{ buildTime }}</time></dd></div>
      </dl>
    </div>
    <AiModelCenter :open="open" :native="native" :initial-provider="initialProvider" @status="emit('status',$event)"/>
  </EditorDialog>
</template>

<style scoped>
.app-info-dialog{width:min(900px,calc(100vw - 24px));--ed-border:var(--ui-line);--ed-panel:var(--ui-surface);--ed-text:var(--ui-text);--ed-accent:var(--ui-accent);--ed-muted:var(--ui-muted);--ed-bg:var(--ui-hover)}
.app-information{display:flex;align-items:center;justify-content:space-between;gap:20px;padding:20px;border-bottom:1px solid var(--ui-line)}
.app-identity{display:flex;align-items:center;gap:12px}.app-identity img{flex:none}.app-identity strong{font-size:18px;letter-spacing:-.4px}.app-identity p{margin:4px 0 0;color:var(--ui-muted);font-size:11px}
dl{margin:0;display:grid;gap:7px;font-size:11px}dl>div{display:grid;grid-template-columns:60px minmax(0,1fr);gap:10px}dt{color:var(--ui-muted)}dd{margin:0;overflow-wrap:anywhere;font-variant-numeric:tabular-nums}
@media(max-width:650px){.app-information{align-items:flex-start;flex-direction:column;padding:16px;gap:16px}}
</style>
