import type { IncomingHttpHeaders, IncomingMessage } from 'node:http';
import https from 'node:https';
import { URL } from 'node:url';

export interface HttpGetOptions {
  headers?: Record<string, string>;
  maxRedirects?: number;
  userAgent?: string;
}

export class HttpError extends Error {
  readonly url: string;
  readonly statusCode: number;
  readonly headers: IncomingHttpHeaders;

  constructor(url: string, statusCode: number, headers: IncomingHttpHeaders) {
    super(`GET ${url} failed with ${statusCode}`);
    this.name = 'HttpError';
    this.url = url;
    this.statusCode = statusCode;
    this.headers = headers;
  }
}

// Credentials must never follow a redirect to a different host (e.g. from
// api.github.com to the release-asset CDN).
function withoutAuthorization(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).filter(([k]) => k.toLowerCase() !== 'authorization'),
  );
}

export async function httpsGet(
  url: string,
  options: HttpGetOptions = {},
): Promise<IncomingMessage> {
  const { headers = {}, maxRedirects = 5, userAgent } = options;

  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const opts = {
      headers: {
        ...(userAgent && { 'User-Agent': userAgent }),
        ...headers,
      },
    };

    https
      .get(u, opts, (res: IncomingMessage) => {
        const { statusCode, headers: h } = res;
        if (statusCode === undefined) {
          return reject(new Error(`GET ${url} failed with no status code`));
        }
        if (statusCode >= 300 && statusCode < 400 && h.location && maxRedirects > 0) {
          res.resume();
          const next = new URL(h.location, u);
          const nextHeaders = next.host === u.host ? headers : withoutAuthorization(headers);
          return resolve(
            httpsGet(next.toString(), {
              ...options,
              headers: nextHeaders,
              maxRedirects: maxRedirects - 1,
            }),
          );
        }
        if (statusCode < 200 || statusCode >= 300) {
          res.resume();
          return reject(new HttpError(url, statusCode, h));
        }
        resolve(res);
      })
      .on('error', reject);
  });
}

export async function httpsGetWithRange(
  url: string,
  startByte: number,
  options: HttpGetOptions = {},
): Promise<IncomingMessage> {
  const rangeHeaders = {
    Range: `bytes=${startByte}-`,
    ...options.headers,
  };

  return httpsGet(url, {
    ...options,
    headers: rangeHeaders,
  });
}

export async function getText(url: string, options: HttpGetOptions = {}): Promise<string> {
  const res = await httpsGet(url, options);
  return new Promise<string>((resolve, reject) => {
    let data = '';
    res.setEncoding('utf8');
    res.on('data', (c) => {
      data += c;
    });
    res.on('end', () => resolve(data));
    res.on('error', reject);
  });
}

// biome-ignore lint/suspicious/noExplicitAny: reasonable return type for JSON.parse
export async function getJSON(url: string, options: HttpGetOptions = {}): Promise<any> {
  const s = await getText(url, options);
  return JSON.parse(s);
}
