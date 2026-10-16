import { invoke } from '@tauri-apps/api/core'
import type { CaptureSelection, CaptureSelectionContext } from './capture-selection'

export const getCapturePickerContext = (requestId: string) => invoke<CaptureSelectionContext>('get_capture_picker_context', { requestId })
export const readyCapturePicker = (requestId: string) => invoke<void>('capture_picker_ready', { requestId })
export const completeCapturePicker = (requestId: string, selection: CaptureSelection | null) => invoke<void>('complete_capture_picker', { requestId, selection })
