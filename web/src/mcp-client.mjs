const protocolVersion = '2025-06-18';

function parsePayload(text) {
  const lines = String(text || '').split(/\r?\n/).filter((line) => line.startsWith('data:'));
  const raw = lines.length ? lines.at(-1).slice(5).trim() : String(text || '').trim();
  if (!raw) return null;
  if (!raw.startsWith('{')) throw new Error(raw.slice(0, 500));
  return JSON.parse(raw);
}

export function redactSecrets(message = '') {
  return String(message)
    .replace(/([?&]token=)[^)&\s]+/gi, '$1[redacted]')
    .replace(/(PLAYWRIGHT_MCP_EXTENSION_TOKEN\s*=\s*)[^\s]+/gi, '$1[redacted]');
}

export class McpToolError extends Error {
  constructor(message, { toolName, payload } = {}) {
    super(redactSecrets(message));
    this.name = 'McpToolError';
    this.toolName = toolName;
    this.payload = payload;
  }
}

export class McpClient {
  constructor({ endpoint = 'http://localhost:8931/mcp', clientName = 'ai-img-gen-web', timeoutMs = 120000 } = {}) {
    this.endpoint = endpoint;
    this.clientName = clientName;
    this.timeoutMs = timeoutMs;
    this.sessionId = null;
    this.nextId = 1;
  }

  async request(body) {
    const headers = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': protocolVersion,
    };
    if (this.sessionId) headers['mcp-session-id'] = this.sessionId;
    const response = await fetch(this.endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const text = await response.text();
    if (!response.ok) throw new McpToolError(text || `MCP request failed with HTTP ${response.status}`);
    return { response, text, payload: parsePayload(text) };
  }

  async initialize() {
    if (this.sessionId) return;
    const initialized = await this.request({
      jsonrpc: '2.0',
      id: this.nextId++,
      method: 'initialize',
      params: {
        protocolVersion,
        capabilities: {},
        clientInfo: { name: this.clientName, version: '0.2.0' },
      },
    });
    this.sessionId = initialized.response.headers.get('mcp-session-id');
    if (!this.sessionId) throw new McpToolError(initialized.text || 'Missing MCP session id');
    await this.request({ jsonrpc: '2.0', method: 'notifications/initialized' });
  }

  async callTool(name, args = {}) {
    if (!this.sessionId) await this.initialize();
    const called = await this.request({
      jsonrpc: '2.0',
      id: this.nextId++,
      method: 'tools/call',
      params: { name, arguments: args },
    });
    const payload = called.payload;
    if (payload?.error) throw new McpToolError(payload.error.message || 'MCP tool call failed', { toolName: name, payload });
    const text = payload?.result?.content?.map((item) => item.text || '').filter(Boolean).join('\n') || '';
    if (payload?.result?.isError) throw new McpToolError(text || `${name} failed`, { toolName: name, payload });
    return { text: redactSecrets(text), content: payload?.result?.content || [] };
  }
}
