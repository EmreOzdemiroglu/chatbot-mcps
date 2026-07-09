#!/usr/bin/env node
/**
 * chatbots-omp-as-mcp — OMP agent MCP + Cloudflare tunnel
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ensureDataDir,
  loadEnvFile,
  ENV_FILE,
  DATA_DIR,
} from './lib/auth.mjs';
import {
  ensureCloudflared,
  resolveCloudflared,
  spawnTunnel,
} from './lib/tunnel.mjs';
import { startHttpServer } from './server.mjs';

ensureDataDir();
loadEnvFile(ENV_FILE);
loadEnvFile(path.join(path.dirname(fileURLToPath(import.meta.url)), '.env'));

console.log('--- chatbots-omp-as-mcp ---');
console.log(`data dir: ${DATA_DIR}`);

const { httpServer, port, apiKey, root } = await startHttpServer();

let tunnelProc = null;

async function startTunnel() {
  if (process.env.MCP_NO_TUNNEL === '1') {
    console.log('MCP_NO_TUNNEL=1 — no public URL');
    return;
  }
  let bin = resolveCloudflared();
  if (!bin) bin = await ensureCloudflared();
  if (!bin) {
    console.log('cloudflared missing — local only');
    return;
  }
  const tunnel = spawnTunnel(bin, port);
  tunnelProc = tunnel.process;
  const publicUrl = await tunnel.waitForUrl();
  if (publicUrl) {
    console.log('');
    console.log('chatbots-omp-as-mcp is LIVE');
    console.log('--------------------------------------------------');
    console.log(`Streamable HTTP (ChatGPT/Grok secure path):`);
    console.log(`  ${publicUrl}/mcp/${apiKey}`);
    console.log(`Legacy SSE:`);
    console.log(`  ${publicUrl}/sse/${apiKey}`);
    console.log(`Workspace: ${root}`);
    if (process.env.MCP_NO_AUTH === '1') {
      console.log('Auth:      NONE (MCP_NO_AUTH=1)');
    } else {
      console.log(`API key:   ${apiKey}`);
    }
    console.log('--------------------------------------------------');
    console.log('Tools: list_models, omp_prompt(model=…), omp_continue, omp_status');
    console.log('ChatGPT + Grok custom connectors');
  } else {
    console.log('Tunnel URL not detected.');
  }
}

await startTunnel();

const shutdown = () => {
  try {
    tunnelProc?.kill('SIGTERM');
  } catch {
    /* ignore */
  }
  httpServer.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
