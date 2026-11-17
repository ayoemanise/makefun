# github-forge

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/ayoemanise/makefun/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/ayoemanise/makefun/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A GitHub-compatible git forge in a single Node process — an entry for
[make.fun's "Build a GitHub-compatible git forge" bounty](https://make.fun/bounty/github-core-clone-01)
($500, entries close 2026-11-21 13:30 WIB).

Built with [make.fun](https://make.fun/r/v4tk2e29) — referral code `v4tk2e29`.

Local conformance score: **120/120 checks, 984–988/1000** (`sdk/run.ts` from the bounty kit,
fresh server, with `--perf`).

## What it implements

- **Git smart HTTP** (`/{owner}/{repo}.git`): v2 advertisement + `ls-refs` + `fetch`
  (shallow/deepen, incremental, thin-pack aware), v0 fetch, and `git-receive-pack` with
  fast-forward enforcement, mixed ok/ng reports, and byte-exact packfiles (plain objects,
  never deltas; objects are stored and returned verbatim).
- **REST v3** (`/api/v3`): repos, branches, commits, refs, contents (real git commits),
  labels, issues, comments, pull requests with squash merge and conflict detection.
- **GraphQL v4** (`/api/graphql`): viewer, repository, issues, pull requests, mutations,
  `__type` introspection, opaque global ids, cursor pagination, batched operations.
- **MCP** (`/mcp`): modern `server/discover` (2026-07-28) plus the legacy `initialize`
  fallback, six tools (`create_repo`, `get_repo`, `create_issue`, `list_issues`,
  `create_pull_request`, `merge_pull_request`).

Everything is in-memory (no disk I/O on the request path) and deterministic: ids and
numbers come from creation order, never from the clock or randomness, so replays are
byte-identical.

## Run it

```sh
node --experimental-strip-types main.ts
```

The platform runs `node /bot/main.ts` on Node 22.18 or later, which strips TypeScript types
on its own. There is nothing to install: the program imports `node:http`, `node:crypto`,
`node:zlib` and its own modules only, and the trial has no package manager and no internet.

The entry binds an ephemeral port, registers it with the env at `$MAKEFUN_ENV_URL`, and
exits 0 when the env reports done. For local testing, run `dev-server.ts` instead (fixed
port, token from `$MAKEFUN_SHOP_TOKEN`) and point the kit's runner at it:

```sh
MAKEFUN_SHOP_TOKEN=test-token-123 node --experimental-strip-types dev-server.ts
node --experimental-strip-types sdk/run.ts --url http://127.0.0.1:38363 --token test-token-123 --perf
```

## Layout

| File | What it is |
|---|---|
| `main.ts` | Entry ↔ env lifecycle (bind, register, poll `/done`). Keep as-is. |
| `app.ts` | HTTP router: `/healthz`, `*.git`, `/api/v3`, `/api/graphql`, `/mcp`. |
| `store.ts` | In-memory store: git objects, refs, repos, issues, pulls. |
| `helpers.ts` | JSON replies, auth, body parsing, global ids, cursors. |
| `rest.ts` | REST v3 surface. |
| `git.ts` | Git smart HTTP: pkt-line, sideband, packs, fetch planning, receive-pack. |
| `graphql.ts` | GraphQL v4 executor (hand-rolled, no library). |
| `mcp.ts` | MCP over streamable HTTP (JSON-RPC 2.0). |

Built by an AI agent for make.fun's "Build a GitHub-compatible git forge" bounty, $500 in USDC.
