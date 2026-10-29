/**
 * @fileoverview Chat transcript reader (fork): Claude Code's conversation log as
 * chat items for the phone/desktop chat view.
 *
 * Claude Code appends every turn to `~/.claude/projects/<encoded cwd>/<id>.jsonl` on
 * the machine it runs on; Codeman launches it with `--session-id <claudeSessionId>`,
 * so the file name is known. Local sessions read the file directly (or the path the
 * hooks reported); remote sessions read byte ranges over the host's pooled ssh shell (remote-shell-pool.ts),
 * looking in the WSL home first and then the Windows profiles under /mnt/c (the
 * Windows `claude` keeps its log there).
 *
 * Reads are by byte offset: `after` returns complete lines appended since the last
 * read, `before` returns the chunk ending at an earlier offset (for "load earlier"),
 * and neither returns a partial line. Entries are trimmed to what the chat view
 * draws: big strings are cut, image bytes stay in the log (readChatImage fetches one
 * by its line's offset) and file-history snapshots are dropped.
 */

import { open, stat } from 'node:fs/promises';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import type { SessionRemote } from './types/session.js';
import { shellescape } from './remote-hosts.js';
import { runWithRemoteSshLimit } from './remote-ssh-limiter.js';
import { remoteExec } from './remote-shell-pool.js';

const execAsync = promisify(exec);

/** Most bytes one read returns; a backlog bigger than this arrives over several reads. */
export const CHAT_CHUNK_BYTES = 768 * 1024;
const TEXT_CAP = 24_000;
const INPUT_STRING_CAP = 16_000;
const RESULT_CAP = 6_000;
const LOCATION_TTL_MS = 15_000;
/** A first or earlier read keeps going back until it has this many entries… */
const MIN_ENTRIES = 60;
/** …or has covered this many bytes. */
const MAX_BACKFILL_BYTES = 6 * 1024 * 1024;
/** Longest line read whole (a pasted screenshot is a few MB of base64); longer ones are skipped. */
const MAX_LINE_BYTES = 48 * 1024 * 1024;

export interface ChatBlock {
  type: 'text' | 'thinking' | 'tool_use' | 'tool_result' | 'image';
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  toolUseId?: string;
  isError?: boolean;
  /** Images: where the line holding the bytes sits in the log, and which image of it this is. */
  at?: number;
  len?: number;
  n?: number;
}

export interface ChatEntry {
  uuid: string;
  role: 'user' | 'assistant' | 'system';
  timestamp: string;
  sidechain?: boolean;
  /** Text-only meta prompts Claude Code injects (caveats, reminders). */
  meta?: boolean;
  model?: string;
  /** Assistant turns: tokens the request carried (the context size at that point) and wrote. */
  usage?: { context: number; output: number };
  /** Sent while Claude was working (Claude Code queued it into the running turn). */
  queued?: boolean;
  /** The summary Claude Code writes after /compact (shown folded, not as a message). */
  compactSummary?: boolean;
  /** A compaction point: context tokens before and after it. */
  compacted?: { before: number; after: number };
  blocks: ChatBlock[];
}

export interface ChatChunk {
  /** The log's conversation id; offsets belong to it, so a change means start over. */
  log: string;
  /** Byte offset of the first returned line. */
  start: number;
  /** Byte offset just past the last returned line; pass back as `after`. */
  end: number;
  size: number;
  entries: ChatEntry[];
  /** Absent when the log has not been created yet (a fresh session before its first prompt). */
  found: boolean;
}

interface Located {
  path: string;
  at: number;
}
const located = new Map<string, Located>();

function cut(value: string, cap: number): string {
  return value.length > cap
    ? `${value.slice(0, cap)}\n… (${(value.length - cap).toLocaleString()} more characters)`
    : value;
}

function trimInput(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return cut(value, INPUT_STRING_CAP);
  if (depth > 6 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.slice(0, 200).map((v) => trimInput(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) out[k] = trimInput(v, depth + 1);
  return out;
}

function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) =>
      part && typeof part === 'object' && (part as { type?: string }).type === 'text'
        ? String((part as { text?: string }).text ?? '')
        : ''
    )
    .filter(Boolean)
    .join('\n');
}

/** One JSONL line → a chat entry, or null for lines the chat view does not draw. */
export function parseChatLine(line: string): ChatEntry | null {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (raw.type === 'attachment') {
    // A message typed while Claude was working lands as a queued-command attachment.
    const att = (raw.attachment ?? {}) as { type?: string; prompt?: unknown; origin?: { kind?: string } };
    if (att.type !== 'queued_command' || typeof att.prompt !== 'string' || att.origin?.kind !== 'human') return null;
    return {
      uuid: String(raw.uuid ?? ''),
      role: 'user',
      timestamp: String(raw.timestamp ?? ''),
      queued: true,
      blocks: [{ type: 'text', text: cut(att.prompt, TEXT_CAP) }],
    };
  }
  const type = raw.type;
  if (type !== 'user' && type !== 'assistant' && type !== 'system') return null;
  const message = (raw.message ?? {}) as { content?: unknown; model?: string };
  const blocks: ChatBlock[] = [];
  let images = 0;
  if (type === 'system') {
    const text = typeof raw.content === 'string' ? raw.content : '';
    if (!text || raw.subtype === 'informational' || raw.level === 'debug') return null;
    blocks.push({ type: 'text', text: cut(text, TEXT_CAP) });
  } else if (typeof message.content === 'string') {
    blocks.push({ type: 'text', text: cut(message.content, TEXT_CAP) });
  } else if (Array.isArray(message.content)) {
    for (const part of message.content as Array<Record<string, unknown>>) {
      switch (part?.type) {
        case 'text':
          if (typeof part.text === 'string' && part.text.trim())
            blocks.push({ type: 'text', text: cut(part.text, TEXT_CAP) });
          break;
        case 'thinking':
          if (typeof part.thinking === 'string' && part.thinking.trim())
            blocks.push({ type: 'thinking', text: cut(part.thinking, TEXT_CAP) });
          break;
        case 'tool_use':
          blocks.push({
            type: 'tool_use',
            id: String(part.id ?? ''),
            name: String(part.name ?? ''),
            input: trimInput(part.input),
          });
          break;
        case 'tool_result':
          blocks.push({
            type: 'tool_result',
            toolUseId: String(part.tool_use_id ?? ''),
            text: cut(resultText(part.content), RESULT_CAP),
            isError: part.is_error === true,
          });
          break;
        case 'image':
          blocks.push({ type: 'image', n: images++ });
          break;
      }
    }
  }
  if (blocks.length === 0) return null;
  const u = (message as { usage?: Record<string, unknown> }).usage;
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  const usage = u
    ? {
        context: num(u.input_tokens) + num(u.cache_read_input_tokens) + num(u.cache_creation_input_tokens),
        output: num(u.output_tokens),
      }
    : null;
  const meta =
    raw.subtype === 'compact_boundary' ? (raw.compactMetadata as Record<string, unknown> | undefined) : undefined;
  const compacted = meta ? { before: num(meta.preTokens), after: num(meta.postTokens) } : null;
  return {
    uuid: String(raw.uuid ?? ''),
    role: type,
    timestamp: String(raw.timestamp ?? ''),
    ...(raw.isSidechain === true ? { sidechain: true } : {}),
    ...(raw.isMeta === true ? { meta: true } : {}),
    ...(type === 'assistant' && message.model ? { model: message.model } : {}),
    ...(type === 'assistant' && usage ? { usage } : {}),
    ...(raw.isCompactSummary === true ? { compactSummary: true } : {}),
    ...(compacted ? { compacted } : {}),
    blocks,
  };
}

/** Complete lines of a chunk; `leading` drops the first (partial) line of a mid-file read. */
export function parseChatChunk(
  buf: Buffer,
  start: number,
  leading: boolean
): { entries: ChatEntry[]; start: number; end: number } {
  let from = 0;
  if (leading) {
    const nl = buf.indexOf(10);
    if (nl < 0) return { entries: [], start, end: start };
    from = nl + 1;
  }
  const last = buf.lastIndexOf(10);
  if (last < from) return { entries: [], start: start + from, end: start + from };
  const entries: ChatEntry[] = [];
  for (let at = from; at < last; ) {
    const nl = buf.indexOf(10, at);
    const line = buf.subarray(at, nl).toString('utf8');
    if (line.trim()) {
      const entry = parseChatLine(line);
      if (entry) {
        for (const b of entry.blocks) {
          if (b.type === 'image') Object.assign(b, { at: start + at, len: nl - at });
        }
        entries.push(entry);
      }
    }
    at = nl + 1;
  }
  return { entries, start: start + from, end: start + last + 1 };
}

export interface ChatSource {
  sessionId: string;
  claudeSessionId: string;
  remote?: SessionRemote;
  /** tmux session the agent runs in (`codeman-ssh-<id8>` on a remote host). */
  muxName?: string | null;
  /** Path Claude's hooks reported for a local session, when known. */
  hookPath?: string | null;
}

/**
 * Shell that prints the live log's path. Claude writes `~/.claude/sessions/<pid>.json`
 * for every running process with its tmux pane and CURRENT conversation id, which
 * follows `/resume` and `/clear`; the launch id is the fallback (and covers the
 * Windows `claude`, which does not see WSL's TMUX). Works the same locally and over ssh.
 */
export function buildLocateScript(muxName: string | null, claudeSessionId: string): string {
  const cid = claudeSessionId.replace(/[^A-Za-z0-9-]/g, '');
  const roots = '"${CLAUDE_CONFIG_DIR:-$HOME/.claude}" "$HOME/.claude" /mnt/c/Users/*/.claude';
  const mux = muxName ? muxName.replace(/[^A-Za-z0-9_-]/g, '') : '';
  const live = mux
    ? `best=; bt=0; for r in ${roots}; do for f in "$r"/sessions/*.json; do [ -f "$f" ] || continue; ` +
      `grep -q '"tmux":"${mux}:' "$f" || continue; t=$(stat -c %Y "$f"); ` +
      `[ "$t" -gt "$bt" ] && { bt=$t; best=$f; }; done; done; ` +
      `if [ -n "$best" ]; then sid=$(sed -n 's/.*"sessionId":"\\([A-Za-z0-9-]*\\)".*/\\1/p' "$best"); ` +
      `root=\${best%/sessions/*}; for f in "$root"/projects/*/"$sid".jsonl; do ` +
      `[ -f "$f" ] && { printf '%s\\n' "$f"; exit 0; }; done; fi; `
    : '';
  const fallback = cid
    ? `for r in ${roots}; do for f in "$r"/projects/*/${cid}.jsonl; do [ -f "$f" ] && { printf '%s\\n' "$f"; exit 0; }; done; done; `
    : '';
  return `${live}${fallback}true`;
}

async function sshRun(remote: SessionRemote, script: string, maxBuffer: number): Promise<Buffer> {
  const result = await runWithRemoteSshLimit(() => remoteExec(remote, script, { timeout: 20_000, maxBuffer }));
  return result.stdout;
}

async function locateAny(source: ChatSource): Promise<string | null> {
  const script = buildLocateScript(source.muxName ?? null, source.claudeSessionId);
  const out = source.remote
    ? (await sshRun(source.remote, script, 64 * 1024)).toString('utf8')
    : (await execAsync(script, { shell: '/bin/sh', timeout: 10_000 })).stdout;
  const path = out.trim().split('\n').pop()?.trim() ?? '';
  return path.startsWith('/') && path.endsWith('.jsonl') ? path : null;
}

async function locate(source: ChatSource): Promise<string | null> {
  const cached = located.get(source.sessionId);
  if (cached && Date.now() - cached.at < LOCATION_TTL_MS && !source.hookPath) return cached.path;
  const path = (!source.remote && source.hookPath) || (await locateAny(source));
  if (path) located.set(source.sessionId, { path, at: Date.now() });
  else located.delete(source.sessionId);
  return path;
}

async function readRange(
  source: ChatSource,
  path: string,
  start: number,
  length: number
): Promise<{ size: number; buf: Buffer }> {
  if (source.remote) {
    const q = shellescape(path);
    const script = `s=$(stat -c %s ${q} 2>/dev/null || wc -c < ${q}); printf '%s\\n' "$s"; tail -c +${start + 1} ${q} 2>/dev/null | head -c ${length}`;
    const out = await sshRun(source.remote, script, length + 4096);
    const nl = out.indexOf(10);
    return { size: Number(out.subarray(0, nl).toString().trim()) || 0, buf: out.subarray(nl + 1) };
  }
  const { size } = await stat(path);
  const fh = await open(path, 'r');
  try {
    const len = Math.max(0, Math.min(length, size - start));
    const buf = Buffer.alloc(len);
    if (len) await fh.read(buf, 0, len, start);
    return { size, buf };
  } finally {
    await fh.close();
  }
}

/**
 * Read the conversation. `after` (byte offset, -1 = the tail) returns what was appended;
 * `before` returns the chunk that ends at that offset.
 */
export async function readChat(source: ChatSource, opts: { after?: number; before?: number }): Promise<ChatChunk> {
  const path = await locate(source);
  if (!path) return { log: '', start: 0, end: 0, size: 0, entries: [], found: false };
  const log = path.slice(path.lastIndexOf('/') + 1, -'.jsonl'.length);

  // Walk backwards from `end` until enough entries or bytes are in hand: image and
  // tool-output lines are large, so one chunk can hold only a handful of messages.
  const readBack = async (end: number) => {
    let start = end;
    let size = 0;
    const entries: ChatEntry[] = [];
    let window = CHAT_CHUNK_BYTES;
    for (let bytes = 0; start > 0 && entries.length < MIN_ENTRIES && bytes < MAX_BACKFILL_BYTES; ) {
      const from = Math.max(0, start - window);
      const read = await readRange(source, path, from, start - from);
      size = read.size;
      // `buf` ends exactly at a line boundary, so add the newline the parser looks for.
      const parsed = parseChatChunk(Buffer.concat([read.buf, Buffer.from('\n')]), from, from > 0);
      if (parsed.start >= start && from > 0 && window < MAX_LINE_BYTES) {
        // One line longer than the window (an image): widen and read it whole.
        window = Math.min(MAX_LINE_BYTES, window * 4);
        continue;
      }
      entries.unshift(...parsed.entries);
      bytes += start - from;
      // A line longer than MAX_LINE_BYTES has no boundary inside it: step over it.
      start = parsed.start < start ? parsed.start : from;
      window = CHAT_CHUNK_BYTES;
    }
    return { start, size, entries };
  };

  if (opts.before !== undefined) {
    const end = Math.max(0, opts.before);
    const back = await readBack(end);
    return { log, start: back.start, end, size: back.size, entries: back.entries, found: true };
  }
  if ((opts.after ?? -1) < 0) {
    const { size } = await readRange(source, path, 0, 0);
    const back = await readBack(size);
    return { log, start: back.start, end: size, size, entries: back.entries, found: true };
  }
  const after = opts.after as number;
  let want = CHAT_CHUNK_BYTES;
  for (;;) {
    const { size, buf } = await readRange(source, path, after, want);
    if (size < after) {
      // The file shrank under us: start over from its tail.
      return readChat(source, { after: -1 });
    }
    const parsed = parseChatChunk(buf, after, false);
    // A line longer than the read (an image) would stall the reader here: read more.
    if (parsed.end === after && after + buf.length < size && want < MAX_LINE_BYTES) {
      want = Math.min(MAX_LINE_BYTES, want * 4);
      continue;
    }
    return { log, start: parsed.start, end: parsed.end, size, entries: parsed.entries, found: true };
  }
}

/** One image from the log: the `n`th image of the line at byte `at` (`len` bytes long). */
export async function readChatImage(
  source: ChatSource,
  log: string,
  at: number,
  len: number,
  n: number
): Promise<{ mediaType: string; data: Buffer } | null> {
  if (!(at >= 0 && len > 0 && len <= MAX_LINE_BYTES && n >= 0)) return null;
  const path = await locate(source);
  if (!path || path.slice(path.lastIndexOf('/') + 1, -'.jsonl'.length) !== log) return null;
  const { buf } = await readRange(source, path, at, len);
  let raw: { message?: { content?: unknown } };
  try {
    raw = JSON.parse(buf.toString('utf8')) as typeof raw;
  } catch {
    return null;
  }
  const parts = Array.isArray(raw.message?.content) ? (raw.message.content as Array<Record<string, unknown>>) : [];
  const image = parts.filter((p) => p?.type === 'image')[n] as
    | { source?: { type?: string; media_type?: string; data?: string } }
    | undefined;
  const src = image?.source;
  if (src?.type !== 'base64' || typeof src.data !== 'string') return null;
  const mediaType = /^image\/(png|jpeg|gif|webp)$/.test(String(src.media_type)) ? String(src.media_type) : 'image/png';
  return { mediaType, data: Buffer.from(src.data, 'base64') };
}
