#!/usr/bin/env node

import type {IncomingMessage} from 'http';
import { eagerAcquireLockAndDownload } from './resumable.ts'

import https from "https"
import { URL } from "url"
import fs from "fs"
import path from "path"
import { spawn, spawnSync } from "child_process"

const REPO_OWNER = "SocketDev";
const REPO_NAME = "firewall-release";
const LATEST_API = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/releases/latest`;
const NEXT_CHECK_FILE = ".sfw-cache/next-check";
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

const PACKAGE_VERSION = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8")).version;
const USER_AGENT = `sfw-lite/${PACKAGE_VERSION}`;

//#! region HTTP Helpers from the before fetch era
/**
 * @param {Record<string, string>} headers
 * @param {number} maxRedirects
 * @returns {Promise<import("http").IncomingMessage>}
 */
function get(url: string, headers: Record<string, string> = {}, maxRedirects = 5): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const opts = {
      headers: {
        "User-Agent": USER_AGENT,
        ...headers
      }
    };
    https.get(u, opts, (res: IncomingMessage) => {
      const { statusCode, headers: h } = res;
      if (statusCode === undefined) {
        return reject(new Error(`GET ${url} failed with no status code`));
      }
      if (statusCode >= 300 && statusCode < 400 && h.location && maxRedirects > 0) {
        res.resume();
        return resolve(get(h.location, headers, maxRedirects - 1));
      }
      if (statusCode < 200 || statusCode >= 300) {
        res.resume();
        return reject(new Error(`GET ${url} failed with ${statusCode}`));
      }
      resolve(res);
    }).on("error", reject);
  });
}

/**
 * @param {string} url
 * @param {Record<string, string>} headers
 * @returns {Promise<string>}
 */
async function getText(url: string, headers = {}) {
  const res = await get(url, headers);
  return new Promise<string>((resolve, reject) => {
    let data = "";
    res.setEncoding("utf8");
    res.on("data", (c) => (data += c));
    res.on("end", () => resolve(data));
    res.on("error", reject);
  });
}

/**
 * @param {string} url
 * @param {Record<string, string>} headers
 * @returns {Promise<any>}
 */
async function getJSON(url: string, headers = {}) {
  const s = await getText(url, headers);
  return JSON.parse(s);
}

function findValidCachedReleaseSync(): {bin:string}|null {
  const symlinkPath = getLatestSymlinkPath();
  try {
    if (fs.existsSync(symlinkPath)) {
      const binPath = fs.realpathSync(symlinkPath);
      if (fs.existsSync(binPath)) {
        return { bin: binPath };
      }
    }
  } catch {}
  return null;
}
function mapPlatform() {
  // Only windows, macos, and linux are published (per spec)
  switch (process.platform) {
    case "darwin":
      return "macos";
    case "win32":
      return "windows";
    case "linux":
      return "linux";
    default:
      return process.platform; // unknown (will fail later if no asset)
  }
}

function mapArch() {
  // Only x86_64 and arm64 are published (per spec)
  switch (process.arch) {
    case "x64":
      return "x86_64";
    case "arm64":
      return "arm64";
    default:
      return process.arch; // unknown (will fail later if no asset)
  }
}

function expectedAssetName() {
  const plat = mapPlatform();
  const arch = mapArch();
  if (plat === "windows" && arch === "x86_64") return "sfw-windows-x86_64.exe";
  if (plat === "macos" && (arch === "arm64" || arch === "x86_64")) return `sfw-macos-${arch}`;
  if (plat === "linux" && arch === "x86_64") return "sfw-linux-x86_64";
  // If we get here, there's no published combo
  throw new Error(`No published asset for ${process.platform}/${process.arch}`);
}

function getInstallRoot() {
  // Handles both global and npx temporary installs.
  return path.resolve(__dirname, "..");
}

/**
 * 
 * @param {string} releaseName 
 * @param {string} assetName 
 * @returns {{
    cacheDir: string;
    assetPath: string;
 }}
 */
function getCachePaths(releaseName: string, assetName: string) {
  const root = getInstallRoot();
  const cacheDir = path.join(root, ".sfw-cache", releaseName);
  const assetPath = path.join(cacheDir, assetName);
  return { cacheDir, assetPath };
}

function getNextCheckPath() {
  return path.join(getInstallRoot(), NEXT_CHECK_FILE);
}

function shouldCheckForUpdate() {
  const nextCheckPath = getNextCheckPath();
  try {
    const data = fs.readFileSync(nextCheckPath, "utf8");
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
  const nextCheckPath = getNextCheckPath();
  const nextCheck = Date.now() + ONE_DAY_MS;
  fs.mkdirSync(path.dirname(nextCheckPath), { recursive: true });
  fs.writeFileSync(nextCheckPath, new Date(nextCheck).toISOString());
}

async function fetchLatest() {
  const json = await getJSON(LATEST_API);
  return {
    tag: json.tag_name,
    name: json.name || json.tag_name,
    assets: Array.isArray(json.assets) ? json.assets : []
  };
}

function findAssetUrl(
  assets: Array<{name:string,browser_download_url:string,digest:string}>,
  name: string
): {browser_download_url:string,digest:string}|null {
  const a = assets.find(x => x.name === name);
  if (!a) {
    return null
  }
  return {
    browser_download_url: a.browser_download_url,
    digest: a.digest // e.g. "sha256:$HEX..."
  }
}

function tryClearQuarantine(p: string): void {
  if (process.platform !== "darwin") return;
  spawnSync("xattr", ["-d", "com.apple.quarantine", p], { stdio: "ignore" });
}

function ensureExecutable(p: string): void {
  if (process.platform !== "win32") {
    try {
      fs.chmodSync(p, 0o755);
    } catch { /* ignore */ }
  }
}


function getLatestSymlinkPath() {
  return path.join(getInstallRoot(), ".sfw-cache", "latest");
}

async function downloadAndVerifyReleaseSync({ name, assets }: {name:string,assets:Array<{name:string,browser_download_url:string,digest:string}>}, assetName: string): Promise<{tag:string,bin:string}> {
  const { cacheDir, assetPath } = getCachePaths(name, assetName);
  fs.mkdirSync(cacheDir, { recursive: true });
  const binUrl = findAssetUrl(assets, assetName);
  if (!binUrl) throw new Error(`Latest release does not contain asset ${assetName}`);
  const [algo,hex] = binUrl.digest.trim().toLowerCase().split(/:/);
  if (!algo || !hex) throw new Error("Invalid digest in release asset");

  // If the binary for this release already exists, do not overwrite
  if (fs.existsSync(assetPath)) {
    return { tag: name, bin: assetPath };
  }

  await eagerAcquireLockAndDownload(binUrl.browser_download_url, assetPath, algo, hex);
  await ensureExecutable(assetPath);
  await tryClearQuarantine(assetPath);
  try {
    const symlinkPath = getLatestSymlinkPath();
    let previousBin = null;
    try {
        previousBin = fs.realpathSync(symlinkPath);
    } catch {}
    fs.symlinkSync(assetPath, symlinkPath);
    // Remove previously newest version (symlink target) if it exists and is different
    if (previousBin && previousBin !== assetPath) {
      try {
        fs.rmSync(path.dirname(previousBin), {recursive: true, force: true});
      } catch {}
    }
  } catch (e) {
    console.error("Failed to create latest symlink:", e);
  }
  return { tag: name, bin: assetPath };
}

async function ensureLatestBinarySync() {
  const assetName = expectedAssetName();
  let releaseInfo;
  const cached = findValidCachedReleaseSync();
  let shouldUpdate = !cached?.bin || shouldCheckForUpdate();
  if (!cached?.bin) {
    // No cached binary, must block and download
    setNextCheckTimeSync();
    try {
      releaseInfo = await fetchLatest();
    } catch (e) {
      throw new Error("Unable to fetch latest release and no valid cached release found.");
    }
    return await downloadAndVerifyReleaseSync(releaseInfo, assetName);
  } else if (shouldUpdate) {
    // Cached binary exists, lazily download new release in background
    setNextCheckTimeSync();
    (async () => {
      try {
        const latest = await fetchLatest();
        await downloadAndVerifyReleaseSync(latest, assetName);
      } catch (e) {
        // Ignore background errors
      }
    })();
    return cached;
  }
  return cached;
}

async function main() {
  // Usage: `sfw npm install ...` or even `npx @socketsecurity/sfw npm install ...`
  const [, , ...argv] = process.argv;

  let binPath;
  try {
    binPath = await ensureLatestBinarySync();
  } catch (e) {
    if (e instanceof Error) {
      console.error(`[sfw] Failed to prepare firewall binary: ${e.message}`);
    } else {
      console.error(`[sfw] Failed to prepare firewall binary: ${String(e)}`);
    }
    process.exit(1);
  }
  if (!binPath || !binPath.bin) {
    console.error("[sfw] No valid firewall binary available for this platform.");
    process.exit(1);
  }

  const child = spawn(binPath.bin, argv, { stdio: "inherit", env: process.env });
  child.on("exit", (code, signal) => {
    if (signal) {
      try { process.kill(process.pid, signal); } catch {}
      return;
    }
    process.exit(code ?? 0);
  });
  child.on("error", (_err) => {
    process.exit(1);
  });
}

main().catch((e) => {
  console.error(e.stack || e.message || String(e));
  process.exit(1);
});
