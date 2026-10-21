import type { AiModel, AiRuntimeStatus, AiStatus } from './ai.ts'
import { getGenerationModel } from './generation-settings.ts'

export interface McpGenerationModel {
  id: string
  name: string
  state: AiModel['state']
  capabilities: AiModel['capabilities']
  runtime: AiRuntimeStatus
  hardware: string
  selected: boolean
  eligible: boolean
  reason?: string
}

export interface McpGenerationCapability {
  capability: 'text-to-image' | 'text-to-music'
  tool: 'open_media_image_generate' | 'open_media_music_generate'
  availability: 'ready' | 'unavailable' | 'unknown'
  route: 'mcp' | 'agent' | 'check-status'
  selectedModelId: string
  reason?: string
  readyModelIds: string[]
  models: McpGenerationModel[]
}

export interface McpGenerationCapabilities {
  check: { tool: 'open_media_ai_status'; arguments: { probeRuntime: true } }
  checked: boolean
  checkError?: string
  busy: boolean
  policy: {
    default: 'local-first'
    modelSelection: 'user-selected-only'
    selectionChange: 'user-interface-only'
    agentOverride: 'explicit-user-request'
    unavailable: 'agent'
    unknown: 'check-status'
    busy: 'wait'
  }
  image: McpGenerationCapability
  music: McpGenerationCapability
}

function unavailableReason(model: AiModel, capability: McpGenerationCapability['capability']): string | undefined {
  if (!model.capabilities.includes(capability)) return '模型不支持所需生成能力。'
  if (model.state !== 'ready') return model.error || ({
    'not-downloaded': '模型尚未下载。', downloading: '模型正在下载。', verifying: '模型正在校验。',
    failed: '模型不可用。', unsupported: '当前平台不支持此模型。', 'update-available': '模型或运行环境需要更新。',
  } as Partial<Record<AiModel['state'], string>>)[model.state] || '模型尚未就绪。'
  if (model.runtime.state !== 'ready') return model.runtime.reason || '模型运行环境尚未就绪。'
}

function capabilityStatus(status: AiStatus | undefined, provider: 'image' | 'music'): McpGenerationCapability {
  const capability = provider === 'image' ? 'text-to-image' : 'text-to-music'
  const selectedModelId = getGenerationModel(provider)
  const models = (status?.models ?? []).filter(model => model.provider === provider).map(model => {
    const selected = model.id === selectedModelId
    const reason = unavailableReason(model, capability)
    return {
      id: model.id, name: model.name, state: model.state, capabilities: [...model.capabilities], hardware: model.hardware, selected, eligible: selected && !reason,
      runtime: { state: model.runtime.state, ...(model.runtime.device ? { device: model.runtime.device } : {}), ...(model.runtime.reason ? { reason: model.runtime.reason } : {}) },
      ...(reason ? { reason } : !selected ? { reason: '未被用户选中；MCP 不能自动切换至此模型。' } : {}),
    }
  })
  const readyModelIds = models.filter(model => model.eligible).map(model => model.id)
  const selectedModel = models.find(model => model.selected)
  const reason = !status ? undefined : !selectedModelId ? '请先在生成页面选择模型；MCP 不能代为选择。' : !selectedModel ? '用户当前选择的模型不在本地目录中；MCP 不能自动改用其他模型。' : selectedModel.reason
  const availability = !status ? 'unknown' : readyModelIds.length ? 'ready' : 'unavailable'
  return {
    capability, tool: provider === 'image' ? 'open_media_image_generate' : 'open_media_music_generate',
    availability, route: availability === 'ready' ? 'mcp' : availability === 'unavailable' ? 'agent' : 'check-status',
    selectedModelId, ...(reason ? { reason } : {}), readyModelIds, models,
  }
}

/** Readiness is constrained to the current user selection, never another installed model. */
export function getMcpGenerationCapabilities(status?: AiStatus): McpGenerationCapabilities {
  return {
    check: { tool: 'open_media_ai_status', arguments: { probeRuntime: true } },
    checked: status !== undefined, busy: status?.busy ?? false,
    policy: { default: 'local-first', modelSelection: 'user-selected-only', selectionChange: 'user-interface-only', agentOverride: 'explicit-user-request', unavailable: 'agent', unknown: 'check-status', busy: 'wait' },
    image: capabilityStatus(status, 'image'), music: capabilityStatus(status, 'music'),
  }
}
