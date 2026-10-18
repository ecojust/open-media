import generalMovie0 from '../assets/general-segments/general-paper-rise.webm?url'
import generalPoster0 from '../assets/general-segments/general-paper-rise.jpg?url'
import generalMovie1 from '../assets/general-segments/general-gallery-reveal.webm?url'
import generalPoster1 from '../assets/general-segments/general-gallery-reveal.jpg?url'
import generalMovie2 from '../assets/general-segments/general-geometric-curtain.webm?url'
import generalPoster2 from '../assets/general-segments/general-geometric-curtain.jpg?url'
import generalMovie3 from '../assets/general-segments/general-soft-halo.webm?url'
import generalPoster3 from '../assets/general-segments/general-soft-halo.jpg?url'
import generalMovie4 from '../assets/general-segments/general-offset-blocks.webm?url'
import generalPoster4 from '../assets/general-segments/general-offset-blocks.jpg?url'
import generalMovie5 from '../assets/general-segments/general-line-assembly.webm?url'
import generalPoster5 from '../assets/general-segments/general-line-assembly.jpg?url'
import generalMovie6 from '../assets/general-segments/general-film-window.webm?url'
import generalPoster6 from '../assets/general-segments/general-film-window.jpg?url'
import generalMovie7 from '../assets/general-segments/general-grain-gradient.webm?url'
import generalPoster7 from '../assets/general-segments/general-grain-gradient.jpg?url'
import generalMovie8 from '../assets/general-segments/general-paper-fold.webm?url'
import generalPoster8 from '../assets/general-segments/general-paper-fold.jpg?url'
import generalMovie9 from '../assets/general-segments/general-gallery-close.webm?url'
import generalPoster9 from '../assets/general-segments/general-gallery-close.jpg?url'
import generalMovie10 from '../assets/general-segments/general-curtain-settle.webm?url'
import generalPoster10 from '../assets/general-segments/general-curtain-settle.jpg?url'
import generalMovie11 from '../assets/general-segments/general-soft-afterglow.webm?url'
import generalPoster11 from '../assets/general-segments/general-soft-afterglow.jpg?url'
import generalMovie12 from '../assets/general-segments/general-blocks-balance.webm?url'
import generalPoster12 from '../assets/general-segments/general-blocks-balance.jpg?url'
import generalMovie13 from '../assets/general-segments/general-line-signature.webm?url'
import generalPoster13 from '../assets/general-segments/general-line-signature.jpg?url'
import generalMovie14 from '../assets/general-segments/general-film-resolve.webm?url'
import generalPoster14 from '../assets/general-segments/general-film-resolve.jpg?url'
import generalMovie15 from '../assets/general-segments/general-grain-dusk.webm?url'
import generalPoster15 from '../assets/general-segments/general-grain-dusk.jpg?url'
import scienceMovie0 from '../assets/science-segments/science-orbital-atlas.webm?url'
import sciencePoster0 from '../assets/science-segments/science-orbital-atlas.jpg?url'
import scienceMovie1 from '../assets/science-segments/science-spectrum-lab.webm?url'
import sciencePoster1 from '../assets/science-segments/science-spectrum-lab.jpg?url'
import scienceMovie2 from '../assets/science-segments/science-molecular-chain.webm?url'
import sciencePoster2 from '../assets/science-segments/science-molecular-chain.jpg?url'
import scienceMovie3 from '../assets/science-segments/science-blueprint-launch.webm?url'
import sciencePoster3 from '../assets/science-segments/science-blueprint-launch.jpg?url'
import scienceMovie4 from '../assets/science-segments/science-data-field.webm?url'
import sciencePoster4 from '../assets/science-segments/science-data-field.jpg?url'
import scienceMovie5 from '../assets/science-segments/science-terrain-observer.webm?url'
import sciencePoster5 from '../assets/science-segments/science-terrain-observer.jpg?url'
import scienceMovie6 from '../assets/science-segments/science-orbit-return.webm?url'
import sciencePoster6 from '../assets/science-segments/science-orbit-return.jpg?url'
import scienceMovie7 from '../assets/science-segments/science-spectrum-resolve.webm?url'
import sciencePoster7 from '../assets/science-segments/science-spectrum-resolve.jpg?url'
import scienceMovie8 from '../assets/science-segments/science-molecular-summary.webm?url'
import sciencePoster8 from '../assets/science-segments/science-molecular-summary.jpg?url'
import scienceMovie9 from '../assets/science-segments/science-blueprint-complete.webm?url'
import sciencePoster9 from '../assets/science-segments/science-blueprint-complete.jpg?url'
import scienceMovie10 from '../assets/science-segments/science-data-archive.webm?url'
import sciencePoster10 from '../assets/science-segments/science-data-archive.jpg?url'
import scienceMovie11 from '../assets/science-segments/science-terrain-horizon.webm?url'
import sciencePoster11 from '../assets/science-segments/science-terrain-horizon.jpg?url'
import movie0 from '../assets/video-segments/midnight-orbit.webm?url'
import movie1 from '../assets/video-segments/prism-dawn.webm?url'
import movie2 from '../assets/video-segments/gold-horizon.webm?url'
import movie3 from '../assets/video-segments/paper-morning.webm?url'
import movie4 from '../assets/video-segments/azure-grid.webm?url'
import movie5 from '../assets/video-segments/velvet-curtain.webm?url'
import movie6 from '../assets/video-segments/ocean-line.webm?url'
import movie7 from '../assets/video-segments/graphite-frame.webm?url'
import movie8 from '../assets/video-segments/coral-sunset.webm?url'
import movie9 from '../assets/video-segments/starlit-finale.webm?url'
import poster0 from '../assets/video-segments/midnight-orbit.jpg?url'
import poster1 from '../assets/video-segments/prism-dawn.jpg?url'
import poster2 from '../assets/video-segments/gold-horizon.jpg?url'
import poster3 from '../assets/video-segments/paper-morning.jpg?url'
import poster4 from '../assets/video-segments/azure-grid.jpg?url'
import poster5 from '../assets/video-segments/velvet-curtain.jpg?url'
import poster6 from '../assets/video-segments/ocean-line.jpg?url'
import poster7 from '../assets/video-segments/graphite-frame.jpg?url'
import poster8 from '../assets/video-segments/coral-sunset.jpg?url'
import poster9 from '../assets/video-segments/starlit-finale.jpg?url'
import { VIDEO_SEGMENT_PRESETS, type VideoSegmentPreset } from './video-segment-presets'

export type { VideoSegmentCaption, VideoSegmentPlacement } from './video-segment-presets'
export interface VideoSegmentItem extends VideoSegmentPreset {
  url: string
  posterUrl: string
  filename: string
  duration: number
  width: number
  height: number
}

const sources: Record<string, { url: string; posterUrl: string }> = {
  'general-paper-rise': { url: generalMovie0, posterUrl: generalPoster0 },
  'general-gallery-reveal': { url: generalMovie1, posterUrl: generalPoster1 },
  'general-geometric-curtain': { url: generalMovie2, posterUrl: generalPoster2 },
  'general-soft-halo': { url: generalMovie3, posterUrl: generalPoster3 },
  'general-offset-blocks': { url: generalMovie4, posterUrl: generalPoster4 },
  'general-line-assembly': { url: generalMovie5, posterUrl: generalPoster5 },
  'general-film-window': { url: generalMovie6, posterUrl: generalPoster6 },
  'general-grain-gradient': { url: generalMovie7, posterUrl: generalPoster7 },
  'general-paper-fold': { url: generalMovie8, posterUrl: generalPoster8 },
  'general-gallery-close': { url: generalMovie9, posterUrl: generalPoster9 },
  'general-curtain-settle': { url: generalMovie10, posterUrl: generalPoster10 },
  'general-soft-afterglow': { url: generalMovie11, posterUrl: generalPoster11 },
  'general-blocks-balance': { url: generalMovie12, posterUrl: generalPoster12 },
  'general-line-signature': { url: generalMovie13, posterUrl: generalPoster13 },
  'general-film-resolve': { url: generalMovie14, posterUrl: generalPoster14 },
  'general-grain-dusk': { url: generalMovie15, posterUrl: generalPoster15 },
  'midnight-orbit': { url: movie0, posterUrl: poster0 },
  'prism-dawn': { url: movie1, posterUrl: poster1 },
  'gold-horizon': { url: movie2, posterUrl: poster2 },
  'paper-morning': { url: movie3, posterUrl: poster3 },
  'azure-grid': { url: movie4, posterUrl: poster4 },
  'velvet-curtain': { url: movie5, posterUrl: poster5 },
  'ocean-line': { url: movie6, posterUrl: poster6 },
  'graphite-frame': { url: movie7, posterUrl: poster7 },
  'coral-sunset': { url: movie8, posterUrl: poster8 },
  'starlit-finale': { url: movie9, posterUrl: poster9 },
  'science-orbital-atlas': { url: scienceMovie0, posterUrl: sciencePoster0 },
  'science-spectrum-lab': { url: scienceMovie1, posterUrl: sciencePoster1 },
  'science-molecular-chain': { url: scienceMovie2, posterUrl: sciencePoster2 },
  'science-blueprint-launch': { url: scienceMovie3, posterUrl: sciencePoster3 },
  'science-data-field': { url: scienceMovie4, posterUrl: sciencePoster4 },
  'science-terrain-observer': { url: scienceMovie5, posterUrl: sciencePoster5 },
  'science-orbit-return': { url: scienceMovie6, posterUrl: sciencePoster6 },
  'science-spectrum-resolve': { url: scienceMovie7, posterUrl: sciencePoster7 },
  'science-molecular-summary': { url: scienceMovie8, posterUrl: sciencePoster8 },
  'science-blueprint-complete': { url: scienceMovie9, posterUrl: sciencePoster9 },
  'science-data-archive': { url: scienceMovie10, posterUrl: sciencePoster10 },
  'science-terrain-horizon': { url: scienceMovie11, posterUrl: sciencePoster11 },
}
export const VIDEO_SEGMENTS: readonly VideoSegmentItem[] = VIDEO_SEGMENT_PRESETS.map(preset => {
  const source = sources[preset.id]
  if (!source) throw new Error(`片头片尾素材缺失：${preset.id}`)
  return { ...preset, ...source, filename: `${preset.id}.webm`, duration: 5, width: 1280, height: 720 }
})
