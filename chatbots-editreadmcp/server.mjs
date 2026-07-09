#!/usr/bin/env node
/**
 * chatbots-editreadmcp — pure coding tools MCP (pi-style)
 * Streamable HTTP: /mcp
 * Legacy SSE:      GET /sse + POST /messages?sessionId=
 * ChatGPT + Grok connectors.
 */
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import {
  ensureApiKey,
  extractBearer,
  isValidApiKey,
  loadEnvFile,
  ensureDataDir,
  ENV_FILE,
  readApiKey,
  API_KEY_PREFIX,
} from './lib/auth.mjs';
import * as vfs from './lib/fs.mjs';

ensureDataDir();
loadEnvFile(ENV_FILE);
loadEnvFile(path.join(path.dirname(fileURLToPath(import.meta.url)), '.env'));
const apiKey = ensureApiKey();

const PORT = parseInt(process.env.PORT || '7878', 10);
const ROOT = vfs.resolveRoot();

function textResult(payload) {
  const text =
    typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2);
  return { content: [{ type: 'text', text }] };
}

function errorResult(err) {
  const message = err instanceof Error ? err.message : String(err);
  return {
    isError: true,
    content: [{ type: 'text', text: `Error: ${message}` }],
  };
}

function runShellCommand(command, timeout) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, {
      shell: true,
      cwd: ROOT,
      env: process.env,
      timeout,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => {
      stdout += d.toString();
      if (stdout.length > 200_000)
        stdout = stdout.slice(0, 200_000) + '\n…truncated';
    });
    child.stderr.on('data', (d) => {
      stderr += d.toString();
      if (stderr.length > 100_000)
        stderr = stderr.slice(0, 100_000) + '\n…truncated';
    });
    child.on('error', reject);
    child.on('close', (code, signal) => {
      resolve({ command, code, signal, stdout, stderr, cwd: ROOT });
    });
  });
}

function normalizeBashArgs({ command, commands, timeout_ms, stop_on_error }) {
  if (command && commands) {
    throw new Error('Provide either command or commands, not both');
  }
  const normalized = commands ?? (command ? [command] : []);
  if (!Array.isArray(normalized) || normalized.length === 0) {
    throw new Error('command or commands is required');
  }
  if (normalized.length > 20) {
    throw new Error('commands is limited to 20 entries');
  }
  for (const cmd of normalized) {
    if (typeof cmd !== 'string' || !cmd.trim()) {
      throw new Error('commands must contain non-empty strings');
    }
  }
  return {
    commands: normalized,
    timeout: timeout_ms ?? 60_000,
    stopOnError: stop_on_error ?? true,
  };
}

function createServer() {
  const server = new McpServer({
    name: 'chatbots-editreadmcp',
    version: '0.2.0',
  });

  server.registerTool(
    'read_file',
    {
      title: 'Read file',
      description:
        'Read a text file. Optional 1-based offset/limit for large files.',
      inputSchema: {
        path: z.string(),
        offset: z.number().int().positive().optional(),
        limit: z.number().int().positive().optional(),
      },
    },
    async ({ path: p, offset, limit }) => {
      try {
        return textResult(await vfs.readFile(p, { offset, limit }));
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.registerTool(
    'write_file',
    {
      title: 'Write file',
      description: 'Create or overwrite a text file (mkdir parents).',
      inputSchema: {
        path: z.string(),
        content: z.string(),
      },
    },
    async ({ path: p, content }) => {
      try {
        return textResult(await vfs.writeFile(p, content));
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.registerTool(
    'edit_file',
    {
      title: 'Edit file',
      description:
        'Exact search/replace. Prefer unique old_string; replace_all for all occurrences.',
      inputSchema: {
        path: z.string(),
        old_string: z.string(),
        new_string: z.string(),
        replace_all: z.boolean().optional(),
      },
    },
    async ({ path: p, old_string, new_string, replace_all }) => {
      try {
        return textResult(
          await vfs.editFile(p, {
            old_string,
            new_string,
            replace_all: !!replace_all,
          }),
        );
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.registerTool(
    'search',
    {
      title: 'Search text',
      description: 'Recursive substring search. Skips node_modules/.git.',
      inputSchema: {
        query: z.string(),
        path: z.string().optional(),
        glob: z.string().optional().describe('e.g. "*.ts"'),
        max_results: z.number().int().positive().optional(),
        case_sensitive: z.boolean().optional(),
      },
    },
    async (args) => {
      try {
        return textResult(await vfs.searchText(args));
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  // bash always on for this MCP (coding-agent surface). Cwd forced under root.
  server.registerTool(
    'bash',
    {
      title: 'Bash',
      description:
        'Run one shell command or a batch of shell commands with cwd inside the workspace root (pi-style). Batch mode accepts commands[] and stops on the first non-zero exit by default.',
      inputSchema: {
        command: z.string().optional().describe('Single shell command'),
        commands: z
          .array(z.string())
          .max(20)
          .optional()
          .describe('Multiple shell commands to run sequentially'),
        timeout_ms: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('Timeout per command in milliseconds'),
        stop_on_error: z
          .boolean()
          .optional()
          .describe('Stop batch execution after the first failing command'),
      },
    },
    async (args) => {
      try {
        const { commands, timeout, stopOnError } = normalizeBashArgs(args);
        const results = [];
        for (const cmd of commands) {
          const result = await runShellCommand(cmd, timeout);
          results.push(result);
          if (stopOnError && result.code !== 0) break;
        }
        return textResult({
          cwd: ROOT,
          count: results.length,
          stopped: results.length < commands.length,
          results,
        });
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  return server;
}

const app = express();
app.use(express.json({ limit: '4mb' }));

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.header(
    'Access-Control-Allow-Headers',
    'Content-Type, Authorization, Accept, Mcp-Session-Id, MCP-Protocol-Version, Last-Event-ID, X-Api-Key',
  );
  res.header('Access-Control-Expose-Headers', 'Mcp-Session-Id');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    name: 'chatbots-editreadmcp',
    kind: 'coding-tools',
    root: ROOT,
    transports: ['/mcp', '/sse', '/messages'],
    auth: process.env.MCP_NO_AUTH === '1' ? false : !!readApiKey(),
    no_auth: process.env.MCP_NO_AUTH === '1',
  });
});

app.get('/', (_req, res) => {
  res.type('html').send(`<!doctype html>
<html><head><meta charset="utf-8"><title>chatbots-editreadmcp</title></head>
<body style="font:14px system-ui;max-width:640px;margin:2rem auto">
<h1>chatbots-editreadmcp</h1>
<p>Coding tools for ChatGPT &amp; Grok. Workspace: <code>${ROOT}</code></p>
<ul>
  <li><b>Streamable HTTP</b> (preferred): <code>/mcp</code></li>
  <li><b>Legacy SSE</b>: <code>GET /sse</code> + <code>POST /messages</code></li>
</ul>
<p>Auth: ${
    process.env.MCP_NO_AUTH === '1'
      ? '<b>DISABLED</b>'
      : 'Bearer MCP_API_KEY'
  }</p>
<p>OMP: sibling <code>chatbots-omp-as-mcp</code>.</p>
</body></html>`);
});

app.use((req, res, next) => {
  if (req.method === 'GET' && (req.path === '/' || req.path === '/health')) {
    return next();
  }
  if (process.env.MCP_NO_AUTH === '1') return next();

  // Extract API key from path if present (e.g. /mcp/editread-xyz -> parts is ['', 'mcp', 'editread-xyz'])
  const parts = req.path.split('/');
  const pathKey = parts[2]; 
  
  const provided = pathKey && pathKey.startsWith(API_KEY_PREFIX)
    ? pathKey
    : extractBearer(req.header('authorization')) || req.header('x-api-key');

  if (isValidApiKey(provided)) {
    // Rewrite req.url to strip the API key so Express routing works normally (e.g. /mcp/key -> /mcp)
    req.url = req.url.replace('/' + provided, '');
    return next();
  }

  res.status(401).json({
    jsonrpc: '2.0',
    error: {
      code: -32001,
      message: 'Unauthorized. Valid API key in path (/mcp/KEY) or Bearer header required.',
    },
    id: null,
  });
});

app.use((req, _res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  next();
});

/** @type {Map<string, { kind: 'http'|'sse', transport: any, server?: any }>} */
const sessions = new Map();

async function handleMcp(req, res) {
  const sessionId = req.header('mcp-session-id');
  try {
    if (sessionId && sessions.has(sessionId)) {
      const entry = sessions.get(sessionId);
      if (entry.kind !== 'http') {
        res.status(400).json({
          jsonrpc: '2.0',
          error: {
            code: -32000,
            message: 'Session uses SSE; POST to /messages?sessionId=',
          },
          id: null,
        });
        return;
      }
      await entry.transport.handleRequest(req, res, req.body);
      return;
    }
    if (!sessionId && req.method === 'POST' && isInitializeRequest(req.body)) {
      const server = createServer();
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sid) => {
          sessions.set(sid, { kind: 'http', transport, server });
          console.log(`http session ${sid}`);
        },
      });
      transport.onclose = () => {
        const sid = transport.sessionId;
        if (sid && sessions.has(sid)) sessions.delete(sid);
      };
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
      return;
    }
    res.status(sessionId ? 404 : 400).json({
      jsonrpc: '2.0',
      error: {
        code: -32000,
        message: sessionId
          ? 'Unknown or expired Mcp-Session-Id'
          : 'Bad Request: expected InitializeRequest or valid Mcp-Session-Id',
      },
      id: null,
    });
  } catch (error) {
    console.error('MCP error:', error);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: '2.0',
        error: { code: -32603, message: 'Internal server error' },
        id: null,
      });
    }
  }
}

app.post('/mcp', handleMcp);
app.get('/mcp', handleMcp);
app.delete('/mcp', handleMcp);

app.get('/sse', async (_req, res) => {
  try {
    const server = createServer();
    const transport = new SSEServerTransport('/messages', res);
    sessions.set(transport.sessionId, { kind: 'sse', transport, server });
    console.log(`sse session ${transport.sessionId}`);
    res.on('close', () => {
      sessions.delete(transport.sessionId);
      server.close().catch(() => {});
    });
    await server.connect(transport);
  } catch (error) {
    console.error('SSE error:', error);
    if (!res.headersSent) res.status(500).end('SSE failed');
  }
});

app.post('/messages', async (req, res) => {
  const sessionId = req.query.sessionId;
  const entry = sessionId ? sessions.get(String(sessionId)) : null;
  if (!entry || entry.kind !== 'sse') {
    res.status(400).json({
      jsonrpc: '2.0',
      error: {
        code: -32000,
        message: 'No SSE session — open GET /sse first',
      },
      id: null,
    });
    return;
  }
  try {
    await entry.transport.handlePostMessage(req, res, req.body);
  } catch (error) {
    console.error('SSE message error:', error);
    if (!res.headersSent) res.status(500).end('message failed');
  }
});

export function startHttpServer() {
  return new Promise((resolve, reject) => {
    const httpServer = app.listen(PORT, '127.0.0.1', (err) => {
      if (err) return reject(err);
      console.log(`chatbots-editreadmcp on http://127.0.0.1:${PORT}/mcp`);
      console.log(`  also SSE: http://127.0.0.1:${PORT}/sse`);
      console.log(`Workspace: ${ROOT}`);
      if (process.env.MCP_NO_AUTH === '1') {
        console.log('AUTH: DISABLED (MCP_NO_AUTH=1)');
      } else {
        console.log(`API key: ${apiKey}`);
      }
      resolve({ httpServer, port: PORT, apiKey, root: ROOT });
    });
  });
}

const entry = process.argv[1] && path.resolve(process.argv[1]);
const thisFile = fileURLToPath(import.meta.url);
if (entry && entry === thisFile) {
  startHttpServer().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
