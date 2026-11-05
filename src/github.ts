import fs from 'node:fs';
import type { IncomingHttpHeaders } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { getJSON, HttpError } from './http.ts';

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
  if (plat === 'windows') return `sfw-free-windows-${arch}.exe`;
  if (plat === 'macos') return `sfw-free-macos-${arch}`;
  if (plat === 'linux') return `sfw-free-linux-${arch}`;
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

// Unauthenticated GitHub API calls are limited to 60/hour per IP, which shared
// CI runners and NAT'd networks exhaust quickly. Use a token when one is set.
function githubToken(): string | undefined {
  return process.env.GITHUB_TOKEN?.trim() || process.env.GH_TOKEN?.trim() || undefined;
}

function apiHeaders(token: string | undefined): Record<string, string> {
  return {
    Accept: 'application/vnd.github+json',
    ...(token && { Authorization: `Bearer ${token}` }),
  };
}

// Thrown when GitHub rejected the configured token (401) and the anonymous
// retry then failed too. The retry's error is the cause.
export class TokenRejectedError extends Error {
  constructor(cause: unknown) {
    super('GITHUB_TOKEN/GH_TOKEN was rejected and the anonymous retry failed', { cause });
    this.name = 'TokenRejectedError';
  }
}

export async function fetchLatest(): Promise<LatestRelease> {
  const token = githubToken();
  // biome-ignore lint/suspicious/noExplicitAny: reasonable type for the GitHub API response
  let json: any;
  try {
    json = await getJSON(LATEST_API, { userAgent: USER_AGENT, headers: apiHeaders(token) });
  } catch (e) {
    // An expired or invalid token shouldn't break a public, anonymous fetch.
    if (!(token && e instanceof HttpError && e.statusCode === 401)) {
      throw e;
    }
    try {
      json = await getJSON(LATEST_API, { userAgent: USER_AGENT, headers: apiHeaders(undefined) });
    } catch (retryError) {
      throw new TokenRejectedError(retryError);
    }
  }
  return {
    tag: json.tag_name,
    name: json.name || json.tag_name,
    assets: Array.isArray(json.assets) ? json.assets : [],
  };
}

// When the limit lifts. Secondary limits send `retry-after`, which takes
// precedence: `x-ratelimit-reset` is on every response and is the primary
// hourly window, so it's only meaningful once that quota is used up.
function rateLimitWait(headers: IncomingHttpHeaders): string {
  const retryAfter = Number(headers['retry-after']);
  if (Number.isFinite(retryAfter) && retryAfter >= 0) {
    return ` (retry after ${retryAfter}s)`;
  }
  const reset = Number(headers['x-ratelimit-reset']);
  if (headers['x-ratelimit-remaining'] === '0' && Number.isFinite(reset) && reset > 0) {
    return ` (resets at ${new Date(reset * 1000).toISOString()})`;
  }
  return '';
}

// Turn a fetchLatest() failure into a message that says what went wrong and,
// where we can tell, what to do about it.
export function describeFetchError(e: unknown): string {
  if (e instanceof TokenRejectedError) {
    return describeFailure(e.cause, true);
  }
  return describeFailure(e, false);
}

function describeFailure(e: unknown, tokenRejected: boolean): string {
  const rejectedNote = tokenRejected ? ' (GITHUB_TOKEN/GH_TOKEN was rejected with 401)' : '';
  if (e instanceof HttpError) {
    const remaining = e.headers['x-ratelimit-remaining'];
    const retryAfter = e.headers['retry-after'];
    const rateLimited =
      e.statusCode === 429 ||
      (e.statusCode === 403 && (remaining === '0' || retryAfter !== undefined));
    if (rateLimited) {
      // The hint depends on the failing request: a rejected token needs fixing,
      // a working token has run out too, and an anonymous request needs one.
      let hint: string;
      if (tokenRejected) {
        hint = 'GITHUB_TOKEN/GH_TOKEN was rejected (401); fix or unset it.';
      } else if (e.authenticated) {
        hint = 'The configured GITHUB_TOKEN/GH_TOKEN has also hit its limit.';
      } else {
        hint = 'Set GITHUB_TOKEN (or GH_TOKEN) to raise the limit.';
      }
      return `${e.message}: GitHub API rate limit exceeded${rateLimitWait(e.headers)}. ${hint}`;
    }
    return `${e.message}${rejectedNote}`;
  }
  if (e instanceof Error) {
    // Node reports a refused connection to a multi-address host as an
    // AggregateError with an empty message; fall back to the error code.
    return `${e.message || (e as NodeJS.ErrnoException).code || e.name}${rejectedNote}`;
  }
  return `${String(e)}${rejectedNote}`;
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
