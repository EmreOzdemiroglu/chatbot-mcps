import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const DEFAULT_TIMEOUT_SEC = 600;
const MAX_TIMEOUT_SEC = 30 * 60;
const MAX_OUT = 350_000;

export function resolveRoot() {
  return path.resolve(process.env.MCP_ROOT || process.cwd());
}

export function resolveOmpBin() {
  const fromEnv = process.env.MCP_OMP_BIN;
  if (fromEnv && fs.existsSync(fromEnv)) return fromEnv;
  const local = path.join(os.homedir(), '.local/bin/omp');
  if (fs.existsSync(local)) return local;
  return fromEnv || 'omp';
}

function clampTimeout(sec) {
  const n = Number(sec);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_TIMEOUT_SEC;
  return Math.min(Math.floor(n), MAX_TIMEOUT_SEC);
}

/**
 * cwd under MCP_ROOT unless MCP_OMP_ALLOW_ANY_CWD=1.
 */
export function resolveOmpCwd(userCwd) {
  const root = resolveRoot();
  if (!userCwd || String(userCwd).trim() === '' || userCwd === '.') {
    return root;
  }
  if (process.env.MCP_OMP_ALLOW_ANY_CWD === '1') {
    return path.resolve(String(userCwd));
  }
  const candidate = path.isAbsolute(userCwd)
    ? path.resolve(userCwd)
    : path.resolve(root, userCwd);
  const rel = path.relative(root, candidate);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`cwd escapes MCP_ROOT: ${userCwd}`);
  }
  return candidate;
}

function readYamlishRoles() {
  const cfg = path.join(os.homedir(), '.omp/agent/config.yml');
  if (!fs.existsSync(cfg)) return {};
  const text = fs.readFileSync(cfg, 'utf8');
  const roles = {};
  let inRoles = false;
  for (const line of text.split('\n')) {
    if (/^modelRoles\s*:/.test(line)) {
      inRoles = true;
      continue;
    }
    if (inRoles) {
      if (/^\S/.test(line) && !/^\s/.test(line)) break;
      const m = line.match(/^\s+([a-zA-Z0-9_]+)\s*:\s*(.+)$/);
      if (m) roles[m[1]] = m[2].trim().replace(/^['"]|['"]$/g, '');
    }
  }
  return roles;
}

function readModelsYmlProviders() {
  const p = path.join(os.homedir(), '.omp/agent/models.yml');
  if (!fs.existsSync(p)) return [];
  const text = fs.readFileSync(p, 'utf8');
  const models = [];
  let provider = null;
  for (const line of text.split('\n')) {
    const prov = line.match(/^  ([a-zA-Z0-9_-]+)\s*:\s*$/);
    if (prov && !line.includes('models')) {
      // only top-level under providers - heuristic
    }
    const top = line.match(/^  ([a-zA-Z0-9_-]+):\s*$/);
    if (top && line.startsWith('  ') && !line.startsWith('    ')) {
      provider = top[1];
    }
    const id = line.match(/^\s+- id:\s*(.+)$/);
    if (id && provider) {
      models.push({
        provider,
        id: id[1].trim(),
        ref: `${provider}/${id[1].trim()}`,
      });
    }
  }
  return models;
}

/**
 * Curated list ChatGPT can pick from (roles + local providers + hints).
 */
export function listModels() {
  const roles = readYamlishRoles();
  const local = readModelsYmlProviders();
  const suggested = [
    { id: 'grok-4.5', note: 'fuzzy → xai grok (typical default)' },
    { id: 'gpt-5.5', note: 'fuzzy → openai-codex / slow role' },
    { id: 'gemini-3.5-flash', note: 'fuzzy → antigravity flash / smol' },
    { id: 'gemini-3.1-pro', note: 'fuzzy → designer-ish' },
    { id: 'opus', note: 'fuzzy Anthropic if configured' },
    { id: 'sonnet', note: 'fuzzy Anthropic if configured' },
  ];

  return {
    omp_bin: resolveOmpBin(),
    default_model_env: process.env.MCP_OMP_DEFAULT_MODEL || null,
    roles_from_config: roles,
    local_models_yml: local.slice(0, 40),
    suggested_model_args: suggested,
    how_to_select:
      'Pass model to omp_prompt (fuzzy match). Omit to use OMP config default role (usually modelRoles.default).',
    examples: [
      'omp_prompt({ prompt: "…", model: "grok-4.5" })',
      'omp_prompt({ prompt: "…", model: "gpt-5.5", thinking: "high" })',
      'omp_prompt({ prompt: "…", model: "gemini-3.5-flash" })',
      'omp_prompt({ prompt: "…", model: "xai-oauth/grok-4.5" })',
    ],
  };
}

export function runOmpPrompt({
  prompt,
  cwd,
  timeout_sec,
  continue_session = false,
  no_session = true,
  model,
  thinking,
  approval_mode = 'yolo',
  append_system,
} = {}) {
  if (!prompt || !String(prompt).trim()) {
    return Promise.reject(new Error('prompt is required'));
  }

  const bin = resolveOmpBin();
  const workdir = resolveOmpCwd(cwd);
  const maxTime = clampTimeout(
    timeout_sec ?? process.env.MCP_OMP_TIMEOUT_SEC ?? DEFAULT_TIMEOUT_SEC,
  );

  const effectiveModel =
    model || process.env.MCP_OMP_DEFAULT_MODEL || undefined;

  const args = ['-p', '--auto-approve'];
  if (approval_mode) args.push('--approval-mode', String(approval_mode));
  args.push('--cwd', workdir);
  args.push('--max-time', String(maxTime));

  if (continue_session) args.push('--continue');
  else if (no_session !== false) args.push('--no-session');

  if (effectiveModel) args.push('--model', String(effectiveModel));
  if (thinking) args.push('--thinking', String(thinking));
  if (append_system) args.push('--append-system-prompt', String(append_system));

  args.push(String(prompt));

  const started = Date.now();
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let killed = false;

    const child = spawn(bin, args, {
      cwd: workdir,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const timer = setTimeout(
      () => {
        killed = true;
        try {
          child.kill('SIGTERM');
        } catch {
          /* ignore */
        }
        setTimeout(() => {
          try {
            child.kill('SIGKILL');
          } catch {
            /* ignore */
          }
        }, 5000).unref();
      },
      (maxTime + 30) * 1000,
    );

    child.stdout.on('data', (d) => {
      stdout += d.toString();
      if (stdout.length > MAX_OUT)
        stdout = stdout.slice(0, MAX_OUT) + '\n…[truncated]';
    });
    child.stderr.on('data', (d) => {
      stderr += d.toString();
      if (stderr.length > MAX_OUT / 2)
        stderr = stderr.slice(0, MAX_OUT / 2) + '\n…[truncated]';
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({
        ok: false,
        error: err.message,
        bin,
        cwd: workdir,
        model: effectiveModel || '(omp default)',
        args,
        duration_ms: Date.now() - started,
      });
    });

    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({
        ok: code === 0 && !killed,
        code,
        signal: signal || null,
        timed_out: killed,
        bin,
        cwd: workdir,
        model: effectiveModel || '(omp default)',
        max_time_sec: maxTime,
        duration_ms: Date.now() - started,
        stdout: stdout.trimEnd(),
        stderr: stderr.trimEnd(),
      });
    });
  });
}

export function ompStatus() {
  const bin = resolveOmpBin();
  return {
    bin,
    bin_exists: bin.includes(path.sep) ? fs.existsSync(bin) : true,
    root: resolveRoot(),
    default_timeout_sec: clampTimeout(process.env.MCP_OMP_TIMEOUT_SEC),
    default_model_env: process.env.MCP_OMP_DEFAULT_MODEL || null,
    allow_any_cwd: process.env.MCP_OMP_ALLOW_ANY_CWD === '1',
    roles: readYamlishRoles(),
  };
}
