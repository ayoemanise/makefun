// GraphQL v4 surface (POST /api/graphql): a small hand-rolled executor for exactly the
// documents the suite sends (checks-graphql.ts). No GraphQL library. It parses each document
// (query/mutation, aliases, variables, inline fragments, __type introspection), resolves it
// against the shared store, and answers {data} / {data, errors} with HTTP 200 — a GraphQL-level
// failure is a 200 with an errors array, never an HTTP error. Unauthenticated -> exactly 401.
// Batched bodies (a JSON array of two operation documents) answer an array in request order.
//
// Also exported for the MCP surface (mcp.ts): computePullFiles (base/head tree diff) and
// squashMerge (squash-merge a pull request into its base branch), so REST, GraphQL and MCP
// merges behave identically on the same store.

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  store,
  buildCommit,
  buildTree,
  parseTree,
  GIT_IDENTITY,
  EPOCH_ISO,
  VIEWER_LOGIN,
  VIEWER_ID,
} from './store.ts';
import type { Issue, Pull, PullFile, Repo } from './store.ts';
import {
  sendJson,
  sendError,
  sendUnauthorized,
  isAuthenticated,
  parseJson,
  globalId,
  parseGlobalId,
  encodeCursor,
  decodeCursor,
} from './helpers.ts';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** An error the executor reports as a GraphQL error (HTTP 200 + errors array). */
class GqlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GqlError';
  }
}

// ---------------------------------------------------------------------------
// Pull-request file diff + squash merge (shared with mcp.ts)
// ---------------------------------------------------------------------------

/** Recursively flatten a tree into path -> blob oid. */
function flattenTree(treeOid: string, prefix: string, out: Map<string, string>): void {
  const obj = store.getObject(treeOid);
  if (!obj || obj.type !== 'tree') return;
  for (const entry of parseTree(obj.bytes)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === '40000') flattenTree(entry.oid, path, out);
    else out.set(path, entry.oid);
  }
}

/** Number of lines in a blob (a trailing newline does not add a line). */
function lineCount(bytes: Buffer | undefined): number {
  if (!bytes || bytes.length === 0) return 0;
  let n = 0;
  for (let i = 0; i < bytes.length; i++) if (bytes[i] === 10) n += 1;
  if (bytes[bytes.length - 1] !== 10) n += 1;
  return n;
}

/** Diff base tree vs head tree into the pull-request files list. */
export function computePullFiles(repo: Repo, baseSha: string, headSha: string): PullFile[] {
  const baseTree = store.commitTree(baseSha);
  const headTree = store.commitTree(headSha);
  const baseMap = new Map<string, string>();
  const headMap = new Map<string, string>();
  if (baseTree !== undefined) flattenTree(baseTree, '', baseMap);
  if (headTree !== undefined) flattenTree(headTree, '', headMap);
  const files: PullFile[] = [];
  const paths = new Set<string>([...baseMap.keys(), ...headMap.keys()]);
  for (const path of [...paths].sort()) {
    const b = baseMap.get(path);
    const h = headMap.get(path);
    if (b !== undefined && h === undefined) {
      const oldLines = lineCount(store.getObject(b)?.bytes);
      const del = Math.max(1, oldLines);
      files.push({ filename: path, status: 'removed', additions: 0, deletions: del, changes: del });
    } else if (b === undefined && h !== undefined) {
      const add = Math.max(1, lineCount(store.getObject(h)?.bytes));
      files.push({ filename: path, status: 'added', additions: add, deletions: 0, changes: add });
    } else if (b !== undefined && h !== undefined && b !== h) {
      const add = Math.max(1, lineCount(store.getObject(h)?.bytes));
      const del = lineCount(store.getObject(b)?.bytes);
      files.push({ filename: path, status: 'modified', additions: add, deletions: del, changes: add + del });
    }
  }
  return files;
}

/** 'MERGEABLE' unless the base moved since the PR was created and a changed file conflicts. */
export function prMergeable(repo: Repo, pull: Pull): 'MERGEABLE' | 'CONFLICTING' {
  const baseTip = store.resolveRef(repo, pull.baseRef);
  if (baseTip === undefined || baseTip === pull.baseSha) return 'MERGEABLE';
  const baseTree = store.commitTree(baseTip);
  const prBaseTree = store.commitTree(pull.baseSha);
  const headTree = store.commitTree(pull.headSha);
  if (baseTree === undefined || prBaseTree === undefined || headTree === undefined) return 'MERGEABLE';
  for (const f of pull.files) {
    const cur = store.readFileAtTree(baseTree, f.filename);
    const old = store.readFileAtTree(prBaseTree, f.filename);
    const head = store.readFileAtTree(headTree, f.filename);
    const curS = cur === undefined ? null : cur.toString('base64');
    const oldS = old === undefined ? null : old.toString('base64');
    const headS = head === undefined ? null : head.toString('base64');
    if (curS !== oldS && headS !== curS) return 'CONFLICTING';
  }
  return 'MERGEABLE';
}

/**
 * Squash-merge a pull request: one new commit on the base branch whose tree is the head's
 * file contents applied onto the base, parent = base tip. Sets merged/state/merged_at/
 * merge_commit_sha on the pull. Deterministic identity + fixed epoch (never wall-clock).
 */
export function squashMerge(repo: Repo, pull: Pull): { ok: boolean; sha: string | null; reason: string | null } {
  if (pull.merged) return { ok: true, sha: pull.merge_commit_sha, reason: null };
  if (prMergeable(repo, pull) === 'CONFLICTING') return { ok: false, sha: null, reason: 'Merge conflict' };
  const baseTip = store.resolveRef(repo, pull.baseRef);
  if (baseTip === undefined) return { ok: false, sha: null, reason: 'Base branch not found' };
  const baseTree = store.commitTree(baseTip);
  const headTree = store.commitTree(pull.headSha);
  if (baseTree === undefined || headTree === undefined) return { ok: false, sha: null, reason: 'Missing commit' };
  let mergedTree = baseTree;
  for (const f of pull.files) {
    if (f.status === 'removed') {
      const next = store.removeFileAtTree(mergedTree, f.filename);
      mergedTree = next ?? store.putObject('tree', buildTree([]));
    } else {
      const bytes = store.readFileAtTree(headTree, f.filename);
      if (bytes !== undefined) mergedTree = store.writeFileAtTree(mergedTree, f.filename, bytes);
    }
  }
  const identity = `${GIT_IDENTITY} 1735689600 +0000`;
  const commitBytes = buildCommit(mergedTree, [baseTip], identity, identity, `Merge pull request #${pull.number} from ${pull.headRef}`);
  const sha = store.putObject('commit', commitBytes);
  repo.refs.set(`refs/heads/${pull.baseRef}`, sha);
  pull.merged = true;
  pull.state = 'closed';
  pull.merged_at = EPOCH_ISO;
  pull.merge_commit_sha = sha;
  return { ok: true, sha, reason: null };
}

// ---------------------------------------------------------------------------
// GraphQL document parser (tokenizer + recursive descent, variables substituted)
// ---------------------------------------------------------------------------

type Tok =
  | { kind: 'name'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: string }
  | { kind: 'float'; value: string }
  | { kind: 'punct'; value: string }
  | { kind: 'spread'; value: '...' };

function tokenize(src: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i]!;
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',') {
      i += 1;
      continue;
    }
    if (c === '#') {
      while (i < n && src[i] !== '\n') i += 1;
      continue;
    }
    if (c === '.' && src[i + 1] === '.' && src[i + 2] === '.') {
      toks.push({ kind: 'spread', value: '...' });
      i += 3;
      continue;
    }
    if ('{}()[]:!=$@&|'.includes(c)) {
      toks.push({ kind: 'punct', value: c });
      i += 1;
      continue;
    }
    if (c === '"') {
      if (src.startsWith('"""', i)) {
        const end = src.indexOf('"""', i + 3);
        if (end < 0) throw new GqlError('Unterminated string in GraphQL document');
        toks.push({ kind: 'string', value: src.slice(i + 3, end) });
        i = end + 3;
        continue;
      }
      let j = i + 1;
      let out = '';
      while (j < n) {
        const ch = src[j]!;
        if (ch === '"') break;
        if (ch === '\\') {
          const esc = src[j + 1];
          if (esc === 'u') {
            out += String.fromCharCode(parseInt(src.slice(j + 2, j + 6), 16));
            j += 6;
            continue;
          }
          const map: Record<string, string> = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', '"': '"', '\\': '\\', '/': '/' };
          out += map[esc ?? ''] ?? esc ?? '';
          j += 2;
          continue;
        }
        out += ch;
        j += 1;
      }
      if (j >= n) throw new GqlError('Unterminated string in GraphQL document');
      toks.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (c === '-' || (c >= '0' && c <= '9')) {
      let j = i;
      if (src[j] === '-') j += 1;
      while (j < n && /[0-9]/.test(src[j]!)) j += 1;
      let isFloat = false;
      if (src[j] === '.') {
        isFloat = true;
        j += 1;
        while (j < n && /[0-9]/.test(src[j]!)) j += 1;
      }
      if (src[j] === 'e' || src[j] === 'E') {
        isFloat = true;
        j += 1;
        if (src[j] === '+' || src[j] === '-') j += 1;
        while (j < n && /[0-9]/.test(src[j]!)) j += 1;
      }
      toks.push({ kind: isFloat ? 'float' : 'int', value: src.slice(i, j) });
      i = j;
      continue;
    }
    if (/[_A-Za-z]/.test(c)) {
      let j = i;
      while (j < n && /[_0-9A-Za-z]/.test(src[j]!)) j += 1;
      toks.push({ kind: 'name', value: src.slice(i, j) });
      i = j;
      continue;
    }
    throw new GqlError(`Unexpected character ${JSON.stringify(c)} in GraphQL document`);
  }
  return toks;
}

interface FieldSel {
  kind: 'field';
  alias: string | null;
  name: string;
  args: Record<string, unknown>;
  sel: Sel[];
}

interface FragSel {
  kind: 'fragment';
  typeCondition: string;
  sel: Sel[];
}

type Sel = FieldSel | FragSel;

interface Operation {
  type: 'query' | 'mutation';
  sel: Sel[];
}

class Parser {
  private pos = 0;
  private toks: Tok[];
  private vars: Record<string, unknown>;

  constructor(toks: Tok[], vars: Record<string, unknown>) {
    this.toks = toks;
    this.vars = vars;
  }

  private peek(): Tok | undefined {
    return this.toks[this.pos];
  }

  private next(): Tok {
    const t = this.toks[this.pos];
    if (t === undefined) throw new GqlError('Unexpected end of GraphQL document');
    this.pos += 1;
    return t;
  }

  private expectPunct(value: string): void {
    const t = this.next();
    if (t.kind !== 'punct' || t.value !== value) throw new GqlError(`Expected '${value}' in GraphQL document`);
  }

  private expectName(value?: string): string {
    const t = this.next();
    if (t.kind !== 'name') throw new GqlError('Expected a name in GraphQL document');
    if (value !== undefined && t.value !== value) throw new GqlError(`Expected '${value}' in GraphQL document`);
    return t.value;
  }

  parseDocument(): Operation {
    const t = this.peek();
    if (t === undefined) throw new GqlError('Empty GraphQL document');
    let type: 'query' | 'mutation' = 'query';
    if (t.kind === 'name' && (t.value === 'query' || t.value === 'mutation')) {
      type = t.value as 'query' | 'mutation';
      this.next();
      const n2 = this.peek();
      if (n2 !== undefined && n2.kind === 'name') this.next(); // operation name
      const p = this.peek();
      if (p !== undefined && p.kind === 'punct' && p.value === '(') this.parseVarDefs();
    }
    return { type, sel: this.parseSelectionSet() };
  }

  private parseVarDefs(): void {
    this.expectPunct('(');
    while (!(this.peek()?.kind === 'punct' && this.peek()!.value === ')')) {
      this.expectPunct('$');
      this.expectName();
      this.expectPunct(':');
      this.parseType();
      if (this.peek()?.kind === 'punct' && this.peek()!.value === '=') {
        this.next();
        this.parseValue();
      }
    }
    this.expectPunct(')');
  }

  private parseType(): void {
    const t = this.peek();
    if (t !== undefined && t.kind === 'punct' && t.value === '[') {
      this.next();
      this.parseType();
      this.expectPunct(']');
    } else {
      this.expectName();
    }
    if (this.peek()?.kind === 'punct' && this.peek()!.value === '!') this.next();
  }

  private parseSelectionSet(): Sel[] {
    this.expectPunct('{');
    const sels: Sel[] = [];
    while (!(this.peek()?.kind === 'punct' && this.peek()!.value === '}')) {
      sels.push(this.parseSelection());
    }
    this.expectPunct('}');
    return sels;
  }

  private parseSelection(): Sel {
    const t = this.peek();
    if (t !== undefined && t.kind === 'spread') {
      this.next();
      const n = this.peek();
      if (n !== undefined && n.kind === 'name' && n.value === 'on') {
        this.next();
        const typeName = this.expectName();
        return { kind: 'fragment', typeCondition: typeName, sel: this.parseSelectionSet() };
      }
      throw new GqlError('Named fragments are not supported');
    }
    let name = this.expectName();
    let alias: string | null = null;
    if (this.peek()?.kind === 'punct' && this.peek()!.value === ':') {
      this.next();
      alias = name;
      name = this.expectName();
    }
    let args: Record<string, unknown> = {};
    if (this.peek()?.kind === 'punct' && this.peek()!.value === '(') args = this.parseArgs();
    while (this.peek()?.kind === 'punct' && this.peek()!.value === '@') {
      this.next();
      this.expectName();
      if (this.peek()?.kind === 'punct' && this.peek()!.value === '(') this.parseArgs();
    }
    let sel: Sel[] = [];
    if (this.peek()?.kind === 'punct' && this.peek()!.value === '{') sel = this.parseSelectionSet();
    return { kind: 'field', alias, name, args, sel };
  }

  private parseArgs(): Record<string, unknown> {
    const args: Record<string, unknown> = {};
    this.expectPunct('(');
    while (!(this.peek()?.kind === 'punct' && this.peek()!.value === ')')) {
      const name = this.expectName();
      this.expectPunct(':');
      args[name] = this.parseValue();
    }
    this.expectPunct(')');
    return args;
  }

  private parseValue(): unknown {
    const t = this.next();
    if (t.kind === 'punct' && t.value === '$') {
      const name = this.expectName();
      return this.vars[name] ?? null;
    }
    if (t.kind === 'string') return t.value;
    if (t.kind === 'int') return parseInt(t.value, 10);
    if (t.kind === 'float') return parseFloat(t.value);
    if (t.kind === 'punct' && t.value === '[') {
      const arr: unknown[] = [];
      while (!(this.peek()?.kind === 'punct' && this.peek()!.value === ']')) arr.push(this.parseValue());
      this.expectPunct(']');
      return arr;
    }
    if (t.kind === 'punct' && t.value === '{') {
      const obj: Record<string, unknown> = {};
      while (!(this.peek()?.kind === 'punct' && this.peek()!.value === '}')) {
        const name = this.expectName();
        this.expectPunct(':');
        obj[name] = this.parseValue();
      }
      this.expectPunct('}');
      return obj;
    }
    if (t.kind === 'name') {
      if (t.value === 'true') return true;
      if (t.value === 'false') return false;
      if (t.value === 'null') return null;
      return t.value; // enum literal
    }
    throw new GqlError(`Unexpected token in GraphQL document value`);
  }
}

// ---------------------------------------------------------------------------
// Resolvers
// ---------------------------------------------------------------------------

interface GqlObj {
  __typename: string;
  [key: string]: unknown;
}

function isGqlObj(value: unknown): value is GqlObj {
  return isRecord(value) && typeof value.__typename === 'string';
}

function findRepoById(id: number): Repo | undefined {
  for (const repo of store.repos.values()) if (repo.id === id) return repo;
  return undefined;
}

function repoFromGlobalId(id: unknown): Repo | null {
  if (typeof id !== 'string') return null;
  const parsed = parseGlobalId(id);
  if (parsed === null || parsed.type !== 'Repository') return null;
  return findRepoById(Number(parsed.key)) ?? null;
}

function issueFromGlobalId(id: unknown): { repo: Repo; issue: Issue } | null {
  if (typeof id !== 'string') return null;
  const parsed = parseGlobalId(id);
  if (parsed === null || parsed.type !== 'Issue') return null;
  const [repoId, num] = parsed.key.split(':');
  const repo = findRepoById(Number(repoId));
  if (repo === undefined) return null;
  const issue = repo.issues.find((i) => i.number === Number(num));
  return issue === undefined ? null : { repo, issue };
}

function pullFromGlobalId(id: unknown): { repo: Repo; pull: Pull } | null {
  if (typeof id !== 'string') return null;
  const parsed = parseGlobalId(id);
  if (parsed === null || parsed.type !== 'PullRequest') return null;
  const [repoId, num] = parsed.key.split(':');
  const repo = findRepoById(Number(repoId));
  if (repo === undefined) return null;
  const pull = repo.pulls.find((p) => p.number === Number(num));
  return pull === undefined ? null : { repo, pull };
}

function repoObj(repo: Repo): GqlObj {
  return { __typename: 'Repository', _repo: repo };
}

function issueObj(repo: Repo, issue: Issue): GqlObj {
  return { __typename: 'Issue', _repo: repo, _issue: issue };
}

function pullObj(repo: Repo, pull: Pull): GqlObj {
  return { __typename: 'PullRequest', _repo: repo, _pull: pull };
}

function userObj(login: string): GqlObj {
  return { __typename: 'User', _login: login };
}

function resolveNode(id: unknown): GqlObj | null {
  if (typeof id !== 'string') return null;
  const parsed = parseGlobalId(id);
  if (parsed === null) return null;
  if (parsed.type === 'Repository') {
    const repo = findRepoById(Number(parsed.key));
    return repo === undefined ? null : repoObj(repo);
  }
  if (parsed.type === 'Issue') {
    const ref = issueFromGlobalId(id);
    return ref === null ? null : issueObj(ref.repo, ref.issue);
  }
  if (parsed.type === 'PullRequest') {
    const ref = pullFromGlobalId(id);
    return ref === null ? null : pullObj(ref.repo, ref.pull);
  }
  if (parsed.type === 'User') return userObj(VIEWER_LOGIN);
  return null;
}

// --- introspection type definitions (field sets the suite's probes require, plus a few more)
const TYPE_DEFS: Record<string, { kind: string; fields: string[]; enumValues: string[] }> = {
  Issue: {
    kind: 'OBJECT',
    fields: ['id', 'number', 'title', 'state', 'body', 'labels', 'comments', 'author', 'createdAt', 'url', 'repository'],
    enumValues: [],
  },
  PullRequest: {
    kind: 'OBJECT',
    fields: ['id', 'number', 'title', 'state', 'body', 'headRefName', 'baseRefName', 'headRef', 'baseRef', 'mergeable', 'merged', 'files', 'mergedAt', 'mergeCommit', 'author', 'createdAt', 'url', 'repository'],
    enumValues: [],
  },
  Repository: {
    kind: 'OBJECT',
    fields: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'private', 'defaultBranch', 'createdAt', 'url'],
    enumValues: [],
  },
  SearchType: {
    kind: 'ENUM',
    fields: [],
    enumValues: ['ISSUE', 'PULL_REQUEST', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'MILESTONE'],
  },
  User: {
    kind: 'OBJECT',
    fields: ['id', 'login', 'name', 'email', 'url'],
    enumValues: [],
  },
  Query: {
    kind: 'OBJECT',
    fields: ['viewer', 'repository', 'node', '__type'],
    enumValues: [],
  },
  Mutation: {
    kind: 'OBJECT',
    fields: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
    enumValues: [],
  },
  IssueConnection: { kind: 'OBJECT', fields: ['nodes', 'pageInfo', 'totalCount'], enumValues: [] },
  PullRequestConnection: { kind: 'OBJECT', fields: ['nodes', 'pageInfo', 'totalCount'], enumValues: [] },
  PageInfo: { kind: 'OBJECT', fields: ['hasNextPage', 'endCursor', 'hasPreviousPage', 'startCursor'], enumValues: [] },
};

function typeObj(name: unknown): GqlObj | null {
  if (typeof name !== 'string') return null;
  const def = TYPE_DEFS[name];
  if (def === undefined) return null;
  return { __typename: '__Type', _name: name, _def: def };
}

function issuesConnection(repo: Repo, args: Record<string, unknown>): GqlObj {
  let list = [...repo.issues];
  const states = args.states;
  if (Array.isArray(states) && states.length > 0) {
    const wanted = new Set(states.map((s) => String(s).toLowerCase()));
    list = list.filter((i) => wanted.has(i.state));
  }
  const orderBy = isRecord(args.orderBy) ? args.orderBy : null;
  const dir = orderBy !== null && String(orderBy.direction ?? '').toUpperCase() === 'ASC' ? 1 : -1;
  list.sort((a, b) => (a.createdAt - b.createdAt) * dir || (a.number - b.number) * dir);
  const first = typeof args.first === 'number' ? args.first : list.length;
  let start = 0;
  if (typeof args.after === 'string' && args.after !== '') {
    const off = decodeCursor(args.after);
    if (off !== null) start = off + 1;
  }
  const page = list.slice(start, start + first);
  const end = start + page.length;
  return {
    __typename: 'IssueConnection',
    _nodes: page.map((i) => issueObj(repo, i)),
    _pageInfo: {
      __typename: 'PageInfo',
      _hasNextPage: end < list.length,
      _endCursor: page.length > 0 ? encodeCursor(start + page.length - 1) : null,
      _hasPreviousPage: start > 0,
      _startCursor: page.length > 0 ? encodeCursor(start) : null,
    },
    _total: list.length,
  };
}

function pullRequestsConnection(repo: Repo, args: Record<string, unknown>): GqlObj {
  const list = [...repo.pulls].sort((a, b) => a.createdAt - b.createdAt || a.number - b.number);
  const first = typeof args.first === 'number' ? args.first : list.length;
  let start = 0;
  if (typeof args.after === 'string' && args.after !== '') {
    const off = decodeCursor(args.after);
    if (off !== null) start = off + 1;
  }
  const page = list.slice(start, start + first);
  const end = start + page.length;
  return {
    __typename: 'PullRequestConnection',
    _nodes: page.map((p) => pullObj(repo, p)),
    _pageInfo: {
      __typename: 'PageInfo',
      _hasNextPage: end < list.length,
      _endCursor: page.length > 0 ? encodeCursor(start + page.length - 1) : null,
      _hasPreviousPage: start > 0,
      _startCursor: page.length > 0 ? encodeCursor(start) : null,
    },
    _total: list.length,
  };
}

type Resolver = (parent: GqlObj, args: Record<string, unknown>) => unknown;

const RESOLVERS: Record<string, Record<string, Resolver>> = {
  Query: {
    viewer: () => userObj(VIEWER_LOGIN),
    repository: (_p, args) => {
      if (args.owner !== VIEWER_LOGIN || typeof args.name !== 'string') return null;
      const repo = store.getRepo(args.owner, args.name);
      return repo === undefined ? null : repoObj(repo);
    },
    node: (_p, args) => resolveNode(args.id),
    __type: (_p, args) => typeObj(args.name),
  },
  Mutation: {
    createIssue: (_p, args) => {
      const input = isRecord(args.input) ? args.input : {};
      const repo = repoFromGlobalId(input.repositoryId);
      if (repo === null) throw new GqlError('Repository not found');
      const title = typeof input.title === 'string' ? input.title : '';
      if (title === '') throw new GqlError('title is required');
      const body = typeof input.body === 'string' ? input.body : '';
      const issue = store.createIssue(repo, title, body, []);
      return { __typename: 'CreateIssuePayload', _issue: issueObj(repo, issue) };
    },
    closeIssue: (_p, args) => {
      const input = isRecord(args.input) ? args.input : {};
      const ref = issueFromGlobalId(input.issueId);
      if (ref === null) throw new GqlError('Issue not found');
      ref.issue.state = 'closed';
      return { __typename: 'CloseIssuePayload', _issue: issueObj(ref.repo, ref.issue) };
    },
    createPullRequest: (_p, args) => {
      const input = isRecord(args.input) ? args.input : {};
      const repo = repoFromGlobalId(input.repositoryId);
      if (repo === null) throw new GqlError('Repository not found');
      const headRef = typeof input.headRefName === 'string' ? input.headRefName : '';
      const baseRef = typeof input.baseRefName === 'string' ? input.baseRefName : '';
      const headSha = store.resolveRef(repo, headRef);
      const baseSha = store.resolveRef(repo, baseRef);
      if (headSha === undefined || baseSha === undefined) throw new GqlError('Branch not found');
      const title = typeof input.title === 'string' ? input.title : '';
      if (title === '') throw new GqlError('title is required');
      const body = typeof input.body === 'string' ? input.body : '';
      const files = computePullFiles(repo, baseSha, headSha);
      const pull = store.createPull(repo, title, body, headRef, headSha, baseRef, baseSha, files);
      return { __typename: 'CreatePullRequestPayload', _pull: pullObj(repo, pull) };
    },
    mergePullRequest: (_p, args) => {
      const input = isRecord(args.input) ? args.input : {};
      const ref = pullFromGlobalId(input.pullRequestId);
      if (ref === null) throw new GqlError('Pull request not found');
      const result = squashMerge(ref.repo, ref.pull);
      if (!result.ok) throw new GqlError(result.reason ?? 'Merge failed');
      return { __typename: 'MergePullRequestPayload', _pull: pullObj(ref.repo, ref.pull) };
    },
    addComment: (_p, args) => {
      const input = isRecord(args.input) ? args.input : {};
      const ref = issueFromGlobalId(input.subjectId);
      if (ref === null) throw new GqlError('Issue not found');
      const body = typeof input.body === 'string' ? input.body : '';
      const comment = store.createComment(ref.issue, body, VIEWER_LOGIN);
      return {
        __typename: 'AddCommentPayload',
        _edge: {
          __typename: 'IssueCommentEdge',
          _node: {
            __typename: 'IssueComment',
            _id: globalId('IssueComment', `${ref.repo.id}:${ref.issue.number}:${comment.id}`),
            _body: body,
          },
        },
      };
    },
  },
  User: {
    login: (p) => p._login,
    id: () => globalId('User', String(VIEWER_ID)),
    name: (p) => p._login,
  },
  Repository: {
    id: (p) => globalId('Repository', String((p._repo as Repo).id)),
    databaseId: (p) => (p._repo as Repo).id,
    name: (p) => (p._repo as Repo).name,
    nameWithOwner: (p) => `${(p._repo as Repo).owner}/${(p._repo as Repo).name}`,
    owner: (p) => userObj((p._repo as Repo).owner),
    defaultBranchRef: (p) => {
      const repo = p._repo as Repo;
      const sha = store.resolveRef(repo, repo.defaultBranch);
      return sha === undefined ? null : { __typename: 'Ref', _name: repo.defaultBranch };
    },
    viewerPermission: () => 'ADMIN',
    hasIssuesEnabled: () => true,
    description: (p) => (p._repo as Repo).description,
    private: (p) => (p._repo as Repo).private,
    issue: (p, args) => {
      const repo = p._repo as Repo;
      if (typeof args.number !== 'number') return null;
      const issue = repo.issues.find((i) => i.number === args.number);
      return issue === undefined ? null : issueObj(repo, issue);
    },
    issues: (p, args) => issuesConnection(p._repo as Repo, args),
    pullRequest: (p, args) => {
      const repo = p._repo as Repo;
      if (typeof args.number !== 'number') return null;
      const pull = repo.pulls.find((x) => x.number === args.number);
      return pull === undefined ? null : pullObj(repo, pull);
    },
    pullRequests: (p, args) => pullRequestsConnection(p._repo as Repo, args),
  },
  Ref: {
    name: (p) => p._name,
  },
  Issue: {
    id: (p) => globalId('Issue', `${(p._repo as Repo).id}:${(p._issue as Issue).number}`),
    number: (p) => (p._issue as Issue).number,
    title: (p) => (p._issue as Issue).title,
    state: (p) => ((p._issue as Issue).state === 'open' ? 'OPEN' : 'CLOSED'),
    body: (p) => (p._issue as Issue).body,
    labels: (p) => (p._issue as Issue).labels.map((l) => ({ __typename: 'Label', _label: l })),
  },
  Label: {
    name: (p) => (p._label as { name: string }).name,
    color: (p) => (p._label as { color: string }).color,
  },
  IssueConnection: {
    nodes: (p) => p._nodes,
    pageInfo: (p) => p._pageInfo,
    totalCount: (p) => p._total,
  },
  PageInfo: {
    hasNextPage: (p) => p._hasNextPage,
    endCursor: (p) => p._endCursor,
    hasPreviousPage: (p) => p._hasPreviousPage,
    startCursor: (p) => p._startCursor,
  },
  PullRequest: {
    id: (p) => globalId('PullRequest', `${(p._repo as Repo).id}:${(p._pull as Pull).number}`),
    number: (p) => (p._pull as Pull).number,
    title: (p) => (p._pull as Pull).title,
    body: (p) => (p._pull as Pull).body,
    state: (p) => ((p._pull as Pull).state === 'open' ? 'OPEN' : 'CLOSED'),
    headRefName: (p) => (p._pull as Pull).headRef,
    baseRefName: (p) => (p._pull as Pull).baseRef,
    mergeable: (p) => prMergeable(p._repo as Repo, p._pull as Pull),
    merged: (p) => (p._pull as Pull).merged,
    files: (p, args) => {
      const pull = p._pull as Pull;
      const first = typeof args.first === 'number' ? args.first : pull.files.length;
      return {
        __typename: 'PullRequestFileConnection',
        _nodes: pull.files.slice(0, first).map((f) => ({ __typename: 'PullRequestFile', _file: f })),
      };
    },
  },
  PullRequestConnection: {
    nodes: (p) => p._nodes,
    pageInfo: (p) => p._pageInfo,
    totalCount: (p) => p._total,
  },
  PullRequestFileConnection: {
    nodes: (p) => p._nodes,
  },
  PullRequestFile: {
    path: (p) => (p._file as PullFile).filename,
    filename: (p) => (p._file as PullFile).filename,
    status: (p) => (p._file as PullFile).status,
    additions: (p) => (p._file as PullFile).additions,
    deletions: (p) => (p._file as PullFile).deletions,
    changes: (p) => (p._file as PullFile).changes,
  },
  __Type: {
    name: (p) => p._name,
    kind: (p) => (p._def as { kind: string }).kind,
    fields: (p) => {
      const def = p._def as { fields: string[] };
      if (def.fields.length === 0) return null;
      return def.fields.map((f) => ({ __typename: '__Field', _name: f }));
    },
    enumValues: (p) => {
      const def = p._def as { enumValues: string[] };
      if (def.enumValues.length === 0) return null;
      return def.enumValues.map((f) => ({ __typename: '__EnumValue', _name: f }));
    },
    description: () => '',
  },
  __Field: {
    name: (p) => p._name,
    description: () => '',
  },
  __EnumValue: {
    name: (p) => p._name,
    description: () => '',
  },
  CreateIssuePayload: {
    issue: (p) => p._issue,
  },
  CloseIssuePayload: {
    issue: (p) => p._issue,
  },
  CreatePullRequestPayload: {
    pullRequest: (p) => p._pull,
  },
  MergePullRequestPayload: {
    pullRequest: (p) => p._pull,
  },
  AddCommentPayload: {
    commentEdge: (p) => p._edge,
  },
  IssueCommentEdge: {
    node: (p) => p._node,
    cursor: () => null,
  },
  IssueComment: {
    id: (p) => p._id,
    body: (p) => p._body,
  },
};

// ---------------------------------------------------------------------------
// Projection + execution
// ---------------------------------------------------------------------------

function projectValue(value: unknown, sels: Sel[], errors: string[]): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map((v) => projectValue(v, sels, errors));
  if (isGqlObj(value)) {
    if (sels.length === 0) return value;
    return project(value.__typename, value, sels, errors);
  }
  return value;
}

function project(typeName: string, obj: GqlObj, sels: Sel[], errors: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const typeResolvers = RESOLVERS[typeName] ?? {};
  for (const sel of sels) {
    if (sel.kind === 'fragment') {
      if (sel.typeCondition === typeName) {
        Object.assign(out, project(typeName, obj, sel.sel, errors));
      }
      continue;
    }
    const key = sel.alias ?? sel.name;
    const resolver = typeResolvers[sel.name];
    if (resolver === undefined) {
      errors.push(`Cannot query field "${sel.name}" on type "${typeName}".`);
      out[key] = null;
      continue;
    }
    let value: unknown;
    try {
      value = resolver(obj, sel.args);
    } catch (err) {
      if (err instanceof GqlError) {
        errors.push(err.message);
        out[key] = null;
        continue;
      }
      throw err;
    }
    out[key] = projectValue(value, sel.sel, errors);
  }
  return out;
}

interface GqlResult {
  data: Record<string, unknown> | null;
  errors?: Array<{ message: string }>;
}

function executeOperation(op: Operation): GqlResult {
  const errors: string[] = [];
  const rootType = op.type === 'mutation' ? 'Mutation' : 'Query';
  try {
    const data = project(rootType, { __typename: rootType }, op.sel, errors);
    if (errors.length > 0) return { data: null, errors: errors.map((m) => ({ message: m })) };
    return { data };
  } catch (err) {
    if (err instanceof GqlError) return { data: null, errors: [{ message: err.message }] };
    return { data: null, errors: [{ message: `Internal error: ${err instanceof Error ? err.message : String(err)}` }] };
  }
}

function executeOne(op: unknown): GqlResult {
  if (!isRecord(op) || typeof op.query !== 'string') {
    return { data: null, errors: [{ message: 'Invalid GraphQL request: expected {query, variables}' }] };
  }
  const variables = isRecord(op.variables) ? (op.variables as Record<string, unknown>) : {};
  let operation: Operation;
  try {
    operation = new Parser(tokenize(op.query), variables).parseDocument();
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : String(err) }] };
  }
  return executeOperation(operation);
}

// ---------------------------------------------------------------------------
// HTTP handler
// ---------------------------------------------------------------------------

export async function handleGraphql(
  req: IncomingMessage,
  res: ServerResponse,
  _pathname: string,
  _search: URLSearchParams,
  body: Buffer | null,
): Promise<boolean> {
  if (req.method !== 'POST') {
    sendError(res, 405, 'Method Not Allowed');
    return true;
  }
  if (!isAuthenticated(req)) {
    sendUnauthorized(res);
    return true;
  }
  const parsed = parseJson(body ?? Buffer.alloc(0));
  if (!parsed.ok) {
    sendError(res, 400, 'Malformed JSON body');
    return true;
  }
  const value = parsed.value;
  if (Array.isArray(value)) {
    sendJson(res, 200, value.map((op) => executeOne(op)));
    return true;
  }
  if (!isRecord(value)) {
    sendError(res, 400, 'Malformed JSON body');
    return true;
  }
  sendJson(res, 200, executeOne(value));
  return true;
}
