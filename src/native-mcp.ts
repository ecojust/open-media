import { isDesktop } from './native'

export interface McpConfig { host: string; port: number; token: string }
export interface McpStatus { running: boolean; host: string; port: number; url: string | null; pendingRequests: number }
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
function observeStatus(status: McpStatus): McpStatus {
  if (lastRunning === true && !status.running) serviceEpoch++
  lastRunning = status.running
  return status
}
export function getMcpServiceEpoch(): number { return serviceEpoch }

export function getMcpConfig(): Promise<McpConfig> { return call('mcp_get_config') }
export async function getMcpStatus(): Promise<McpStatus> {
  const epoch = serviceEpoch, status = await call<McpStatus>('mcp_get_status')
  return epoch === serviceEpoch ? observeStatus(status) : status
}
export function saveMcpConfig(config: McpConfig): Promise<McpConfig> { return call('mcp_save_config', { config }) }
export async function startMcpService(): Promise<McpStatus> {
  serviceEpoch++
  return observeStatus(await call<McpStatus>('mcp_start'))
}
export async function stopMcpService(): Promise<McpStatus> {
  // Invalidate a request already claimed by the native bridge before it can edit.
  serviceEpoch++
  return observeStatus(await call<McpStatus>('mcp_stop'))
}
export function getPendingMcpRequests(): Promise<McpRequest[]> { return call('mcp_pending') }
export function claimMcpRequest(id: string): Promise<boolean> { return call('mcp_claim', { id }) }
export function completeMcpRequest(id: string, result: unknown, isError = false): Promise<boolean> { return call('mcp_complete', { id, result, isError }) }
export async function onMcpRequest(handler: (request: McpRequest) => void): Promise<() => void> {
  if (!isDesktop()) return () => {}
  const { listen } = await import('@tauri-apps/api/event')
  return listen<McpRequest>('mcp-request', event => handler(event.payload))
}
