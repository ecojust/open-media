export type CaptureControlAction = 'pause' | 'resume' | 'stop' | 'toggle-microphone'

export interface CaptureControlsSnapshot {
  phase: 'idle' | 'starting' | 'recording' | 'paused' | 'stopping'
  elapsed: number
  muted: boolean
  audioAvailable: boolean
  microphoneEnabled: boolean
  microphonePending?: boolean
  busy: boolean
  error?: string | null
}

export function recordingClock(seconds: number): string {
  const value = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0))
  return `${String(Math.floor(value / 3600)).padStart(2, '0')}:${String(Math.floor(value / 60) % 60).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`
}
