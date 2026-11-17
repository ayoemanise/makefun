// REST v3 surface of the forge (SPEC section 3): repos, branches, commits, refs, contents,
// labels, issues, comments, pulls and merges, plus the protocol rules (JSON everywhere,
// X-GitHub-Request-Id, 401/404/422 error bodies, malformed JSON -> 400).
//
// Auth: every /api/v3 route requires the shop token (helpers.isAuthenticated). Any {owner}
// other than the viewer login `adaiversen` -> 404, never 403 (SPEC 1.4).

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  store,
  VIEWER_LOGIN,
  VIEWER_ID,
  EPOCH_ISO,
  GIT_IDENTITY,
  parseCommit,
  parseTree,
  buildTree,
  buildCommit,
  objectId,
} from './store.ts';
import type { Repo, Issue, Pull, PullFile } from './store.ts';
import {
  sendJson,
  sendError,
  sendUnauthorized,
  parseJson,
  isAuthenticated,
  b64encode,
  b64decode,
} from './helpers.ts';

/** Fixed commit timestamp for contents/merge commits (deterministic, never wall-clock). */
const COMMIT_EPOCH = 1735689600; // 2025-01-01T00:00:00Z

// ---------------------------------------------------------------- shapes

function repoJson(r: Repo): Record<string, unknown> {
  return {
    id: r.id,
    name: r.name,
    full_name: `${r.owner}/${r.name}`,
    owner: { login: r.owner, id: VIEWER_ID, type: 'User' },
    private: r.private,
    description: r.description,
    default_branch: r.defaultBranch,
    created_at: EPOCH_ISO,
    updated_at: EPOCH_ISO,
    html_url: `https://github.com/${r.owner}/${r.name}`,
    url: `/api/v3/repos/${r.owner}/${r.name}`,
  };
}

function labelJson(l: { name: string; color: string }): Record<string, unknown> {
  return { name: l.name, color: l.color };
}

function issueJson(i: Issue): Record<string, unknown> {
  return {
    id: i.id,
    number: i.number,
    title: i.title,
    body: i.body,
    state: i.state,
    labels: i.labels.map(labelJson),
    user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    created_at: EPOCH_ISO,
    updated_at: EPOCH_ISO,
    comments: i.comments.length,
  };
}

function pullJson(p: Pull): Record<string, unknown> {
  return {
    id: p.id,
    number: p.number,
    title: p.title,
    body: p.body,
    state: p.state,
    merged: p.merged,
    merged_at: p.merged_at,
    merge_commit_sha: p.merge_commit_sha,
    head: { ref: p.headRef, sha: p.headSha, label: `${VIEWER_LOGIN}:${p.headRef}` },
    base: { ref: p.baseRef, sha: p.baseSha, label: `${VIEWER_LOGIN}:${p.baseRef}` },
    user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    mergeable: true,
    created_at: EPOCH_ISO,
    updated_at: EPOCH_ISO,
  };
}

function commentJson(c: { id: number; body: string }): Record<string, unknown> {
  return {
    id: c.id,
    body: c.body,
    user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    created_at: EPOCH_ISO,
    updated_at: EPOCH_ISO,
  };
}

/** Parse a git ident line "Name <email> epoch tz" into a GitHub author object. */
function parseIdent(line: string): { name: string; email: string; date: string } {
  const m = /^(.+?) <([^>]*)> (\d+) ([+-]\d{4})$/.exec(line);
  if (!m) return { name: line, email: '', date: EPOCH_ISO };
  return { name: m[1], email: m[2], date: new Date(Number(m[3]) * 1000).toISOString() };
}

// ---------------------------------------------------------------- git helpers

/** Flatten a tree into path -> { oid, mode }. */
function flattenTree(treeOid: string | null, prefix: string, out: Map<string, { oid: string; mode: string }>): void {
  if (!treeOid) return;
  const obj = store.getObject(treeOid);
  if (!obj || obj.type !== 'tree') return;
  for (const e of parseTree(obj.bytes)) {
    const p = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.mode === '40000') flattenTree(e.oid, p, out);
    else out.set(p, { oid: e.oid, mode: e.mode });
  }
}

function countLines(buf: Buffer): number {
  if (buf.length === 0) return 0;
  const parts = buf.toString('utf8').split('\n');
  if (parts.length > 0 && parts[parts.length - 1] === '') parts.pop();
  return parts.length;
}

/** Diff base tree vs head tree into the PR file list. */
function diffTrees(baseTree: string | null, headTree: string | null): PullFile[] {
  const base = new Map<string, { oid: string; mode: string }>();
  const head = new Map<string, { oid: string; mode: string }>();
  flattenTree(baseTree, '', base);
  flattenTree(headTree, '', head);
  const files: PullFile[] = [];
  for (const [path, h] of head) {
    const b = base.get(path);
    const newBytes = store.getObject(h.oid)?.bytes ?? Buffer.alloc(0);
    if (!b) {
      const adds = Math.max(1, countLines(newBytes));
      files.push({ filename: path, status: 'added', additions: adds, deletions: 0, changes: adds });
    } else if (b.oid !== h.oid) {
      const oldBytes = store.getObject(b.oid)?.bytes ?? Buffer.alloc(0);
      const adds = Math.max(1, countLines(newBytes));
      const dels = countLines(oldBytes);
      files.push({ filename: path, status: 'modified', additions: adds, deletions: dels, changes: adds + dels });
    }
  }
  for (const [path, b] of base) {
    if (!head.has(path)) {
      const oldBytes = store.getObject(b.oid)?.bytes ?? Buffer.alloc(0);
      const dels = countLines(oldBytes);
      files.push({ filename: path, status: 'removed', additions: 0, deletions: dels, changes: dels });
    }
  }
  files.sort((a, b) => (a.filename < b.filename ? -1 : a.filename > b.filename ? 1 : 0));
  return files;
}

/** Create a commit on `branchName` writing (`bytes`) or deleting (null) `path`. */
function commitContents(
  repo: Repo,
  branchName: string,
  path: string,
  bytes: Buffer | null,
  message: string,
): { commitSha: string; blobSha: string | null } {
  const refName = `refs/heads/${branchName}`;
  let tip = repo.refs.get(refName);
  let parents: string[] = [];
  let baseTree: string | null = null;
  if (tip) {
    parents = [tip];
    baseTree = store.commitTree(tip) ?? null;
  } else {
    // New branch: start from the default branch tip when it exists.
    const defTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
    if (defTip && branchName !== repo.defaultBranch) {
      parents = [defTip];
      baseTree = store.commitTree(defTip) ?? null;
    }
  }
  let newTree: string | null;
  if (bytes === null) {
    if (!baseTree) throw new Error('no tree to delete from');
    const t = store.removeFileAtTree(baseTree, path);
    newTree = t ?? store.putObject('tree', buildTree([]));
  } else {
    newTree = store.writeFileAtTree(baseTree, path, bytes);
  }
  const ident = `${GIT_IDENTITY} ${COMMIT_EPOCH} +0000`;
  const commitSha = store.putObject('commit', buildCommit(newTree, parents, ident, ident, message));
  repo.refs.set(refName, commitSha);
  return { commitSha, blobSha: bytes === null ? null : objectId('blob', bytes) };
}

// ---------------------------------------------------------------- handler

export async function handleRest(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  search: URLSearchParams,
  body: Buffer | null,
): Promise<boolean> {
  const method = req.method ?? 'GET';

  // Auth: every /api/v3 route requires the token.
  if (!isAuthenticated(req)) {
    sendUnauthorized(res);
    return true;
  }

  // Parse a JSON body when one was sent; malformed JSON -> 400.
  let json: Record<string, unknown> = {};
  if (body !== null && body.length > 0) {
    const parsed = parseJson(body);
    if (!parsed.ok) {
      sendError(res, 400, 'Problems parsing JSON');
      return true;
    }
    if (parsed.value !== undefined && parsed.value !== null && typeof parsed.value === 'object') {
      json = parsed.value as Record<string, unknown>;
    } else if (parsed.value !== undefined && parsed.value !== null) {
      sendError(res, 400, 'Problems parsing JSON');
      return true;
    }
  }

  const segs = pathname.split('/').filter((s) => s !== '');
  // segs[0] === 'api', segs[1] === 'v3'
  const rest = segs.slice(2);

  // ---- API root
  if (rest.length === 0) {
    if (method !== 'GET') {
      sendError(res, 404, 'Not Found');
      return true;
    }
    res.setHeader('x-oauth-scopes', 'repo, read:org');
    sendJson(res, 200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' });
    return true;
  }

  // ---- /meta
  if (rest.length === 1 && rest[0] === 'meta') {
    if (method !== 'GET') {
      sendError(res, 404, 'Not Found');
      return true;
    }
    sendJson(res, 200, { installed_version: '1.0.0' });
    return true;
  }

  // ---- /user
  if (rest.length === 1 && rest[0] === 'user') {
    if (method !== 'GET') {
      sendError(res, 404, 'Not Found');
      return true;
    }
    sendJson(res, 200, {
      login: VIEWER_LOGIN,
      id: VIEWER_ID,
      type: 'User',
      html_url: `https://github.com/${VIEWER_LOGIN}`,
      url: '/api/v3/user',
    });
    return true;
  }

  // ---- /user/repos
  if (rest.length === 2 && rest[0] === 'user' && rest[1] === 'repos') {
    if (method === 'GET') {
      const perPage = Math.max(1, Math.min(100, Number(search.get('per_page') ?? '10') || 10));
      const page = Math.max(1, Number(search.get('page') ?? '1') || 1);
      const all = store.listRepos(VIEWER_LOGIN);
      const start = (page - 1) * perPage;
      const slice = all.slice(start, start + perPage);
      if (start + perPage < all.length) {
        const host = req.headers.host ?? '127.0.0.1';
        const nextUrl = `http://${host}/api/v3/user/repos?per_page=${perPage}&page=${page + 1}`;
        res.setHeader('link', `<${nextUrl}>; rel="next"`);
      }
      sendJson(res, 200, slice.map(repoJson));
      return true;
    }
    if (method === 'POST') {
      const name = json.name;
      if (typeof name !== 'string' || name === '') {
        sendError(res, 422, 'name is required');
        return true;
      }
      if (store.getRepo(VIEWER_LOGIN, name)) {
        sendError(res, 422, 'Repository already exists');
        return true;
      }
      const repo = store.createRepo(
        VIEWER_LOGIN,
        name,
        typeof json.description === 'string' ? json.description : '',
        json.private === true,
      );
      sendJson(res, 201, repoJson(repo));
      return true;
    }
    sendError(res, 404, 'Not Found');
    return true;
  }

  // ---- /repos/{owner}/{repo}/...
  if (rest.length >= 3 && rest[0] === 'repos') {
    const owner = rest[1];
    const repoName = rest[2];
    // Wrong owner -> 404, never 403.
    if (owner !== VIEWER_LOGIN) {
      sendError(res, 404, 'Not Found');
      return true;
    }
    const repo = store.getRepo(owner, repoName);
    const sub = rest.slice(3);

    // Repo itself: GET / PATCH / DELETE
    if (sub.length === 0) {
      if (method === 'GET') {
        if (!repo) {
          sendError(res, 404, 'Not Found');
          return true;
        }
        sendJson(res, 200, repoJson(repo));
        return true;
      }
      if (method === 'PATCH') {
        if (!repo) {
          sendError(res, 404, 'Not Found');
          return true;
        }
        if (typeof json.description === 'string') repo.description = json.description;
        if (typeof json.private === 'boolean') repo.private = json.private;
        if (typeof json.default_branch === 'string') repo.defaultBranch = json.default_branch;
        sendJson(res, 200, repoJson(repo));
        return true;
      }
      if (method === 'DELETE') {
        if (!repo) {
          sendError(res, 404, 'Not Found');
          return true;
        }
        store.deleteRepo(owner, repoName);
        sendJson(res, 204, null);
        return true;
      }
      sendError(res, 404, 'Not Found');
      return true;
    }

    if (!repo) {
      sendError(res, 404, 'Not Found');
      return true;
    }

    // ---- branches
    if (sub[0] === 'branches') {
      if (sub.length === 1) {
        if (method !== 'GET') {
          sendError(res, 404, 'Not Found');
          return true;
        }
        const out = [...repo.refs.entries()]
          .filter(([ref]) => ref.startsWith('refs/heads/'))
          .map(([ref, sha]) => ({ name: ref.slice('refs/heads/'.length), commit: { sha }, protected: false }))
          .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
        sendJson(res, 200, out);
        return true;
      }
      // GET /branches/{branch} (branch name may contain slashes)
      if (method !== 'GET') {
        sendError(res, 404, 'Not Found');
        return true;
      }
      const branch = sub.slice(1).join('/');
      const sha = store.resolveRef(repo, branch);
      if (!sha) {
        sendError(res, 404, 'Not Found');
        return true;
      }
      sendJson(res, 200, { name: branch, commit: { sha }, protected: false });
      return true;
    }

    // ---- commits
    if (sub.length === 1 && sub[0] === 'commits') {
      if (method !== 'GET') {
        sendError(res, 404, 'Not Found');
        return true;
      }
      const refParam = search.get('sha');
      const tip = refParam ? store.resolveRef(repo, refParam) ?? (repo.refs.get(refParam) ? repo.refs.get(refParam) : undefined) : repo.refs.get(`refs/heads/${repo.defaultBranch}`);
      if (!tip) {
        sendJson(res, 200, []);
        return true;
      }
      const out = store.walkCommits(tip).map((oid) => {
        const obj = store.getObject(oid)!;
        const info = parseCommit(obj.bytes);
        return {
          sha: oid,
          commit: {
            message: info.message,
            author: parseIdent(info.author),
            committer: parseIdent(info.committer),
          },
          parents: info.parents.map((p) => ({ sha: p })),
        };
      });
      sendJson(res, 200, out);
      return true;
    }

    // ---- git/refs
    if (sub[0] === 'git' && sub[1] === 'refs') {
      if (sub.length === 2 && method === 'POST') {
        const ref = json.ref;
        const sha = json.sha;
        if (typeof ref !== 'string' || !ref.startsWith('refs/') || typeof sha !== 'string' || sha === '') {
          sendError(res, 422, 'ref and sha are required');
          return true;
        }
        if (repo.refs.has(ref)) {
          sendError(res, 422, 'Reference already exists');
          return true;
        }
        const obj = store.getObject(sha);
        if (!obj || obj.type !== 'commit') {
          sendError(res, 422, 'Object does not exist');
          return true;
        }
        repo.refs.set(ref, sha);
        sendJson(res, 201, { ref, object: { sha, type: 'commit' }, sha, commit: { sha } });
        return true;
      }
      if (sub.length >= 4 && sub[2] === 'heads' && method === 'GET') {
        const branch = sub.slice(3).join('/');
        const sha = store.resolveRef(repo, branch);
        if (!sha) {
          sendError(res, 404, 'Not Found');
          return true;
        }
        sendJson(res, 200, {
          ref: `refs/heads/${branch}`,
          object: { sha, type: 'commit' },
          sha,
          commit: { sha },
        });
        return true;
      }
      sendError(res, 404, 'Not Found');
      return true;
    }

    // ---- contents
    if (sub[0] === 'contents') {
      const path = sub.slice(1).join('/');
      if (method === 'PUT') {
        const message = typeof json.message === 'string' ? json.message : `Update ${path}`;
        const content = json.content;
        if (typeof content !== 'string') {
          sendError(res, 422, 'content is required');
          return true;
        }
        const bytes = b64decode(content);
        const branch = typeof json.branch === 'string' && json.branch !== '' ? json.branch : repo.defaultBranch;
        const tip = store.resolveRef(repo, branch);
        if (typeof json.sha === 'string') {
          // Update: the supplied sha must match the current blob sha.
          const curBytes = tip ? store.readFileAtTree(store.commitTree(tip) ?? '', path) : undefined;
          const curSha = curBytes ? objectId('blob', curBytes) : undefined;
          if (curSha !== json.sha) {
            sendError(res, 409, 'sha does not match the current blob');
            return true;
          }
        }
        const existed = tip ? store.readFileAtTree(store.commitTree(tip) ?? '', path) !== undefined : false;
        const { commitSha, blobSha } = commitContents(repo, branch, path, bytes, message);
        sendJson(res, existed ? 200 : 201, {
          content: {
            name: path.split('/').pop() ?? path,
            path,
            sha: blobSha,
            size: bytes.length,
            type: 'file',
            encoding: 'base64',
            content: b64encode(bytes),
          },
          commit: { sha: commitSha, message },
        });
        return true;
      }
      if (method === 'GET') {
        const refParam = search.get('ref');
        let tip: string | undefined;
        if (refParam) {
          tip = /^[0-9a-f]{40}$/.test(refParam) ? refParam : store.resolveRef(repo, refParam);
        } else {
          tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
        }
        if (!tip) {
          sendError(res, 404, 'Not Found');
          return true;
        }
        const treeOid = store.commitTree(tip);
        if (!treeOid) {
          sendError(res, 404, 'Not Found');
          return true;
        }
        if (path === '') {
          const entries = store.listDirAtTree(treeOid, '');
          if (!entries) {
            sendError(res, 404, 'Not Found');
            return true;
          }
          sendJson(res, 200, entries.map((e) => dirEntryJson(e, '')));
          return true;
        }
        const bytes = store.readFileAtTree(treeOid, path);
        if (bytes !== undefined) {
          sendJson(res, 200, {
            type: 'file',
            encoding: 'base64',
            size: bytes.length,
            name: path.split('/').pop() ?? path,
            path,
            content: b64encode(bytes),
            sha: objectId('blob', bytes),
          });
          return true;
        }
        const entries = store.listDirAtTree(treeOid, path);
        if (entries) {
          sendJson(res, 200, entries.map((e) => dirEntryJson(e, path)));
          return true;
        }
        sendError(res, 404, 'Not Found');
        return true;
      }
      if (method === 'DELETE') {
        const message = typeof json.message === 'string' ? json.message : `Delete ${path}`;
        const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
        if (!tip) {
          sendError(res, 404, 'Not Found');
          return true;
        }
        const curBytes = store.readFileAtTree(store.commitTree(tip) ?? '', path);
        if (curBytes === undefined) {
          sendError(res, 404, 'Not Found');
          return true;
        }
        if (typeof json.sha === 'string' && json.sha !== objectId('blob', curBytes)) {
          sendError(res, 409, 'sha does not match the current blob');
          return true;
        }
        const { commitSha } = commitContents(repo, repo.defaultBranch, path, null, message);
        sendJson(res, 200, { commit: { sha: commitSha, message } });
        return true;
      }
      sendError(res, 404, 'Not Found');
      return true;
    }

    // ---- labels
    if (sub.length === 1 && sub[0] === 'labels') {
      if (method !== 'POST') {
        sendError(res, 404, 'Not Found');
        return true;
      }
      const name = json.name;
      if (typeof name !== 'string' || name === '') {
        sendError(res, 422, 'name is required');
        return true;
      }
      const color = typeof json.color === 'string' ? json.color : 'ededed';
      let label = repo.labels.find((l) => l.name === name);
      if (!label) {
        label = { name, color };
        repo.labels.push(label);
      }
      sendJson(res, 201, labelJson(label));
      return true;
    }

    // ---- issues
    if (sub[0] === 'issues') {
      if (sub.length === 1) {
        if (method === 'GET') {
          const state = search.get('state') ?? 'open';
          const direction = search.get('direction') ?? 'desc';
          let list = [...repo.issues];
          if (state === 'open') list = list.filter((i) => i.state === 'open');
          else if (state === 'closed') list = list.filter((i) => i.state === 'closed');
          list.sort((a, b) => (direction === 'asc' ? a.createdAt - b.createdAt : b.createdAt - a.createdAt));
          const perPageRaw = search.get('per_page');
          if (perPageRaw) {
            const perPage = Math.max(1, Number(perPageRaw) || 30);
            list = list.slice(0, perPage);
          }
          sendJson(res, 200, list.map(issueJson));
          return true;
        }
        if (method === 'POST') {
          const title = json.title;
          if (typeof title !== 'string' || title === '') {
            sendError(res, 422, 'title is required');
            return true;
          }
          const rawLabels = Array.isArray(json.labels) ? json.labels : [];
          const labelNames: string[] = [];
          for (const l of rawLabels) {
            if (typeof l === 'string') labelNames.push(l);
            else if (l && typeof l === 'object' && typeof (l as Record<string, unknown>).name === 'string') {
              labelNames.push((l as Record<string, unknown>).name as string);
            }
          }
          for (const n of labelNames) {
            if (!repo.labels.some((l) => l.name === n)) {
              sendError(res, 422, `Label does not exist: ${n}`);
              return true;
            }
          }
          const issue = store.createIssue(
            repo,
            title,
            typeof json.body === 'string' ? json.body : '',
            labelNames,
          );
          sendJson(res, 201, issueJson(issue));
          return true;
        }
        sendError(res, 404, 'Not Found');
        return true;
      }
      const num = Number(sub[1]);
      if (!Number.isInteger(num) || num < 1) {
        sendError(res, 404, 'Not Found');
        return true;
      }
      const issue = repo.issues.find((i) => i.number === num);
      if (sub.length === 2) {
        if (method === 'GET') {
          if (!issue) {
            sendError(res, 404, 'Not Found');
            return true;
          }
          sendJson(res, 200, issueJson(issue));
          return true;
        }
        if (method === 'PATCH') {
          if (!issue) {
            sendError(res, 404, 'Not Found');
            return true;
          }
          if (json.state === 'open' || json.state === 'closed') issue.state = json.state;
          if (typeof json.title === 'string') issue.title = json.title;
          if (typeof json.body === 'string') issue.body = json.body;
          sendJson(res, 200, issueJson(issue));
          return true;
        }
        sendError(res, 404, 'Not Found');
        return true;
      }
      if (sub.length === 3 && sub[2] === 'comments') {
        if (!issue) {
          sendError(res, 404, 'Not Found');
          return true;
        }
        if (method === 'GET') {
          sendJson(res, 200, issue.comments.map(commentJson));
          return true;
        }
        if (method === 'POST') {
          if (typeof json.body !== 'string') {
            sendError(res, 422, 'body is required');
            return true;
          }
          const comment = store.createComment(issue, json.body, VIEWER_LOGIN);
          sendJson(res, 201, commentJson(comment));
          return true;
        }
        sendError(res, 404, 'Not Found');
        return true;
      }
      sendError(res, 404, 'Not Found');
      return true;
    }

    // ---- pulls
    if (sub[0] === 'pulls') {
      if (sub.length === 1) {
        if (method === 'GET') {
          const state = search.get('state') ?? 'open';
          let list = [...repo.pulls];
          if (state === 'open') list = list.filter((p) => p.state === 'open');
          else if (state === 'closed') list = list.filter((p) => p.state === 'closed');
          list.sort((a, b) => b.createdAt - a.createdAt);
          sendJson(res, 200, list.map(pullJson));
          return true;
        }
        if (method === 'POST') {
          const title = json.title;
          if (typeof title !== 'string' || title === '') {
            sendError(res, 422, 'title is required');
            return true;
          }
          const headRef = refNameOf(json.head);
          const baseRef = refNameOf(json.base);
          if (!headRef || !baseRef) {
            sendError(res, 422, 'head and base are required');
            return true;
          }
          const headSha = store.resolveRef(repo, headRef);
          const baseSha = store.resolveRef(repo, baseRef);
          if (!headSha || !baseSha) {
            sendError(res, 422, 'head or base ref does not exist');
            return true;
          }
          const files = diffTrees(store.commitTree(baseSha) ?? null, store.commitTree(headSha) ?? null);
          const pull = store.createPull(
            repo,
            title,
            typeof json.body === 'string' ? json.body : '',
            headRef,
            headSha,
            baseRef,
            baseSha,
            files,
          );
          sendJson(res, 201, pullJson(pull));
          return true;
        }
        sendError(res, 404, 'Not Found');
        return true;
      }
      const num = Number(sub[1]);
      if (!Number.isInteger(num) || num < 1) {
        sendError(res, 404, 'Not Found');
        return true;
      }
      const pull = repo.pulls.find((p) => p.number === num);
      if (sub.length === 2) {
        if (method !== 'GET') {
          sendError(res, 404, 'Not Found');
          return true;
        }
        if (!pull) {
          sendError(res, 404, 'Not Found');
          return true;
        }
        sendJson(res, 200, pullJson(pull));
        return true;
      }
      if (sub.length === 3 && sub[2] === 'files') {
        if (method !== 'GET') {
          sendError(res, 404, 'Not Found');
          return true;
        }
        if (!pull) {
          sendError(res, 404, 'Not Found');
          return true;
        }
        sendJson(res, 200, pull.files);
        return true;
      }
      if (sub.length === 3 && sub[2] === 'merge') {
        if (method !== 'PUT') {
          sendError(res, 404, 'Not Found');
          return true;
        }
        if (!pull) {
          sendError(res, 404, 'Not Found');
          return true;
        }
        const result = mergePull(repo, pull);
        if (result.status === 200) sendJson(res, 200, result.body);
        else sendError(res, result.status, (result.body as { message: string }).message);
        return true;
      }
      sendError(res, 404, 'Not Found');
      return true;
    }

    sendError(res, 404, 'Not Found');
    return true;
  }

  // Unknown /api/v3 route.
  sendError(res, 404, 'Not Found');
  return true;
}

/** A directory entry as GitHub's contents API returns it. */
function dirEntryJson(e: { mode: string; name: string; oid: string }, dirPath: string): Record<string, unknown> {
  const isDir = e.mode === '40000';
  const out: Record<string, unknown> = {
    type: isDir ? 'dir' : 'file',
    name: e.name,
    path: dirPath ? `${dirPath}/${e.name}` : e.name,
    sha: e.oid,
  };
  if (!isDir) {
    const blob = store.getObject(e.oid);
    if (blob) out.size = blob.bytes.length;
  }
  return out;
}

/** A head/base value may be a string ("branch") or an object { ref }. */
function refNameOf(v: unknown): string | null {
  if (typeof v === 'string') return v;
  if (v && typeof v === 'object') {
    const r = (v as Record<string, unknown>).ref;
    if (typeof r === 'string') return r;
  }
  return null;
}

/** Squash-merge `pull` onto its base branch. Returns the HTTP status + body. */
function mergePull(repo: Repo, pull: Pull): { status: number; body: unknown } {
  if (pull.merged) return { status: 405, body: { message: 'Pull request has already been merged' } };
  const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
  if (!baseTip) return { status: 404, body: { message: 'Not Found' } };
  const baseTree = store.commitTree(baseTip) ?? null;
  const baseAtCreationTree = store.commitTree(pull.baseSha) ?? null;
  const headTree = store.commitTree(pull.headSha) ?? null;

  // Conflict: a file this PR changes was changed on base since the PR was opened, to content
  // that is neither the PR's base version nor the PR's head version.
  for (const f of pull.files) {
    const cur = baseTree ? store.readFileAtTree(baseTree, f.filename) : undefined;
    const old = baseAtCreationTree ? store.readFileAtTree(baseAtCreationTree, f.filename) : undefined;
    const head = headTree ? store.readFileAtTree(headTree, f.filename) : undefined;
    const same = (a: Buffer | undefined, b: Buffer | undefined): boolean =>
      (a === undefined && b === undefined) || (a !== undefined && b !== undefined && a.equals(b));
    if (!same(cur, old) && !same(cur, head)) {
      return { status: 405, body: { message: 'Merge conflict' } };
    }
  }

  // Apply the head's changed files onto the base tree.
  let newTree = baseTree;
  for (const f of pull.files) {
    const headBytes = headTree ? store.readFileAtTree(headTree, f.filename) : undefined;
    if (f.status === 'removed' || headBytes === undefined) {
      if (newTree) {
        const t = store.removeFileAtTree(newTree, f.filename);
        newTree = t ?? store.putObject('tree', buildTree([]));
      }
    } else {
      newTree = store.writeFileAtTree(newTree, f.filename, headBytes);
    }
  }
  if (!newTree) newTree = store.putObject('tree', buildTree([]));
  const ident = `${GIT_IDENTITY} ${COMMIT_EPOCH} +0000`;
  const message = `Merge pull request #${pull.number} from ${VIEWER_LOGIN}/${pull.headRef}`;
  const sha = store.putObject('commit', buildCommit(newTree, [baseTip], ident, ident, message));
  repo.refs.set(`refs/heads/${pull.baseRef}`, sha);
  pull.state = 'closed';
  pull.merged = true;
  pull.merged_at = EPOCH_ISO;
  pull.merge_commit_sha = sha;
  return { status: 200, body: { merged: true, sha, message } };
}
