/**
 * @fileoverview Shared Claude config (fork): one canonical copy of the owner's chosen
 * user-level Claude Code config, pushed to the machines they pick, by hand.
 *
 * What can be shared (all under `~/.claude` on a machine):
 *
 * - `skill`   `skills/<name>/` (the whole folder)
 * - `memory`  `CLAUDE.md` (user memory)
 * - `agent`   `agents/<name>.md`
 * - `command` `commands/<name>.md`
 * - `setting` one top-level key of `settings.json` (permissions, hooks, env, …)
 *
 * The store lives in the data dir (`~/.codeman/shared-claude/`): the items themselves
 * plus `manifest.json` (which items are shared, which machines receive them). Nothing
 * runs on its own: the owner imports items from a machine, ticks what is shared and
 * which machines receive it, and presses Sync.
 *
 * Machines are the fleet's remote hosts, reached through the pooled shells
 * (`runOnHost` → remote-shell-pool.ts). Windows-native hosts are not supported yet.
 * Each remote script is a fixed POSIX `sh` program built here (paths are validated and
 * shell-quoted, the browser never supplies command text); file contents travel as
 * stdin (a tar archive on sync), never on the command line.
 *
 * Status is by content hash: SHA-256 per file, a skill hashes its sorted
 * `path\0filehash` list, a settings key hashes its canonical JSON (sorted keys). The
 * machine reports file hashes (`sha256sum`), so file contents only cross the wire on
 * import, diff and sync.
 *
 * ⚠️ Safety rules (pinned by test/shared-config.test.ts):
 * - Credentials are out of scope: only the paths above are read or written, so
 *   `~/.claude/.credentials.json`, `~/.claude.json` and the fleet's
 *   `~/.config/claude-rc/*.secret` are never touched; files that look like keys
 *   (`*.secret`, `.env*`, `*.pem`, `*.key`, `.credentials.json`) are skipped inside
 *   skills; settings keys that name a credential (`apiKeyHelper`, …) cannot be shared;
 *   `env` variables whose NAME looks like a credential are kept out of the store and a
 *   machine's own are kept on sync.
 * - settings.json is MERGED: only the shared keys change (`env` merges per variable),
 *   the write is refused if the file changed since it was read or does not parse, and
 *   the previous file is kept as `settings.json.rc-backup-<ts>` next to it.
 * - Anything else a sync replaces moves to `~/.claude/.rc-sync-backup/<ts>/` first
 *   (the newest ten are kept). A symlinked target is skipped, never written through.
 * - The browser gets names, hashes and states. Diffs hide lines that look like
 *   secrets, and `env` shows variable names only.
 */

import { createHash, randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import type { RemoteHost } from './types/index.js';
import { shellescape } from './remote-hosts.js';
import { runOnHost } from './fleet.js';

export type SharedKind = 'skill' | 'memory' | 'agent' | 'command' | 'setting';
export type ItemState = 'in-sync' | 'differs' | 'missing';

export const SHARED_KINDS: readonly SharedKind[] = ['skill', 'memory', 'agent', 'command', 'setting'];

/** Limits (also enforced by the remote scripts' `find -size`). */
export const MAX_FILE_BYTES = 1024 * 1024;
export const MAX_SKILL_FILES = 300;
export const MAX_SKILL_BYTES = 8 * 1024 * 1024;
export const MAX_SETTINGS_BYTES = 1024 * 1024;
const MAX_SYNC_BYTES = 24 * 1024 * 1024;
const BACKUPS_KEPT = 10;

const SKILL_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const MD_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}\.md$/;
const SETTING_KEY_RE = /^[A-Za-z][A-Za-z0-9_]{0,59}$/;
const SHA_RE = /^[0-9a-f]{64}$/;

/** Folders never descended into inside a skill. */
const PRUNED_DIRS = ['.git', 'node_modules', '__pycache__', '.venv'];
/** File names never read inside a skill (they look like credentials). */
const EXCLUDED_FILES = ['*.secret', '.credentials.json', '.env', '.env.*', '*.pem', '*.key', '.DS_Store'];

/** Settings keys that hold or fetch credentials: never shared. */
const DENIED_SETTING_KEYS = new Set(['apiKeyHelper', 'awsCredentialExport', 'awsAuthRefresh', 'otelHeadersHelper']);
const CREDENTIAL_NAME_RE = /token|secret|passw|credential|api_?key|private|auth/i;

// ── Names and paths ─────────────────────────────────────────────────────────

export function itemId(kind: SharedKind, name: string): string {
  return `${kind}:${name}`;
}

export function isSharedKind(kind: unknown): kind is SharedKind {
  return typeof kind === 'string' && (SHARED_KINDS as readonly string[]).includes(kind);
}

/** Why a setting key cannot be shared, or null when it can. */
export function settingKeyRefusal(key: string): string | null {
  if (!SETTING_KEY_RE.test(key)) return 'Not a settings key';
  if (DENIED_SETTING_KEYS.has(key) || CREDENTIAL_NAME_RE.test(key)) return 'Holds credentials: never shared';
  return null;
}

/** True when an env variable's name looks like a credential (kept out of the store). */
export function isCredentialEnvName(name: string): boolean {
  return CREDENTIAL_NAME_RE.test(name);
}

export function validItemName(kind: SharedKind, name: string): boolean {
  switch (kind) {
    case 'skill':
      return SKILL_NAME_RE.test(name);
    case 'memory':
      return name === 'CLAUDE.md';
    case 'agent':
    case 'command':
      return MD_NAME_RE.test(name);
    case 'setting':
      return settingKeyRefusal(name) === null;
  }
}

/** The item's path relative to `~/.claude` on a machine (not for settings). */
export function remotePath(kind: SharedKind, name: string): string {
  switch (kind) {
    case 'skill':
      return `skills/${name}`;
    case 'memory':
      return 'CLAUDE.md';
    case 'agent':
      return `agents/${name}`;
    case 'command':
      return `commands/${name}`;
    case 'setting':
      throw new Error('settings keys have no path');
  }
}

function globMatch(pattern: string, name: string): boolean {
  if (pattern.startsWith('*')) return name.endsWith(pattern.slice(1));
  if (pattern.endsWith('*')) return name.startsWith(pattern.slice(0, -1));
  return name === pattern;
}

/** A file name skipped inside skills (same list as the remote `find`). */
export function isExcludedFileName(name: string): boolean {
  return EXCLUDED_FILES.some((p) => globMatch(p, name));
}

/** A path inside a skill (relative to the skill folder) that may be stored and synced. */
export function validSkillFilePath(rel: string): boolean {
  if (!rel || rel.length > 200 || /[\0\r\n\\]/.test(rel)) return false;
  const parts = rel.split('/');
  if (parts.some((p) => p === '' || p === '.' || p === '..')) return false;
  if (parts.slice(0, -1).some((p) => PRUNED_DIRS.includes(p))) return false;
  return !isExcludedFileName(parts[parts.length - 1]);
}

// ── Hashes ──────────────────────────────────────────────────────────────────

export function sha256(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

/** JSON with object keys sorted at every level, so equal values hash equal. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    return `{${Object.keys(obj)
      .sort()
      .filter((k) => obj[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

export function hashJson(value: unknown): string {
  return sha256(canonicalJson(value));
}

export interface FileHash {
  /** Relative to the skill folder. */
  path: string;
  hash: string;
}

/** A skill's hash: its files' paths and hashes, sorted by path. */
export function hashSkill(files: FileHash[]): string {
  const sorted = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return sha256(sorted.map((f) => `${f.path}\0${f.hash}\n`).join(''));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** `env` without variables whose name looks like a credential. */
export function shareableEnv(env: unknown): { env: Record<string, unknown>; withheld: string[] } {
  const out: Record<string, unknown> = {};
  const withheld: string[] = [];
  if (!isPlainObject(env)) return { env: out, withheld };
  for (const [k, v] of Object.entries(env)) {
    if (isCredentialEnvName(k)) withheld.push(k);
    else out[k] = v;
  }
  return { env: out, withheld };
}

/**
 * A settings key's state on a machine. `env` is in sync when every shared variable
 * has the same value there (the machine may have more).
 */
export function settingState(
  key: string,
  storeValue: unknown,
  machineSettings: Record<string, unknown> | null
): ItemState {
  if (!machineSettings || !(key in machineSettings)) return 'missing';
  const theirs = machineSettings[key];
  if (key === 'env') {
    if (!isPlainObject(theirs) || !isPlainObject(storeValue)) return 'differs';
    return Object.entries(storeValue).every(([k, v]) => k in theirs && canonicalJson(theirs[k]) === canonicalJson(v))
      ? 'in-sync'
      : 'differs';
  }
  return canonicalJson(theirs) === canonicalJson(storeValue) ? 'in-sync' : 'differs';
}

// ── settings.json merge ─────────────────────────────────────────────────────

export interface SettingsMerge {
  /** The file to write (unchanged input when nothing changed). */
  text: string;
  /** Keys whose value changed. */
  changed: string[];
}

/** Indentation of a JSON document (a tab, or N spaces; 2 by default). */
function detectIndent(text: string): string | number {
  const m = /\n([ \t]+)"/.exec(text);
  if (!m) return 2;
  return m[1].includes('\t') ? '\t' : m[1].length;
}

/**
 * Merges the shared keys into a machine's settings.json. Only `keys` change: each is
 * replaced by the store's value, except `env`, which merges per variable (the store
 * wins, the machine's other variables stay). Other keys keep their order and values.
 * Throws when the machine's file does not parse to an object: it is never replaced.
 */
export function mergeSettings(
  machineText: string | null,
  store: Record<string, unknown>,
  keys: string[]
): SettingsMerge {
  let base: Record<string, unknown> = {};
  if (machineText !== null && machineText.trim() !== '') {
    let parsed: unknown;
    try {
      parsed = JSON.parse(machineText);
    } catch {
      throw new Error('settings.json on the machine does not parse; fix it there first');
    }
    if (!isPlainObject(parsed)) throw new Error('settings.json on the machine is not a JSON object');
    base = parsed;
  }
  const next: Record<string, unknown> = { ...base };
  const changed: string[] = [];
  for (const key of keys) {
    if (!(key in store) || settingKeyRefusal(key)) continue;
    const value =
      key === 'env'
        ? { ...(isPlainObject(base.env) ? base.env : {}), ...shareableEnv(store.env).env }
        : structuredClone(store[key]);
    if (!(key in base) || canonicalJson(base[key]) !== canonicalJson(value)) {
      next[key] = value;
      changed.push(key);
    }
  }
  if (!changed.length && machineText !== null) return { text: machineText, changed };
  return { text: JSON.stringify(next, null, machineText ? detectIndent(machineText) : 2) + '\n', changed };
}

// ── Remote scripts ──────────────────────────────────────────────────────────

/** Runs `body` under /bin/sh whatever the login shell is (zsh aborts on empty globs). */
export function wrapForSh(body: string): string {
  return `exec /bin/sh -c ${shellescape(body)}`;
}

const SKILL_FIND_FILTER =
  `\\( ${PRUNED_DIRS.map((d) => `-name ${shellescape(d)}`).join(' -o ')} \\) -prune -o -type f ` +
  `${EXCLUDED_FILES.map((p) => `! -name ${shellescape(p)}`).join(' ')} -size -${MAX_FILE_BYTES / 1024 + 1}k`;

const HASHER = `if command -v sha256sum >/dev/null 2>&1; then H=sha256sum; else H='shasum -a 256'; fi`;

/**
 * Lists a machine's shareable config: `@@settings <bytes> <base64>`, `@@f <sha> <path>`
 * per file item, `@@big <path>` for one over the size cap, and per skill
 * `@@skill <name>` (`@@link skills/<name>` when it is a symlink) then `sha256sum`
 * lines for its files.
 */
export const INVENTORY_SCRIPT = wrapForSh(
  [
    'C="$HOME/.claude"',
    `[ -d "$C" ] || { echo '@@none'; exit 0; }`,
    'cd "$C" || exit 3',
    HASHER,
    `if [ -f settings.json ]; then printf '@@settings %s ' "$(wc -c < settings.json | tr -d ' ')"; ` +
      `head -c ${MAX_SETTINGS_BYTES} settings.json | base64 | tr -d '\\n'; printf '\\n'; fi`,
    'for f in CLAUDE.md agents/*.md commands/*.md; do',
    '  [ -f "$f" ] || continue',
    `  if [ "$(wc -c < "$f" | tr -d ' ')" -gt ${MAX_FILE_BYTES} ]; then printf '@@big %s\\n' "$f"; continue; fi`,
    `  printf '@@f %s %s\\n' "$($H < "$f" | cut -c1-64)" "$f"`,
    'done',
    'for d in skills/*; do',
    '  [ -d "$d" ] || continue',
    `  [ -L "$d" ] && printf '@@link %s\\n' "$d"`,
    `  printf '@@skill %s\\n' "\${d#skills/}"`,
    `  find -L "$d" ${SKILL_FIND_FILTER} -exec $H {} + 2>/dev/null | head -n ${MAX_SKILL_FILES * 3}`,
    'done',
    'exit 0',
  ].join('\n')
);

/**
 * Prints one item's files as `@@file <x|-> <path>` lines, each followed by a line of
 * base64 content; `@@missing` when it is not there.
 */
export function buildReadItemScript(kind: SharedKind, name: string): string {
  if (kind === 'setting' || !validItemName(kind, name)) throw new Error('Invalid item');
  const path = remotePath(kind, name);
  const emit =
    `if [ -x "$f" ]; then m=x; else m=-; fi; printf '@@file %s %s\\n' "$m" "$f"; ` +
    `base64 < "$f" | tr -d '\\n'; printf '\\n'`;
  const lines = ['C="$HOME/.claude"', `cd "$C" 2>/dev/null || { echo '@@missing'; exit 0; }`, `p=${shellescape(path)}`];
  if (kind === 'skill') {
    lines.push(
      `[ -d "$p" ] || { echo '@@missing'; exit 0; }`,
      `find -L "$p" ${SKILL_FIND_FILTER} -print 2>/dev/null | head -n ${MAX_SKILL_FILES + 1} | ` +
        `while IFS= read -r f; do ${emit}; done`
    );
  } else {
    lines.push(`[ -f "$p" ] || { echo '@@missing'; exit 0; }`, `f=$p; ${emit}`);
  }
  lines.push('exit 0');
  return wrapForSh(lines.join('\n'));
}

export interface ReadFile {
  /** Path relative to `~/.claude`. */
  path: string;
  executable: boolean;
  content: Buffer;
}

/** {@link buildReadItemScript}'s output, or null for `@@missing`. */
export function parseReadItemOutput(stdout: string): ReadFile[] | null {
  const lines = stdout.split('\n');
  if (lines.some((l) => l === '@@missing')) return null;
  const files: ReadFile[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^@@file ([x-]) (.+)$/.exec(lines[i]);
    if (!m) continue;
    files.push({ path: m[2], executable: m[1] === 'x', content: Buffer.from(lines[i + 1] ?? '', 'base64') });
    i++;
  }
  return files;
}

export interface MachineSkill {
  files: FileHash[];
  symlink: boolean;
  problem?: string;
}

export interface MachineInventory {
  hasClaudeDir: boolean;
  /** memory/agent/command files: path relative to ~/.claude → sha256. */
  files: Map<string, string>;
  skills: Map<string, MachineSkill>;
  /** File items over the size cap. */
  big: string[];
  /** settings.json: raw text (null when absent), parsed object, or why it is unusable. */
  settings: { text: string | null; parsed: Record<string, unknown> | null; sha: string | null; error?: string };
}

/** {@link INVENTORY_SCRIPT}'s output. */
export function parseInventory(stdout: string): MachineInventory {
  const inv: MachineInventory = {
    hasClaudeDir: true,
    files: new Map(),
    skills: new Map(),
    big: [],
    settings: { text: null, parsed: null, sha: null },
  };
  const links = new Set<string>();
  let skill: MachineSkill | null = null;
  let skillName = '';
  for (const line of stdout.split('\n')) {
    if (line === '@@none') {
      inv.hasClaudeDir = false;
      continue;
    }
    let m: RegExpExecArray | null;
    if ((m = /^@@settings (\d+) ?(.*)$/.exec(line))) {
      const size = Number(m[1]);
      if (size > MAX_SETTINGS_BYTES) {
        inv.settings.error = 'settings.json is too large';
        continue;
      }
      const buf = Buffer.from(m[2], 'base64');
      inv.settings.text = buf.toString('utf8');
      inv.settings.sha = sha256(buf);
      try {
        const parsed: unknown = inv.settings.text.trim() ? JSON.parse(inv.settings.text) : {};
        if (isPlainObject(parsed)) inv.settings.parsed = parsed;
        else inv.settings.error = 'settings.json is not a JSON object';
      } catch {
        inv.settings.error = 'settings.json does not parse';
      }
    } else if ((m = /^@@f ([0-9a-f]{64}) (CLAUDE\.md|(?:agents|commands)\/[^/]+)$/.exec(line))) {
      inv.files.set(m[2], m[1]);
    } else if ((m = /^@@big (.+)$/.exec(line))) {
      inv.big.push(m[1]);
    } else if ((m = /^@@link skills\/(.+)$/.exec(line))) {
      links.add(m[1]);
    } else if ((m = /^@@skill (.+)$/.exec(line))) {
      skillName = m[1];
      skill = { files: [], symlink: links.has(skillName) };
      if (SKILL_NAME_RE.test(skillName)) inv.skills.set(skillName, skill);
    } else if (skill && (m = /^([0-9a-f]{64}) [ *](.+)$/.exec(line))) {
      const prefix = `skills/${skillName}/`;
      const rel = m[2].startsWith(prefix) ? m[2].slice(prefix.length) : '';
      if (validSkillFilePath(rel)) skill.files.push({ path: rel, hash: m[1] });
      else skill.problem = 'has a file name that cannot be synced';
    }
  }
  for (const s of inv.skills.values()) {
    if (s.files.length > MAX_SKILL_FILES) s.problem = `more than ${MAX_SKILL_FILES} files`;
  }
  return inv;
}

/** One machine item: hash (settings keys too) and whether it can be written or imported. */
export interface MachineItem {
  kind: SharedKind;
  name: string;
  hash: string | null;
  symlink?: boolean;
  problem?: string;
}

/** Everything shareable a machine has, keyed by item id. */
export function machineItems(inv: MachineInventory): Map<string, MachineItem> {
  const out = new Map<string, MachineItem>();
  for (const [path, hash] of inv.files) {
    const [kind, name] =
      path === 'CLAUDE.md'
        ? (['memory', 'CLAUDE.md'] as const)
        : path.startsWith('agents/')
          ? (['agent', path.slice(7)] as const)
          : (['command', path.slice(9)] as const);
    if (validItemName(kind, name)) out.set(itemId(kind, name), { kind, name, hash });
  }
  for (const path of inv.big) {
    const kind = path === 'CLAUDE.md' ? 'memory' : path.startsWith('agents/') ? 'agent' : 'command';
    const name = path === 'CLAUDE.md' ? 'CLAUDE.md' : path.slice(path.indexOf('/') + 1);
    if (validItemName(kind, name)) {
      out.set(itemId(kind, name), { kind, name, hash: null, problem: 'larger than 1 MB' });
    }
  }
  for (const [name, s] of inv.skills) {
    out.set(itemId('skill', name), {
      kind: 'skill',
      name,
      hash: s.problem ? null : hashSkill(s.files),
      symlink: s.symlink || undefined,
      problem: s.problem,
    });
  }
  for (const [key, value] of Object.entries(inv.settings.parsed ?? {})) {
    if (!SETTING_KEY_RE.test(key)) continue;
    const refusal = settingKeyRefusal(key);
    out.set(itemId('setting', key), {
      kind: 'setting',
      name: key,
      hash: key === 'env' ? hashJson(shareableEnv(value).env) : hashJson(value),
      problem: refusal ?? undefined,
    });
  }
  return out;
}

// ── Sync: tar archive + write script ────────────────────────────────────────

export interface TarEntry {
  path: string;
  content: Buffer;
  executable?: boolean;
}

function tarHeaderField(buf: Buffer, offset: number, length: number, value: string): void {
  buf.write(value, offset, Math.min(length, Buffer.byteLength(value)), 'utf8');
}

function octal(value: number, length: number): string {
  return value.toString(8).padStart(length - 1, '0') + '\0';
}

/** Splits a path into ustar `prefix` + `name` (≤155 / ≤100 bytes). */
function ustarSplit(path: string): [string, string] {
  if (Buffer.byteLength(path) <= 100) return ['', path];
  for (let i = path.length - 1; i > 0; i--) {
    if (path[i] !== '/') continue;
    const prefix = path.slice(0, i);
    const name = path.slice(i + 1);
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(name) <= 100 && name) return [prefix, name];
  }
  throw new Error(`Path too long to sync: ${path}`);
}

/** A plain ustar archive of regular files (what `tar -xf -` reads on any machine). */
export function buildTar(entries: TarEntry[]): Buffer {
  const blocks: Buffer[] = [];
  const mtime = Math.floor(Date.now() / 1000);
  for (const entry of entries) {
    const [prefix, name] = ustarSplit(entry.path);
    const header = Buffer.alloc(512);
    tarHeaderField(header, 0, 100, name);
    tarHeaderField(header, 100, 8, octal(entry.executable ? 0o755 : 0o644, 8));
    tarHeaderField(header, 108, 8, octal(0, 8));
    tarHeaderField(header, 116, 8, octal(0, 8));
    tarHeaderField(header, 124, 12, octal(entry.content.length, 12));
    tarHeaderField(header, 136, 12, octal(mtime, 12));
    header.fill(' ', 148, 156);
    header.write('0', 156);
    header.write('ustar\0', 257);
    header.write('00', 263);
    tarHeaderField(header, 345, 155, prefix);
    let sum = 0;
    for (const byte of header) sum += byte;
    header.write(octal(sum, 7) + ' ', 148);
    blocks.push(header, entry.content);
    const pad = (512 - (entry.content.length % 512)) % 512;
    if (pad) blocks.push(Buffer.alloc(pad));
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}

export interface SyncPlan {
  /** `YYYYMMDD-HHMMSS`, names this sync's backups. */
  stamp: string;
  /** Paths (relative to ~/.claude, present in the archive) that replace the machine's. */
  puts: string[];
  /** settings.json: the hash the machine's file must still have (`none` when absent). */
  settingsExpectedSha?: string;
}

export function syncStamp(date = new Date()): string {
  return date.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
}

/**
 * The write script. stdin is the tar archive (paths relative to ~/.claude, plus
 * `settings.json` when it changes). Prints `@@ok|@@skip|@@fail <path> [reason]`.
 */
export function buildSyncScript(plan: SyncPlan): string {
  if (!/^\d{8}-\d{6}$/.test(plan.stamp)) throw new Error('Invalid stamp');
  for (const p of plan.puts) {
    if (!/^(CLAUDE\.md|skills\/[^/]+|agents\/[^/]+|commands\/[^/]+)$/.test(p) || p.includes('..')) {
      throw new Error(`Invalid path ${p}`);
    }
  }
  if (plan.settingsExpectedSha && !(plan.settingsExpectedSha === 'none' || SHA_RE.test(plan.settingsExpectedSha))) {
    throw new Error('Invalid settings hash');
  }
  const lines = [
    'umask 077',
    'C="$HOME/.claude"',
    `TS=${plan.stamp}`,
    'B="$C/.rc-sync-backup/$TS"',
    `mkdir -p "$C" || { echo '@@fail - no ~/.claude'; exit 3; }`,
    HASHER,
    `S=$(mktemp -d "$C/.rc-sync-XXXXXX") || { echo '@@fail - staging'; exit 3; }`,
    `trap 'rm -rf "$S"' EXIT`,
    `tar -xf - -C "$S" || { echo '@@fail - archive'; exit 4; }`,
    'put() {',
    `  if [ -L "$C/$1" ]; then printf '@@skip %s symlink\\n' "$1"; return; fi`,
    '  if [ -e "$C/$1" ]; then',
    `    mkdir -p "$B/$(dirname "$1")" && mv "$C/$1" "$B/$1" || { printf '@@fail %s backup\\n' "$1"; return; }`,
    '  fi',
    `  mkdir -p "$C/$(dirname "$1")" && mv "$S/$1" "$C/$1" && printf '@@ok %s\\n' "$1" || printf '@@fail %s write\\n' "$1"`,
    '}',
    'settings() {',
    '  F="$C/settings.json"',
    '  if [ -f "$F" ]; then cur=$($H < "$F" | cut -c1-64); else cur=none; fi',
    `  [ "$cur" = "$1" ] || { printf '@@skip settings.json changed\\n'; return; }`,
    `  if [ -e "$F" ]; then`,
    `    cp -p "$F" "$F.rc-backup-$TS" || { printf '@@fail settings.json backup\\n'; return; }`,
    // In place: keeps the file's mode and writes through a symlinked settings.json.
    `    cat "$S/settings.json" > "$F" || { printf '@@fail settings.json write\\n'; return; }`,
    '  else',
    `    mv "$S/settings.json" "$F" || { printf '@@fail settings.json write\\n'; return; }`,
    '  fi',
    `  printf '@@ok settings.json\\n'`,
    '}',
    ...plan.puts.map((p) => `put ${shellescape(p)}`),
  ];
  if (plan.settingsExpectedSha) lines.push(`settings ${plan.settingsExpectedSha}`);
  lines.push(
    // Keep the newest backups only. Names are listed relative to their folder and must
    // be a stamp, so nothing outside the backups can match.
    `(cd "$C/.rc-sync-backup" 2>/dev/null && ls -1 | grep -E '^[0-9]{8}-[0-9]{6}$' | sort -r | tail -n +${BACKUPS_KEPT + 1} | ` +
      `while IFS= read -r d; do rm -rf "./$d"; done)`,
    `(cd "$C" && ls -1 | grep -E '^settings[.]json[.]rc-backup-[0-9]{8}-[0-9]{6}$' | sort -r | ` +
      `tail -n +${BACKUPS_KEPT + 1} | while IFS= read -r f; do rm -f "./$f"; done)`,
    'exit 0'
  );
  return wrapForSh(lines.join('\n'));
}

export interface SyncOutcome {
  path: string;
  outcome: 'ok' | 'skip' | 'fail';
  reason?: string;
}

export function parseSyncOutput(stdout: string): SyncOutcome[] {
  const out: SyncOutcome[] = [];
  for (const line of stdout.split('\n')) {
    const m = /^@@(ok|skip|fail) (\S+)(?: (.*))?$/.exec(line);
    if (m) out.push({ outcome: m[1] as SyncOutcome['outcome'], path: m[2], ...(m[3] ? { reason: m[3] } : {}) });
  }
  return out;
}

// ── Diffs (for the browser: secret-looking lines hidden) ─────────────────────

const SECRET_LINE_RE =
  /sk-ant-|sk-[A-Za-z0-9]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|xox[abpr]-|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}|(?:token|secret|passw(?:or)?d|api[_-]?key|authorization|bearer)["'\s]*[:=]\s*["']?[^\s"']{6,}|[A-Za-z0-9_+-]{40,}/i;

export function looksLikeSecret(line: string): boolean {
  return SECRET_LINE_RE.test(line);
}

export interface DiffLine {
  op: ' ' | '+' | '-' | '@';
  text: string;
}

const MAX_DIFF_CELLS = 4_000_000;

/**
 * A line diff from `machine` (−) to `store` (+): what a sync would change, with
 * three lines of context. Lines that look like secrets show as a placeholder.
 */
export function lineDiff(machine: string, store: string): { lines: DiffLine[]; tooLarge: boolean } {
  // A final newline is not a line of its own.
  const split = (text: string) => (text === '' ? [] : text.replace(/\n$/, '').split('\n'));
  const a = split(machine);
  const b = split(store);
  if (machine !== store && a.join('\n') === b.join('\n')) {
    return { lines: [{ op: '@', text: 'Only the final newline differs.' }], tooLarge: false };
  }
  if (a.length * b.length > MAX_DIFF_CELLS) return { lines: [], tooLarge: true };
  const n = a.length;
  const m = b.length;
  // LCS table, built from the end.
  const lcs: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const ops: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) {
      ops.push({ op: ' ', text: a[i++] });
      j++;
    } else if (i < n && (j >= m || lcs[i + 1][j] >= lcs[i][j + 1])) {
      ops.push({ op: '-', text: a[i++] });
    } else {
      ops.push({ op: '+', text: b[j++] });
    }
  }
  const keep = new Uint8Array(ops.length);
  ops.forEach((o, k) => {
    if (o.op === ' ') return;
    for (let c = Math.max(0, k - 3); c <= Math.min(ops.length - 1, k + 3); c++) keep[c] = 1;
  });
  const lines: DiffLine[] = [];
  let skipped = false;
  ops.forEach((o, k) => {
    if (!keep[k]) {
      skipped = true;
      return;
    }
    if (skipped) lines.push({ op: '@', text: '…' });
    skipped = false;
    lines.push({ op: o.op, text: looksLikeSecret(o.text) ? '[hidden: looks like a secret]' : o.text });
  });
  return { lines, tooLarge: false };
}

// ── The store ───────────────────────────────────────────────────────────────

export interface ManifestEntry {
  shared: boolean;
  importedFrom?: string;
  importedAt?: string;
}

export interface Manifest {
  version: 1;
  items: Record<string, ManifestEntry>;
  /** Host ids that receive shared items. */
  targets: string[];
}

export interface StoreItem {
  kind: SharedKind;
  name: string;
  shared: boolean;
  hash: string;
  importedFrom?: string;
  importedAt?: string;
  /** Skill: file count. */
  files?: number;
  /** `env`: variable names (values never leave the server). */
  envKeys?: string[];
}

export interface StoreSnapshot {
  items: StoreItem[];
  targets: string[];
  /** Store values of settings keys (server side only). */
  settings: Record<string, unknown>;
}

export function storeDir(configDir: string): string {
  return join(configDir, 'shared-claude');
}

function storeItemPath(dir: string, kind: SharedKind, name: string): string {
  if (kind === 'memory') return join(dir, 'memory', 'CLAUDE.md');
  if (kind === 'setting') return join(dir, 'settings.json');
  return join(dir, remotePath(kind, name));
}

async function readJson<T>(path: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await fs.readFile(path, 'utf8')) as T;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return fallback;
    throw err;
  }
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await fs.mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  await fs.rename(tmp, path);
}

export async function readManifest(dir: string): Promise<Manifest> {
  const raw = await readJson<Partial<Manifest>>(join(dir, 'manifest.json'), {});
  return {
    version: 1,
    items: isPlainObject(raw.items) ? (raw.items as Record<string, ManifestEntry>) : {},
    targets: Array.isArray(raw.targets) ? raw.targets.filter((t): t is string => typeof t === 'string') : [],
  };
}

async function writeManifest(dir: string, manifest: Manifest): Promise<void> {
  await writeJsonAtomic(join(dir, 'manifest.json'), manifest);
}

async function readStoreSettings(dir: string): Promise<Record<string, unknown>> {
  const raw = await readJson<unknown>(join(dir, 'settings.json'), {});
  return isPlainObject(raw) ? raw : {};
}

/** A stored skill's files (relative paths), with the same filters as the remote find. */
export async function readStoreSkill(dir: string, name: string): Promise<TarEntry[]> {
  const root = join(dir, 'skills', name);
  const out: TarEntry[] = [];
  const walk = async (rel: string): Promise<void> => {
    const entries = await fs.readdir(join(root, rel), { withFileTypes: true });
    for (const e of entries) {
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (!PRUNED_DIRS.includes(e.name)) await walk(childRel);
      } else if (e.isFile() && validSkillFilePath(childRel)) {
        const full = join(root, childRel);
        const stat = await fs.stat(full);
        if (stat.size > MAX_FILE_BYTES) continue;
        out.push({ path: childRel, content: await fs.readFile(full), executable: (stat.mode & 0o100) !== 0 });
      }
    }
  };
  await walk('');
  return out;
}

/** Reads the store: every item with its hash, plus the stored settings values. */
export async function readStore(configDir: string): Promise<StoreSnapshot> {
  const dir = storeDir(configDir);
  const manifest = await readManifest(dir);
  const settings = await readStoreSettings(dir);
  const items: StoreItem[] = [];
  for (const [id, entry] of Object.entries(manifest.items)) {
    const sep = id.indexOf(':');
    const kind = id.slice(0, sep);
    const name = id.slice(sep + 1);
    if (!isSharedKind(kind) || !validItemName(kind, name)) continue;
    const base = {
      kind,
      name,
      shared: Boolean(entry.shared),
      importedFrom: entry.importedFrom,
      importedAt: entry.importedAt,
    };
    try {
      if (kind === 'setting') {
        if (!(name in settings)) continue;
        const value = name === 'env' ? shareableEnv(settings.env).env : settings[name];
        items.push({
          ...base,
          hash: hashJson(value),
          ...(name === 'env' ? { envKeys: Object.keys(value as object).sort() } : {}),
        });
      } else if (kind === 'skill') {
        const files = await readStoreSkill(dir, name);
        if (!files.length) continue;
        items.push({
          ...base,
          hash: hashSkill(files.map((f) => ({ path: f.path, hash: sha256(f.content) }))),
          files: files.length,
        });
      } else {
        items.push({ ...base, hash: sha256(await fs.readFile(storeItemPath(dir, kind, name))) });
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }
  const order = (k: SharedKind) => SHARED_KINDS.indexOf(k);
  items.sort((x, y) => order(x.kind) - order(y.kind) || x.name.localeCompare(y.name));
  return { items, targets: manifest.targets, settings };
}

let storeLock: Promise<unknown> = Promise.resolve();

/** Serializes every store write. */
export function withStoreLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = storeLock.then(fn, fn);
  storeLock = run.catch(() => undefined);
  return run;
}

/** Writes one item into the store (replacing it) and marks it shared. */
export async function writeStoreItem(
  configDir: string,
  kind: SharedKind,
  name: string,
  content: { files?: TarEntry[]; value?: unknown },
  meta: { importedFrom?: string; shared?: boolean } = {}
): Promise<void> {
  if (!validItemName(kind, name)) throw new Error('Invalid item name');
  const dir = storeDir(configDir);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  if (kind === 'setting') {
    const settings = await readStoreSettings(dir);
    settings[name] = name === 'env' ? shareableEnv(content.value).env : content.value;
    await writeJsonAtomic(join(dir, 'settings.json'), settings);
  } else if (kind === 'skill') {
    const files = content.files ?? [];
    if (!files.length) throw new Error('The skill has no files');
    if (files.length > MAX_SKILL_FILES) throw new Error(`The skill has more than ${MAX_SKILL_FILES} files`);
    if (files.reduce((s, f) => s + f.content.length, 0) > MAX_SKILL_BYTES)
      throw new Error('The skill is larger than 8 MB');
    const staging = join(dir, `.tmp-${randomBytes(6).toString('hex')}`);
    try {
      for (const f of files) {
        if (!validSkillFilePath(f.path)) throw new Error(`Cannot store ${f.path}`);
        const target = join(staging, f.path);
        await fs.mkdir(dirname(target), { recursive: true, mode: 0o700 });
        await fs.writeFile(target, f.content, { mode: f.executable ? 0o700 : 0o600 });
      }
      const final = join(dir, 'skills', name);
      await fs.mkdir(join(dir, 'skills'), { recursive: true, mode: 0o700 });
      await fs.rm(final, { recursive: true, force: true });
      await fs.rename(staging, final);
    } finally {
      await fs.rm(staging, { recursive: true, force: true });
    }
  } else {
    const file = content.files?.[0];
    if (!file) throw new Error('Nothing to store');
    if (file.content.length > MAX_FILE_BYTES) throw new Error('The file is larger than 1 MB');
    const target = storeItemPath(dir, kind, name);
    await fs.mkdir(dirname(target), { recursive: true, mode: 0o700 });
    const tmp = `${target}.${randomBytes(4).toString('hex')}.tmp`;
    await fs.writeFile(tmp, file.content, { mode: 0o600 });
    await fs.rename(tmp, target);
  }
  const manifest = await readManifest(dir);
  const id = itemId(kind, name);
  manifest.items[id] = {
    shared: meta.shared ?? manifest.items[id]?.shared ?? true,
    ...(meta.importedFrom ? { importedFrom: meta.importedFrom, importedAt: new Date().toISOString() } : {}),
  };
  await writeManifest(dir, manifest);
}

export async function removeStoreItem(configDir: string, kind: SharedKind, name: string): Promise<boolean> {
  if (!validItemName(kind, name)) return false;
  const dir = storeDir(configDir);
  const manifest = await readManifest(dir);
  const id = itemId(kind, name);
  if (!manifest.items[id]) return false;
  if (kind === 'setting') {
    const settings = await readStoreSettings(dir);
    delete settings[name];
    await writeJsonAtomic(join(dir, 'settings.json'), settings);
  } else {
    await fs.rm(storeItemPath(dir, kind, name), { recursive: true, force: true });
  }
  delete manifest.items[id];
  await writeManifest(dir, manifest);
  return true;
}

export async function setItemShared(
  configDir: string,
  kind: SharedKind,
  name: string,
  shared: boolean
): Promise<boolean> {
  const dir = storeDir(configDir);
  const manifest = await readManifest(dir);
  const entry = manifest.items[itemId(kind, name)];
  if (!entry) return false;
  entry.shared = shared;
  await writeManifest(dir, manifest);
  return true;
}

export async function setTargets(configDir: string, hostIds: string[]): Promise<void> {
  const dir = storeDir(configDir);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const manifest = await readManifest(dir);
  manifest.targets = [...new Set(hostIds)];
  await writeManifest(dir, manifest);
}

// ── Machines ────────────────────────────────────────────────────────────────

/** Why a host cannot take part (Windows-native for now), or null. */
export function hostUnsupported(host: Pick<RemoteHost, 'system'>): string | null {
  return host.system === 'windows' ? 'Windows-native: not supported yet' : null;
}

export interface ItemStatus {
  kind: SharedKind;
  name: string;
  /** Relative to the store; `machine-only` when the store does not have it. */
  state: ItemState | 'machine-only';
  inStore: boolean;
  shared: boolean;
  symlink?: boolean;
  problem?: string;
}

/** Every store item's state on a machine, then what only the machine has. */
export function compareWithMachine(store: StoreSnapshot, inv: MachineInventory): ItemStatus[] {
  const theirs = machineItems(inv);
  const out: ItemStatus[] = [];
  for (const item of store.items) {
    const id = itemId(item.kind, item.name);
    const mine = theirs.get(id);
    let state: ItemState;
    if (item.kind === 'setting') state = settingState(item.name, store.settings[item.name], inv.settings.parsed);
    else if (!mine) state = 'missing';
    else state = mine.hash === item.hash ? 'in-sync' : 'differs';
    out.push({
      kind: item.kind,
      name: item.name,
      state,
      inStore: true,
      shared: item.shared,
      ...(mine?.symlink ? { symlink: true } : {}),
      ...(item.kind === 'setting' && inv.settings.error ? { problem: inv.settings.error } : {}),
    });
    theirs.delete(id);
  }
  const order = (k: SharedKind) => SHARED_KINDS.indexOf(k);
  const rest = [...theirs.values()].sort((x, y) => order(x.kind) - order(y.kind) || x.name.localeCompare(y.name));
  for (const m of rest) {
    out.push({
      kind: m.kind,
      name: m.name,
      state: 'machine-only',
      inStore: false,
      shared: false,
      ...(m.symlink ? { symlink: true } : {}),
      ...(m.problem ? { problem: m.problem } : {}),
    });
  }
  return out;
}

/** Runs a script on a host (the pooled shell; tests run it locally under a temp HOME). */
export type HostRunner = (
  host: RemoteHost,
  script: string,
  input?: string | Buffer,
  timeoutMs?: number
) => Promise<{ code: number | null; stdout: string; stderr: string }>;

export async function readMachineInventory(host: RemoteHost, run: HostRunner = runOnHost): Promise<MachineInventory> {
  const result = await run(host, INVENTORY_SCRIPT, undefined, 30_000);
  if (result.code !== 0) throw new Error(result.stderr.trim().split('\n').pop() || `${host.label} did not answer`);
  return parseInventory(result.stdout);
}

/** Reads one item from a machine for import or diff. */
export async function readMachineItem(
  host: RemoteHost,
  kind: SharedKind,
  name: string,
  run: HostRunner = runOnHost
): Promise<{ files?: TarEntry[]; value?: unknown } | null> {
  if (kind === 'setting') {
    const inv = await readMachineInventory(host, run);
    if (inv.settings.error) throw new Error(inv.settings.error);
    if (!inv.settings.parsed || !(name in inv.settings.parsed)) return null;
    return { value: inv.settings.parsed[name] };
  }
  const result = await run(host, buildReadItemScript(kind, name), undefined, 60_000);
  if (result.code !== 0) throw new Error(result.stderr.trim().split('\n').pop() || `${host.label} did not answer`);
  const files = parseReadItemOutput(result.stdout);
  if (!files) return null;
  const base = kind === 'skill' ? `skills/${name}/` : '';
  const entries: TarEntry[] = [];
  for (const f of files) {
    const rel = kind === 'skill' ? (f.path.startsWith(base) ? f.path.slice(base.length) : '') : f.path;
    if (kind === 'skill' && !validSkillFilePath(rel))
      throw new Error(`${name} has a file that cannot be synced: ${f.path}`);
    entries.push({ path: rel, content: f.content, executable: f.executable });
  }
  if (kind === 'skill' && entries.length > MAX_SKILL_FILES) {
    throw new Error(`${name} has more than ${MAX_SKILL_FILES} files`);
  }
  return { files: entries };
}

export interface SyncReport {
  results: SyncOutcome[];
  /** Shared items that were already in sync. */
  unchanged: number;
}

/**
 * Pushes every SHARED store item that is missing or differs to one machine.
 * Reads the machine first, so unchanged items and keys are not rewritten.
 */
export async function syncToHost(
  configDir: string,
  host: RemoteHost,
  run: HostRunner = runOnHost
): Promise<SyncReport> {
  const unsupported = hostUnsupported(host);
  if (unsupported) throw new Error(unsupported);
  const store = await readStore(configDir);
  const inv = await readMachineInventory(host, run);
  const statuses = compareWithMachine(store, inv);
  const dir = storeDir(configDir);
  const entries: TarEntry[] = [];
  const puts: string[] = [];
  const results: SyncOutcome[] = [];
  const settingKeys: string[] = [];
  let unchanged = 0;
  for (const s of statuses) {
    if (!s.inStore || !s.shared) continue;
    if (s.state === 'in-sync') {
      unchanged++;
      continue;
    }
    if (s.kind === 'setting') {
      settingKeys.push(s.name);
      continue;
    }
    const path = remotePath(s.kind, s.name);
    if (s.symlink) {
      results.push({ path, outcome: 'skip', reason: 'symlink' });
      continue;
    }
    if (s.kind === 'skill') {
      for (const f of await readStoreSkill(dir, s.name)) entries.push({ ...f, path: `${path}/${f.path}` });
    } else {
      entries.push({ path, content: await fs.readFile(storeItemPath(dir, s.kind, s.name)) });
    }
    puts.push(path);
  }
  let settingsExpectedSha: string | undefined;
  if (settingKeys.length) {
    if (inv.settings.error) {
      results.push({ path: 'settings.json', outcome: 'skip', reason: inv.settings.error });
    } else {
      const merged = mergeSettings(inv.settings.text, store.settings, settingKeys);
      if (merged.changed.length) {
        entries.push({ path: 'settings.json', content: Buffer.from(merged.text, 'utf8') });
        settingsExpectedSha = inv.settings.sha ?? 'none';
      } else {
        unchanged += settingKeys.length;
      }
    }
  }
  if (!puts.length && !settingsExpectedSha) return { results, unchanged };
  const archive = buildTar(entries);
  if (archive.length > MAX_SYNC_BYTES) throw new Error('Too much to send in one sync (24 MB)');
  const script = buildSyncScript({ stamp: syncStamp(), puts, settingsExpectedSha });
  const result = await run(host, script, archive, 120_000);
  results.push(...parseSyncOutput(result.stdout));
  if (result.code !== 0 && !results.some((r) => r.outcome === 'fail')) {
    results.push({
      path: '-',
      outcome: 'fail',
      reason: result.stderr.trim().split('\n').pop() || `exit ${result.code}`,
    });
  }
  return { results, unchanged };
}
