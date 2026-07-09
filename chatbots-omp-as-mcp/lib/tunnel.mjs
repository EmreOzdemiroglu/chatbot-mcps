import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs';
import https from 'node:https';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_DIR = path.resolve(__dirname, '..');
const BIN_NAME = process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared';
const BUNDLED = path.join(PACKAGE_DIR, BIN_NAME);

export function resolveCloudflared() {
  if (fs.existsSync(BUNDLED)) {
    try {
      fs.accessSync(BUNDLED, fs.constants.X_OK);
      return BUNDLED;
    } catch {
      /* not executable */
    }
  }
  // Sibling editread install
  const sibling = path.resolve(
    PACKAGE_DIR,
    '..',
    'chatbots-editreadmcp',
    BIN_NAME,
  );
  if (fs.existsSync(sibling)) {
    try {
      fs.accessSync(sibling, fs.constants.X_OK);
      return sibling;
    } catch {
      /* ignore */
    }
  }
  try {
    const onPath = execSync(
      process.platform === 'win32' ? 'where cloudflared' : 'command -v cloudflared',
      { encoding: 'utf8' },
    )
      .trim()
      .split(/\r?\n/)[0];
    if (onPath) return onPath;
  } catch {
    /* not on PATH */
  }
  return null;
}

function downloadToFile(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    const get = (u) =>
      https
        .get(u, (response) => {
          if (response.statusCode === 301 || response.statusCode === 302) {
            response.resume();
            get(response.headers.location);
            return;
          }
          if (response.statusCode !== 200) {
            reject(new Error(`HTTP ${response.statusCode}`));
            response.resume();
            return;
          }
          response.pipe(file);
          file.on('finish', () => file.close(resolve));
        })
        .on('error', (err) => {
          fs.unlink(dest, () => {});
          reject(err);
        });
    get(url);
  });
}

export async function ensureCloudflared() {
  if (resolveCloudflared()) return resolveCloudflared();
  if (process.env.MCP_NO_DOWNLOAD_CLOUDFLARED) return null;

  const { platform, arch } = process;
  const archMap = { x64: 'amd64', arm64: 'arm64', ia32: '386' };
  const mappedArch = archMap[arch];
  if (!mappedArch) return null;

  let url;
  if (platform === 'darwin') {
    url = `https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-darwin-${mappedArch}.tgz`;
  } else if (platform === 'linux') {
    url = `https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${mappedArch}`;
  } else if (platform === 'win32') {
    url = `https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-${mappedArch}.exe`;
  } else {
    return null;
  }

  console.log('cloudflared: downloading…');
  try {
    if (url.endsWith('.tgz')) {
      const tarPath = path.join(PACKAGE_DIR, 'cloudflared.tgz');
      await downloadToFile(url, tarPath);
      execSync(`tar -xzf "${tarPath}" -C "${PACKAGE_DIR}"`);
      fs.unlinkSync(tarPath);
    } else {
      await downloadToFile(url, BUNDLED);
    }
    if (!fs.existsSync(BUNDLED) || fs.statSync(BUNDLED).size < 5 * 1024 * 1024) {
      throw new Error('downloaded binary failed size check');
    }
    if (platform !== 'win32') fs.chmodSync(BUNDLED, 0o755);
    console.log('cloudflared: installed.');
    return BUNDLED;
  } catch (e) {
    console.log(`cloudflared: download failed (${e.message}).`);
    return null;
  }
}

export function spawnTunnel(cloudflaredPath, port) {
  let urlFound = false;
  let publicUrl = null;
  const waiters = [];

  const child = spawn(
    cloudflaredPath,
    ['tunnel', '--url', `http://127.0.0.1:${port}`],
    { cwd: PACKAGE_DIR, stdio: ['ignore', 'pipe', 'pipe'] },
  );

  const onData = (data) => {
    const match = data
      .toString()
      .match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
    if (match && !urlFound) {
      urlFound = true;
      publicUrl = match[0];
      for (const w of waiters.splice(0)) w(publicUrl);
    }
  };
  child.stderr.on('data', onData);
  child.stdout.on('data', onData);
  child.on('close', (code) => {
    if (!urlFound) for (const w of waiters.splice(0)) w(null);
    if (code) console.log(`Tunnel exited with code ${code}`);
  });

  function waitForUrl(timeoutMs = 45_000) {
    if (publicUrl) return Promise.resolve(publicUrl);
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        const i = waiters.indexOf(resolve);
        if (i >= 0) waiters.splice(i, 1);
        resolve(null);
      }, timeoutMs);
      waiters.push((url) => {
        clearTimeout(t);
        resolve(url);
      });
    });
  }

  return { process: child, waitForUrl, get url() { return publicUrl; } };
}
