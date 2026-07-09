#!/usr/bin/env node
/**
 * chatbots-editreadmcp — coding tools MCP + Cloudflare tunnel
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

console.log('--- chatbots-editreadmcp ---');
console.log(`data dir: ${DATA_DIR}`);

const { httpServer, port, apiKey, root } = await startHttpServer();

let tunnelProc = null;

async function startTunnel() {
  if (process.env.MCP_NO_TUNNEL === '1') {
    console.log('MCP_NO_TUNNEL=1 — public tunnel disabled.');
    return;
  }
  let bin = resolveCloudflared();
  if (!bin) bin = await ensureCloudflared();
  if (!bin) {
    console.log('cloudflared not found — public tunnel disabled.');
    return;
  }
  const tunnel = spawnTunnel(bin, port);
  tunnelProc = tunnel.process;
  const publicUrl = await tunnel.waitForUrl();
  if (publicUrl) {
    console.log('');
    console.log('chatbots-editreadmcp is LIVE');
    console.log('--------------------------------------------------');
    console.log(`Streamable HTTP (ChatGPT/Grok secure path):`);
    console.log(`  ${publicUrl}/mcp/${apiKey}`);
    console.log(`Legacy SSE (Grok SSE fallback):`);
    console.log(`  ${publicUrl}/sse/${apiKey}`);
    console.log(`Workspace: ${root}`);
    if (process.env.MCP_NO_AUTH === '1') {
      console.log('Auth:      NONE (MCP_NO_AUTH=1)');
    } else {
      console.log(`API key:   ${apiKey}`);
    }
    console.log('--------------------------------------------------');
    console.log('Connectors: ChatGPT Developer Mode · Grok Custom Connector');
    console.log('URL changes every free-tunnel restart.');
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
