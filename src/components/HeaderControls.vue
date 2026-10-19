<script setup lang="ts">
import Icon from './Icon.vue'

type Theme = 'light' | 'dark' | 'system'
const props = defineProps<{ theme: Theme; effectiveTheme: 'light' | 'dark'; sidebar?: boolean; collapsed?: boolean; infoOpen?: boolean }>()
const emit = defineEmits<{ 'update:theme': [theme: Theme]; 'open-info': [] }>()
const themes: { id: Theme; label: string; icon: string }[] = [
  { id: 'light', label: '浅色主题', icon: 'sun' },
  { id: 'dark', label: '深色主题', icon: 'moon' },
  { id: 'system', label: '跟随系统', icon: 'screen' },
]
</script>

<template>
  <div class="header-controls" :class="{ 'sidebar-controls': sidebar, compact: sidebar && collapsed }" role="group" aria-label="外观与信息" @keydown.space.stop @keyup.space.stop>
    <div class="theme-switch" role="group" aria-label="界面主题">
      <button v-for="option in themes" :key="option.id" type="button" :data-testid="`theme-${option.id}`" :aria-label="option.label" :title="option.id === 'system' && props.theme === 'system' ? `跟随系统（当前为${props.effectiveTheme === 'dark' ? '深色' : '浅色'}）` : option.label" :aria-pressed="props.theme === option.id" @click="emit('update:theme', option.id)"><Icon :name="option.icon" :size="17" /></button>
    </div>
    <button type="button" class="header-icon" title="关于 Open Media" aria-label="关于 Open Media" aria-haspopup="dialog" :aria-expanded="infoOpen" @click="emit('open-info')"><Icon name="info" /></button>

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
.sidebar-controls{justify-content:center;padding-top:10px;border-top:1px solid var(--ui-line)}
.sidebar-controls.compact,.sidebar-controls.compact .theme-switch{flex-direction:column}
@media(max-width:900px){.sidebar-controls,.sidebar-controls .theme-switch{flex-direction:column}}
@media(max-width:420px){.header-controls{gap:2px}.header-icon{width:30px;height:30px}}
</style>
