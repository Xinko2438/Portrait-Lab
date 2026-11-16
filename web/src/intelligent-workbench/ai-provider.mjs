export const AI_PROVIDER_CAPABILITY_VERSION = 'ai-img-gen.ai-provider-capability.v1';

export function createFoundationProviderRegistry() {
  const providers = [
    { id: 'deterministic', state: 'active', capabilities: ['prompt_compilation'], external: false },
    { id: 'opencodex', state: 'disabled_pending_contract', capabilities: [], external: true, endpoint: 'http://127.0.0.1:10100/v1/responses' },
    { id: 'codex-cli', state: 'reserved_offline', capabilities: [], external: true },
  ];
  return {
    statuses() { return providers.map((item) => ({ schema_version: AI_PROVIDER_CAPABILITY_VERSION, ...item })); },
    resolve(capability) {
      const provider = providers.find((item) => item.state === 'active' && item.capabilities.includes(capability));
      if (!provider) throw new Error(`No active provider for capability: ${capability}`);
      return { ...provider };
    },
  };
}
export async function inspectOpenCodexHealth({ fetch: fetchImpl = globalThis.fetch?.bind(globalThis), baseUrl = 'http://127.0.0.1:10100' } = {}) {
  if (!fetchImpl) return { provider_id: 'opencodex', transport_ready: false, activation_state: 'disabled_pending_contract', model_count: 0 };
  try {
    const [healthResponse, readyResponse, modelsResponse] = await Promise.all([fetchImpl(`${baseUrl}/healthz`), fetchImpl(`${baseUrl}/readyz`), fetchImpl(`${baseUrl}/v1/models`)]);
    const [health, ready, models] = await Promise.all([healthResponse.json(), readyResponse.json(), modelsResponse.json()]);
    return { schema_version: AI_PROVIDER_CAPABILITY_VERSION, provider_id: 'opencodex', endpoint: `${baseUrl}/v1/responses`, transport_ready: Boolean(healthResponse.ok && readyResponse.ok && ready.status === 'ready'), service_version: health.version || null, model_count: Array.isArray(models.data) ? models.data.length : 0, activation_state: 'disabled_pending_contract' };
  } catch (error) {
    return { schema_version: AI_PROVIDER_CAPABILITY_VERSION, provider_id: 'opencodex', endpoint: `${baseUrl}/v1/responses`, transport_ready: false, model_count: 0, activation_state: 'disabled_pending_contract', message: String(error?.message || error) };
  }
}