import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export const API_KEY_PREFIX = 'omp-mcp-';

const HOME = os.homedir();
const DEFAULT_DATA = path.join(HOME, '.chatbots-omp-as-mcp');
const LEGACY_DATA = path.join(HOME, '.chatgpt-omp-as-mcp');

export const DATA_DIR = process.env.MCP_DATA_DIR
  ? path.resolve(process.env.MCP_DATA_DIR)
  : fs.existsSync(DEFAULT_DATA)
    ? DEFAULT_DATA
    : fs.existsSync(LEGACY_DATA)
      ? LEGACY_DATA
      : DEFAULT_DATA;

export const ENV_FILE = path.join(DATA_DIR, '.env');

export function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  } else {
    try {
      fs.chmodSync(DATA_DIR, 0o700);
    } catch {
      /* best-effort */
    }
  }
}

export function loadEnvFile(filePath = ENV_FILE) {
  if (!fs.existsSync(filePath)) return;
  const text = fs.readFileSync(filePath, 'utf8');
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = val;
  }
}

function generateApiKey() {
  const raw = crypto
    .randomBytes(12)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
  return API_KEY_PREFIX + raw;
}

export function readApiKey() {
  const v = process.env.MCP_API_KEY;
  return v && v.length > 0 ? v : null;
}

export function ensureApiKey() {
  const existing = readApiKey();
  if (existing) return existing;
  ensureDataDir();
  const key = generateApiKey();
  let content = fs.existsSync(ENV_FILE) ? fs.readFileSync(ENV_FILE, 'utf8') : '';
  const re = /^#?\s*MCP_API_KEY=.*$/m;
  const line = `MCP_API_KEY=${key}`;
  if (re.test(content)) content = content.replace(re, line);
  else content = content.trimEnd() + (content ? '\n' : '') + line + '\n';
  fs.writeFileSync(ENV_FILE, content, { mode: 0o600 });
  process.env.MCP_API_KEY = key;
  return key;
}

export function isValidApiKey(provided) {
  const expected = readApiKey();
  if (!expected || !provided) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(String(provided));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export function extractBearer(authorizationHeader) {
  if (!authorizationHeader) return null;
  const m = String(authorizationHeader).match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}
