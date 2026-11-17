// MCP endpoint (POST /mcp): JSON-RPC 2.0 over Streamable HTTP, modern era 2026-07-28
// as primary (server/discover, no handshake, no session) with the legacy initialize
// handshake as a fallback. Answers application/json. The six tools are thin wrappers over
// the shared store, so MCP-created repos/issues/pulls are the same objects REST reads back.
//
// Auth: tools/call (and every JSON-RPC request) without a valid Authorization header -> HTTP
// 401, decided before any tool lookup. Unknown tool -> JSON-RPC -32602. Missing required
// arguments -> isError:true. A body that is not JSON -> HTTP 400 + JSON-RPC -32700.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { store, VIEWER_LOGIN } from './store.ts';
import type { Repo } from './store.ts';
import { sendJson, sendUnauthorized, isAuthenticated, parseJson } from './helpers.ts';
import { computePullFiles, squashMerge } from './graphql.ts';

const SERVER_NAME = 'github-forge';
const SERVER_VERSION = '0.1.0';
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const LEGACY_REVISIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// ---------------------------------------------------------------------------
// Tools (fixed order, fixed content — two tools/list calls must be byte-identical)
// ---------------------------------------------------------------------------

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description?: string }>;
    required: string[];
  };
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'Issue state: open, closed or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        body: { type: 'string', description: 'The pull request body.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request with a squash merge.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'integer', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

// Aliases the suite may call a tool by (matched by normalized suffix in the client, but
// the client calls the name tools/list returned, so exact canonical names suffice; the
// map below accepts aliases too, for robustness).
const TOOL_ALIASES: Record<string, string> = {
  create_repository: 'create_repo',
  repo_create: 'create_repo',
  repos_create: 'create_repo',
  repository_create: 'create_repo',
  get_repository: 'get_repo',
  repo_get: 'get_repo',
  repos_get: 'get_repo',
  repository_get: 'get_repo',
  issue_create: 'create_issue',
  issues_create: 'create_issue',
  issues_list: 'list_issues',
  issue_list: 'list_issues',
  pull_request_create: 'create_pull_request',
  pulls_create: 'create_pull_request',
  create_pr: 'create_pull_request',
  pr_create: 'create_pull_request',
  pull_request_merge: 'merge_pull_request',
  pulls_merge: 'merge_pull_request',
  merge_pr: 'merge_pull_request',
  pr_merge: 'merge_pull_request',
};

// ---------------------------------------------------------------------------
// Tool implementations. Each returns { ok, value } on success or { ok: false, message }
// for a tool execution error (answered with isError: true).
// ---------------------------------------------------------------------------

type ToolOutcome = { ok: true; value: unknown } | { ok: false; message: string };

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

function repoShape(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner },
    description: repo.description,
    private: repo.private,
    default_branch: repo.defaultBranch,
  };
}

function issueShape(repo: Repo, issue: { id: number; number: number; title: string; body: string; state: string; labels: Array<{ name: string; color: string }> }): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((l) => ({ name: l.name, color: l.color })),
  };
}

function resolveRepo(ownerArg: unknown, repoArg: unknown): Repo | null {
  const owner = nonEmptyString(ownerArg) ?? VIEWER_LOGIN;
  const name = nonEmptyString(repoArg);
  if (name === null) return null;
  return store.getRepo(owner, name) ?? null;
}

function callCreateRepo(args: Record<string, unknown>): ToolOutcome {
  const name = nonEmptyString(args.name);
  if (name === null) return { ok: false, message: 'Missing required argument: name' };
  const description = typeof args.description === 'string' ? args.description : '';
  const isPrivate = args.private === true;
  const existing = store.getRepo(VIEWER_LOGIN, name);
  if (existing !== undefined) return { ok: true, value: repoShape(existing) };
  const repo = store.createRepo(VIEWER_LOGIN, name, description, isPrivate);
  return { ok: true, value: repoShape(repo) };
}

function callGetRepo(args: Record<string, unknown>): ToolOutcome {
  const repo = resolveRepo(args.owner, args.repo);
  if (repo === null) return { ok: false, message: 'Repository not found' };
  return { ok: true, value: repoShape(repo) };
}

function callCreateIssue(args: Record<string, unknown>): ToolOutcome {
  const owner = nonEmptyString(args.owner);
  const name = nonEmptyString(args.repo);
  const title = nonEmptyString(args.title);
  if (owner === null || name === null || title === null) {
    return { ok: false, message: 'Missing required argument: owner, repo and title are required' };
  }
  const repo = store.getRepo(owner, name);
  if (repo === undefined) return { ok: false, message: 'Repository not found' };
  const body = typeof args.body === 'string' ? args.body : '';
  const issue = store.createIssue(repo, title, body, []);
  return { ok: true, value: issueShape(repo, issue) };
}

function callListIssues(args: Record<string, unknown>): ToolOutcome {
  const repo = resolveRepo(args.owner, args.repo);
  if (repo === null) return { ok: false, message: 'Repository not found' };
  const state = typeof args.state === 'string' ? args.state.toLowerCase() : 'open';
  const list = repo.issues.filter((i) => state === 'all' || i.state === state);
  return { ok: true, value: list.map((i) => issueShape(repo, i)) };
}

function callCreatePullRequest(args: Record<string, unknown>): ToolOutcome {
  const owner = nonEmptyString(args.owner);
  const name = nonEmptyString(args.repo);
  const title = nonEmptyString(args.title);
  const head = nonEmptyString(args.head);
  const base = nonEmptyString(args.base);
  if (owner === null || name === null || title === null || head === null || base === null) {
    return { ok: false, message: 'Missing required argument: owner, repo, title, head and base are required' };
  }
  const repo = store.getRepo(owner, name);
  if (repo === undefined) return { ok: false, message: 'Repository not found' };
  const headSha = store.resolveRef(repo, head);
  const baseSha = store.resolveRef(repo, base);
  if (headSha === undefined || baseSha === undefined) return { ok: false, message: 'Branch not found' };
  const body = typeof args.body === 'string' ? args.body : '';
  const files = computePullFiles(repo, baseSha, headSha);
  const pull = store.createPull(repo, title, body, head, headSha, base, baseSha, files);
  return {
    ok: true,
    value: {
      id: pull.id,
      number: pull.number,
      title: pull.title,
      body: pull.body,
      state: pull.state,
      head,
      base,
      headRef: head,
      baseRef: base,
    },
  };
}

function callMergePullRequest(args: Record<string, unknown>): ToolOutcome {
  const repo = resolveRepo(args.owner, args.repo);
  if (repo === null) return { ok: false, message: 'Repository not found' };
  const raw = args.pull_number;
  const number = typeof raw === 'number' ? raw : typeof raw === 'string' && /^\d+$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isInteger(number)) return { ok: false, message: 'Missing required argument: pull_number' };
  const pull = repo.pulls.find((p) => p.number === number);
  if (pull === undefined) return { ok: false, message: 'Pull request not found' };
  const result = squashMerge(repo, pull);
  if (!result.ok) return { ok: false, message: result.reason ?? 'Merge failed' };
  return {
    ok: true,
    value: { number: pull.number, merged: true, state: pull.state, sha: result.sha, merge_commit_sha: result.sha },
  };
}

const TOOL_HANDLERS: Record<string, (args: Record<string, unknown>) => ToolOutcome> = {
  create_repo: callCreateRepo,
  get_repo: callGetRepo,
  create_issue: callCreateIssue,
  list_issues: callListIssues,
  create_pull_request: callCreatePullRequest,
  merge_pull_request: callMergePullRequest,
};

// ---------------------------------------------------------------------------
// JSON-RPC plumbing
// ---------------------------------------------------------------------------

function rpcResult(res: ServerResponse, id: unknown, result: unknown): void {
  sendJson(res, 200, { jsonrpc: '2.0', id: id ?? null, result });
}

function rpcError(res: ServerResponse, status: number, id: unknown, code: number, message: string, data?: unknown): void {
  const error: Record<string, unknown> = { code, message };
  if (data !== undefined) error.data = data;
  sendJson(res, status, { jsonrpc: '2.0', id: id ?? null, error });
}

function serverInfo(): { name: string; version: string } {
  return { name: SERVER_NAME, version: SERVER_VERSION };
}

function capabilities(): Record<string, unknown> {
  return { tools: {} };
}

function discoverResult(): Record<string, unknown> {
  const info = serverInfo();
  return {
    supportedVersions: [...SUPPORTED_VERSIONS],
    capabilities: capabilities(),
    serverInfo: info,
    _meta: { 'io.modelcontextprotocol/serverInfo': info },
  };
}

function toolResultResponse(outcome: ToolOutcome): Record<string, unknown> {
  if (outcome.ok) {
    return {
      content: [{ type: 'text', text: JSON.stringify(outcome.value) }],
      structuredContent: outcome.value,
    };
  }
  return { content: [{ type: 'text', text: outcome.message }], isError: true };
}

function dispatchMethod(req: IncomingMessage, res: ServerResponse, method: unknown, params: unknown, id: unknown): void {
  const p = isRecord(params) ? params : {};
  if (method === 'server/discover') {
    // A revision the server does not support is a -32022 naming the supported ones.
    const meta = isRecord(p._meta) ? p._meta : {};
    const requested = meta['io.modelcontextprotocol/protocolVersion'] ?? meta.protocolVersion;
    if (typeof requested === 'string' && !SUPPORTED_VERSIONS.includes(requested)) {
      rpcError(res, 200, id, -32022, `Unsupported protocol version: ${requested}`, { supported: [...SUPPORTED_VERSIONS] });
      return;
    }
    rpcResult(res, id, discoverResult());
    return;
  }
  if (method === 'initialize') {
    const offered = typeof p.protocolVersion === 'string' ? p.protocolVersion : LEGACY_REVISIONS[0];
    const version = LEGACY_REVISIONS.includes(offered) || SUPPORTED_VERSIONS.includes(offered) ? offered : LEGACY_REVISIONS[0]!;
    rpcResult(res, id, { protocolVersion: version, serverInfo: serverInfo(), capabilities: capabilities() });
    return;
  }
  if (method === 'tools/list') {
    rpcResult(res, id, { tools: TOOLS });
    return;
  }
  if (method === 'tools/call') {
    const name = typeof p.name === 'string' ? p.name : '';
    const canonical = TOOL_HANDLERS[name] !== undefined ? name : (TOOL_ALIASES[name] ?? null);
    if (canonical === null) {
      rpcError(res, 200, id, -32602, `Unknown tool: ${name}`);
      return;
    }
    const args = isRecord(p.arguments) ? (p.arguments as Record<string, unknown>) : {};
    const outcome = TOOL_HANDLERS[canonical]!(args);
    rpcResult(res, id, toolResultResponse(outcome));
    return;
  }
  if (method === 'ping') {
    rpcResult(res, id, {});
    return;
  }
  rpcError(res, 200, id, -32601, `Method not found: ${typeof method === 'string' ? method : String(method)}`);
}

// ---------------------------------------------------------------------------
// HTTP handler
// ---------------------------------------------------------------------------

export async function handleMcp(
  req: IncomingMessage,
  res: ServerResponse,
  _pathname: string,
  _search: URLSearchParams,
  body: Buffer | null,
): Promise<boolean> {
  // Legacy session close: best-effort, ignore.
  if (req.method === 'DELETE') {
    sendJson(res, 200, {});
    return true;
  }
  if (req.method !== 'POST') {
    sendJson(res, 405, { message: 'Method Not Allowed' });
    return true;
  }
  const parsed = parseJson(body ?? Buffer.alloc(0));
  if (!parsed.ok) {
    // A body that is not JSON: HTTP 400 + JSON-RPC -32700 (modern transport).
    rpcError(res, 400, null, -32700, 'Parse error');
    return true;
  }
  const value = parsed.value;
  if (!isRecord(value) || typeof value.method !== 'string') {
    rpcError(res, 400, isRecord(value) ? value.id ?? null : null, -32600, 'Invalid Request');
    return true;
  }
  // Auth is decided before any tool exists: no/invalid token -> HTTP 401.
  if (!isAuthenticated(req)) {
    sendUnauthorized(res);
    return true;
  }
  const id = 'id' in value ? value.id : undefined;
  if (id === undefined) {
    // A notification (e.g. notifications/initialized): no JSON-RPC reply, HTTP 202.
    sendJson(res, 202, null);
    return true;
  }
  dispatchMethod(req, res, value.method, value.params, id);
  return true;
}
