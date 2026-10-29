/**
 * @fileoverview Fleet routes (fork): machines, accounts, folder browsing, usage.
 *
 * - GET    /api/fleet                         machines (hosts grouped by machine), accounts
 *                                             (no secrets) with usage, this server's ssh key
 * - PUT    /api/fleet/accounts/:id            create or update an account; omit `secret` to
 *                                             keep the saved one, send "" to clear it
 * - DELETE /api/fleet/accounts/:id
 * - PUT    /api/fleet/machines/:slug          { name, host, username, port?, systems[], wakeMac? }
 *                                             writes one remote host per system
 * - DELETE /api/fleet/machines/:slug          removes its hosts and their remote cases
 * - POST   /api/fleet/hosts/:id/test          ssh, tmux and claude on that system
 * - GET    /api/fleet/hosts/:id/folders?path= one folder level on that system
 * - GET    /api/fleet/status[?fresh=1]         per machine: online/asleep/offline, a one-line
 *                                             fix hint, CPU/MEM (machine-status.ts; cached,
 *                                             never wakes a machine)
 * - POST   /api/fleet/hosts/:id/wake          lives in session-routes.ts, beside the wake
 *                                             registry (the only module allowed to wake)
 * - GET    /api/fleet/running                 the machines discovery looks on
 * - GET    /api/fleet/running/:target         every Claude running on that machine that the
 *                                             dashboard does not show (claude-discovery.ts):
 *                                             in tmux (attachable) or outside tmux (resumable)
 * - GET    /api/fleet/history/:target?offset=&limit=&fresh=1
 *                                             past Claude conversations on that machine, newest
 *                                             first, one page per pooled-shell command, cached
 *                                             30 s (claude-history.ts); each row says whether it
 *                                             is running there or open in the dashboard
 *
 * Machine-level config like the remote-host routes, so admin-only in multi-user mode.
 * See src/fleet.ts for the model and its secret-handling rules.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { ApiResponse, RemoteHost } from '../../types.js';
import { ApiErrorCode, createErrorResponse } from '../../types.js';
import { getDataDir } from '../../config/instance.js';
import { isMultiUserMode } from '../../config/multiuser.js';
import { isAdmin } from '../route-helpers.js';
import { RemoteHostSchema } from '../schemas.js';
import { readRemoteCases, readRemoteHosts, writeRemoteCases, writeRemoteHosts } from '../../remote-hosts.js';
import { MachineStatusMonitor, classifySshFailure, createDefaultMachineStatusDeps } from '../../machine-status.js';
import { discoverTarget, discoveryTargets, knownForTarget, loginKey } from '../../claude-discovery.js';
import { ClaudeHistoryService, historyPaging } from '../../claude-history.js';
import { resolveTmuxSocketName } from '../../config/instance.js';
import { remoteTmuxLocation } from '../../tmux-manager.js';
import type { SessionPort } from '../ports/index.js';
import {
  ensureServerKey,
  listHostFolders,
  publicAccount,
  readFleet,
  readFleetUsage,
  runOnHost,
  validateAccount,
  writeFleet,
  type FleetAccount,
  type FleetSystem,
} from '../../fleet.js';

const CONFIG_DIR = getDataDir();
const SYSTEM_LABEL: Record<FleetSystem, string> = { wsl: 'WSL', windows: 'Windows', linux: 'Linux' };

const MachineSchema = z.object({
  name: z.string().min(1).max(60),
  host: z.string().min(1).max(255),
  username: z.string().min(1).max(100),
  port: z.number().int().min(1).max(65535).optional(),
  systems: z
    .array(z.enum(['wsl', 'windows', 'linux']))
    .min(1)
    .max(3),
  wakeMac: z.string().max(200).optional(),
});

const AccountSchema = z.object({
  label: z.string().min(1).max(60),
  kind: z.enum(['machine', 'token', 'api', 'shell']),
  setupCommand: z.string().max(200).optional(),
  email: z.string().max(200).optional(),
  baseUrl: z.string().max(300).optional(),
  apiModel: z.string().max(70).optional(),
  apiSmallModel: z.string().max(70).optional(),
  secret: z.string().max(4096).optional(),
});

function denied(req: FastifyRequest, reply: FastifyReply): ApiResponse<never> | null {
  if (isMultiUserMode() && !isAdmin(req)) {
    reply.code(403);
    return createErrorResponse(ApiErrorCode.FORBIDDEN, 'Admin only in multi-user mode');
  }
  return null;
}

/** Hosts grouped into machines: fleet hosts by `machine`, older hosts by label prefix. */
function groupMachines(hosts: RemoteHost[]) {
  const machines = new Map<
    string,
    { name: string; host: string; username: string; port?: number; wakeMac?: string; systems: unknown[] }
  >();
  for (const h of hosts) {
    const name = h.machine || h.label.split(' · ')[0] || h.label;
    if (!machines.has(name)) {
      machines.set(name, { name, host: h.host, username: h.username, port: h.port, wakeMac: h.wakeMac, systems: [] });
    }
    machines.get(name)!.systems.push({
      hostId: h.id,
      system: h.system ?? null,
      label: h.label,
      // A host made before accounts existed may carry a command override (an account
      // baked into a host); the UI offers to retire it.
      legacyCommand: Boolean(h.commands?.claude),
    });
  }
  return [...machines.values()];
}

function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 30) || 'machine'
  );
}

export function registerFleetRoutes(
  app: FastifyInstance,
  ctx?: SessionPort,
  /** Test seams: a monitor and a history service with fake IO. */
  options: { machineStatus?: MachineStatusMonitor; history?: ClaudeHistoryService } = {}
): void {
  const history = options.history ?? new ClaudeHistoryService();
  const machineStatus =
    options.machineStatus ??
    new MachineStatusMonitor(createDefaultMachineStatusDeps(() => readRemoteHosts(CONFIG_DIR)));

  app.get('/api/fleet/status', async (req, reply) => {
    const no = denied(req, reply);
    if (no) return no;
    const fresh = (req.query as { fresh?: string } | undefined)?.fresh === '1';
    return { success: true, data: { machines: await machineStatus.read({ force: fresh }) } };
  });

  app.get('/api/fleet', async (req, reply) => {
    const no = denied(req, reply);
    if (no) return no;
    const [fleet, hosts] = await Promise.all([readFleet(CONFIG_DIR), readRemoteHosts(CONFIG_DIR)]);
    const usage = await readFleetUsage(fleet, hosts).catch(() => new Map());
    return {
      success: true,
      data: {
        machines: groupMachines(hosts),
        accounts: fleet.accounts.map((a) => ({ ...publicAccount(a), usage: usage.get(a.id) ?? null })),
        publicKey: await ensureServerKey().catch(() => null),
      },
    };
  });

  app.put('/api/fleet/accounts/:id', async (req, reply) => {
    const no = denied(req, reply);
    if (no) return no;
    const { id } = req.params as { id: string };
    const parsed = AccountSchema.safeParse(req.body);
    if (!parsed.success) {
      return createErrorResponse(ApiErrorCode.INVALID_INPUT, parsed.error.issues[0]?.message ?? 'Invalid account');
    }
    const fleet = await readFleet(CONFIG_DIR);
    const prev = fleet.accounts.find((a) => a.id === id);
    const next: FleetAccount = { id, ...parsed.data };
    for (const key of ['email', 'baseUrl', 'apiModel', 'apiSmallModel', 'setupCommand'] as const) {
      if (!next[key]) delete next[key];
    }
    if (parsed.data.secret === undefined) {
      if (prev?.secret) next.secret = prev.secret;
    } else if (parsed.data.secret.trim() === '') {
      delete next.secret;
    } else {
      next.secret = parsed.data.secret.trim();
    }
    const error = validateAccount(next);
    if (error) return createErrorResponse(ApiErrorCode.INVALID_INPUT, error);
    fleet.accounts = prev ? fleet.accounts.map((a) => (a.id === id ? next : a)) : [...fleet.accounts, next];
    await writeFleet(CONFIG_DIR, fleet);
    return { success: true, data: { account: publicAccount(next) } };
  });

  app.delete('/api/fleet/accounts/:id', async (req, reply) => {
    const no = denied(req, reply);
    if (no) return no;
    const { id } = req.params as { id: string };
    const fleet = await readFleet(CONFIG_DIR);
    fleet.accounts = fleet.accounts.filter((a) => a.id !== id);
    await writeFleet(CONFIG_DIR, fleet);
    return { success: true };
  });

  app.put('/api/fleet/machines/:slug', async (req, reply) => {
    const no = denied(req, reply);
    if (no) return no;
    const parsed = MachineSchema.safeParse(req.body);
    if (!parsed.success) {
      return createErrorResponse(ApiErrorCode.INVALID_INPUT, parsed.error.issues[0]?.message ?? 'Invalid machine');
    }
    const machine = parsed.data;
    const { slug: rawSlug } = req.params as { slug: string };
    const slug = rawSlug === 'new' ? slugify(machine.name) : rawSlug;
    if (machine.systems.includes('windows') && !machine.systems.includes('wsl')) {
      return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Windows sessions run through WSL, so tick WSL too');
    }
    const hosts = await readRemoteHosts(CONFIG_DIR);
    const mine = (h: RemoteHost) => h.id === slug || h.id.startsWith(`${slug}-`);
    const wanted: RemoteHost[] = [];
    for (const system of machine.systems) {
      const candidate = {
        id: `${slug}-${system}`,
        label: `${machine.name} · ${SYSTEM_LABEL[system]}`,
        host: machine.host,
        username: machine.username,
        ...(machine.port ? { port: machine.port } : {}),
        ...(machine.wakeMac ? { wakeMac: machine.wakeMac } : {}),
        machine: machine.name,
        system,
        // LAN machines: trust the host key on first connect (a later change still fails).
        // Connection sharing is added for every host by buildSshConnectionArgs.
        extraSshOptions: ['StrictHostKeyChecking=accept-new'],
      };
      const checked = RemoteHostSchema.safeParse(candidate);
      if (!checked.success) {
        return createErrorResponse(ApiErrorCode.INVALID_INPUT, checked.error.issues[0]?.message ?? 'Invalid machine');
      }
      wanted.push(checked.data as RemoteHost);
    }
    // Drop systems no longer ticked, unless a remote case still points at them.
    const cases = await readRemoteCases(CONFIG_DIR);
    const kept = hosts.filter((h) => !mine(h) || wanted.some((w) => w.id === h.id));
    const removed = hosts.filter((h) => mine(h) && !wanted.some((w) => w.id === h.id));
    const stuck = removed.filter((h) => cases.some((c) => c.hostId === h.id));
    const next = [...kept.filter((h) => !wanted.some((w) => w.id === h.id)), ...stuck, ...wanted];
    await writeRemoteHosts(CONFIG_DIR, next);
    return { success: true, data: { slug, hosts: wanted.map((h) => h.id) } };
  });

  app.delete('/api/fleet/machines/:slug', async (req, reply) => {
    const no = denied(req, reply);
    if (no) return no;
    const { slug } = req.params as { slug: string };
    const hosts = await readRemoteHosts(CONFIG_DIR);
    const doomed = new Set(hosts.filter((h) => h.id === slug || h.id.startsWith(`${slug}-`)).map((h) => h.id));
    if (!doomed.size) return createErrorResponse(ApiErrorCode.NOT_FOUND, 'Machine not found');
    const cases = await readRemoteCases(CONFIG_DIR);
    await writeRemoteCases(
      CONFIG_DIR,
      cases.filter((c) => !doomed.has(c.hostId))
    );
    await writeRemoteHosts(
      CONFIG_DIR,
      hosts.filter((h) => !doomed.has(h.id))
    );
    return { success: true };
  });

  app.post('/api/fleet/hosts/:id/test', async (req, reply) => {
    const no = denied(req, reply);
    if (no) return no;
    const { id } = req.params as { id: string };
    const host = (await readRemoteHosts(CONFIG_DIR)).find((h) => h.id === id);
    if (!host) return createErrorResponse(ApiErrorCode.NOT_FOUND, 'Machine not found');
    const claude =
      host.system === 'windows' ? '/mnt/c/Windows/System32/cmd.exe /c "claude --version"' : 'claude --version';
    const result = await runOnHost(
      host,
      `echo "@@ssh ok"; echo "@@tmux $(command -v tmux || echo missing)"; ` +
        `echo "@@claude $(bash -lc ${JSON.stringify(claude)} 2>/dev/null | tr -d '\\r' | head -n 1 || echo missing)"`,
      undefined,
      25_000
    );
    const line = (key: string) =>
      result.stdout
        .split('\n')
        .find((l) => l.startsWith(`@@${key} `))
        ?.slice(key.length + 3)
        .trim() || 'missing';
    if (result.code !== 0 || !result.stdout.includes('@@ssh ok')) {
      const detail = result.stderr.trim().split('\n').pop() || 'Could not connect over ssh';
      const kind = classifySshFailure(result.stderr);
      const hint =
        kind === 'auth'
          ? ` (add the dashboard key to ~/.ssh/authorized_keys; check AllowUsers ${host.username})`
          : kind === 'host-key'
            ? ' (host key changed: ssh-keygen -R the host on the dashboard)'
            : '';
      return { success: true, data: { ok: false, error: detail + hint } };
    }
    return {
      success: true,
      data: { ok: true, tmux: line('tmux'), claude: line('claude') },
    };
  });

  // Read-only: one listing script per machine, nothing attached or signalled. Each
  // machine is its own request so a sleeping one does not hold up the rest.
  app.get('/api/fleet/running', async (req, reply) => {
    const no = denied(req, reply);
    if (no) return no;
    return { success: true, data: { targets: discoveryTargets(await readRemoteHosts(CONFIG_DIR)) } };
  });

  app.get('/api/fleet/running/:target', async (req, reply) => {
    const no = denied(req, reply);
    if (no) return no;
    const { target: id } = req.params as { target: string };
    const hosts = await readRemoteHosts(CONFIG_DIR);
    const target = discoveryTargets(hosts).find((t) => t.id === id);
    if (!target) return createErrorResponse(ApiErrorCode.NOT_FOUND, 'Machine not found');
    const sessions = [...(ctx?.sessions.values() ?? [])].map((s) => ({
      id: s.id,
      remote: s.remote,
      adoptedTmux: s.adoptedTmux,
    }));
    const known = knownForTarget(target, hosts, sessions, resolveTmuxSocketName(), remoteTmuxLocation);
    return { success: true, data: await discoverTarget(target, hosts, known) };
  });

  // Read-only like discovery: one listing script per page, through the pooled shell.
  // The machine's Windows system is not listed (its logs live under /mnt/c, and the
  // WSL login already covers the machine).
  app.get('/api/fleet/history/:target', async (req, reply) => {
    const no = denied(req, reply);
    if (no) return no;
    const { target: id } = req.params as { target: string };
    const query = (req.query ?? {}) as { offset?: string; limit?: string; fresh?: string };
    const hosts = await readRemoteHosts(CONFIG_DIR);
    const target = discoveryTargets(hosts).find((t) => t.id === id && t.hostId !== null);
    const host = target && hosts.find((h) => h.id === target.hostId);
    if (!target || !host) {
      reply.code(404);
      return createErrorResponse(ApiErrorCode.NOT_FOUND, 'Machine not found');
    }
    // Conversations the dashboard already shows on that login: a click selects the tab.
    const login = loginKey(host);
    const knownOpen = new Map<string, string>();
    for (const s of ctx?.sessions.values() ?? []) {
      const conversation = s.claudeSessionId;
      if (s.remote && conversation && loginKey(s.remote) === login) knownOpen.set(conversation, s.id);
    }
    try {
      const page = await history.page(host, historyPaging(query), { fresh: query.fresh === '1', knownOpen });
      return { success: true, data: { target, ...page } };
    } catch (err) {
      return createErrorResponse(ApiErrorCode.OPERATION_FAILED, (err as Error).message);
    }
  });

  app.get('/api/fleet/hosts/:id/folders', async (req, reply) => {
    const no = denied(req, reply);
    if (no) return no;
    const { id } = req.params as { id: string };
    const { path = '~' } = req.query as { path?: string };
    const host = (await readRemoteHosts(CONFIG_DIR)).find((h) => h.id === id);
    if (!host) return createErrorResponse(ApiErrorCode.NOT_FOUND, 'Machine not found');
    try {
      return { success: true, data: await listHostFolders(host, path) };
    } catch (err) {
      return createErrorResponse(ApiErrorCode.OPERATION_FAILED, (err as Error).message);
    }
  });
}
