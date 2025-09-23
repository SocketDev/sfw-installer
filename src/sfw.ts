#!/usr/bin/env node

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { expectedAssetName, fetchLatest, findAssetUrl, type LatestRelease } from './github.ts';
import { eagerAcquireLockAndDownload } from './resumable.ts';
import { swallowError } from './util.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const NEXT_CHECK_FILE = '.sfw-cache/next-check';
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

// Handles both global and npx temporary installs.
const INSTALL_ROOT = path.resolve(__dirname, '..');
const NEXT_CHECK_PATH = path.join(INSTALL_ROOT, NEXT_CHECK_FILE);
const LATEST_SYMLINK_PATH = path.join(INSTALL_ROOT, '.sfw-cache', 'latest');

interface LatestBinary {
  tag: string;
  bin: string;
}

function findValidCachedReleaseSync(): string | null {
  const symlinkPath = LATEST_SYMLINK_PATH;
  try {
    if (fs.existsSync(symlinkPath)) {
      const binPath = fs.realpathSync(symlinkPath);
      if (fs.existsSync(binPath)) {
        return binPath;
      }
    }
  } catch {}
  return null;
}

function getCachePaths(releaseName: string, assetName: string) {
  const cacheDir = path.join(INSTALL_ROOT, '.sfw-cache', releaseName);
  const assetPath = path.join(cacheDir, assetName);
  return { cacheDir, assetPath };
}

function shouldCheckForUpdate() {
  try {
    const data = fs.readFileSync(NEXT_CHECK_PATH, 'utf8');
    const nextCheck = Date.parse(data.trim());
    if (Number.isNaN(nextCheck)) {
      return true;
    }
    return Date.now() > nextCheck;
  } catch {
    return true;
  }
}

function setNextCheckTimeSync() {
  const nextCheck = Date.now() + ONE_DAY_MS;
  fs.mkdirSync(path.dirname(NEXT_CHECK_PATH), { recursive: true });
  fs.writeFileSync(NEXT_CHECK_PATH, new Date(nextCheck).toISOString());
}

function tryClearQuarantine(p: string): void {
  if (process.platform !== 'darwin') return;
  spawnSync('xattr', ['-d', 'com.apple.quarantine', p], { stdio: 'ignore' });
}

function ensureExecutable(p: string): void {
  if (process.platform !== 'win32') {
    swallowError(() => fs.chmodSync(p, 0o755));
  }
}

function removeSymlink(symlinkPath: string) {
  try {
    // Does not follow symlink. Will throw if the file does not exist.
    fs.lstatSync(symlinkPath);
    fs.unlinkSync(symlinkPath);
    // biome-ignore lint/suspicious/noExplicitAny: safe to use in this context
  } catch (err: any) {
    if (err?.code !== 'ENOENT') {
      throw err;
    }
  }
}

function trySymlinkLatest(assetPath: string) {
  try {
    const previousBin = swallowError(() => fs.realpathSync(LATEST_SYMLINK_PATH));
    // Remove previously newest version (symlink target) if it exists and is different
    if (previousBin && previousBin !== assetPath) {
      swallowError(() => fs.rmSync(path.dirname(previousBin), { recursive: true, force: true }));
    }
    removeSymlink(LATEST_SYMLINK_PATH);
    fs.symlinkSync(assetPath, LATEST_SYMLINK_PATH);
  } catch (e) {
    console.error('Failed to create latest symlink:', e);
  }
}

async function downloadAndVerifyReleaseSync(
  {
    name,
    assets,
  }: {
    name: string;
    assets: Array<{ name: string; browser_download_url: string; digest: string }>;
  },
  assetName: string,
): Promise<LatestBinary> {
  const { cacheDir, assetPath } = getCachePaths(name, assetName);
  fs.mkdirSync(cacheDir, { recursive: true });

  const binUrl = findAssetUrl(assets, assetName);
  if (!binUrl) {
    throw new Error(`Latest release does not contain asset ${assetName}`);
  }

  const [algo, hex] = binUrl.digest.trim().toLowerCase().split(/:/);
  if (!algo || !hex) {
    throw new Error('Invalid digest in release asset');
  }

  // If the binary for this release already exists, do not overwrite
  if (fs.existsSync(assetPath)) {
    return { tag: name, bin: assetPath };
  }

  await eagerAcquireLockAndDownload(binUrl.browser_download_url, assetPath, algo, hex);
  ensureExecutable(assetPath);
  tryClearQuarantine(assetPath);
  trySymlinkLatest(assetPath);

  return { tag: name, bin: assetPath };
}

async function ensureLatestBinary(): Promise<LatestBinary> {
  const assetName = expectedAssetName();
  let releaseInfo: LatestRelease;
  const cached = findValidCachedReleaseSync();
  const shouldUpdate = !cached || shouldCheckForUpdate();

  if (!cached) {
    // No cached binary, must block and download
    setNextCheckTimeSync();
    try {
      releaseInfo = await fetchLatest();
    } catch (_e) {
      throw new Error('Unable to fetch latest release and no valid cached release found.');
    }
    return await downloadAndVerifyReleaseSync(releaseInfo, assetName);
  }

  if (shouldUpdate) {
    // Cached binary exists, lazily download new release in background
    setNextCheckTimeSync();

    await swallowError(async () => {
      const latest = await fetchLatest();
      await downloadAndVerifyReleaseSync(latest, assetName);
    });
  }
  return { tag: 'cached', bin: cached };
}

async function main() {
  // Usage: `sfw npm install ...` or even `npx @socketsecurity/sfw-lite npm install ...`
  const [, , ...argv] = process.argv;

  let latestBinary: LatestBinary;
  try {
    latestBinary = await ensureLatestBinary();
  } catch (e) {
    if (e instanceof Error) {
      console.error(`[sfw] Failed to prepare firewall binary: ${e.message}`);
    } else {
      console.error(`[sfw] Failed to prepare firewall binary: ${String(e)}`);
    }
    process.exit(1);
  }

  const child = spawn(latestBinary.bin, argv, { stdio: 'inherit', env: process.env });
  child.on('exit', (code, signal) => {
    if (signal) {
      return swallowError(() => process.kill(process.pid, signal));
    }
    process.exit(code ?? 0);
  });
  child.on('error', (_err) => {
    process.exit(1);
  });
}

main().catch((e) => {
  console.error(e.stack || e.message || String(e));
  process.exit(1);
});
