/**
 * @fileoverview Agent mail (fork): the server's IO for the relay (web/agent-mail-relay.ts).
 *
 * Kept out of server.ts so the relay's ports read as one unit:
 * - the setting `agentMailEnabled` (synced, absent = on), read from settings.json at most every
 *   few seconds;
 * - the machines: fleet hosts (re-read every {@link HOSTS_REFRESH_MS}) plus this server, named
 *   `$CLAUDE_RC_MAIL_MACHINE` or `server`;
 * - polls: this server through a local `sh`, remote machines through `remoteExecIfIdle` (`sh -c`
 *   with the fixed script, data on stdin), so a poll never waits behind a user's command and never
 *   opens a connection per message;
 * - outside agents: claude-discovery.ts, its read-only script through the same idle-only shell;
 * - nudges: the session's own `writeViaMux`, gated on an idle pane and an empty composer;
 * - state: `agent-mail.json` in the data dir, 0600, written tmp + rename.
 *
 * @module web/agent-mail-wiring
 */

import { spawn } from 'node:child_process';
import { promises as fs, readFileSync } from 'node:fs';
import { dataPath, getDataDir, resolveTmuxSocketName } from '../config/instance.js';
import { mailEndpoints, LOCAL_ENDPOINT_ID, type MailEndpoint } from '../agent-mail.js';
import { readRemoteHosts, shellescape } from '../remote-hosts.js';
import { remoteExecIfIdle, remoteShellStatus } from '../remote-shell-pool.js';
import { remoteSignalsKey, remoteSignalsSupport } from '../remote-session-signals.js';
import { remoteTmuxLocation } from '../tmux-manager.js';
import {
  classifyDiscovery,
  discoverLocal,
  discoveryCommand,
  discoveryTargets,
  knownForTarget,
  parseDiscoveryOutput,
  type DiscoveryRun,
} from '../claude-discovery.js';
import { composerIsEmpty } from '../session-submit-verifier.js';
import { getCli } from '../config/cli-registry/registry.js';
import type { RemoteHost } from '../types.js';
import type { Session } from '../session.js';
import { AgentMailRelay, type AgentMailSnapshot } from './agent-mail-relay.js';

const HOSTS_REFRESH_MS = 30_000;
const SETTINGS_TTL_MS = 5_000;
const STATE_FILE = 'agent-mail.json';

export interface AgentMailDeps {
  sessions(): Iterable<Session>;
  getSession(id: string): Session | undefined;
  browserConnected(): boolean;
  /** The pane's visible frame with styles (`capture-pane -p -e`), or null. */
  capturePane(session: Session): string | null;
  /** A permission/question dialog is open, or respawn/Ralph/an agent drives the session. */
  busy(sessionId: string): boolean;
  log(message: string): void;
}

let settingsCache: { at: number; enabled: boolean } | null = null;

/** `agentMailEnabled`: absent or non-boolean = on (this fork's default). */
export function readAgentMailEnabled(now = Date.now()): boolean {
  if (settingsCache && now - settingsCache.at < SETTINGS_TTL_MS) return settingsCache.enabled;
  let enabled = true;
  try {
    const s = JSON.parse(readFileSync(dataPath('settings.json'), 'utf8')) as Record<string, unknown>;
    if (typeof s.agentMailEnabled === 'boolean') enabled = s.agentMailEnabled;
  } catch {
    // No settings yet: the default.
  }
  settingsCache = { at: now, enabled };
  return enabled;
}

/** Run a script under the server's own `sh`, stdin from `input`. */
function runLocal(script: string, input: string, timeoutMs: number, maxBytes = 8 * 1024 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('sh', ['-c', script], { stdio: ['pipe', 'pipe', 'pipe'] });
    const chunks: Buffer[] = [];
    let size = 0;
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', (d: Buffer) => {
      size += d.length;
      if (size > maxBytes) child.kill('SIGKILL');
      else chunks.push(d);
    });
    child.stderr.on('data', (d: Buffer) => {
      if (stderr.length < 4000) stderr += d.toString('utf8');
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolve(Buffer.concat(chunks).toString('utf8'));
      else reject(new Error(stderr.trim() || `sh exited ${code ?? signal}`));
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

export function createAgentMailRelay(deps: AgentMailDeps): AgentMailRelay {
  let hosts: RemoteHost[] = [];
  let hostsAt = 0;
  let hostsLoading = false;
  const refreshHosts = () => {
    if (hostsLoading || Date.now() - hostsAt < HOSTS_REFRESH_MS) return;
    hostsLoading = true;
    readRemoteHosts(getDataDir())
      .then((list) => {
        hosts = list;
      })
      .catch(() => {})
      .finally(() => {
        hostsAt = Date.now();
        hostsLoading = false;
      });
  };
  const localName = () => process.env.CLAUDE_RC_MAIL_MACHINE?.trim() || 'server';

  const sessionKey = (s: Session): string | undefined => {
    if (!s.remote) return undefined;
    const support = remoteSignalsSupport(s);
    return support === 'on' || support === 'relaunch' ? remoteSignalsKey(s.remote, s.id) : undefined;
  };

  return new AgentMailRelay({
    enabled: () => readAgentMailEnabled(),
    endpoints: () => {
      refreshHosts();
      return mailEndpoints(hosts, localName());
    },
    sessions: () => deps.sessions(),
    sessionKey: (view) => sessionKey(view as Session),
    browserConnected: () => deps.browserConnected(),
    hasLink: (ep) => {
      if (!ep.host) return false;
      for (const s of deps.sessions()) if (s.remote && ep.hostIds.includes(s.remote.hostId)) return true;
      return remoteShellStatus(ep.host).ready > 0;
    },
    exec: async (ep, script, input, timeoutMs) => {
      if (ep.local) return runLocal(script, input, timeoutMs);
      if (!ep.host) throw new Error('no host');
      const result = await remoteExecIfIdle(ep.host, `sh -c ${shellescape(script)}`, {
        input,
        timeout: timeoutMs,
        maxBuffer: 8 * 1024 * 1024,
      });
      return result.stdout.toString('utf8');
    },
    discover: async (ep: MailEndpoint) => {
      const target = discoveryTargets(hosts).find((t) =>
        ep.local ? t.id === 'local' : t.hostId !== null && ep.hostIds.includes(t.hostId)
      );
      if (!target) return null;
      const sessions = [...deps.sessions()].map((s) => ({ id: s.id, remote: s.remote, adoptedTmux: s.adoptedTmux }));
      const known = knownForTarget(target, hosts, sessions, resolveTmuxSocketName(), remoteTmuxLocation);
      let run: DiscoveryRun;
      if (ep.id === LOCAL_ENDPOINT_ID) run = await discoverLocal();
      else if (ep.host) {
        try {
          const r = await remoteExecIfIdle(ep.host, discoveryCommand(), {
            timeout: 20_000,
            maxBuffer: 8 * 1024 * 1024,
          });
          const raw = parseDiscoveryOutput(r.stdout.toString('utf8'));
          run = raw.complete ? { ok: true, raw } : { ok: false };
        } catch {
          return null;
        }
      } else return null;
      if (!run.ok || !run.raw) return null;
      const found = classifyDiscovery(run.raw, known);
      return [...found.tmux, ...found.outside]
        .filter((c) => c.cwd)
        .map((c) => ({ cwd: c.cwd as string, ...(c.title ? { title: c.title } : {}) }));
    },
    nudgeView: (id) => {
      const session = deps.getSession(id);
      if (!session) return null;
      const alive = session.pid !== null && !session.paneExit;
      const idle = alive && !session.isWorking && !deps.busy(id);
      let composerEmpty: boolean | null = null;
      if (idle) {
        const text = deps.capturePane(session);
        const glyph = getCli(session.mode)?.capabilities.workDetect?.promptGlyph ?? '';
        composerEmpty = text ? (composerIsEmpty(text, glyph) ?? null) : null;
      }
      return { idle, composerEmpty, lastHumanInputAt: session.lastHumanInputAt };
    },
    nudge: async (id, text) => {
      const session = deps.getSession(id);
      return session ? session.writeViaMux(`${text}\r`) : false;
    },
    load: async () => {
      try {
        return JSON.parse(await fs.readFile(dataPath(STATE_FILE), 'utf8')) as unknown;
      } catch {
        return null;
      }
    },
    save: async (snapshot: AgentMailSnapshot) => {
      const file = dataPath(STATE_FILE);
      const tmp = `${file}.${process.pid}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(snapshot), { mode: 0o600 });
      await fs.rename(tmp, file);
    },
    log: (message) => deps.log(message),
  });
}
