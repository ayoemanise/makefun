// Shared HTTP helpers for the forge: JSON replies, request-id header, auth, body reading.
// Every reply carries a non-empty X-GitHub-Request-Id and application/json (never HTML).

import type { IncomingMessage, ServerResponse } from 'node:http';

let requestCounter = 0;

/** The bearer token this process trusts (from its own env). */
export function shopToken(): string | undefined {
  return process.env.MAKEFUN_SHOP_TOKEN;
}

/**
 * True when the request carries the shop token. When MAKEFUN_SHOP_TOKEN is unset (local dev
 * without the env), any non-empty Bearer token is accepted so the local runner still works.
 */
export function isAuthenticated(req: IncomingMessage): boolean {
  const auth = req.headers.authorization ?? '';
  const m = /^Bearer\s+(.+)$/.exec(auth);
  if (!m) return false;
  const token = shopToken();
  if (!token) return true;
  return m[1] === token;
}

export function sendJson(res: ServerResponse, status: number, obj: unknown): void {
  requestCounter += 1;
  const body = obj === null ? '' : JSON.stringify(obj);
  res.writeHead(status, {
    'content-type': 'application/json',
    'x-github-request-id': `req-${requestCounter}`,
  });
  res.end(body);
}

export function sendError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { message });
}

/** 401 JSON for unauthenticated requests. */
export function sendUnauthorized(res: ServerResponse): void {
  sendError(res, 401, 'Requires authentication');
}

/** Read the full request body. */
export function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Parse a JSON body. Returns { ok: true, value } or { ok: false } on malformed JSON. */
export function parseJson(body: Buffer): { ok: true; value: unknown } | { ok: false } {
  if (body.length === 0) return { ok: true, value: undefined };
  try {
    return { ok: true, value: JSON.parse(body.toString('utf8')) };
  } catch {
    return { ok: false };
  }
}

/** Base64 encode (standard, with padding) / decode. */
export function b64encode(buf: Buffer): string {
  return buf.toString('base64');
}

export function b64decode(s: string): Buffer {
  return Buffer.from(s, 'base64');
}

/** Opaque global id: base64 of "Type:<key>". Stable for the same object. */
export function globalId(type: string, key: string): string {
  return Buffer.from(`${type}:${key}`, 'utf8').toString('base64');
}

/** Decode a global id back to { type, key }, or null. */
export function parseGlobalId(id: string): { type: string; key: string } | null {
  try {
    const decoded = Buffer.from(id, 'base64').toString('utf8');
    const i = decoded.indexOf(':');
    if (i <= 0) return null;
    return { type: decoded.slice(0, i), key: decoded.slice(i + 1) };
  } catch {
    return null;
  }
}

/** Cursor for GraphQL pagination: opaque base64 of the offset. */
export function encodeCursor(offset: number): string {
  return Buffer.from(`cursor:${offset}`, 'utf8').toString('base64');
}

export function decodeCursor(cursor: string): number | null {
  try {
    const decoded = Buffer.from(cursor, 'base64').toString('utf8');
    const m = /^cursor:(\d+)$/.exec(decoded);
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}
