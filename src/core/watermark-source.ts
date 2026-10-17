import type { WatermarkMaterial } from './watermark-library.ts'

/** Selects a bundled video format supported by the current playback environment. */
export function chooseWatermarkSource(material: WatermarkMaterial, media?: HTMLVideoElement): string {
  if (material.kind !== 'video' || !material.fallbackUrl) return material.url
  const player = media ?? document.createElement('video')
  return player.canPlayType('video/mp4; codecs="avc1.64001e"') ? material.url : material.fallbackUrl
}
