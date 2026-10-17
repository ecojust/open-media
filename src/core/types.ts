export type AssetKind = 'video' | 'audio' | 'image'
export type TrackKind = 'video' | 'audio' | 'text'
export type MediaFit = 'contain' | 'cover' | 'fill'

export interface MediaAsset {
  id: string
  /** Time this asset was added to the project; absent in older documents. */
  addedAt?: string
  name: string
  kind: AssetKind
  url: string
  sourceUrl?: string
  duration: number
  width: number
  height: number
  size: number
  mime: string
  nativePath?: string
}

export type Asset = MediaAsset

export interface SpeechBinding {
  textClipId?: string
  text: string
  voiceId: string
  rate: number
}

/** RGB adjustments are applied before clip opacity and timeline compositing. */
export interface ClipFilters {
  enabled: boolean
  intensity: number
  brightness: number
  contrast: number
  saturation: number
  temperature: number
  tint: number
  sepia: number
}

/** Removes a selected source color before clip color adjustments and compositing. */
export interface ClipChromaKey {
  enabled: boolean
  color: string
  similarity: number
  blend: number
  spillSuppression?: boolean
}

/** Source trims are measured in source seconds; start and fades use timeline seconds. */
export interface Clip {
  id: string
  /** Last creation or text-content generation time; absent in older documents. */
  generatedAt?: string
  assetId?: string
  name: string
  start: number
  trimIn: number
  trimOut: number
  speed: number
  volume: number
  opacity: number
  x: number
  y: number
  width: number
  height: number
  rotation: number
  fit: MediaFit
  fadeIn: number
  fadeOut: number
  text?: string
  textRole?: 'subtitle' | 'watermark'
  fontSize?: number
  fontFamily?: string
  fontWeight?: number
  color?: string
  background?: string
  textAlign?: 'left' | 'center' | 'right'
  /** Align the text block inside its existing clip bounds. */
  textVerticalAlign?: 'top' | 'middle' | 'bottom'
  speech?: SpeechBinding
  filters?: ClipFilters
  chromaKey?: ClipChromaKey
}

/** Visual settings remembered independently of subtitle content and timing. */
export type SubtitleStyle = Required<Pick<Clip,
  'x' | 'y' | 'width' | 'height' | 'rotation' | 'opacity' | 'fadeIn' | 'fadeOut' |
  'fontSize' | 'fontFamily' | 'fontWeight' | 'color' | 'background' | 'textAlign' | 'textVerticalAlign'
>>

export interface Track {
  id: string
  name: string
  kind: TrackKind
  muted: boolean
  locked: boolean
  clips: Clip[]
}

/** Tracks are ordered from foreground to background. */
export interface Project {
  version: 1
  id: string
  title: string
  width: number
  height: number
  fps: number
  /** New projects wait for their first video size; matching or manual sizing disables this. */
  autoSizeFromVideo?: boolean
  background: string
  createdAt: string
  updatedAt: string
  assets: MediaAsset[]
  tracks: Track[]
  subtitleStyle?: SubtitleStyle
}

export type MediaProject = Project

export interface ProjectSummary {
  id: string
  title: string
  width: number
  height: number
  duration: number
  updatedAt: string
  assetCount: number
}

export interface ProjectHistory {
  past: Project[]
  present: Project
  future: Project[]
  limit: number
}

export interface ImportedProject {
  project: Project
  blobs: Map<string, Blob>
  revoke: () => void
}
