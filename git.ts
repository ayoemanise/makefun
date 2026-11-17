// Git smart HTTP: git-upload-pack / git-receive-pack, protocol v0 and v2.
// Implements SPEC.md section 4 (30 checks): pkt-line framing, sideband, v2 ls-refs/fetch,
// v0 fetch, pack read/write (plain objects only, never deltas), receive-pack with the
// fast-forward rule and report-status. Object bytes are stored and returned verbatim;
// object selection never re-sends anything the client already holds.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { store, objectId, parseCommit, parseTag, parseTree, VIEWER_LOGIN } from './store.ts';
import type { ObjType, Repo } from './store.ts';
import { isAuthenticated } from './helpers.ts';

const ZERO_OID = '0'.repeat(40);
const AGENT = 'forge/1.0';

const TYPE_CODE: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, ObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

let gitRequestCounter = 0;

// ---------------------------------------------------------------- pkt-line

type PktKind = 'data' | 'flush' | 'delim' | 'response-end';

interface Pkt {
  kind: PktKind;
  payload: Buffer;
}

/** One pkt-line: 4 lowercase hex length bytes (payload + 4) then the payload. */
function pktLine(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  if (data.length > 65516) throw new Error('pkt-line payload too long');
  const header = Buffer.alloc(4);
  header.write((data.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([header, data]);
}

function pktFlush(): Buffer {
  return Buffer.from('0000', 'ascii');
}

function pktDelim(): Buffer {
  return Buffer.from('0001', 'ascii');
}

/**
 * Parse every pkt-line in `buf`, stopping at the first bytes that are not a pkt-line header
 * (a raw pack after a flush). Returns the packets and the unparsed remainder.
 * A body that is not pkt-lines at all yields zero packets and the whole body as `rest`.
 */
function parsePktLines(buf: Buffer): { packets: Pkt[]; rest: Buffer } {
  const packets: Pkt[] = [];
  let offset = 0;
  while (offset < buf.length) {
    if (offset + 4 > buf.length) break;
    const header = buf.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(header)) break;
    const len = parseInt(header, 16);
    if (len === 0) {
      packets.push({ kind: 'flush', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (len === 1) {
      packets.push({ kind: 'delim', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (len === 2) {
      packets.push({ kind: 'response-end', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (len === 3) throw new Error('invalid pkt-line length 0003');
    if (len > 65520) throw new Error('pkt-line too long');
    if (offset + len > buf.length) throw new Error('truncated pkt-line');
    packets.push({ kind: 'data', payload: buf.subarray(offset + 4, offset + len) });
    offset += len;
  }
  return { packets, rest: buf.subarray(offset) };
}

/** Split `data` into sideband frames (band byte + chunk), each a pkt-line. */
function sidebandFrames(band: 1 | 2 | 3, data: Buffer): Buffer[] {
  const frames: Buffer[] = [];
  const bandByte = Buffer.from([band]);
  if (data.length === 0) {
    frames.push(pktLine(bandByte));
    return frames;
  }
  for (let i = 0; i < data.length; i += 32768) {
    frames.push(pktLine(Buffer.concat([bandByte, data.subarray(i, Math.min(i + 32768, data.length))])));
  }
  return frames;
}

// ---------------------------------------------------------------- packs

/** Encode one object's pack header: the type/size varint. */
function packObjectHeader(type: ObjType, size: number): Buffer {
  const code = TYPE_CODE[type];
  const bytes: number[] = [];
  let remaining = size;
  let first = (code << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

/** Build a packfile from plain objects (never deltas). Deterministic: sorted by oid. */
function buildPack(objects: Array<{ type: ObjType; bytes: Buffer }>): Buffer {
  const withOid = objects.map((o) => ({ ...o, oid: objectId(o.type, o.bytes) }));
  const sorted = withOid.sort((a, b) => (a.oid < b.oid ? -1 : a.oid > b.oid ? 1 : 0));
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(sorted.length, 8);
  parts.push(header);
  for (const object of sorted) {
    parts.push(packObjectHeader(object.type, object.bytes.length));
    parts.push(deflateSync(object.bytes));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

function readVarintSize(buffer: Buffer, start: number): { size: number; next: number; first: number } {
  if (start >= buffer.length) throw new Error('pack entry has no size header');
  let byte = buffer[start];
  const first = byte;
  let size = byte & 0x0f;
  let shift = 4;
  let offset = start + 1;
  while (byte & 0x80) {
    if (offset >= buffer.length) throw new Error('pack entry size varint is truncated');
    byte = buffer[offset++];
    size += (byte & 0x7f) * 2 ** shift;
    shift += 7;
    if (shift > 63) throw new Error('pack entry size varint is too long');
  }
  return { size, next: offset, first };
}

/** Inflate one zlib stream at `offset` (bounded by `end`); returns bytes and the next offset. */
function inflateAt(buffer: Buffer, offset: number, end: number): { data: Buffer; next: number } {
  const view = buffer.subarray(offset, end);
  let result: { buffer: Buffer; engine: { bytesWritten: number } };
  try {
    result = inflateSync(view, { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
  } catch (err) {
    throw new Error(`zlib stream at offset ${offset} did not inflate: ${(err as Error).message}`);
  }
  const written = result.engine.bytesWritten;
  if (!written || written <= 0) throw new Error(`zlib stream at offset ${offset} consumed no bytes`);
  return { data: result.buffer, next: offset + written };
}

interface ParsedPackObject {
  type: ObjType;
  bytes: Buffer;
  oid: string;
}

/** Parse and verify a packfile (plain objects only). Throws on any corruption. */
function parsePack(pack: Buffer): ParsedPackObject[] {
  if (pack.length < 32) throw new Error('pack is too short');
  if (pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('pack does not start with PACK');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = pack.readUInt32BE(8);
  const trailerStart = pack.length - 20;
  const trailer = pack.subarray(trailerStart).toString('hex');
  const computed = createHash('sha1').update(pack.subarray(0, trailerStart)).digest('hex');
  if (trailer !== computed) throw new Error('pack trailer checksum mismatch');
  const objects: ParsedPackObject[] = [];
  let offset = 12;
  for (let index = 0; index < count; index += 1) {
    const header = readVarintSize(pack, offset);
    offset = header.next;
    const typeCode = (header.first >> 4) & 0x07;
    if (typeCode === 6 || typeCode === 7) throw new Error('delta objects are not accepted');
    const type = CODE_TYPE[typeCode];
    if (!type) throw new Error(`unknown pack object type ${typeCode}`);
    const inflated = inflateAt(pack, offset, trailerStart);
    offset = inflated.next;
    if (inflated.data.length !== header.size) {
      throw new Error(`pack entry at ${index} declares ${header.size} bytes but inflated to ${inflated.data.length}`);
    }
    objects.push({ type, bytes: inflated.data, oid: objectId(type, inflated.data) });
  }
  if (offset !== trailerStart) throw new Error('pack has trailing bytes before its trailer');
  return objects;
}

// ---------------------------------------------------------------- fetch planning

interface FetchPlan {
  objects: Array<{ type: ObjType; bytes: Buffer }>;
  shallow: string[];
  unshallow: string[];
  acks: string[];
}

/** All objects in a commit's own tree closure (commit + trees + blobs, not parents). */
function commitTreeClosure(commitOid: string, clientHasObjects: Set<string>, out: Set<string>): void {
  const obj = store.getObject(commitOid);
  if (!obj || obj.type !== 'commit') return;
  const stack: string[] = [parseCommit(obj.bytes).tree];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (out.has(oid) || clientHasObjects.has(oid)) continue;
    const entry = store.getObject(oid);
    if (!entry) continue;
    out.add(oid);
    if (entry.type === 'tree') {
      for (const child of parseTree(entry.bytes)) stack.push(child.oid);
    }
  }
}

/**
 * Decide what a fetch sends. `wants` are the wanted oids, `haves` the oids the client holds,
 * `shallowBoundaries` the client's shallow commits (it holds them but not their parents),
 * `depth` the deepen limit (null = full history).
 *
 * Rules: send only objects the client does not have (a want already held sends an empty pack);
 * depth N sends commits up to N generations from the wants; the new boundary is the depth-N
 * frontier; an old boundary becomes unshallow when its parents are all delivered or held.
 */
function planFetch(
  wants: string[],
  haves: string[],
  shallowBoundaries: string[],
  depth: number | null,
): FetchPlan {
  const shallowSet = new Set(shallowBoundaries);

  // Expand wants: commits are seeds; tags contribute the tag object and recurse into their
  // target; tree/blob wants contribute the object (and a tree's contents).
  const seedCommits: string[] = [];
  const extraOids = new Set<string>();
  const expand = (oid: string, seen: Set<string>): void => {
    if (seen.has(oid)) return;
    seen.add(oid);
    const obj = store.getObject(oid);
    if (!obj) return;
    if (obj.type === 'commit') {
      seedCommits.push(oid);
      return;
    }
    extraOids.add(oid);
    if (obj.type === 'tag') expand(parseTag(obj.bytes).object, seen);
    else if (obj.type === 'tree') {
      for (const child of parseTree(obj.bytes)) expand(child.oid, seen);
    }
  };
  const seenWants = new Set<string>();
  for (const want of wants) expand(want, seenWants);

  // BFS from the seeds, depth-limited (depth 1 = the seeds themselves).
  const depthOf = new Map<string, number>();
  const queue: string[] = [];
  for (const seed of seedCommits) {
    if (!depthOf.has(seed)) {
      depthOf.set(seed, 1);
      queue.push(seed);
    }
  }
  for (let qi = 0; qi < queue.length; qi += 1) {
    const oid = queue[qi];
    const d = depthOf.get(oid)!;
    if (depth !== null && d >= depth) continue;
    const obj = store.getObject(oid);
    if (!obj || obj.type !== 'commit') continue;
    for (const parent of parseCommit(obj.bytes).parents) {
      if (!depthOf.has(parent)) {
        depthOf.set(parent, d + 1);
        queue.push(parent);
      }
    }
  }
  const wantCommits = new Set(depthOf.keys());

  // What the client holds: BFS from the haves, never crossing a shallow boundary
  // (the client holds the boundary commit itself, but not its parents).
  const clientHasCommits = new Set<string>();
  const havesQueue: string[] = [];
  for (const have of haves) {
    const obj = store.getObject(have);
    if (obj && obj.type === 'commit' && !clientHasCommits.has(have)) {
      clientHasCommits.add(have);
      havesQueue.push(have);
    }
  }
  for (let hi = 0; hi < havesQueue.length; hi += 1) {
    const oid = havesQueue[hi];
    if (shallowSet.has(oid)) continue;
    const obj = store.getObject(oid);
    if (!obj || obj.type !== 'commit') continue;
    for (const parent of parseCommit(obj.bytes).parents) {
      if (!clientHasCommits.has(parent)) {
        clientHasCommits.add(parent);
        havesQueue.push(parent);
      }
    }
  }

  // The client's held objects: the held commits plus their tree closures.
  const clientHasObjects = new Set<string>();
  for (const held of clientHasCommits) {
    clientHasObjects.add(held);
    commitTreeClosure(held, new Set<string>(), clientHasObjects);
  }

  // New commits = wanted commits the client does not hold.
  const newCommits = [...wantCommits].filter((c) => !clientHasCommits.has(c));

  const sendOids = new Set<string>();
  for (const commit of newCommits) {
    sendOids.add(commit);
    commitTreeClosure(commit, clientHasObjects, sendOids);
  }
  for (const oid of extraOids) {
    if (!clientHasObjects.has(oid)) sendOids.add(oid);
  }
  const objects = [...sendOids].map((oid) => {
    const found = store.getObject(oid)!;
    return { type: found.type, bytes: found.bytes };
  });

  // New shallow boundary: the depth frontier of the delivered commits.
  const shallow: string[] = [];
  if (depth !== null) {
    for (const commit of newCommits) {
      if (depthOf.get(commit) === depth) shallow.push(commit);
    }
    shallow.sort();
  }

  // An old boundary is unshallow when its parents are all delivered or already held,
  // and it is an ancestor-or-equal of a want.
  const unshallow: string[] = [];
  const available = new Set([...newCommits, ...clientHasCommits]);
  for (const boundary of shallowBoundaries) {
    const obj = store.getObject(boundary);
    if (!obj || obj.type !== 'commit') continue;
    const parents = parseCommit(obj.bytes).parents;
    if (parents.length === 0) continue;
    if (!parents.every((p) => available.has(p))) continue;
    const related = seedCommits.some((seed) => boundary === seed || store.isAncestor(boundary, seed));
    if (!related) continue;
    unshallow.push(boundary);
  }
  unshallow.sort();

  // ACKs: haves that are ancestors-or-equal of a want.
  const acks: string[] = [];
  for (const have of haves) {
    if (wantCommits.has(have)) {
      acks.push(have);
      continue;
    }
    for (const seed of seedCommits) {
      if (store.isAncestor(have, seed)) {
        acks.push(have);
        break;
      }
    }
  }

  return { objects, shallow, unshallow, acks };
}

// ---------------------------------------------------------------- responses

function sendGitBuffer(res: ServerResponse, status: number, contentType: string, body: Buffer): void {
  gitRequestCounter += 1;
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': String(body.length),
    'x-github-request-id': `git-${gitRequestCounter}`,
  });
  res.end(body);
}

function sendGitJson(res: ServerResponse, status: number, message: string): void {
  sendGitBuffer(res, status, 'application/json', Buffer.from(JSON.stringify({ message }), 'utf8'));
}

function sendGitError(res: ServerResponse, status: number, message: string): void {
  sendGitBuffer(res, status, 'text/plain; charset=utf-8', Buffer.from(message, 'utf8'));
}

// ---------------------------------------------------------------- advertisements

function v0UploadCapabilities(): string {
  return 'side-band-64k multi_ack_detailed thin-pack no-progress ofs-delta shallow symref=HEAD:refs/heads/main';
}

function v0ReceiveCapabilities(): string {
  return 'report-status report-status-v2 side-band-64k delete-refs ofs-delta symref=HEAD:refs/heads/main';
}

/** v0 ref lines: HEAD first (carrying the capabilities after NUL), then sorted refs, then `^{}` peel lines. */
function v0RefLines(repo: Repo, capabilities: string): Buffer[] {
  const refs = store.listRefs(repo);
  const lines: Buffer[] = [];
  if (refs.length === 0) {
    lines.push(pktLine(`${ZERO_OID} capabilities^{}\0${capabilities}\n`));
    return lines;
  }
  const mainTip = repo.refs.get('refs/heads/main');
  const headOid = mainTip ?? refs.find(([name]) => name.startsWith('refs/heads/'))?.[1] ?? ZERO_OID;
  lines.push(pktLine(`${headOid} HEAD\0${capabilities}\n`));
  for (const [name, oid] of refs) {
    lines.push(pktLine(`${oid} ${name}\n`));
    if (name.startsWith('refs/tags/')) {
      const obj = store.getObject(oid);
      if (obj && obj.type === 'tag') {
        const target = parseTag(obj.bytes);
        if (target.type === 'commit') lines.push(pktLine(`${target.object} ${name}^{}\n`));
      }
    }
  }
  return lines;
}

function v0Advertisement(service: 'git-upload-pack' | 'git-receive-pack', repo: Repo): Buffer {
  const caps = service === 'git-upload-pack' ? v0UploadCapabilities() : v0ReceiveCapabilities();
  return Buffer.concat([pktLine(`# service=${service}\n`), pktFlush(), ...v0RefLines(repo, caps)]);
}

function v2Advertisement(): Buffer {
  return Buffer.concat([
    pktLine('version 2\n'),
    pktLine(`agent=${AGENT}\n`),
    pktLine('ls-refs=unborn\n'),
    pktLine('fetch=shallow\n'),
    pktLine('object-format=sha1\n'),
    pktLine('\n'),
    pktFlush(),
  ]);
}

// ---------------------------------------------------------------- ls-refs

interface LsRefsArgs {
  peel: boolean;
  symrefs: boolean;
  unborn: boolean;
  prefixes: string[];
}

function lsRefsResponse(repo: Repo, args: LsRefsArgs): Buffer {
  const parts: Buffer[] = [];
  const keep = (name: string): boolean =>
    args.prefixes.length === 0 || args.prefixes.some((prefix) => name.startsWith(prefix));
  const mainTip = repo.refs.get('refs/heads/main');
  if (keep('HEAD')) {
    if (mainTip) {
      parts.push(pktLine(`${mainTip} HEAD symref-target:refs/heads/main\n`));
    } else if (args.unborn) {
      parts.push(pktLine('unborn HEAD symref-target:refs/heads/main\n'));
    }
  }
  for (const [name, oid] of store.listRefs(repo)) {
    if (!keep(name)) continue;
    let line = `${oid} ${name}`;
    if (name.startsWith('refs/tags/')) {
      const obj = store.getObject(oid);
      if (obj && obj.type === 'tag') {
        const target = parseTag(obj.bytes);
        if (target.type === 'commit') line += ` peeled:${target.object}`;
      }
    }
    parts.push(pktLine(`${line}\n`));
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- fetch responses

function buildV2FetchResponse(plan: FetchPlan): Buffer {
  const parts: Buffer[] = [];
  parts.push(pktLine('acknowledgments\n'));
  if (plan.acks.length > 0) {
    for (const ack of plan.acks) parts.push(pktLine(`ACK ${ack}\n`));
    parts.push(pktLine('ready\n'));
  } else {
    parts.push(pktLine('NAK\n'));
  }
  parts.push(pktDelim());
  if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(pktDelim());
  }
  parts.push(pktLine('packfile\n'));
  const pack = buildPack(plan.objects);
  parts.push(...sidebandFrames(1, pack));
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

function buildV0FetchResponse(plan: FetchPlan): Buffer {
  const parts: Buffer[] = [];
  if (plan.acks.length > 0) {
    for (const ack of plan.acks) parts.push(pktLine(`ACK ${ack}\n`));
  } else {
    parts.push(pktLine('NAK\n'));
  }
  for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  const pack = buildPack(plan.objects);
  parts.push(...sidebandFrames(1, pack));
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- upload-pack

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
}

function parseV2Args(packets: Pkt[]): FetchArgs {
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let depth: number | null = null;
  let afterDelim = false;
  for (const packet of packets.slice(1)) {
    if (packet.kind === 'delim') {
      afterDelim = true;
      continue;
    }
    if (packet.kind === 'flush') break;
    if (packet.kind !== 'data' || !afterDelim) continue;
    const line = packet.payload.toString('utf8').trim();
    if (line.startsWith('want ')) wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) {
      const n = parseInt(line.slice(7).trim(), 10);
      if (Number.isFinite(n)) depth = n;
    }
    // thin-pack, no-progress, ofs-delta, filter, deepen-since, deepen-not, done: ignored.
  }
  return { wants, haves, shallow, depth };
}

function parseV0Fetch(packets: Pkt[]): FetchArgs {
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let depth: number | null = null;
  let section = 0;
  for (const packet of packets) {
    if (packet.kind === 'flush') {
      section += 1;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').trim();
    if (section === 0) {
      if (line.startsWith('want ')) wants.push(line.slice(5).trim().split(' ')[0]);
      else if (line.startsWith('shallow ')) shallow.push(line.slice(8).trim());
      else if (line.startsWith('deepen ')) {
        const n = parseInt(line.slice(7).trim(), 10);
        if (Number.isFinite(n)) depth = n;
      }
    } else if (line.startsWith('have ')) {
      haves.push(line.slice(5).trim());
    }
  }
  return { wants, haves, shallow, depth };
}

function handleUploadPack(req: IncomingMessage, res: ServerResponse, repo: Repo, body: Buffer): void {
  let packets: Pkt[];
  try {
    packets = parsePktLines(body).packets;
  } catch {
    sendGitError(res, 400, 'malformed pkt-line stream');
    return;
  }
  if (packets.length === 0 || packets[0].kind !== 'data') {
    sendGitError(res, 400, 'empty upload-pack request');
    return;
  }
  const firstLine = packets[0].payload.toString('utf8').trim();

  if (firstLine.startsWith('command=ls-refs')) {
    const args: LsRefsArgs = { peel: false, symrefs: false, unborn: false, prefixes: [] };
    let afterDelim = false;
    for (const packet of packets.slice(1)) {
      if (packet.kind === 'delim') {
        afterDelim = true;
        continue;
      }
      if (packet.kind === 'flush') break;
      if (packet.kind !== 'data' || !afterDelim) continue;
      const line = packet.payload.toString('utf8').trim();
      if (line === 'peel') args.peel = true;
      else if (line === 'symrefs') args.symrefs = true;
      else if (line === 'unborn') args.unborn = true;
      else if (line.startsWith('ref-prefix ')) args.prefixes.push(line.slice('ref-prefix '.length));
    }
    sendGitBuffer(res, 200, 'application/x-git-upload-pack-result', lsRefsResponse(repo, args));
    return;
  }

  if (firstLine.startsWith('command=fetch')) {
    const args = parseV2Args(packets);
    const plan = planFetch(args.wants, args.haves, args.shallow, args.depth);
    sendGitBuffer(res, 200, 'application/x-git-upload-pack-result', buildV2FetchResponse(plan));
    return;
  }

  if (firstLine.startsWith('want ')) {
    const args = parseV0Fetch(packets);
    const plan = planFetch(args.wants, args.haves, args.shallow, args.depth);
    sendGitBuffer(res, 200, 'application/x-git-upload-pack-result', buildV0FetchResponse(plan));
    return;
  }

  sendGitError(res, 400, 'unknown upload-pack command');
}

// ---------------------------------------------------------------- receive-pack

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

function applyPushCommand(repo: Repo, cmd: PushCommand, unpackError: string | null): { ref: string; ok: boolean; reason: string } {
  const { oldOid, newOid, ref } = cmd;
  if (unpackError) return { ref, ok: false, reason: 'unpack failed' };
  const current = repo.refs.get(ref);
  if (newOid === ZERO_OID) {
    // Delete.
    if (current === undefined) return { ref, ok: false, reason: 'remote ref does not exist' };
    if (oldOid !== ZERO_OID && oldOid !== current) return { ref, ok: false, reason: 'non-fast-forward' };
    repo.refs.delete(ref);
    return { ref, ok: true, reason: '' };
  }
  const newObj = store.getObject(newOid);
  if (!newObj) return { ref, ok: false, reason: 'object not found' };
  if (oldOid === ZERO_OID) {
    // Create.
    if (current !== undefined) return { ref, ok: false, reason: 'already exists' };
    repo.refs.set(ref, newOid);
    return { ref, ok: true, reason: '' };
  }
  // Update: must fast-forward.
  if (current === undefined) return { ref, ok: false, reason: 'remote ref does not exist' };
  if (oldOid !== current) return { ref, ok: false, reason: 'non-fast-forward' };
  if (newOid === oldOid) return { ref, ok: true, reason: '' };
  if (ref.startsWith('refs/tags/')) return { ref, ok: false, reason: 'non-fast-forward' };
  if (newObj.type !== 'commit') return { ref, ok: false, reason: 'non-fast-forward' };
  if (!store.isAncestor(oldOid, newOid)) return { ref, ok: false, reason: 'non-fast-forward' };
  repo.refs.set(ref, newOid);
  return { ref, ok: true, reason: '' };
}

function handleReceivePack(req: IncomingMessage, res: ServerResponse, repo: Repo, body: Buffer): void {
  let packets: Pkt[];
  let rest: Buffer;
  try {
    const parsed = parsePktLines(body);
    packets = parsed.packets;
    rest = parsed.rest;
  } catch {
    sendGitError(res, 400, 'malformed pkt-line stream');
    return;
  }
  const commands: PushCommand[] = [];
  let sideband = false;
  let first = true;
  for (const packet of packets) {
    if (packet.kind === 'flush') break;
    if (packet.kind !== 'data') continue;
    const text = packet.payload.toString('utf8');
    const nul = text.indexOf('\0');
    let line = text;
    let caps = '';
    if (nul >= 0) {
      line = text.slice(0, nul);
      caps = text.slice(nul + 1);
    }
    if (first) {
      first = false;
      sideband = caps.split(' ').includes('side-band-64k');
    }
    const m = /^([0-9a-f]{40}) ([0-9a-f]{40}) (\S+)\s*$/.exec(line.trim());
    if (!m) {
      sendGitError(res, 400, 'malformed receive-pack command');
      return;
    }
    commands.push({ oldOid: m[1], newOid: m[2], ref: m[3] });
  }
  if (commands.length === 0) {
    sendGitError(res, 400, 'no receive-pack commands');
    return;
  }

  // Unpack and store the objects (even when a ref update is later refused).
  let unpackError: string | null = null;
  if (rest.length > 0) {
    try {
      for (const object of parsePack(rest)) store.putObject(object.type, object.bytes);
    } catch (err) {
      unpackError = err instanceof Error ? err.message : 'unpack failed';
    }
  }

  const results = commands.map((cmd) => applyPushCommand(repo, cmd, unpackError));
  const reportLines: string[] = [unpackError ? `unpack ${unpackError}\n` : 'unpack ok\n'];
  for (const result of results) {
    reportLines.push(result.ok ? `ok ${result.ref}\n` : `ng ${result.ref} ${result.reason}\n`);
  }
  const report = Buffer.concat(reportLines.map((line) => pktLine(line)));
  const out: Buffer[] = sideband ? sidebandFrames(1, report) : [report];
  out.push(pktFlush());
  sendGitBuffer(res, 200, 'application/x-git-receive-pack-result', Buffer.concat(out));
}

// ---------------------------------------------------------------- entry point

/**
 * Handle a `/{owner}/{repo}.git/...` request. Returns true when the path is a git path
 * (handled, even as a 404/401); false when it is not a .git path at all.
 */
export async function handleGit(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  search: URLSearchParams,
  body: Buffer | null,
): Promise<boolean> {
  const match = /^\/([^/]+)\/([^/]+)\.git(?:\/(.*))?$/.exec(pathname);
  if (!match) return false;
  const owner = match[1];
  const repoName = match[2];
  const rest = match[3] ?? '';
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(owner) || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(repoName)) {
    sendGitJson(res, 404, 'Not Found');
    return true;
  }
  if (!isAuthenticated(req)) {
    sendGitJson(res, 401, 'Requires authentication');
    return true;
  }
  if (owner !== VIEWER_LOGIN) {
    sendGitJson(res, 404, 'Not Found');
    return true;
  }
  const repo = store.getRepo(owner, repoName);
  if (!repo) {
    sendGitJson(res, 404, 'Not Found');
    return true;
  }
  const method = req.method ?? 'GET';
  try {
    if (method === 'GET' && rest === 'info/refs') {
      const service = search.get('service');
      if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
        sendGitError(res, 400, 'unknown service');
        return true;
      }
      const isV2 = service === 'git-upload-pack' && (req.headers['git-protocol'] ?? '') === 'version=2';
      const contentType =
        service === 'git-upload-pack'
          ? 'application/x-git-upload-pack-advertisement'
          : 'application/x-git-receive-pack-advertisement';
      sendGitBuffer(res, 200, contentType, isV2 ? v2Advertisement() : v0Advertisement(service, repo));
      return true;
    }
    if (method === 'POST' && rest === 'git-upload-pack') {
      handleUploadPack(req, res, repo, body ?? Buffer.alloc(0));
      return true;
    }
    if (method === 'POST' && rest === 'git-receive-pack') {
      handleReceivePack(req, res, repo, body ?? Buffer.alloc(0));
      return true;
    }
  } catch (err) {
    // A git request must never crash the server.
    try {
      sendGitError(res, 500, err instanceof Error ? err.message : 'internal error');
    } catch {
      // The response was already sent.
    }
    return true;
  }
  sendGitJson(res, 404, 'Not Found');
  return true;
}
