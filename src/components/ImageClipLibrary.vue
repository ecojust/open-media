<script setup lang="ts">
import { ref } from 'vue'
import type { MediaAsset } from '../core/types'
import Icon from './Icon.vue'

defineProps<{ assets: MediaAsset[]; busy: boolean; error: string }>()
const emit = defineEmits<{ select: [asset: MediaAsset]; import: [file: File] }>()
const input = ref<HTMLInputElement>()
function importFile(event: Event): void {
  const element = event.target as HTMLInputElement, file = element.files?.[0]
  element.value = ''
  if (file) emit('import', file)
}
</script>

<template>
  <div class="image-clip-library" data-testid="image-clip-library">
    <div class="image-clip-heading"><p>图片会从当前播放头开始，放在独立图片轨道。添加后可直接拖动、缩放并吸附对齐。SVG 会先转换为保留透明度的 PNG。</p><button type="button" :disabled="busy" @click="input?.click()"><Icon name="import" :size="15" />导入图片</button></div>
    <input ref="input" type="file" accept="image/*,.png,.jpg,.jpeg,.webp,.gif,.avif,.svg" hidden data-testid="image-clip-file" @change="importFile" />
    <p v-if="error" class="image-clip-error" role="alert">{{ error }}</p>
    <div v-if="assets.length" class="image-clip-grid">
      <button v-for="asset in assets" :key="asset.id" type="button" :disabled="busy" :data-image-asset-id="asset.id" :title="`添加 ${asset.name}`" @click="emit('select', asset)">
        <span class="image-clip-thumb"><img :src="asset.url" alt="" loading="lazy" /></span><strong>{{ asset.name }}</strong><small>{{ asset.width }} × {{ asset.height }}</small>
      </button>
    </div>
    <p v-else class="image-clip-empty">工程中还没有图片，可以导入本地图片；透明图片会保留透明区域。</p>
    <p v-if="busy" role="status">正在添加图片…</p>
  </div>
</template>

<style scoped>
.image-clip-library{padding:14px;box-sizing:border-box;display:flex;flex-direction:column;gap:12px;min-width:0;color:var(--ed-text)}
.image-clip-heading{display:flex;align-items:center;gap:16px}.image-clip-heading p{flex:1;margin:0;font-size:12px;line-height:1.65;color:var(--ed-muted)}.image-clip-heading button{flex:none;display:inline-flex;align-items:center;gap:6px;padding:7px 12px;border:1px solid var(--ed-border);border-radius:6px;background:var(--ed-panel);color:var(--ed-text);cursor:pointer}
.image-clip-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(125px,1fr));gap:10px;max-height:360px;overflow:auto;padding:2px;scrollbar-width:thin;scrollbar-color:var(--ed-border) transparent}.image-clip-grid button{display:flex;flex-direction:column;align-items:stretch;gap:5px;padding:7px;border:1px solid var(--ed-border);border-radius:8px;background:var(--ed-bg);color:var(--ed-text);cursor:pointer;min-width:0}.image-clip-grid button:hover{border-color:var(--ed-accent)}.image-clip-grid button:focus-visible,.image-clip-heading button:focus-visible{outline:2px solid var(--ed-accent);outline-offset:2px}.image-clip-library button:disabled{opacity:.5;cursor:wait}.image-clip-thumb{height:90px;display:flex;align-items:center;justify-content:center;border-radius:4px;background:repeating-conic-gradient(#8882 0 25%,transparent 0 50%) 0/14px 14px}.image-clip-thumb img{max-width:100%;max-height:100%;object-fit:contain}.image-clip-grid strong{font-size:11px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.image-clip-grid small{font-size:10px;color:var(--ed-muted)}.image-clip-error{margin:0;color:var(--ed-danger,#e57280);font-size:12px}.image-clip-empty{padding:24px 12px;text-align:center;color:var(--ed-muted);font-size:12px;line-height:1.7}
</style>
