import fs from 'node:fs/promises';
import fssync from 'node:fs';
import path from 'node:path';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { execSync, spawn } from 'node:child_process';

const DEFAULT_MAX_READ = 512 * 1024;

export function resolveRoot() {
  const raw = process.env.MCP_ROOT || process.cwd();
  return path.resolve(raw);
}

/**
 * Resolve a user path against the workspace root and reject escapes.
 * Returns absolute path inside the root.
 */
export function resolveSafe(userPath, root = resolveRoot()) {
  if (userPath == null || String(userPath).trim() === '') {
    throw new Error('path is required');
  }
  const input = String(userPath);
  // Absolute paths are re-rooted only if they already sit under root.
  const candidate = path.isAbsolute(input)
    ? path.resolve(input)
    : path.resolve(root, input);

  const rel = path.relative(root, candidate);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`path escapes workspace root: ${input}`);
  }
  // Block null bytes / weird separators
  if (candidate.includes('\0')) throw new Error('invalid path');
  return candidate;
}

export function toRelative(absPath, root = resolveRoot()) {
  const rel = path.relative(root, absPath);
  return rel === '' ? '.' : rel;
}

function maxReadBytes() {
  const n = parseInt(process.env.MCP_MAX_READ_BYTES || '', 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_READ;
}

export async function listDir(userPath = '.', { includeHidden = false } = {}) {
  const root = resolveRoot();
  const abs = resolveSafe(userPath, root);
  const st = await fs.stat(abs);
  if (!st.isDirectory()) throw new Error(`not a directory: ${userPath}`);

  const entries = await fs.readdir(abs, { withFileTypes: true });
  const rows = [];
  for (const ent of entries) {
    if (!includeHidden && ent.name.startsWith('.')) continue;
    const full = path.join(abs, ent.name);
    let size = null;
    let type = 'other';
    if (ent.isDirectory()) type = 'dir';
    else if (ent.isFile()) type = 'file';
    else if (ent.isSymbolicLink()) type = 'symlink';
    try {
      if (ent.isFile()) size = (await fs.stat(full)).size;
    } catch {
      /* ignore broken symlinks */
    }
    rows.push({
      name: ent.name,
      path: toRelative(full, root),
      type,
      size,
    });
  }
  rows.sort((a, b) => {
    if (a.type === 'dir' && b.type !== 'dir') return -1;
    if (a.type !== 'dir' && b.type === 'dir') return 1;
    return a.name.localeCompare(b.name);
  });
  return { root, path: toRelative(abs, root), entries: rows };
}

export async function readFile(userPath, { offset, limit } = {}) {
  const root = resolveRoot();
  const abs = resolveSafe(userPath, root);
  const st = await fs.stat(abs);
  if (!st.isFile()) throw new Error(`not a file: ${userPath}`);

  const maxBytes = maxReadBytes();
  if (st.size > maxBytes && offset == null && limit == null) {
    // Auto-paginate large files: first chunk + hint
    const fd = await fs.open(abs, 'r');
    try {
      const buf = Buffer.alloc(Math.min(maxBytes, st.size));
      const { bytesRead } = await fd.read(buf, 0, buf.length, 0);
      const text = buf.subarray(0, bytesRead).toString('utf8');
      return {
        path: toRelative(abs, root),
        size: st.size,
        truncated: true,
        note: `File is ${st.size} bytes; returned first ${bytesRead} bytes. Use offset/limit (1-based lines) to page.`,
        content: text,
      };
    } finally {
      await fd.close();
    }
  }

  // Line-based paging when offset/limit provided
  if (offset != null || limit != null) {
    const start = Math.max(1, offset ?? 1);
    const maxLines = limit ?? 200;
    const lines = [];
    let lineNo = 0;
    let truncated = false;
    const rl = createInterface({
      input: createReadStream(abs, { encoding: 'utf8' }),
      crlfDelay: Infinity,
    });
    for await (const line of rl) {
      lineNo += 1;
      if (lineNo < start) continue;
      if (lines.length >= maxLines) {
        truncated = true;
        break;
      }
      lines.push(`${lineNo}:${line}`);
    }
    return {
      path: toRelative(abs, root),
      size: st.size,
      offset: start,
      limit: maxLines,
      truncated,
      content: lines.join('\n'),
    };
  }

  if (st.size > maxBytes) {
    throw new Error(
      `file too large (${st.size} bytes > ${maxBytes}). Raise MCP_MAX_READ_BYTES or use offset/limit.`,
    );
  }
  const content = await fs.readFile(abs, 'utf8');
  return {
    path: toRelative(abs, root),
    size: st.size,
    truncated: false,
    content,
  };
}

export async function writeFile(userPath, content, { createDirs = true } = {}) {
  const root = resolveRoot();
  const abs = resolveSafe(userPath, root);
  if (createDirs) await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content, 'utf8');
  const st = await fs.stat(abs);
  return {
    path: toRelative(abs, root),
    size: st.size,
    bytes_written: Buffer.byteLength(content, 'utf8'),
  };
}

/**
 * Apply a single exact string replacement (first occurrence, or all if replaceAll).
 */
export async function editFile(
  userPath,
  { old_string, new_string, replace_all = false },
) {
  if (typeof old_string !== 'string' || typeof new_string !== 'string') {
    throw new Error('old_string and new_string are required strings');
  }
  if (old_string.length === 0) throw new Error('old_string must not be empty');

  const root = resolveRoot();
  const abs = resolveSafe(userPath, root);
  const before = await fs.readFile(abs, 'utf8');
  if (!before.includes(old_string)) {
    throw new Error('old_string not found in file');
  }
  let after;
  let count = 0;
  if (replace_all) {
    after = before.split(old_string).join(new_string);
    count = before.split(old_string).length - 1;
  } else {
    after = before.replace(old_string, new_string);
    count = 1;
  }
  await fs.writeFile(abs, after, 'utf8');
  return {
    path: toRelative(abs, root),
    replacements: count,
    bytes_before: Buffer.byteLength(before, 'utf8'),
    bytes_after: Buffer.byteLength(after, 'utf8'),
  };
}

export async function mkdir(userPath) {
  const root = resolveRoot();
  const abs = resolveSafe(userPath, root);
  await fs.mkdir(abs, { recursive: true });
  return { path: toRelative(abs, root), created: true };
}

export async function deletePath(userPath, { recursive = false } = {}) {
  const root = resolveRoot();
  const abs = resolveSafe(userPath, root);
  if (abs === root) throw new Error('refusing to delete workspace root');
  await fs.rm(abs, { recursive, force: false });
  return { path: toRelative(abs, root), deleted: true };
}

/**
 * Recursive text search under a directory. Simple and bounded.
 */
function matchGlob(name, fullPath, glob) {
  if (!glob) return true;
  const braceMatch = glob.match(/^(.*)\{(.*)\}(.*)$/);
  if (braceMatch) {
    const prefix = braceMatch[1];
    const middle = braceMatch[2].split(',');
    const suffix = braceMatch[3];
    return middle.some((m) => {
      const g = `${prefix}${m}${suffix}`;
      return matchSingleGlob(name, fullPath, g);
    });
  }
  return matchSingleGlob(name, fullPath, glob);
}

function matchSingleGlob(name, fullPath, glob) {
  if (glob.startsWith('*.')) {
    return name.endsWith(glob.slice(1));
  }
  return name.includes(glob) || fullPath.includes(glob);
}

let hasRg = null;
function checkRg() {
  if (hasRg !== null) return hasRg;
  try {
    execSync('command -v rg', { stdio: 'ignore' });
    hasRg = true;
  } catch {
    hasRg = false;
  }
  return hasRg;
}

/**
 * Recursive text search under a directory. Uses ripgrep if available.
 */
export async function searchText({
  query,
  path: userPath = '.',
  glob: globFilter = null,
  max_results = 50,
  case_sensitive = false,
} = {}) {
  if (!query) throw new Error('query is required');
  const root = resolveRoot();
  const abs = resolveSafe(userPath, root);
  const max = Math.min(Math.max(1, max_results), 200);
  const results = [];

  // --- Ripgrep Mode ---
  if (checkRg()) {
    const relativeSearchPath = path.relative(root, abs) || '.';
    const args = [
      '--json',
      case_sensitive ? '' : '--ignore-case',
      '--fixed-strings',
      query,
      relativeSearchPath,
    ].filter(Boolean);

    if (globFilter) {
      args.push('-g', globFilter);
    }

    try {
      const child = spawn('rg', args, { cwd: root, env: process.env });
      const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });

      for await (const line of rl) {
        if (results.length >= max) {
          child.kill('SIGTERM');
          break;
        }
        try {
          const data = JSON.parse(line);
          if (data.type === 'match') {
            results.push({
              path: data.data.path.text,
              line: data.data.line_number,
              text: data.data.lines.text.slice(0, 400).replace(/\r?\n$/, ''),
            });
          }
        } catch {
          /* ignore bad json lines */
        }
      }

      return {
        query,
        path: toRelative(abs, root),
        count: results.length,
        truncated: results.length >= max,
        matches: results,
        engine: 'ripgrep',
      };
    } catch (e) {
      console.warn('Ripgrep failed, falling back to native search:', e.message);
    }
  }

  // --- Native Fallback Mode ---
  const needle = case_sensitive ? query : query.toLowerCase();

  async function walk(dir) {
    if (results.length >= max) return;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (results.length >= max) return;
      if (ent.name === 'node_modules' || ent.name === '.git') continue;
      if (ent.name.startsWith('.') && ent.name !== '.') continue;
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        await walk(full);
        continue;
      }
      if (!ent.isFile()) continue;
      if (globFilter && !matchGlob(ent.name, full, globFilter)) {
        continue;
      }
      let st;
      try {
        st = await fs.stat(full);
      } catch {
        continue;
      }
      if (st.size > 1024 * 1024) continue;
      let text;
      try {
        text = await fs.readFile(full, 'utf8');
      } catch {
        continue;
      }
      if (text.includes('\0')) continue;
      const lines = text.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        if (results.length >= max) break;
        const hay = case_sensitive ? lines[i] : lines[i].toLowerCase();
        if (hay.includes(needle)) {
          results.push({
            path: toRelative(full, root),
            line: i + 1,
            text: lines[i].slice(0, 400),
          });
        }
      }
    }
  }

  const st = await fs.stat(abs);
  if (st.isFile()) {
    const text = await fs.readFile(abs, 'utf8');
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      if (results.length >= max) break;
      const hay = case_sensitive ? lines[i] : lines[i].toLowerCase();
      if (hay.includes(needle)) {
        results.push({
          path: toRelative(abs, root),
          line: i + 1,
          text: lines[i].slice(0, 400),
        });
      }
    }
  } else {
    await walk(abs);
  }

  return {
    query,
    path: toRelative(abs, root),
    count: results.length,
    truncated: results.length >= max,
    matches: results,
    engine: 'native',
  };
}

export function workspaceInfo() {
  const root = resolveRoot();
  return {
    root,
    exists: fssync.existsSync(root),
    allow_shell: process.env.MCP_ALLOW_SHELL === '1',
  };
}
