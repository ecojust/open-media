<script setup lang="ts">
import { computed, ref } from 'vue'
import { buildInfo, formatBuildTime } from '../core/build-info'
import EditorDialog from './EditorDialog.vue'
import Icon from './Icon.vue'

type Theme = 'light' | 'dark' | 'system'
const props = defineProps<{ theme: Theme; effectiveTheme: 'light' | 'dark' }>()
const emit = defineEmits<{ 'update:theme': [theme: Theme] }>()
const infoOpen = ref(false)
const infoButton = ref<HTMLButtonElement | null>(null)
const themes: { id: Theme; label: string; icon: string }[] = [
  { id: 'light', label: '浅色', icon: 'sun' },
  { id: 'dark', label: '深色', icon: 'moon' },
  { id: 'system', label: '跟随系统', icon: 'screen' },
]
const currentTheme = computed(() => themes.find(item => item.id === props.theme) || themes[2])
const nextTheme = computed(() => themes[(themes.findIndex(item => item.id === props.theme) + 1) % themes.length])
const themeTitle = computed(() => {
  const current = props.theme === 'system' ? `跟随系统（${props.effectiveTheme === 'dark' ? '深色' : '浅色'}）` : currentTheme.value.label
  return `主题：${current}；切换为${nextTheme.value.label}`
})
const buildTime = formatBuildTime(buildInfo.builtAt)
</script>

<template>
  <div class="header-controls" role="group" aria-label="外观与信息">
    <button type="button" class="header-icon" :title="themeTitle" :aria-label="themeTitle" @click="emit('update:theme', nextTheme.id)"><Icon :name="currentTheme.icon" /></button>
    <button ref="infoButton" type="button" class="header-icon" title="关于 Open Media" aria-label="关于 Open Media" aria-haspopup="dialog" :aria-expanded="infoOpen" @click="infoOpen = true"><Icon name="info" /></button>
    <EditorDialog :open="infoOpen" title="关于 Open Media" icon="info" :return-focus="infoButton" @close="infoOpen = false">
      <div class="app-information">
        <div class="app-identity"><img src="/favicon.svg" alt="" width="42" height="42" /><div><strong>Open Media</strong><p>录屏、剪辑与媒体转换</p></div></div>
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
.header-icon{display:inline-flex;align-items:center;justify-content:center;width:32px;height:32px;padding:0;border:1px solid transparent;border-radius:6px;background:transparent;color:var(--ui-muted)}
.header-icon:hover:not(:disabled){background:var(--ui-hover);border-color:transparent;color:var(--ui-text)}
.header-icon:focus-visible{outline:2px solid var(--ui-accent);outline-offset:2px}
.app-information{padding:22px 20px 20px}
.app-identity{display:flex;align-items:center;gap:12px;margin-bottom:23px}
.app-identity img{border-radius:10px;flex:none}
.app-identity strong{font-size:18px;font-weight:650;letter-spacing:-.4px}
.app-identity p{margin:4px 0 0;color:var(--ui-muted);font-size:11px}
dl{margin:0;display:grid;gap:13px;font-size:12px}
dl>div{display:grid;grid-template-columns:68px minmax(0,1fr);gap:12px}
dt{color:var(--ui-muted)}
dd{margin:0;overflow-wrap:anywhere;font-variant-numeric:tabular-nums}
@media(max-width:420px){.header-controls{gap:2px}.header-icon{width:30px;height:30px}.app-information{padding:19px 16px}.app-identity{margin-bottom:20px}dl>div{grid-template-columns:60px minmax(0,1fr);gap:9px}}
</style>
