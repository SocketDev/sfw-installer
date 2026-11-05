import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { IncomingHttpHeaders } from 'node:http';
import https from 'node:https';
import { afterEach, beforeEach, describe, mock, test } from 'node:test';

import { describeFetchError, fetchLatest, TokenRejectedError } from '../src/github.ts';
import { HttpError, httpsGet } from '../src/http.ts';

const API = 'https://api.github.com/repos/SocketDev/sfw-free/releases/latest';

interface Route {
  status: number;
  headers?: IncomingHttpHeaders;
  body?: string;
}

interface Call {
  url: string;
  headers: Record<string, string>;
}

// Stub https.get with a router. A route may be a function of the request
// headers, so tests can answer differently with and without Authorization.
let routes: Record<string, Route | ((headers: Record<string, string>) => Route)>;
let calls: Call[];

function stubHttps() {
  mock.method(
    https,
    'get',
    (u: URL, opts: { headers: Record<string, string> }, cb: (res: unknown) => void) => {
      calls.push({ url: u.toString(), headers: opts.headers });
      const entry = routes[u.toString()];
      const route = typeof entry === 'function' ? entry(opts.headers) : (entry ?? { status: 404 });
      const res = Object.assign(new EventEmitter(), {
        statusCode: route.status,
        headers: route.headers ?? {},
        resume() {},
        setEncoding() {},
      });
      setImmediate(() => {
        cb(res);
        setImmediate(() => {
          if (route.body) res.emit('data', route.body);
          res.emit('end');
        });
      });
      return new EventEmitter();
    },
  );
}

const release = (tag: string): Route => ({
  status: 200,
  body: JSON.stringify({ tag_name: tag, assets: [] }),
});

const primaryLimit = { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1700000000' };

function clearTokens() {
  delete process.env.GITHUB_TOKEN;
  delete process.env.GH_TOKEN;
}

beforeEach(() => {
  routes = {};
  calls = [];
  clearTokens();
  stubHttps();
});

afterEach(() => {
  mock.restoreAll();
  clearTokens();
});

describe('httpsGet redirects', () => {
  test('keeps Authorization on same-host redirects and resolves relative Location', async () => {
    routes['https://api.github.com/a'] = { status: 302, headers: { location: '/b' } };
    routes['https://api.github.com/b'] = { status: 200 };
    await httpsGet('https://api.github.com/a', { headers: { Authorization: 'Bearer x' } });
    assert.equal(calls[1]?.url, 'https://api.github.com/b');
    assert.equal(calls[1]?.headers.Authorization, 'Bearer x');
  });

  test('drops Authorization on cross-host redirects and keeps other headers', async () => {
    routes['https://api.github.com/a'] = {
      status: 302,
      headers: { location: 'https://cdn.example/c' },
    };
    routes['https://cdn.example/c'] = { status: 200 };
    await httpsGet('https://api.github.com/a', {
      headers: { authorization: 'Bearer x', Accept: 'y' },
    });
    assert.equal(calls[1]?.url, 'https://cdn.example/c');
    assert.equal(calls[1]?.headers.authorization, undefined);
    assert.equal(calls[1]?.headers.Accept, 'y');
  });

  test('marks an error as unauthenticated once a redirect has dropped the token', async () => {
    routes['https://api.github.com/a'] = {
      status: 302,
      headers: { location: 'https://cdn.example/denied' },
    };
    routes['https://cdn.example/denied'] = { status: 403 };
    const err = await httpsGet('https://api.github.com/a', {
      headers: { Authorization: 'Bearer x' },
    }).catch((e: unknown) => e);
    assert.ok(err instanceof HttpError);
    assert.equal(err.authenticated, false);
  });
});

describe('fetchLatest', () => {
  test('sends GITHUB_TOKEN when set', async () => {
    process.env.GITHUB_TOKEN = 'good';
    routes[API] = release('v1');
    assert.equal((await fetchLatest()).tag, 'v1');
    assert.equal(calls[0]?.headers.Authorization, 'Bearer good');
  });

  test('falls back to GH_TOKEN', async () => {
    process.env.GH_TOKEN = 'gh';
    routes[API] = release('v1');
    await fetchLatest();
    assert.equal(calls[0]?.headers.Authorization, 'Bearer gh');
  });

  test('sends no Authorization without a token', async () => {
    routes[API] = release('v1');
    await fetchLatest();
    assert.equal(calls[0]?.headers.Authorization, undefined);
  });

  test('retries anonymously when the token is rejected', async () => {
    process.env.GITHUB_TOKEN = 'bad';
    routes[API] = (h) => (h.Authorization ? { status: 401 } : release('v2'));
    assert.equal((await fetchLatest()).tag, 'v2');
    assert.equal(calls.length, 2);
    assert.equal(calls[1]?.headers.Authorization, undefined);
  });

  test('does not retry other failures', async () => {
    process.env.GITHUB_TOKEN = 'good';
    routes[API] = { status: 500 };
    const err = await fetchLatest().catch((e: unknown) => e);
    assert.ok(err instanceof HttpError);
    assert.equal(calls.length, 1);
  });

  test('throws TokenRejectedError when the anonymous retry fails too', async () => {
    process.env.GITHUB_TOKEN = 'bad';
    routes[API] = (h) =>
      h.Authorization ? { status: 401 } : { status: 403, headers: primaryLimit };
    const err = await fetchLatest().catch((e: unknown) => e);
    assert.ok(err instanceof TokenRejectedError);
    assert.ok(err.cause instanceof HttpError);
    assert.match(
      describeFetchError(err),
      /rate limit exceeded .*was rejected \(401\); fix or unset it/,
    );
  });
});

describe('describeFetchError', () => {
  const describeHttp = (status: number, headers: IncomingHttpHeaders, authenticated = false) =>
    describeFetchError(new HttpError(API, status, headers, authenticated));

  test('reports the primary reset time and suggests a token', () => {
    assert.equal(
      describeHttp(403, primaryLimit),
      `GET ${API} failed with 403: GitHub API rate limit exceeded ` +
        '(resets at 2023-11-14T22:13:20.000Z). Set GITHUB_TOKEN (or GH_TOKEN) to raise the limit.',
    );
  });

  test('prefers retry-after for secondary limits', () => {
    const msg = describeHttp(403, {
      ...primaryLimit,
      'x-ratelimit-remaining': '42',
      'retry-after': '60',
    });
    assert.match(msg, /rate limit exceeded \(retry after 60s\)/);
    assert.doesNotMatch(msg, /resets at/);
  });

  test('omits the reset time while primary quota remains', () => {
    assert.doesNotMatch(
      describeHttp(429, { ...primaryLimit, 'x-ratelimit-remaining': '42' }),
      /resets at/,
    );
  });

  test('says an authenticated request has hit its limit too', () => {
    assert.match(describeHttp(403, primaryLimit, true), /has also hit its limit/);
  });

  test('treats a 403 without rate-limit headers as a plain failure', () => {
    assert.equal(describeHttp(403, {}), `GET ${API} failed with 403`);
  });

  test('notes a rejected token on non-rate-limit failures', () => {
    const err = new TokenRejectedError(new Error('getaddrinfo ENOTFOUND api.github.com'));
    assert.equal(
      describeFetchError(err),
      'getaddrinfo ENOTFOUND api.github.com (GITHUB_TOKEN/GH_TOKEN was rejected with 401)',
    );
  });

  test('falls back to the error code when the message is empty', () => {
    // What Node reports for a refused connection to a host with several addresses.
    const err = Object.assign(new AggregateError([], ''), { code: 'ECONNREFUSED' });
    assert.equal(describeFetchError(err), 'ECONNREFUSED');
  });
});
