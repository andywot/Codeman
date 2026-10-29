/**
 * @fileoverview Persistent remote shells (fork): run short commands on a remote host
 * over an ssh connection that stays open, instead of a fresh `ssh host 'cmd'` each time.
 *
 * Why: a new ssh login costs the full handshake and login every time, and on a Windows
 * host the forced command adds PowerShell and WSL on top: about 3.5 s per command on
 * the desktop, paid by every chat read, image, folder listing and liveness check. A
 * pooled shell pays it once; later commands cost a round trip.
 *
 * Why not ssh's ControlMaster: Windows OpenSSH does not multiplex sessions over a
 * master connection, and a master shared with the session panes broke them all.
 * Each pooled shell here is its own ordinary ssh connection.
 *
 * Protocol: `ssh … 'exec sh'` starts a POSIX shell reading commands from stdin. The
 * server sends a small driver (the `rcx` function) once, then one line per command:
 * `rcx <id> <base64 script> <base64 stdin>`. The script runs under the user's own
 * shell (`$SHELL -c`, as a plain ssh command would) with that stdin, and answers
 *
 *     __RCPOOL_<id>_B\n <base64 stdout> \n__RCPOOL_<id>_E <exit code> <base64 stderr>\n
 *
 * Everything travels as base64, so no quoting can break out of the line, binary output
 * survives Windows OpenSSH, and stdin (fleet tokens) never touches the remote disk;
 * only stderr is spooled, to a 0600 temp file the shell removes on exit. `<id>` carries
 * a per-shell random nonce, so output cannot forge a marker for another command.
 *
 * Each host gets up to MAX_SHELLS_PER_HOST shells, each running one command at a time;
 * further commands queue. A command past its timeout kills its shell (the next one
 * starts fresh) and rejects like `exec` does (`killed: true`); a dropped connection
 * rejects with code 255, ssh's own transport-failure status. Idle shells close after
 * IDLE_MS. Streams (video, large downloads) keep using plain ssh.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { buildSshConnectionArgs, remoteSshTarget, shellescape } from './remote-hosts.js';
import type { RemoteHost, RemoteSshOptions } from './types.js';

type PoolTarget = Pick<RemoteHost, 'username' | 'host' | 'port'> & RemoteSshOptions;

const MAX_SHELLS_PER_HOST = 3;
const IDLE_MS = 10 * 60_000;
/** Login plus driver setup; the desktop's Windows path alone takes a few seconds. */
const START_TIMEOUT_MS = 30_000;

export interface RemoteExecOptions {
  timeout?: number;
  /** Most decoded stdout bytes accepted; more rejects like exec's maxBuffer. */
  maxBuffer?: number;
  input?: string | Buffer;
}

export interface RemoteExecResult {
  code: number;
  stdout: Buffer;
  stderr: string;
}

/** Rejection shaped like a failed `exec`: callers read `code`, `killed` and `stderr`. */
export class RemoteExecError extends Error {
  code: number | string | null;
  killed: boolean;
  stderr: string;
  stdout: Buffer;
  constructor(
    message: string,
    fields: { code: number | string | null; killed?: boolean; stderr?: string; stdout?: Buffer }
  ) {
    super(message);
    this.name = 'RemoteExecError';
    this.code = fields.code;
    this.killed = fields.killed ?? false;
    this.stderr = fields.stderr ?? '';
    this.stdout = fields.stdout ?? Buffer.alloc(0);
  }
}

const DRIVER = [
  'umask 077',
  'T=$(mktemp "${TMPDIR:-/tmp}/rcpool.XXXXXX") || exit 1',
  `trap 'rm -f "$T" "$T.rc"' EXIT`,
  'rcx() {',
  `  printf '__RCPOOL_%s_B\\n' "$1"`,
  `  { printf '%s' "$3" | base64 -d | "\${SHELL:-/bin/sh}" -c "$(printf '%s' "$2" | base64 -d)" 2>"$T"; echo $? >"$T.rc"; } | base64`,
  `  printf '\\n__RCPOOL_%s_E %s ' "$1" "$(cat "$T.rc")"`,
  `  base64 <"$T" | tr -d '\\n'`,
  `  printf '\\n'`,
  '}',
].join('\n');

interface Job {
  script: string;
  opts: RemoteExecOptions;
  resolve: (r: RemoteExecResult) => void;
  reject: (e: RemoteExecError) => void;
}

/** Decoded size of `n` bytes of `base64` output, which wraps a line every 76 characters. */
function base64Bytes(n: number): number {
  return Math.floor(((n - Math.floor(n / 77)) * 3) / 4);
}

class PooledShell {
  private readonly child: ChildProcess;
  private readonly nonce = randomBytes(8).toString('hex');
  private seq = 0;
  private buf: Buffer = Buffer.alloc(0);
  private sshStderr = '';
  private ready = false;
  private readyWaiters: Array<{ resolve: () => void; reject: (e: RemoteExecError) => void }> = [];
  private job: (Job & { id: string; timer: NodeJS.Timeout }) | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  dead = false;

  constructor(
    target: PoolTarget,
    private readonly onIdle: (shell: PooledShell) => void,
    private readonly onDead: (shell: PooledShell) => void
  ) {
    const line = [...buildSshConnectionArgs(target), shellescape(remoteSshTarget(target)), shellescape('exec sh')].join(
      ' '
    );
    this.child = spawn('/bin/sh', ['-c', line], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.child.stdout?.on('data', (d: Buffer) => this.onData(d));
    this.child.stderr?.on('data', (d: Buffer) => {
      if (this.sshStderr.length < 8_000) this.sshStderr += d.toString('utf8');
    });
    this.child.stdin?.on('error', () => this.die('ssh input closed'));
    this.child.on('error', (err) => this.die(`ssh could not be started (${err.message})`));
    this.child.on('close', (code) => this.die(code === null ? 'ssh was stopped' : `ssh exit ${code}`));
    const startTimer = setTimeout(() => {
      if (!this.ready) this.die('timed out connecting', true);
    }, START_TIMEOUT_MS);
    startTimer.unref?.();
    this.write(`${DRIVER}\nprintf '__RCPOOL_READY_%s\\n' ${this.nonce}\n`);
  }

  get busy(): boolean {
    return this.job !== null;
  }

  /** Logged in and the driver answered: a command sent now runs at once. */
  get isReady(): boolean {
    return this.ready && !this.dead;
  }

  private write(text: string): void {
    if (!this.dead) this.child.stdin?.write(text);
  }

  private whenReady(): Promise<void> {
    if (this.ready) return Promise.resolve();
    return new Promise((resolve, reject) => this.readyWaiters.push({ resolve, reject }));
  }

  /** Run one command; the pool only calls this on an idle shell. */
  run(job: Job): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    const id = `${this.nonce}_${++this.seq}`;
    const timer = setTimeout(() => {
      const current = this.job;
      this.job = null;
      current?.reject(new RemoteExecError('timed out', { code: null, killed: true }));
      // Still connecting: the command was never sent, so the shell is clean; let it
      // finish logging in and serve the next command (a desktop login takes ~4 s).
      if (!this.ready) {
        this.onIdle(this);
        return;
      }
      // The command may still be running remotely; only a fresh shell is safe now.
      this.die('timed out');
    }, job.opts.timeout ?? 20_000);
    this.job = { ...job, id, timer };
    this.whenReady().then(
      () => {
        if (this.job?.id !== id) return;
        const input = job.opts.input === undefined ? '' : Buffer.from(job.opts.input).toString('base64');
        this.write(`rcx ${id} ${Buffer.from(job.script).toString('base64')} '${input}'\n`);
      },
      (err: RemoteExecError) => this.finish(id, err)
    );
  }

  private finish(id: string, outcome: RemoteExecResult | RemoteExecError): void {
    if (this.job?.id !== id) return;
    const job = this.job;
    clearTimeout(job.timer);
    this.job = null;
    if (outcome instanceof RemoteExecError) job.reject(outcome);
    else if (outcome.code !== 0) {
      job.reject(
        new RemoteExecError(`remote command exited ${outcome.code}`, {
          code: outcome.code,
          stderr: outcome.stderr,
          stdout: outcome.stdout,
        })
      );
    } else job.resolve(outcome);
    if (!this.dead) {
      this.idleTimer = setTimeout(() => this.die('idle'), IDLE_MS);
      this.idleTimer.unref?.();
      this.onIdle(this);
    }
  }

  private onData(chunk: Buffer): void {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    if (!this.ready) {
      const marker = Buffer.from(`__RCPOOL_READY_${this.nonce}\n`);
      const at = this.buf.indexOf(marker);
      // Anything before the marker is login noise (a banner, an rc file's echo).
      if (at < 0) return;
      this.buf = this.buf.subarray(at + marker.length);
      this.ready = true;
      for (const w of this.readyWaiters.splice(0)) w.resolve();
    }
    const job = this.job;
    if (!job) {
      this.buf = Buffer.alloc(0);
      return;
    }
    const begin = Buffer.from(`__RCPOOL_${job.id}_B\n`);
    const start = this.buf.indexOf(begin);
    if (start < 0) return;
    const body = start + begin.length;
    const max = job.opts.maxBuffer;
    const tooLarge = () => {
      this.finish(
        job.id,
        new RemoteExecError('stdout maxBuffer length exceeded', { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' })
      );
      // The rest of the output is still on its way: only a fresh shell is in sync.
      this.die('output too large');
    };
    const end = Buffer.from(`\n__RCPOOL_${job.id}_E `);
    const endAt = this.buf.indexOf(end, body);
    if (endAt < 0) {
      // Still streaming: stop a runaway early (the slack covers line breaks and the end marker).
      if (max !== undefined && base64Bytes(this.buf.length - body) > max + 64 * 1024) tooLarge();
      return;
    }
    const nl = this.buf.indexOf(10, endAt + end.length);
    if (nl < 0) return;
    const [rcText, errB64 = ''] = this.buf
      .subarray(endAt + end.length, nl)
      .toString('latin1')
      .trim()
      .split(' ');
    const stdout = Buffer.from(
      this.buf
        .subarray(body, endAt)
        .toString('latin1')
        .replace(/[^A-Za-z0-9+/=]/g, ''),
      'base64'
    );
    if (max !== undefined && stdout.length > max) {
      tooLarge();
      return;
    }
    const stderr = Buffer.from(errB64.replace(/[^A-Za-z0-9+/=]/g, ''), 'base64').toString('utf8');
    this.buf = this.buf.subarray(nl + 1);
    const code = Number.parseInt(rcText, 10);
    this.finish(job.id, { code: Number.isFinite(code) ? code : 1, stdout, stderr });
  }

  /** Close the shell; a command in flight fails like a dropped ssh connection (255). */
  die(reason: string, killed = false): void {
    if (this.dead) return;
    this.dead = true;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    const detail = this.sshStderr.trim().split('\n').filter(Boolean).pop() ?? '';
    const err = new RemoteExecError(detail || reason, { code: killed ? null : 255, killed, stderr: detail || reason });
    for (const w of this.readyWaiters.splice(0)) w.reject(err);
    if (this.job) this.finish(this.job.id, err);
    this.child.stdin?.end();
    if (this.child.exitCode === null) this.child.kill('SIGTERM');
    this.onDead(this);
  }
}

class HostPool {
  private readonly shells = new Set<PooledShell>();
  private readonly queue: Job[] = [];

  constructor(private readonly target: PoolTarget) {}

  submit(job: Job): void {
    this.queue.push(job);
    this.pump();
  }

  /**
   * Submit only if the job starts now, on an idle shell or a new one within the cap, so
   * it never queues ahead of (or behind) other work. False leaves the job unsubmitted.
   */
  trySubmit(job: Job): boolean {
    if (this.queue.length) return false;
    const live = [...this.shells].filter((s) => !s.dead);
    if (!live.some((s) => !s.busy) && live.length >= MAX_SHELLS_PER_HOST) return false;
    this.submit(job);
    return true;
  }

  status(): RemoteShellStatus {
    const live = [...this.shells].filter((s) => !s.dead);
    return {
      ready: live.filter((s) => s.isReady).length,
      connecting: live.filter((s) => !s.isReady).length,
      busy: live.filter((s) => s.busy).length,
      queued: this.queue.length,
    };
  }

  private pump(): void {
    while (this.queue.length) {
      let shell = [...this.shells].find((s) => !s.busy && !s.dead);
      if (!shell) {
        if (this.shells.size >= MAX_SHELLS_PER_HOST) return;
        shell = new PooledShell(
          this.target,
          () => this.pump(),
          (s) => {
            this.shells.delete(s);
            this.pump();
          }
        );
        this.shells.add(shell);
      }
      shell.run(this.queue.shift() as Job);
    }
  }

  close(): void {
    for (const s of [...this.shells]) s.die('closed');
  }
}

const pools = new Map<string, HostPool>();

/** What the pool holds for one host right now; reading it opens nothing. */
export interface RemoteShellStatus {
  /** Logged-in shells (an ssh connection is up). */
  ready: number;
  /** Shells still logging in. */
  connecting: number;
  /** Shells running a command. */
  busy: number;
  /** Commands waiting for a shell. */
  queued: number;
}

function poolKey(target: PoolTarget): string {
  // Keyed by everything that shapes the connection, so an edited host gets new shells.
  return JSON.stringify([...buildSshConnectionArgs(target), remoteSshTarget(target)]);
}

function poolFor(target: PoolTarget): HostPool {
  const key = poolKey(target);
  let pool = pools.get(key);
  if (!pool) {
    pool = new HostPool(target);
    pools.set(key, pool);
  }
  return pool;
}

/**
 * Run `script` on the host through a pooled shell. Resolves on exit 0; any other exit
 * rejects with a {@link RemoteExecError} carrying code/stderr/stdout, like `exec`.
 */
export function remoteExec(
  target: PoolTarget,
  script: string,
  opts: RemoteExecOptions = {}
): Promise<RemoteExecResult> {
  // Tests opt in with a fake `ssh` on PATH (test/remote-shell-pool.test.ts).
  if (process.env.VITEST && process.env.CODEMAN_TEST_SHELL_POOL !== '1') {
    return Promise.reject(new RemoteExecError('remote commands are disabled under test', { code: 'ETEST' }));
  }
  return new Promise((resolve, reject) => poolFor(target).submit({ script, opts, resolve, reject }));
}

/**
 * Like {@link remoteExec}, but only when the command can start at once: on an idle shell,
 * or a new one while the host is under its shell cap and nothing is queued. Otherwise it
 * rejects at once with code `EBUSY` and sends nothing, so a background check never delays
 * a user's command. Used by the machine-state poll (machine-status.ts).
 */
export function remoteExecIfIdle(
  target: PoolTarget,
  script: string,
  opts: RemoteExecOptions = {}
): Promise<RemoteExecResult> {
  if (process.env.VITEST && process.env.CODEMAN_TEST_SHELL_POOL !== '1') {
    return Promise.reject(new RemoteExecError('remote commands are disabled under test', { code: 'ETEST' }));
  }
  return new Promise((resolve, reject) => {
    if (!poolFor(target).trySubmit({ script, opts, resolve, reject })) {
      reject(new RemoteExecError('shells busy', { code: 'EBUSY' }));
    }
  });
}

/** The host's pooled shells right now (all zero when none was ever opened). Opens nothing. */
export function remoteShellStatus(target: PoolTarget): RemoteShellStatus {
  return pools.get(poolKey(target))?.status() ?? { ready: 0, connecting: 0, busy: 0, queued: 0 };
}

/** Like {@link remoteExec}, but a non-zero exit resolves with its code (for callers that branch on it). */
export async function remoteExecStatus(
  target: PoolTarget,
  script: string,
  opts: RemoteExecOptions = {}
): Promise<RemoteExecResult> {
  try {
    return await remoteExec(target, script, opts);
  } catch (err) {
    if (err instanceof RemoteExecError && typeof err.code === 'number' && err.code !== 255) {
      return { code: err.code, stdout: err.stdout, stderr: err.stderr };
    }
    throw err;
  }
}

/** Close every pooled shell (server shutdown). */
export function closeRemoteShells(): void {
  for (const pool of pools.values()) pool.close();
  pools.clear();
}
