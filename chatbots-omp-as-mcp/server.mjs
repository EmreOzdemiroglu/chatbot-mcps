#!/usr/bin/env node
/**
 * chatbots-omp-as-mcp — ChatGPT/Grok → full local Oh My Pi agent
 * Streamable HTTP: /mcp
 * Legacy SSE: GET /sse + POST /messages?sessionId=
 */
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import {
  ensureApiKey,
  extractBearer,
  isValidApiKey,
  loadEnvFile,
  ensureDataDir,
  ENV_FILE,
  readApiKey,
  DATA_DIR,
  API_KEY_PREFIX,
} from './lib/auth.mjs';
import {
  listModels,
  ompStatus,
  resolveRoot,
  runOmpPrompt,
} from './lib/omp.mjs';

ensureDataDir();
loadEnvFile(ENV_FILE);
loadEnvFile(path.join(path.dirname(fileURLToPath(import.meta.url)), '.env'));
const apiKey = ensureApiKey();

const PORT = parseInt(process.env.PORT || '7879', 10);
const ROOT = resolveRoot();

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

function createServer() {
  const server = new McpServer({
    name: 'chatbots-omp-as-mcp',
    version: '0.1.0',
  });

  server.registerTool(
    'omp_status',
    {
      title: 'OMP status',
      description: 'Binary path, workspace root, roles, timeouts.',
      inputSchema: {},
    },
    async () => textResult(ompStatus()),
  );

  server.registerTool(
    'list_models',
    {
      title: 'List OMP models',
      description:
        'Show modelRoles from ~/.omp/agent/config.yml, local models.yml entries, and suggested --model strings you can pass to omp_prompt.',
      inputSchema: {},
    },
    async () => textResult(listModels()),
  );

  server.registerTool(
    'omp_prompt',
    {
      title: 'Run Oh My Pi agent',
      description:
        'Hand a task to the FULL local OMP coding agent (bash, edit, browser, git, skills, subagents…). ' +
        'Use for multi-step work. Pass model to pick Grok/GPT/Gemini/local/etc. Omit model for OMP default. ' +
        'Can take minutes. Prefer this over ChatGPT inventing shell steps itself.',
      inputSchema: {
        prompt: z
          .string()
          .describe(
            'Full task: goals, paths, constraints, definition of done.',
          ),
        cwd: z
          .string()
          .optional()
          .describe('Workdir relative to MCP_ROOT (default root)'),
        model: z
          .string()
          .optional()
          .describe(
            'OMP --model fuzzy id, e.g. grok-4.5, gpt-5.5, gemini-3.5-flash, or provider/id',
          ),
        thinking: z
          .enum(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'auto'])
          .optional(),
        timeout_sec: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('Default 600, max 1800'),
        continue_session: z
          .boolean()
          .optional()
          .describe('Continue last OMP session in that cwd'),
        append_system: z
          .string()
          .optional()
          .describe('Extra system prompt text for this run'),
      },
    },
    async (args) => {
      try {
        const result = await runOmpPrompt({
          prompt: args.prompt,
          cwd: args.cwd || '.',
          model: args.model,
          thinking: args.thinking,
          timeout_sec: args.timeout_sec,
          continue_session: !!args.continue_session,
          no_session: !args.continue_session,
          append_system: args.append_system,
        });
        if (!result.ok) {
          return {
            isError: true,
            content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          };
        }
        const body = [
          result.stdout || '(no stdout)',
          '',
          '---',
          `omp ok model=${result.model} code=${result.code} duration_ms=${result.duration_ms} cwd=${result.cwd}`,
        ].join('\n');
        return { content: [{ type: 'text', text: body }] };
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.registerTool(
    'omp_continue',
    {
      title: 'Continue OMP session',
      description:
        'Same as omp_prompt with continue_session=true (multi-turn memory in that cwd).',
      inputSchema: {
        prompt: z.string(),
        cwd: z.string().optional(),
        model: z.string().optional(),
        thinking: z
          .enum(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'auto'])
          .optional(),
        timeout_sec: z.number().int().positive().optional(),
      },
    },
    async (args) => {
      try {
        const result = await runOmpPrompt({
          prompt: args.prompt,
          cwd: args.cwd || '.',
          model: args.model,
          thinking: args.thinking,
          timeout_sec: args.timeout_sec,
          continue_session: true,
          no_session: false,
        });
        if (!result.ok) {
          return {
            isError: true,
            content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          };
        }
        const body = [
          result.stdout || '(no stdout)',
          '',
          '---',
          `omp continue ok model=${result.model} duration_ms=${result.duration_ms}`,
        ].join('\n');
        return { content: [{ type: 'text', text: body }] };
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
    name: 'chatbots-omp-as-mcp',
    kind: 'omp-agent',
    root: ROOT,
    data_dir: DATA_DIR,
    transports: ['/mcp', '/sse', '/messages'],
    auth: process.env.MCP_NO_AUTH === '1' ? false : !!readApiKey(),
    no_auth: process.env.MCP_NO_AUTH === '1',
  });
});

app.get('/', (_req, res) => {
  res.type('html').send(`<!doctype html>
<html><body style="font:14px system-ui;max-width:640px;margin:2rem auto">
<h1>chatbots-omp-as-mcp</h1>
<p>Full Oh My Pi agent for ChatGPT &amp; Grok. Root: <code>${ROOT}</code></p>
<ul>
  <li><b>Streamable HTTP</b>: <code>/mcp</code></li>
  <li><b>Legacy SSE</b>: <code>/sse</code> + <code>/messages</code></li>
</ul>
<p>Tools: omp_status, list_models, omp_prompt, omp_continue</p>
<p>Auth: ${process.env.MCP_NO_AUTH === '1' ? '<b>DISABLED</b>' : 'Bearer'}</p>
</body></html>`);
});

app.use((req, res, next) => {
  if (req.method === 'GET' && (req.path === '/' || req.path === '/health')) {
    return next();
  }
  if (process.env.MCP_NO_AUTH === '1') return next();

  const parts = req.path.split('/');
  const pathKey = parts[2];

  const provided = pathKey && pathKey.startsWith(API_KEY_PREFIX)
    ? pathKey
    : extractBearer(req.header('authorization')) || req.header('x-api-key');

  if (isValidApiKey(provided)) {
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
        if (sid) sessions.delete(sid);
      };
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
      return;
    }
    res.status(sessionId ? 404 : 400).json({
      jsonrpc: '2.0',
      error: {
        code: -32000,
        message: sessionId ? 'Unknown session' : 'Expected InitializeRequest or session',
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
      console.log(`chatbots-omp-as-mcp on http://127.0.0.1:${PORT}/mcp`);
      console.log(`  also SSE: http://127.0.0.1:${PORT}/sse`);
      console.log(`Workspace: ${ROOT}`);
      console.log(`Data dir:  ${DATA_DIR}`);
      if (process.env.MCP_NO_AUTH === '1') {
        console.log('AUTH: DISABLED (MCP_NO_AUTH=1) — public tunnel OPEN');
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
