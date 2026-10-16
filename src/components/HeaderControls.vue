<script setup lang="ts">
import { ref } from 'vue'
import { buildInfo, formatBuildTime } from '../core/build-info'
import EditorDialog from './EditorDialog.vue'
import Icon from './Icon.vue'

type Theme = 'light' | 'dark' | 'system'
const props = defineProps<{ theme: Theme; effectiveTheme: 'light' | 'dark' }>()
const emit = defineEmits<{ 'update:theme': [theme: Theme] }>()
const infoOpen = ref(false)
const infoButton = ref<HTMLButtonElement | null>(null)
const themes: { id: Theme; label: string; icon: string }[] = [
  { id: 'light', label: '浅色主题', icon: 'sun' },
  { id: 'dark', label: '深色主题', icon: 'moon' },
  { id: 'system', label: '跟随系统', icon: 'screen' },
]
const buildTime = formatBuildTime(buildInfo.builtAt)
</script>

<template>
  <div class="header-controls" role="group" aria-label="外观与信息" @keydown.space.stop @keyup.space.stop>
    <div class="theme-switch" role="group" aria-label="界面主题">
      <button v-for="option in themes" :key="option.id" type="button" :data-testid="`theme-${option.id}`" :aria-label="option.label" :title="option.id === 'system' && props.theme === 'system' ? `跟随系统（当前为${props.effectiveTheme === 'dark' ? '深色' : '浅色'}）` : option.label" :aria-pressed="props.theme === option.id" @click="emit('update:theme', option.id)"><Icon :name="option.icon" :size="17" /></button>
    </div>
    <button ref="infoButton" type="button" class="header-icon" title="关于 Open Media" aria-label="关于 Open Media" aria-haspopup="dialog" :aria-expanded="infoOpen" @click="infoOpen = true"><Icon name="info" /></button>
    <EditorDialog :open="infoOpen" title="关于 Open Media" icon="info" :return-focus="infoButton" @close="infoOpen = false">
      <div class="app-information">
        <div class="app-identity"><img src="/brand-mark.png" alt="" width="42" height="42" /><div><strong>Open Media</strong><p>录屏、剪辑与媒体转换</p></div></div>
        <dl>
          <div><dt>版本号</dt><dd>{{ buildInfo.version }}</dd></div>
          <div><dt>构建时间</dt><dd><template v-if="buildInfo.development">开发模式，尚未构建</template><time v-else :datetime="buildInfo.builtAt" :title="buildInfo.builtAt">{{ buildTime }}</time></dd></div>
          <div v-if="buildInfo.development"><dt>开发启动</dt><dd><time :datetime="buildInfo.builtAt" :title="buildInfo.builtAt">{{ buildTime }}</time></dd></div>
        </dl>
      </div>
    </EditorDialog>
  </div>
</template>

<style scoped>
.header-controls{display:flex;align-items:center;gap:4px;--ed-border:var(--ui-line);--ed-panel:var(--ui-surface);--ed-text:var(--ui-text);--ed-accent:var(--ui-accent);--ed-muted:var(--ui-muted);--ed-bg:var(--ui-hover)}
.theme-switch{display:flex;flex:none;gap:2px;padding:3px;border:1px solid var(--ui-line);border-radius:7px;background:var(--ui-surface-2)}
.theme-switch>button{display:grid;place-items:center;width:28px;height:26px;padding:0;border:0;border-radius:4px;background:transparent;color:var(--ui-muted)}
.theme-switch>button:hover{background:var(--ui-hover);color:var(--ui-text)}
.theme-switch>button[aria-pressed="true"]{background:var(--ui-surface);color:var(--ui-accent);box-shadow:0 1px 3px #0002}
.theme-switch>button:focus-visible{outline:2px solid var(--ui-accent);outline-offset:2px}
.header-icon{display:inline-flex;align-items:center;justify-content:center;width:32px;height:32px;padding:0;border:1px solid transparent;border-radius:6px;background:transparent;color:var(--ui-muted)}
.header-icon:hover:not(:disabled){background:var(--ui-hover);border-color:transparent;color:var(--ui-text)}
.header-icon:focus-visible{outline:2px solid var(--ui-accent);outline-offset:2px}
.app-information{padding:22px 20px 20px}
.app-identity{display:flex;align-items:center;gap:12px;margin-bottom:23px}
.app-identity img{flex:none}
.app-identity strong{font-size:18px;font-weight:650;letter-spacing:-.4px}
.app-identity p{margin:4px 0 0;color:var(--ui-muted);font-size:11px}
dl{margin:0;display:grid;gap:13px;font-size:12px}
dl>div{display:grid;grid-template-columns:68px minmax(0,1fr);gap:12px}
dt{color:var(--ui-muted)}
dd{margin:0;overflow-wrap:anywhere;font-variant-numeric:tabular-nums}
@media(max-width:420px){.header-controls{gap:2px}.header-icon{width:30px;height:30px}.app-information{padding:19px 16px}.app-identity{margin-bottom:20px}dl>div{grid-template-columns:60px minmax(0,1fr);gap:9px}}
</style>
