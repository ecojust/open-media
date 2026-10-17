<script setup lang="ts">
import { computed } from 'vue'
import Icon from './Icon.vue'
import { recordingClock, type CaptureControlAction, type CaptureControlsSnapshot } from '../core/capture-controls'

const props = defineProps<{ snapshot: CaptureControlsSnapshot }>()
const emit = defineEmits<{ action: [action: CaptureControlAction] }>()
const paused = computed(() => props.snapshot.phase === 'paused')
const available = computed(() => ['recording', 'paused'].includes(props.snapshot.phase) && !props.snapshot.busy)
const muted = computed(() => props.snapshot.muted || !props.snapshot.audioAvailable)
const audioLabel = computed(() => !props.snapshot.audioAvailable ? '未开启录音' : props.snapshot.muted ? '恢复录音' : '静音，不录制声音')
const status = computed(() => props.snapshot.error || (props.snapshot.busy ? '正在处理录制' : paused.value ? '录制已暂停' : props.snapshot.phase === 'recording' ? '正在录制' : '正在准备录制'))
</script>

<template>
  <div class="recording-toolbar" :class="{ paused, muted }" role="group" aria-label="录制操作栏" data-testid="recording-toolbar">
    <span class="recording-clock" :title="status"><i :class="{ busy: snapshot.busy }" aria-hidden="true" /><span :aria-label="`已录制 ${recordingClock(snapshot.elapsed)}`">{{ recordingClock(snapshot.elapsed) }}</span></span>
    <button type="button" :disabled="!available" :aria-label="paused ? '继续录制' : '暂停录制'" :title="paused ? '继续录制' : '暂停录制'" @click="emit('action', paused ? 'resume' : 'pause')"><Icon :name="paused ? 'play' : 'pause'" :size="17" /></button>
    <button type="button" class="mute-control" :disabled="!available || !snapshot.audioAvailable" :aria-label="audioLabel" :title="audioLabel" :aria-pressed="muted" @click="emit('action', 'toggle-mute')"><Icon :name="muted ? 'mic-off' : 'mic'" :size="17" /></button>
    <button type="button" class="stop-control" :disabled="!available" aria-label="停止录制" title="停止录制并保存" @click="emit('action', 'stop')"><Icon name="stop" :size="17" /></button>
    <span class="toolbar-status" role="status">{{ status }}</span>
  </div>
</template>

<style scoped>
.recording-toolbar{box-sizing:border-box;display:flex;align-items:center;gap:4px;width:244px;max-width:100%;height:44px;padding:5px 7px;border:1px solid #f06472;border-radius:9px;background:#20232bee;color:#fff;box-shadow:0 3px 12px #0003;font:12px system-ui,sans-serif;user-select:none}
.recording-clock{display:flex;align-items:center;gap:7px;margin-right:auto;white-space:nowrap;font:12px ui-monospace,monospace;font-variant-numeric:tabular-nums}
.recording-clock i{width:7px;height:7px;flex:none;background:#ff586a;border-radius:50%}.paused .recording-clock i{background:#f4be65}.recording-clock i.busy{background:#aeb6c7}
.recording-toolbar button{display:flex;align-items:center;justify-content:center;width:32px;height:32px;flex:none;min-height:0;padding:0;border:0;border-radius:5px;background:transparent;color:#f8fafc;cursor:pointer}
.recording-toolbar button:hover:not(:disabled){background:#ffffff20}.recording-toolbar button:focus-visible{outline:2px solid #fff;outline-offset:-2px}.recording-toolbar button:disabled{opacity:.4;cursor:default}.recording-toolbar .stop-control{color:#ff7483}.muted .mute-control{background:#f0647220;color:#ff96a1}
.toolbar-status{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}
</style>
