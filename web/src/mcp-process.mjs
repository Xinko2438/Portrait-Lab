import { spawn } from 'node:child_process';
import { createConnection } from 'node:net';
import { mkdir, open, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const moduleDir = dirname(fileURLToPath(import.meta.url));
const mcpCliPath = join(moduleDir, '..', 'node_modules', '@playwright', 'mcp', 'cli.js');

export function buildMcpLaunch({ token, outputDir, workingDirectory, port = 8931 }) {
  return {
    command: process.execPath,
    cwd: workingDirectory,
    args: [mcpCliPath, '--extension', '--port', String(port), '--host', '127.0.0.1', '--shared-browser-context', '--output-dir', outputDir],
    env: {
      ...process.env,
      PLAYWRIGHT_MCP_EXTENSION_TOKEN: token,
      PLAYWRIGHT_MCP_PING_TIMEOUT_MS: '0',
      PLAYWRIGHT_MCP_TIMEOUT_ACTION: '15000',
    },
  };
}

export function isPortOpen(port = 8931, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const socket = createConnection({ port, host });
    const done = (value) => { socket.destroy(); resolve(value); };
    socket.setTimeout(500);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

export async function ensureMcpServer({ tokenFile, outputDir, logFile, workingDirectory = dirname(tokenFile), port = 8931 }) {
  if (await isPortOpen(port)) return { ready: true, owned: false, process: null };
  let token = '';
  try {
    token = (await readFile(tokenFile, 'utf8')).trim();
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  if (token.length < 20) return { ready: false, owned: false, state: 'token_required', process: null };
  await mkdir(outputDir, { recursive: true });
  await mkdir(dirname(logFile), { recursive: true });
  const log = await open(logFile, 'a');
  const launch = buildMcpLaunch({ token, outputDir, workingDirectory, port });
  const child = spawn(launch.command, launch.args, { cwd: launch.cwd, env: launch.env, windowsHide: true, stdio: ['ignore', log.fd, log.fd] });
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (await isPortOpen(port)) return { ready: true, owned: true, process: child };
    if (child.exitCode !== null) return { ready: false, state: 'service_failed', process: child };
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  child.kill();
  return { ready: false, state: 'service_timeout', process: child };
}
