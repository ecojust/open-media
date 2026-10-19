export type AssetKind = 'video' | 'audio' | 'image'
export type TrackKind = 'video' | 'audio' | 'text' | 'transition'
export type MediaFit = 'contain' | 'cover' | 'fill'

export type AnimationEasing = 'linear' | 'ease-in' | 'ease-out' | 'ease-in-out' | 'step'
export type AnimatedProperty = 'x' | 'y' | 'scaleX' | 'scaleY' | 'opacity' | 'rotation' | 'volume'
export interface ClipKeyframe { time: number; value: number; easing?: AnimationEasing }
export type ClipKeyframes = Partial<Record<AnimatedProperty, ClipKeyframe[]>>
export interface NormalizedRect { x: number; y: number; width: number; height: number }
export interface ClipSpeedRamp { points: { position: number; speed: number }[]; easing: AnimationEasing; preservePitch: boolean; sourceRange?: { start: number; end: number } }
export interface ClipFreezeFrame { sourceTime: number; original: { trimIn: number; trimOut: number; speed: number; volume: number; speedRamp?: ClipSpeedRamp } }
export interface ClipOverlay {
  kind: 'arrow' | 'rectangle' | 'highlight' | 'mask' | 'spotlight' | 'blur'
    | 'ellipse' | 'brackets' | 'double-arrow' | 'leader' | 'underline' | 'check'
  color: string
  strokeWidth: number
  blurRadius: number
  /** Spotlight opening in local clip pixels. */
  region?: { x: number; y: number; width: number; height: number }
}
export interface TimelineMarker { id: string; time: number; label: string; kind: 'chapter' | 'highlight' | 'review'; color?: string }

export type TransitionEffect = 'fade' | 'wipe-up' | 'wipe-down' | 'wipe-left' | 'wipe-right' | 'close-vertical' | 'close-horizontal' | 'slide-left' | 'slide-right' | 'zoom'
  | 'zoom-fade' | 'zoom-fade-left' | 'zoom-fade-right' | 'zoom-fade-up' | 'zoom-fade-down'
  | 'iris' | 'diamond' | 'blinds' | 'flash-white' | 'defocus' | 'zoom-through' | 'diagonal' | 'radial'
  | 'fragment-burst' | 'fragment-vortex' | 'fragment-collapse' | 'pixel-dissolve' | 'pixel-wave' | 'slice-stagger' | 'slice-vertical' | 'checker-flip'
  | 'tile-orbit' | 'glitch-slices' | 'zipper-slices' | 'stepped-shutter'

/** A transition is anchored to the shared cut of two adjacent video clips. */
export interface ClipTransition {
  effect: TransitionEffect
  fromClipId: string
  toClipId: string
  direction?: 'up' | 'down' | 'left' | 'right'
  easing?: AnimationEasing
  color?: string
  blur?: number
  scope?: 'both' | 'outgoing' | 'incoming'
}

export interface MediaAsset {
  id: string
  /** Time this asset was added to the project; absent in older documents. */
  addedAt?: string
  /** Built-in library material role; ordinary imported files have no role. */
  provenance?: { kind: 'upload' | 'url'; name?: string; url?: string; finalUrl?: string; mimeType?: string; sha256: string; size?: number; importedAt: number }
  libraryRole?: 'watermark' | 'background-music' | 'video-segment'
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
  transition?: ClipTransition
  /** Local animation time retained when a clip is split or trimmed. */
  animationOffset?: number
  keyframes?: ClipKeyframes
  crop?: NormalizedRect
  overlay?: ClipOverlay
  freezeFrame?: ClipFreezeFrame
  speedRamp?: ClipSpeedRamp
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
  markers?: TimelineMarker[]
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
