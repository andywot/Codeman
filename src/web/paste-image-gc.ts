/**
 * @fileoverview Periodic GC for prompt-upload files, and the one place that
 * names the directories they live in.
 *
 * Without cleanup, /api/sessions/:id/paste-image accumulates files indefinitely
 * under {workingDir}/.codeman-uploads/. The route only triggers cleanup on
 * killMux=true session deletion, so long-lived sessions can fill disk under
 * heavy pasting. This sweeper bounds disk use by deleting `paste-*` files
 * older than MAX_AGE_MS from each live session's upload dirs on an interval;
 * remote (ssh) sessions get the same sweep on their machine, one command per host.
 *
 * Conservative defaults — only files matching the `paste-` prefix are
 * considered, and we lstat (not stat) so a planted symlink cannot escape the
 * upload dir.
 */
import fs from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { getDataDir } from '../config/instance.js';
import { probePathKind, type PathProbeOptions } from '../utils/bounded-path-probe.js';
import { shellescape } from '../remote-hosts.js';
import { remoteExecIfIdle } from '../remote-shell-pool.js';
import type { RemoteHost } from '../types.js';
import type { SessionPort } from './ports/index.js';

const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const SWEEP_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
const INITIAL_DELAY_MS = 30 * 1000; // 30s after startup

/**
 * Where a prompt upload is written, relative to the session's working
 * directory. IN the workspace, because that is the only path that resolves
 * identically for a local agent and a container (only the workspace is
 * bind-mounted, at the same absolute path); hidden, so it stays out of
 * `git status` and the agent's view of the repository; FLAT, because a nested
 * `<workspace>/.codeman/` is Codeman's own data dir when the workspace is the
 * home directory; and self-ignoring, through a `.gitignore` of `*` the route
 * writes once.
 */
export const UPLOADS_DIR = '.codeman-uploads';
/** Where uploads landed before the move: written to by nothing, readable for one release. */
export const LEGACY_UPLOADS_DIR = '.claude-images';
/** Every upload dir name, current first. Retiring the legacy one here retires it for every reader. */
export const UPLOAD_DIR_NAMES = [UPLOADS_DIR, LEGACY_UPLOADS_DIR];

/**
 * Every directory a session's uploads sit in, current first. Both consumers
 * act on what this returns, the hourly sweep and the recursive delete in
 * cleanupSession(), so it lists only REAL directories (a link planted by a
 * workspace script, `.codeman-uploads -> /other-case/.codeman-uploads`, is
 * not one; readdir follows a link to a directory), none that is or contains
 * this instance's data dir (a home workspace reaches it under a contrived
 * instance name, `CODEMAN_INSTANCE=uploads`, and `CODEMAN_DATA_DIR` can point
 * inside one; a directory strictly below the data dir only ever holds uploads
 * and is listed, or the uploads of a workspace like `~/.codeman/app` would
 * never be collected), and nothing for a remote (SSH) session, whose
 * workingDir is the remote path and would name a same-named LOCAL directory
 * here. The working directory is a user-chosen path, so it is probed BOUNDED
 * first (#516): one on a mount that stopped answering reads `unknown` and is
 * skipped, never touched. The sweep keeps the probe's stall cap; the delete,
 * acting on one path at the user's request, passes `pastCap`. The check is
 * made when listing: a same-user process that swaps a listed directory for a
 * link afterwards is accepted, since it already writes anywhere this process
 * can.
 */
export async function uploadDirs(
  session: { workingDir: string; remote?: unknown },
  probe: PathProbeOptions = {}
): Promise<string[]> {
  if (session.remote) return [];
  if ((await probePathKind(session.workingDir, probe)) !== 'directory') return [];
  const dataDir = await realDir(getDataDir());
  const dirs: string[] = [];
  for (const dir of UPLOAD_DIR_NAMES.map((name) => join(session.workingDir, name))) {
    if (!(await isRealDir(dir))) continue;
    const real = await realDir(dir);
    if (real === dataDir || dataDir.startsWith(real + sep)) continue;
    dirs.push(dir);
  }
  return dirs;
}

/** lstat, so a symlink is not a directory, whatever it points at. */
async function isRealDir(p: string): Promise<boolean> {
  try {
    return (await fs.lstat(p)).isDirectory();
  } catch {
    return false;
  }
}

/** `canonicalDir()` for the listing, which must not block the event loop on a user path. */
async function realDir(dir: string): Promise<string> {
  try {
    return await fs.realpath(dir);
  } catch {
    return resolve(dir);
  }
}

export async function sweepPasteImagesOnce(
  ctx: Pick<SessionPort, 'sessions'>,
  now: number = Date.now()
): Promise<{ scanned: number; deleted: number }> {
  const cutoff = now - MAX_AGE_MS;
  let scanned = 0;
  let deleted = 0;
  for (const session of ctx.sessions.values()) {
    for (const dir of await uploadDirs(session)) {
      let entries: string[];
      try {
        entries = await fs.readdir(dir);
      } catch {
        continue; // gone since listed — nothing to do
      }
      for (const name of entries) {
        if (!name.startsWith('paste-')) continue;
        const p = join(dir, name);
        scanned += 1;
        try {
          const st = await fs.lstat(p);
          if (!st.isFile()) continue;
          if (st.mtimeMs < cutoff) {
            await fs.unlink(p);
            deleted += 1;
          }
        } catch {
          // best-effort: skip permission/race errors silently
        }
      }
    }
  }
  return { scanned, deleted };
}

/** The slice of a session the remote sweep reads: where it runs and its working folder there. */
export interface RemoteSweepSession {
  remote?: {
    hostId: string;
    host: string;
    username: string;
    port?: number;
    remotePath: string;
  } & Record<string, unknown>;
}

/** Runs one script on a host; resolves on exit 0, rejects otherwise. Injectable for tests. */
export type RemoteSweepExec = (host: RemoteHost, script: string) => Promise<unknown>;

/**
 * The one shell command that sweeps a host's upload dirs. For each directory: only a REAL
 * `<dir>/.codeman-uploads` (not a link someone planted there), only regular files
 * (`-type f`, and `find` never follows links) directly inside it (`-maxdepth 1`) named
 * `paste-*` and last modified more than 7 days ago (`-mtime +7`). Paths are shell-escaped
 * tokens; every folder is independent (`;`), so one that is gone does not stop the rest.
 * Pure, so the test pins the exact text.
 */
export function buildRemoteSweepScript(dirs: readonly string[]): string {
  return dirs
    .map((dir) => {
      const up = `${dir.replace(/\/+$/, '')}/${UPLOADS_DIR}`;
      const q = shellescape(up);
      return `if [ -d ${q} ] && [ ! -L ${q} ]; then find ${q} -maxdepth 1 -type f -name 'paste-*' -mtime +7 -exec rm -f -- {} +; fi`;
    })
    .join('; ');
}

/**
 * Same 7-day sweep for REMOTE (ssh) sessions, whose uploads `pushUploadToHost()` (fleet.ts)
 * wrote into `<remote workspace>/.codeman-uploads/` on the machine. ONE command per host per
 * sweep, naming only the workspaces of that host's live sessions here (several sessions in
 * one folder collapse to one entry). Never wakes anything: it only ever asks a pooled shell
 * that is idle (`remoteExecIfIdle`, the machine poll's way), the Wake-on-LAN registry is not
 * involved, and a host that does not answer (asleep, offline, busy) is skipped until the next
 * hour; the files are old news. Windows systems are WSL under the hood (the same POSIX shell
 * and `/mnt/c/...` path the upload used), so they sweep like the rest.
 */
export async function sweepRemotePasteImagesOnce(
  ctx: { sessions: Map<string, RemoteSweepSession> | { values(): Iterable<RemoteSweepSession> } },
  exec: RemoteSweepExec = (host, script) => remoteExecIfIdle(host, script, { timeout: 30_000, maxBuffer: 64 * 1024 })
): Promise<{ hosts: number; swept: number; failed: number }> {
  const byHost = new Map<string, { host: RemoteHost; dirs: Set<string> }>();
  for (const session of ctx.sessions.values()) {
    const remote = session.remote;
    if (!remote || typeof remote.remotePath !== 'string') continue;
    // Absolute only: a relative or empty path would sweep the login directory's own .codeman-uploads.
    if (!remote.remotePath.startsWith('/') || remote.remotePath.replace(/\/+$/, '') === '') continue;
    let entry = byHost.get(remote.hostId);
    if (!entry) {
      entry = { host: remote as unknown as RemoteHost, dirs: new Set() };
      byHost.set(remote.hostId, entry);
    }
    entry.dirs.add(remote.remotePath.replace(/\/+$/, ''));
  }
  let swept = 0;
  let failed = 0;
  for (const { host, dirs } of byHost.values()) {
    try {
      await exec(host, buildRemoteSweepScript([...dirs]));
      swept += 1;
    } catch {
      failed += 1; // asleep, busy or unreachable: next hour
    }
  }
  return { hosts: byHost.size, swept, failed };
}

/**
 * The path two sessions must share to share an upload dir: the canonical
 * path when it can be resolved, so a sibling that reaches the same directory
 * through a symlink matches, and the normalised path otherwise (a directory
 * that no longer exists has nothing left to protect).
 */
function canonicalDir(dir: string): string {
  try {
    return realpathSync(dir);
  } catch {
    return resolve(dir);
  }
}

/** One session the upload-dir guard weighs: its id, directory and, for a persisted record, its status. */
export interface PasteImageDirUser {
  id: string;
  workingDir: string;
  status?: string;
}

/**
 * Does another live session still use this working directory's upload dirs?
 * Deleting a session removes them (`uploadDirs()`) recursively, and several
 * sessions routinely share one case directory, so without this check closing
 * one session deletes the pasted images a sibling in the same case still
 * refers to.
 *
 * Two kinds of sibling count as live:
 *
 * - a session in the server's map, unless it is itself being killed;
 * - a persisted record whose status is not `stopped`. That covers a session
 *   detached with `killMux=false`, which leaves the server's map while its
 *   tmux pane keeps running, and a session whose detach is still in progress.
 *
 * A session being KILLED does not count. Without that exemption, killing two
 * sessions of one case concurrently (a bulk delete, or the exited-agent sweep
 * closing two panes on one tick) would have each defer to the other, and
 * neither would remove the dir.
 *
 * Erring toward "in use" only costs a missed deletion, which the periodic
 * sweep above ages out. A pinned record whose tmux session is gone keeps its
 * status through boot pruning, so it holds the dir this way until unpinned.
 */
export function pasteImageDirInUseByOtherSession(input: {
  live: Iterable<PasteImageDirUser>;
  persisted: Iterable<PasteImageDirUser>;
  closingId: string;
  workingDir: string;
  killing: ReadonlySet<string>;
}): boolean {
  const target = canonicalDir(input.workingDir);
  const matches = (user: PasteImageDirUser): boolean =>
    user.id !== input.closingId &&
    !input.killing.has(user.id) &&
    !!user.workingDir &&
    canonicalDir(user.workingDir) === target;
  for (const user of input.live) {
    if (matches(user)) return true;
  }
  for (const user of input.persisted) {
    if (user.status === 'stopped') continue;
    if (matches(user)) return true;
  }
  return false;
}

export function startPasteImageGc(ctx: Pick<SessionPort, 'sessions'>): () => void {
  const sweep = (): void => {
    void sweepPasteImagesOnce(ctx);
    void sweepRemotePasteImagesOnce(ctx as unknown as Parameters<typeof sweepRemotePasteImagesOnce>[0]).catch(() => {});
  };
  const initial = setTimeout(sweep, INITIAL_DELAY_MS);
  const interval = setInterval(sweep, SWEEP_INTERVAL_MS);
  if (typeof initial.unref === 'function') initial.unref();
  if (typeof interval.unref === 'function') interval.unref();
  return (): void => {
    clearTimeout(initial);
    clearInterval(interval);
  };
}
