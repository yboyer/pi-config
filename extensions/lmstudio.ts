import type { ExtensionAPI, ProviderModelConfig } from '@earendil-works/pi-coding-agent'

const DEFAULT_LM_STUDIO_URL = 'http://127.0.0.1:1234'

function resolveValue(value: string): string {
  if (value.startsWith('$')) {
    const envKey = value.slice(1)
    return process.env[envKey] ?? value
  }
  return value
}

function getLmStudioUrl(): string {
  return resolveValue(DEFAULT_LM_STUDIO_URL)
}

interface LMStudioLoadedInstance {
  config: {
    context_length: number
    eval_batch_size: number
    flash_attention: boolean
    num_experts: number
    offload_kv_cache_to_gpu: boolean
  }
  id: string
}

interface LMStudioModel {
  architecture?: string
  capabilities?: {
    vision?: boolean
    trained_for_tool_use?: boolean
    reasoning?: { allowed_options: string[]; default: string }
  }
  description?: string | null
  display_name: string
  format: string
  key: string
  loaded_instances: LMStudioLoadedInstance[]
  max_context_length: number
  params_string: string | null
  publisher: string
  quantization?: { name: string; bits_per_weight: number }
  selected_variant: string
  size_bytes: number
  type: string
  variants: string[]
}

interface LMStudioResponse {
  models: LMStudioModel[]
}

/**
 * Helper to map LMStudioModel to Pi's model format
 */
function mapModels(models: LMStudioModel[]): ProviderModelConfig[] {
  return models.map(m => ({
    id: m.key,
    name: m.display_name,
    reasoning: m.capabilities?.reasoning !== undefined,
    provider: 'lmstudio',
    input: m.capabilities?.vision ? ['text', 'image'] : ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: m.loaded_instances[0]?.config.context_length ?? m.max_context_length,
    maxTokens: m.max_context_length,
  }))
}

/**
 * Fetch models from LM Studio endpoint
 */
async function fetchModels(): Promise<ProviderModelConfig[]> {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), 5000)

  try {
    const response = await fetch(`${getLmStudioUrl()}/api/v1/models`, { signal: controller.signal })
    if (!response.ok) throw new Error(`LM Studio HTTP status: ${response.status}`)

    const data: LMStudioResponse = await response.json()
    return mapModels((data.models || []).filter(m => m.type === 'llm'))
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError')
      throw new Error('LM Studio request timed out')
    throw error
  } finally {
    clearTimeout(timeoutId)
  }
}

export default async function (pi: ExtensionAPI) {
  pi.registerProvider('lmstudio', {
    baseUrl: `${getLmStudioUrl()}/v1/`,
    api: 'openai-completions',
    apiKey: 'lmstudio',
    models: await fetchModels().catch(() => []),
  })

  let fetchedThisCycle = false

  pi.on('agent_start', async () => {
    fetchedThisCycle = false
  })

  pi.on('message_end', async (event, _ctx) => {
    if (event.message.role === 'assistant' && !fetchedThisCycle) {
      fetchedThisCycle = true
      pi.registerProvider('lmstudio', {
        baseUrl: `${getLmStudioUrl()}/v1/`,
        api: 'openai-completions',
        apiKey: 'lmstudio',
        models: await fetchModels().catch(() => []),
      })
    }
  })
}
