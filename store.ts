// The forge's in-memory store: git objects, refs, repos, issues, pulls, labels, comments.
// Shared by REST, git smart HTTP, GraphQL and MCP. Everything lives in RAM (no disk I/O on the
// request path). Object bytes are stored verbatim and never re-serialized (clone checks verify
// commits/trees/blobs byte-exact). IDs and numbers are assigned deterministically from creation
// order (never random, never wall-clock) so replays are byte-identical.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export type ObjType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: ObjType;
  bytes: Buffer;
}

/** SHA-1 hex of a buffer. */
export function sha1(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

/** The git object id of `type` + `bytes`: sha1("<type> <len>\0" + bytes). */
export function objectId(type: ObjType, bytes: Buffer): string {
  const head = Buffer.from(`${type} ${bytes.length}\0`, 'utf8');
  return sha1(Buffer.concat([head, bytes]));
}

/** zlib-deflate `bytes` (pack object payloads are deflated). */
export function zdeflate(bytes: Buffer): Buffer {
  return deflateSync(bytes);
}

/** zlib-inflate `bytes`. */
export function zinflate(bytes: Buffer): Buffer {
  return inflateSync(bytes);
}

// ---------------------------------------------------------------- git objects

/** One tree entry: mode (e.g. "100644", "40000"), name, child oid. */
export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

/** Parse a tree object's bytes into entries. */
export function parseTree(bytes: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let i = 0;
  while (i < bytes.length) {
    const sp = bytes.indexOf(0x20, i);
    const mode = bytes.subarray(i, sp).toString('utf8');
    const nul = bytes.indexOf(0, sp + 1);
    const name = bytes.subarray(sp + 1, nul).toString('utf8');
    const oid = bytes.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    i = nul + 21;
  }
  return entries;
}

/** Serialize tree entries (git sort: by name, directories compared as `name/`). */
export function buildTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const an = a.mode === '40000' ? `${a.name}/` : a.name;
    const bn = b.mode === '40000' ? `${b.name}/` : b.name;
    return an < bn ? -1 : an > bn ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const e of sorted) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'));
    parts.push(Buffer.from(e.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

/** Parse a commit object's headers + message. */
export interface CommitInfo {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export function parseCommit(bytes: Buffer): CommitInfo {
  const text = bytes.toString('utf8');
  const headEnd = text.indexOf('\n\n');
  const head = headEnd >= 0 ? text.slice(0, headEnd) : text;
  const message = headEnd >= 0 ? text.slice(headEnd + 2) : '';
  const info: CommitInfo = { tree: '', parents: [], author: '', committer: '', message };
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) info.tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) info.parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) info.author = line.slice(7);
    else if (line.startsWith('committer ')) info.committer = line.slice(10);
  }
  return info;
}

/** Build a commit object: tree, parents, author/committer lines, message. */
export function buildCommit(tree: string, parents: string[], author: string, committer: string, message: string): Buffer {
  const lines = [`tree ${tree}`];
  for (const p of parents) lines.push(`parent ${p}`);
  lines.push(`author ${author}`, `committer ${committer}`, '', message);
  return Buffer.from(lines.join('\n'), 'utf8');
}

/** Parse a tag object's headers + message. */
export interface TagInfo {
  object: string;
  type: string;
  tag: string;
  tagger: string;
  message: string;
}

export function parseTag(bytes: Buffer): TagInfo {
  const text = bytes.toString('utf8');
  const headEnd = text.indexOf('\n\n');
  const head = headEnd >= 0 ? text.slice(0, headEnd) : text;
  const message = headEnd >= 0 ? text.slice(headEnd + 2) : '';
  const info: TagInfo = { object: '', type: '', tag: '', tagger: '', message };
  for (const line of head.split('\n')) {
    if (line.startsWith('object ')) info.object = line.slice(7).trim();
    else if (line.startsWith('type ')) info.type = line.slice(5).trim();
    else if (line.startsWith('tag ')) info.tag = line.slice(4).trim();
    else if (line.startsWith('tagger ')) info.tagger = line.slice(7);
  }
  return info;
}

// ---------------------------------------------------------------- the store

export interface Label {
  name: string;
  color: string;
}

export interface Comment {
  id: number;
  body: string;
  user: string;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: Label[];
  comments: Comment[];
  createdAt: number; // creation sequence (deterministic order)
}

export interface PullFile {
  filename: string;
  status: 'added' | 'modified' | 'removed';
  additions: number;
  deletions: number;
  changes: number;
}

export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  merged_at: string | null;
  merge_commit_sha: string | null;
  headRef: string;
  headSha: string;
  baseRef: string;
  baseSha: string;
  files: PullFile[];
  createdAt: number;
}

export interface Repo {
  id: number;
  name: string;
  owner: string;
  description: string;
  private: boolean;
  defaultBranch: string;
  refs: Map<string, string>; // refname -> oid
  issues: Issue[];
  pulls: Pull[];
  labels: Label[];
  issueSeq: number;
  pullSeq: number;
  createdAt: number;
}

export const VIEWER_LOGIN = 'adaiversen';
export const VIEWER_ID = 1000;
/** Fixed deterministic timestamp used for merged_at (never wall-clock). */
export const EPOCH_ISO = '2025-01-01T00:00:00Z';
export const GIT_IDENTITY = 'Conformance <conformance@make.fun>';

export class Store {
  /** oid -> object (bytes verbatim). */
  objects = new Map<string, GitObject>();
  /** "owner/name" -> repo. */
  repos = new Map<string, Repo>();
  private nextRepoId = 5000;
  private nextIssueId = 1;
  private nextCommentId = 1;
  private nextPullId = 1;
  private seq = 0;

  /** Next deterministic creation-sequence number. */
  nextSeq(): number {
    this.seq += 1;
    return this.seq;
  }

  // ---- objects
  putObject(type: ObjType, bytes: Buffer): string {
    const oid = objectId(type, bytes);
    if (!this.objects.has(oid)) this.objects.set(oid, { type, bytes });
    return oid;
  }

  getObject(oid: string): GitObject | undefined {
    return this.objects.get(oid);
  }

  hasObject(oid: string): boolean {
    return this.objects.has(oid);
  }

  putBlob(bytes: Buffer): string {
    return this.putObject('blob', bytes);
  }

  // ---- repos
  repoKey(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.repoKey(owner, name));
  }

  createRepo(owner: string, name: string, description: string, isPrivate: boolean): Repo {
    const repo: Repo = {
      id: this.nextRepoId++,
      name,
      owner,
      description,
      private: isPrivate,
      defaultBranch: 'main',
      refs: new Map(),
      issues: [],
      pulls: [],
      labels: [],
      issueSeq: 0,
      pullSeq: 0,
      createdAt: this.nextSeq(),
    };
    this.repos.set(this.repoKey(owner, name), repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.repoKey(owner, name));
  }

  listRepos(owner: string): Repo[] {
    const out: Repo[] = [];
    for (const repo of this.repos.values()) if (repo.owner === owner) out.push(repo);
    out.sort((a, b) => a.createdAt - b.createdAt);
    return out;
  }

  // ---- refs
  /** Resolve a ref name (short or full) to an oid, or undefined. */
  resolveRef(repo: Repo, ref: string): string | undefined {
    if (repo.refs.has(ref)) return repo.refs.get(ref);
    const full = ref.startsWith('refs/') ? ref : `refs/heads/${ref}`;
    return repo.refs.get(full);
  }

  /** All refs of a repo, sorted by refname. */
  listRefs(repo: Repo): [string, string][] {
    return [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  }

  // ---- trees / files
  /** Read a file's bytes from a tree (nested path), or undefined. */
  readFileAtTree(treeOid: string, path: string): Buffer | undefined {
    const parts = path.split('/').filter((p) => p !== '');
    let cur = treeOid;
    for (let i = 0; i < parts.length; i++) {
      const obj = this.objects.get(cur);
      if (!obj || obj.type !== 'tree') return undefined;
      const entry = parseTree(obj.bytes).find((e) => e.name === parts[i]);
      if (!entry) return undefined;
      if (i === parts.length - 1) {
        if (entry.mode === '40000') return undefined;
        const blob = this.objects.get(entry.oid);
        return blob && blob.type === 'blob' ? blob.bytes : undefined;
      }
      cur = entry.oid;
    }
    return undefined;
  }

  /** List the entries of a directory tree ("" = root). Returns null when the path is not a dir. */
  listDirAtTree(treeOid: string, path: string): TreeEntry[] | null {
    const parts = path === '' ? [] : path.split('/').filter((p) => p !== '');
    let cur = treeOid;
    for (const part of parts) {
      const obj = this.objects.get(cur);
      if (!obj || obj.type !== 'tree') return null;
      const entry = parseTree(obj.bytes).find((e) => e.name === part);
      if (!entry || entry.mode !== '40000') return null;
      cur = entry.oid;
    }
    const obj = this.objects.get(cur);
    if (!obj || obj.type !== 'tree') return null;
    return parseTree(obj.bytes);
  }

  /** Write `bytes` at `path` into the tree rooted at `treeOid` ("" tree = empty). Returns the new tree oid. */
  writeFileAtTree(treeOid: string | null, path: string, bytes: Buffer): string {
    const parts = path.split('/').filter((p) => p !== '');
    const blobOid = this.putBlob(bytes);
    const build = (curOid: string | null, depth: number): string => {
      const entries = curOid ? parseTree(this.objects.get(curOid)!.bytes) : [];
      const name = parts[depth];
      const last = depth === parts.length - 1;
      const idx = entries.findIndex((e) => e.name === name);
      if (last) {
        const entry: TreeEntry = { mode: '100644', name, oid: blobOid };
        if (idx >= 0) entries[idx] = entry;
        else entries.push(entry);
      } else {
        const child = idx >= 0 && entries[idx].mode === '40000' ? entries[idx].oid : null;
        const newChild = build(child, depth + 1);
        const entry: TreeEntry = { mode: '40000', name, oid: newChild };
        if (idx >= 0) entries[idx] = entry;
        else entries.push(entry);
      }
      return this.putObject('tree', buildTree(entries));
    };
    return build(treeOid, 0);
  }

  /** Remove `path` from the tree rooted at `treeOid`. Returns the new tree oid (or null if empty). */
  removeFileAtTree(treeOid: string, path: string): string | null {
    const parts = path.split('/').filter((p) => p !== '');
    const build = (curOid: string, depth: number): string | null => {
      const entries = parseTree(this.objects.get(curOid)!.bytes);
      const name = parts[depth];
      const idx = entries.findIndex((e) => e.name === name);
      if (idx < 0) return curOid;
      if (depth === parts.length - 1) {
        entries.splice(idx, 1);
      } else {
        if (entries[idx].mode !== '40000') return curOid;
        const newChild = build(entries[idx].oid, depth + 1);
        if (newChild === null) entries.splice(idx, 1);
        else entries[idx] = { ...entries[idx], oid: newChild };
      }
      if (entries.length === 0) return null;
      return this.putObject('tree', buildTree(entries));
    };
    return build(treeOid, 0);
  }

  /** The tree oid of a commit, or undefined. */
  commitTree(commitOid: string): string | undefined {
    const obj = this.objects.get(commitOid);
    if (!obj || obj.type !== 'commit') return undefined;
    return parseCommit(obj.bytes).tree;
  }

  /** Walk a commit's ancestry (newest first, following first parents then all parents, deduped). */
  walkCommits(tip: string, limit = 10000): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    const queue: string[] = [tip];
    while (queue.length > 0 && out.length < limit) {
      const oid = queue.shift()!;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const obj = this.objects.get(oid);
      if (!obj || obj.type !== 'commit') continue;
      out.push(oid);
      for (const p of parseCommit(obj.bytes).parents) if (!seen.has(p)) queue.push(p);
    }
    return out;
  }

  /** True when `ancestor` is reachable from `tip` (or equal). */
  isAncestor(ancestor: string, tip: string): boolean {
    if (ancestor === tip) return true;
    const seen = new Set<string>([tip]);
    const queue: string[] = [tip];
    while (queue.length > 0) {
      const oid = queue.shift()!;
      const obj = this.objects.get(oid);
      if (!obj || obj.type !== 'commit') continue;
      for (const p of parseCommit(obj.bytes).parents) {
        if (p === ancestor) return true;
        if (!seen.has(p)) {
          seen.add(p);
          queue.push(p);
        }
      }
    }
    return false;
  }

  /** All objects reachable from `tips` (commits + their trees/blobs/tags), in topo order (children before parents is not guaranteed; the set is what matters). */
  reachableObjects(tips: string[]): Set<string> {
    const out = new Set<string>();
    const queue: string[] = [...tips];
    while (queue.length > 0) {
      const oid = queue.shift()!;
      if (out.has(oid)) continue;
      const obj = this.objects.get(oid);
      if (!obj) continue;
      out.add(oid);
      if (obj.type === 'commit') {
        const c = parseCommit(obj.bytes);
        queue.push(c.tree);
        for (const p of c.parents) queue.push(p);
      } else if (obj.type === 'tree') {
        for (const e of parseTree(obj.bytes)) queue.push(e.oid);
      } else if (obj.type === 'tag') {
        queue.push(parseTag(obj.bytes).object);
      }
    }
    return out;
  }

  // ---- issues / pulls
  createIssue(repo: Repo, title: string, body: string, labelNames: string[]): Issue {
    repo.issueSeq += 1;
    const labels = labelNames
      .map((n) => repo.labels.find((l) => l.name === n)!)
      .filter(Boolean);
    const issue: Issue = {
      id: this.nextIssueId++,
      number: repo.issueSeq,
      title,
      body,
      state: 'open',
      labels,
      comments: [],
      createdAt: this.nextSeq(),
    };
    repo.issues.push(issue);
    return issue;
  }

  createPull(repo: Repo, title: string, body: string, headRef: string, headSha: string, baseRef: string, baseSha: string, files: PullFile[]): Pull {
    repo.pullSeq += 1;
    const pull: Pull = {
      id: this.nextPullId++,
      number: repo.pullSeq,
      title,
      body,
      state: 'open',
      merged: false,
      merged_at: null,
      merge_commit_sha: null,
      headRef,
      headSha,
      baseRef,
      baseSha,
      files,
      createdAt: this.nextSeq(),
    };
    repo.pulls.push(pull);
    return pull;
  }

  createComment(issue: Issue, body: string, user: string): Comment {
    const comment: Comment = { id: this.nextCommentId++, body, user };
    issue.comments.push(comment);
    return comment;
  }
}

/** The single shared store for the process. */
export const store = new Store();
