export interface BrowserMicrophoneDevice {
  id: string
  name: string
}

export interface MicrophonePreference {
  deviceId: string
  name: string
}

function cancelled(): DOMException {
  return new DOMException('已取消麦克风请求。', 'AbortError')
}

function devices(): MediaDevices {
  if (typeof navigator === 'undefined' || !navigator.mediaDevices) {
    throw new Error('当前环境无法访问麦克风，请使用桌面版或通过安全连接访问网页。')
  }
  return navigator.mediaDevices
}

/** Listing inputs never starts capture or requests permission. */
export async function listBrowserMicrophones(): Promise<{ devices: BrowserMicrophoneDevice[]; permissionRequired: boolean }> {
  const mediaDevices = devices()
  if (!mediaDevices.enumerateDevices) throw new Error('当前环境无法列出麦克风设备。')
  const inputs = (await mediaDevices.enumerateDevices()).filter(device => device.kind === 'audioinput')
  const seen = new Set<string>()
  const microphones: BrowserMicrophoneDevice[] = []
  for (const input of inputs) {
    if (!input.deviceId || input.deviceId === 'default' || input.deviceId === 'communications' || seen.has(input.deviceId)) continue
    seen.add(input.deviceId)
    microphones.push({ id: input.deviceId, name: input.label.trim() || `麦克风 ${microphones.length + 1}` })
  }
  return { devices: microphones, permissionRequired: !inputs.some(input => input.label.trim()) }
}

/** Keep an explicit choice exact so unplugging an input never records from another microphone. */
export function requestBrowserMicrophone({ deviceId, signal, audioConstraints }: {
  deviceId?: string
  signal?: AbortSignal
  audioConstraints?: MediaTrackConstraints
} = {}): Promise<MediaStream> {
  if (signal?.aborted) return Promise.reject(cancelled())
  const mediaDevices = devices()
  if (!mediaDevices.getUserMedia) return Promise.reject(new Error('当前环境不支持麦克风访问。'))
  const explicit = deviceId && deviceId !== 'default'
  const constraints = { ...audioConstraints, ...(explicit ? { deviceId: { exact: deviceId } } : {}) }
  const pending = mediaDevices.getUserMedia({ audio: Object.keys(constraints).length ? constraints : true, video: false })
  if (!signal) return pending
  return new Promise((resolve, reject) => {
    let settled = false
    const abort = () => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', abort)
      reject(cancelled())
    }
    signal.addEventListener('abort', abort, { once: true })
    pending.then(stream => {
      if (settled) { for (const track of stream.getTracks()) track.stop(); return }
      settled = true
      signal.removeEventListener('abort', abort)
      resolve(stream)
    }, error => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', abort)
      reject(error)
    })
    if (signal.aborted) abort()
  })
}

/** Called by the explicit authorization action; release immediately after labels become available. */
export async function authorizeBrowserMicrophones(signal?: AbortSignal): Promise<void> {
  const stream = await requestBrowserMicrophone({ signal })
  for (const track of stream.getTracks()) track.stop()
  if (signal?.aborted) throw cancelled()
}

export function readMicrophonePreference(scope: string): MicrophonePreference {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(`open-media:microphone:${scope}`) || 'null')
    if (value && typeof value === 'object' && 'deviceId' in value && typeof value.deviceId === 'string') {
      return { deviceId: value.deviceId === 'default' ? '' : value.deviceId, name: 'name' in value && typeof value.name === 'string' ? value.name : '' }
    }
  } catch { /* Storage can be unavailable in private sessions. */ }
  return { deviceId: '', name: '' }
}

export function writeMicrophonePreference(scope: string, preference: MicrophonePreference): void {
  try { localStorage.setItem(`open-media:microphone:${scope}`, JSON.stringify(preference)) }
  catch { /* Keep the current selection even if persistence is unavailable. */ }
}
