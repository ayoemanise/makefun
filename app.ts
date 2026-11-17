// The forge's HTTP router: dispatches on path prefix to the four surfaces, reads request bodies
// before dispatch, and answers a JSON 404 for everything else. Keep-alive is left on (Node's
// http.createServer default) — the read benchmark does 2,000 requests on one socket. No logging
// per request. A handler throw becomes a 500 JSON and never crashes the server.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { handleRest } from './rest.ts';
import { handleGit } from './git.ts';
import { handleGraphql } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { readBody, sendJson } from './helpers.ts';

/** The path of a request URL, or '/' when it does not parse (never a throw from a request). */
function pathOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    return '/';
  }
}

function searchOf(req: IncomingMessage): URLSearchParams {
  try {
    return new URL(req.url ?? '/', 'http://entry').searchParams;
  } catch {
    return new URLSearchParams();
  }
}

/** True when the path is /{owner}/{repo}.git[/...]. */
const GIT_PATH = /^\/[^/]+\/[^/]+\.git(\/.*)?$/;

/** Build the server. It binds nothing until the caller listens; the entry listens on an ephemeral port. */
export function createApp(): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const path = pathOf(req);
      const method = req.method ?? 'GET';
      try {
        // The env's boot check calls this twice: 200 {"ok":true}.
        if (method === 'GET' && path === '/healthz') {
          sendJson(res, 200, { ok: true });
          return;
        }

        // Read the body for methods that carry one (null when there is none).
        let body: Buffer | null = null;
        if (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
          body = await readBody(req);
          if (body.length === 0) body = null;
        }

        const search = searchOf(req);

        if (GIT_PATH.test(path)) {
          if (await handleGit(req, res, path, search, body)) return;
        } else if (path === '/api/graphql') {
          if (await handleGraphql(req, res, path, search, body)) return;
        } else if (path === '/mcp') {
          if (await handleMcp(req, res, path, search, body)) return;
        } else if (path === '/api/v3' || path.startsWith('/api/v3/')) {
          if (await handleRest(req, res, path, search, body)) return;
        }

        // Everything else, every method: GitHub's 404 body.
        sendJson(res, 404, { message: 'Not Found' });
      } catch (err) {
        // Never let a handler throw kill the server (repo-survives-errors).
        try {
          sendJson(res, 500, { message: err instanceof Error ? err.message : 'Internal Server Error' });
        } catch {
          // The socket is already gone; nothing more to do.
        }
      }
    })();
  });
}
