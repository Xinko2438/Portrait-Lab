import { McpClient, redactSecrets } from './mcp-client.mjs';

export { redactSecrets } from './mcp-client.mjs';

export function classifyProviderFailure(message = '') {
  const safe = redactSecrets(message);
  if (/请求过于频繁|too many requests|rate limit|稍等几分钟后再试/i.test(safe)) {
    return {
      state: 'provider_rate_limited',
      retryAutomatically: false,
      playwrightHealthy: true,
      message: 'ChatGPT 暂时限制请求。任务已保留，系统不会自动重试。',
    };
  }
  return {
    state: 'provider_error',
    retryAutomatically: false,
    playwrightHealthy: true,
    message: safe || 'ChatGPT 返回了未分类错误。',
  };
}

export function classifyBrowserProbe(message = '') {
  const safe = redactSecrets(message);
  if (/Playwright Extension not found/i.test(safe)) {
    return { ready: false, state: 'extension_required', message: '默认 Chrome 尚未连接官方 Playwright Extension。' };
  }
  if (/ECONNREFUSED|fetch failed|service unavailable/i.test(safe)) {
    return { ready: false, state: 'service_unavailable', message: '本地 Playwright 服务尚未启动。' };
  }
  if(safe.trim())return {ready:false,state:'probe_failed',message:safe};
  return { ready: true, state: 'bridge_ready', message: '浏览器桥接已连接；ChatGPT 编辑区将在装载任务前核对。' };
}

export async function probeBrowser(endpoint = 'http://localhost:8931/mcp') {
  try {
    const client = new McpClient({ endpoint, clientName: 'ai-img-gen-browser-probe', timeoutMs: 15000 });
    await client.initialize();
    await client.callTool('browser_tabs', { action: 'list' });
    return classifyBrowserProbe('');
  } catch (error) {
    return classifyBrowserProbe(String(error?.cause || error?.message || error));
  }
}
