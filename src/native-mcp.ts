import { isDesktop } from './native'

export interface McpConfig { host: string; port: number; token: string }
export interface McpStatus { running: boolean; host: string; port: number; url: string | null; pendingRequests: number; connectedClients: number }
export interface McpRequest { id: string; tool: string; arguments: Record<string, unknown>; createdAt: number; deadlineAt: number }
export interface McpPanelJob {
  id: string
  name: string
  state: 'running' | 'completed' | 'failed' | 'cancelled'
  progress?: number
  stage?: string
  error?: string
  cancelable?: boolean
  cancelling?: boolean
}

async function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (!isDesktop()) throw new Error('MCP 服务需要桌面端。')
  const { invoke } = await import('@tauri-apps/api/core')
  return invoke<T>(command, args)
}

let serviceEpoch = 0, lastRunning: boolean | undefined
let statusSequence = 0, settledStatusSequence = 0
let latestStatus: { epoch: number; value: McpStatus } | undefined
function observeStatus(status: McpStatus): McpStatus {
  if (lastRunning === true && !status.running) serviceEpoch++
  lastRunning = status.running
  const connectedClients = status.running && Number.isFinite(status.connectedClients) ? Math.max(0, Math.floor(status.connectedClients)) : 0
  const value = { ...status, connectedClients }
  latestStatus = { epoch: serviceEpoch, value }
  return value
}
function currentStatus(): McpStatus {
  if (latestStatus?.epoch === serviceEpoch) return latestStatus.value
  throw new DOMException('MCP 状态请求已过期。', 'AbortError')
}
export function getMcpServiceEpoch(): number { return serviceEpoch }

export function getMcpConfig(): Promise<McpConfig> { return call('mcp_get_config') }
export async function getMcpStatus(): Promise<McpStatus> {
  const epoch = serviceEpoch, sequence = ++statusSequence
  try {
    const status = await call<McpStatus>('mcp_get_status')
    if (epoch !== serviceEpoch || sequence < settledStatusSequence) return currentStatus()
    settledStatusSequence = sequence
    return observeStatus(status)
  } catch (cause) {
    if (epoch !== serviceEpoch || sequence < settledStatusSequence) return currentStatus()
    settledStatusSequence = sequence; latestStatus = undefined
    throw cause
  }
}
export function saveMcpConfig(config: McpConfig): Promise<McpConfig> { return call('mcp_save_config', { config }) }
export async function startMcpService(): Promise<McpStatus> {
  const epoch = ++serviceEpoch
  latestStatus = undefined
  const status = await call<McpStatus>('mcp_start')
  if (epoch !== serviceEpoch) return currentStatus()
  settledStatusSequence = ++statusSequence
  return observeStatus(status)
}
export async function stopMcpService(): Promise<McpStatus> {
  // Invalidate a request already claimed by the native bridge before it can edit.
  const epoch = ++serviceEpoch
  latestStatus = undefined
  const status = await call<McpStatus>('mcp_stop')
  if (epoch !== serviceEpoch) return currentStatus()
  settledStatusSequence = ++statusSequence
  return observeStatus(status)
}
export function getPendingMcpRequests(): Promise<McpRequest[]> { return call('mcp_pending') }
export function claimMcpRequest(id: string): Promise<boolean> { return call('mcp_claim', { id }) }
export function completeMcpRequest(id: string, result: unknown, isError = false): Promise<boolean> { return call('mcp_complete', { id, result, isError }) }
export async function onMcpRequest(handler: (request: McpRequest) => void): Promise<() => void> {
  if (!isDesktop()) return () => {}
  const { listen } = await import('@tauri-apps/api/event')
  return listen<McpRequest>('mcp-request', event => handler(event.payload))
}
