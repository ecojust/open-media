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

const movies = [movie0, movie1, movie2, movie3, movie4, movie5, movie6, movie7, movie8, movie9]
const posters = [poster0, poster1, poster2, poster3, poster4, poster5, poster6, poster7, poster8, poster9]
export const VIDEO_SEGMENTS: readonly VideoSegmentItem[] = VIDEO_SEGMENT_PRESETS.map((preset, index) => ({
  ...preset, url: movies[index]!, posterUrl: posters[index]!, filename: `${preset.id}.webm`, duration: 5, width: 1280, height: 720,
}))
