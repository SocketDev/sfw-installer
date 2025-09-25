import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { getJSON } from './http.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_OWNER = 'SocketDev';
const REPO_NAME = 'sfw-free';
const LATEST_API = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/releases/latest`;

const PACKAGE_VERSION = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'),
).version;
const USER_AGENT = `sfw-free/${PACKAGE_VERSION}`;

function mapPlatform() {
  // Only windows, macos, and linux are published (per spec)
  switch (process.platform) {
    case 'darwin':
      return 'macos';
    case 'win32':
      return 'windows';
    case 'linux':
      return 'linux';
    default:
      return process.platform; // unknown (will fail later if no asset)
  }
}

function mapArch() {
  // Only x86_64 and arm64 are published (per spec)
  switch (process.arch) {
    case 'x64':
      return 'x86_64';
    case 'arm64':
      return 'arm64';
    default:
      return process.arch; // unknown (will fail later if no asset)
  }
}

export function expectedAssetName() {
  const plat = mapPlatform();
  const arch = mapArch();
  if (plat === 'windows' && arch === 'x86_64') return 'sfw-free-windows-x86_64.exe';
  if (plat === 'macos' && (arch === 'arm64' || arch === 'x86_64')) return `sfw-free-macos-${arch}`;
  if (plat === 'linux' && arch === 'x86_64') return 'sfw-free-linux-x86_64';
  // If we get here, there's no published combo
  throw new Error(`No published asset for ${process.platform}/${process.arch}`);
}

export interface Asset {
  name: string;
  browser_download_url: string;
  digest: string;
}

export type Assets = Asset[];

export interface LatestRelease {
  tag: string;
  name: string;
  assets: Assets;
}

export async function fetchLatest(): Promise<LatestRelease> {
  const json = await getJSON(LATEST_API, { userAgent: USER_AGENT });
  return {
    tag: json.tag_name,
    name: json.name || json.tag_name,
    assets: Array.isArray(json.assets) ? json.assets : [],
  };
}

export function findAssetUrl(
  assets: Array<{ name: string; browser_download_url: string; digest: string }>,
  name: string,
): { browser_download_url: string; digest: string } | null {
  const a = assets.find((x) => x.name === name);
  if (!a) {
    return null;
  }
  return {
    browser_download_url: a.browser_download_url,
    digest: a.digest, // e.g. "sha256:$HEX..."
  };
}
