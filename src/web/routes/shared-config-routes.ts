/**
 * @fileoverview Shared config routes (fork): the canonical store of shared Claude
 * config and manual sync to machines. Model and safety rules: src/shared-config.ts.
 *
 * - GET    /api/shared-config                      store items (names, hashes, env key
 *                                                   names; never values), targets, machines
 * - GET    /api/shared-config/hosts/:id             what that machine has, and each item's
 *                                                   state (in-sync / differs / missing /
 *                                                   machine-only)
 * - GET    /api/shared-config/hosts/:id/diff?kind=&name=
 *                                                   machine → store diff (secret-looking
 *                                                   lines hidden; env shows names only;
 *                                                   a skill shows per-file states)
 * - POST   /api/shared-config/import                { hostId, kind, name } copy an item
 *                                                   from a machine into the store
 * - PUT    /api/shared-config/items/:kind/:name     { shared } share or stop sharing
 * - DELETE /api/shared-config/items/:kind/:name     remove from the store (machines keep
 *                                                   their copies)
 * - PUT    /api/shared-config/targets               { hostIds } machines that receive
 * - POST   /api/shared-config/sync                  { hostIds? } push shared items (default:
 *                                                   the targets); one sync per machine at a time
 *
 * Machine-level config like the fleet routes, so admin-only in multi-user mode.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { ApiResponse, RemoteHost } from '../../types.js';
import { ApiErrorCode, createErrorResponse } from '../../types.js';
import { getDataDir } from '../../config/instance.js';
import { isMultiUserMode } from '../../config/multiuser.js';
import { isAdmin } from '../route-helpers.js';
import { readRemoteHosts } from '../../remote-hosts.js';
import { runOnHost } from '../../fleet.js';
import {
  compareWithMachine,
  hostUnsupported,
  isSharedKind,
  lineDiff,
  readMachineInventory,
  readMachineItem,
  readStore,
  readStoreSkill,
  removeStoreItem,
  setItemShared,
  setTargets,
  settingKeyRefusal,
  shareableEnv,
  sha256,
  storeDir,
  syncToHost,
  validItemName,
  withStoreLock,
  writeStoreItem,
  type HostRunner,
  type SharedKind,
} from '../../shared-config.js';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';

const ItemRef = z.object({
  kind: z.enum(['skill', 'memory', 'agent', 'command', 'setting']),
  name: z.string().min(1).max(120),
});
const ImportSchema = ItemRef.extend({ hostId: z.string().min(1).max(100) });
const SharedSchema = z.object({ shared: z.boolean() });
const TargetsSchema = z.object({ hostIds: z.array(z.string().min(1).max(100)).max(50) });
const SyncSchema = z.object({ hostIds: z.array(z.string().min(1).max(100)).max(50).optional() });

export interface SharedConfigRouteOptions {
  /** Data dir holding remote-hosts.json and shared-claude/ (tests use a temp dir). */
  configDir?: string;
  /** Runs scripts on a machine (tests run them locally). */
  run?: HostRunner;
}

function denied(req: FastifyRequest, reply: FastifyReply): ApiResponse<never> | null {
  if (isMultiUserMode() && !isAdmin(req)) {
    reply.code(403);
    return createErrorResponse(ApiErrorCode.FORBIDDEN, 'Admin only in multi-user mode');
  }
  return null;
}

function lastLine(err: unknown): string {
  return (err as Error).message.trim().split('\n').pop() || 'failed';
}

export function registerSharedConfigRoutes(app: FastifyInstance, options: SharedConfigRouteOptions = {}): void {
  const configDir = options.configDir ?? getDataDir();
  const run = options.run ?? runOnHost;
  const syncing = new Set<string>();

  async function findHost(id: string): Promise<RemoteHost | undefined> {
    return (await readRemoteHosts(configDir)).find((h) => h.id === id);
  }

  /** The host, or an error response: unknown, or not supported yet. */
  async function usableHost(id: string, reply: FastifyReply): Promise<RemoteHost | ApiResponse<never>> {
    const host = await findHost(id);
    if (!host) {
      reply.code(404);
      return createErrorResponse(ApiErrorCode.NOT_FOUND, 'Machine not found');
    }
    const unsupported = hostUnsupported(host);
    if (unsupported) return createErrorResponse(ApiErrorCode.OPERATION_FAILED, unsupported);
    return host;
  }

  app.get('/api/shared-config', async (req, reply) => {
    const no = denied(req, reply);
    if (no) return no;
    const [store, hosts] = await Promise.all([readStore(configDir), readRemoteHosts(configDir)]);
    return {
      success: true,
      data: {
        items: store.items,
        targets: store.targets,
        machines: hosts.map((h) => ({
          id: h.id,
          label: h.label,
          machine: h.machine ?? null,
          system: h.system ?? null,
          unsupported: hostUnsupported(h),
        })),
      },
    };
  });

  app.get('/api/shared-config/hosts/:id', async (req, reply) => {
    const no = denied(req, reply);
    if (no) return no;
    const host = await usableHost((req.params as { id: string }).id, reply);
    if ('success' in host) return host;
    try {
      const [store, inv] = await Promise.all([readStore(configDir), readMachineInventory(host, run)]);
      return {
        success: true,
        data: {
          hostId: host.id,
          hasClaudeDir: inv.hasClaudeDir,
          settingsError: inv.settings.error ?? null,
          items: compareWithMachine(store, inv),
        },
      };
    } catch (err) {
      return createErrorResponse(ApiErrorCode.OPERATION_FAILED, lastLine(err));
    }
  });

  app.get('/api/shared-config/hosts/:id/diff', async (req, reply) => {
    const no = denied(req, reply);
    if (no) return no;
    const parsed = ItemRef.safeParse(req.query);
    if (!parsed.success || !validItemName(parsed.data.kind, parsed.data.name)) {
      return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Invalid item');
    }
    const { kind, name } = parsed.data;
    const host = await usableHost((req.params as { id: string }).id, reply);
    if ('success' in host) return host;
    try {
      const store = await readStore(configDir);
      if (!store.items.some((i) => i.kind === kind && i.name === name)) {
        return createErrorResponse(ApiErrorCode.NOT_FOUND, 'Not in the store');
      }
      const dir = storeDir(configDir);
      if (kind === 'setting') {
        const inv = await readMachineInventory(host, run);
        if (inv.settings.error) return createErrorResponse(ApiErrorCode.OPERATION_FAILED, inv.settings.error);
        const theirs = inv.settings.parsed?.[name];
        if (name === 'env') {
          // Names only: values may be tokens.
          const mine = shareableEnv(store.settings.env).env;
          const other = shareableEnv(theirs).env;
          const names = [...new Set([...Object.keys(mine), ...Object.keys(other)])].sort();
          return {
            success: true,
            data: {
              mode: 'env',
              vars: names.map((n) => ({
                name: n,
                state: !(n in other)
                  ? 'store-only'
                  : !(n in mine)
                    ? 'machine-only'
                    : JSON.stringify(mine[n]) === JSON.stringify(other[n])
                      ? 'same'
                      : 'changed',
              })),
            },
          };
        }
        const machineText = theirs === undefined ? '' : JSON.stringify(theirs, null, 2);
        return {
          success: true,
          data: { mode: 'lines', ...lineDiff(machineText, JSON.stringify(store.settings[name], null, 2)) },
        };
      }
      if (kind === 'skill') {
        const inv = await readMachineInventory(host, run);
        const theirs = new Map((inv.skills.get(name)?.files ?? []).map((f) => [f.path, f.hash]));
        const mine = new Map((await readStoreSkill(dir, name)).map((f) => [f.path, sha256(f.content)]));
        const paths = [...new Set([...mine.keys(), ...theirs.keys()])].sort();
        return {
          success: true,
          data: {
            mode: 'files',
            files: paths.map((p) => ({
              path: p,
              state: !theirs.has(p)
                ? 'store-only'
                : !mine.has(p)
                  ? 'machine-only'
                  : theirs.get(p) === mine.get(p)
                    ? 'same'
                    : 'changed',
            })),
          },
        };
      }
      const item = await readMachineItem(host, kind, name, run);
      const machineBuf = item?.files?.[0]?.content ?? Buffer.alloc(0);
      const storeBuf = await fs.readFile(
        kind === 'memory' ? join(dir, 'memory', 'CLAUDE.md') : join(dir, kind === 'agent' ? 'agents' : 'commands', name)
      );
      if (machineBuf.includes(0) || storeBuf.includes(0)) {
        return { success: true, data: { mode: 'lines', lines: [], tooLarge: false, binary: true } };
      }
      return {
        success: true,
        data: { mode: 'lines', ...lineDiff(machineBuf.toString('utf8'), storeBuf.toString('utf8')) },
      };
    } catch (err) {
      return createErrorResponse(ApiErrorCode.OPERATION_FAILED, lastLine(err));
    }
  });

  app.post('/api/shared-config/import', async (req, reply) => {
    const no = denied(req, reply);
    if (no) return no;
    const parsed = ImportSchema.safeParse(req.body);
    if (!parsed.success) return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Invalid item');
    const { hostId, kind, name } = parsed.data;
    if (kind === 'setting' && settingKeyRefusal(name)) {
      return createErrorResponse(ApiErrorCode.INVALID_INPUT, `${name}: ${settingKeyRefusal(name)}`);
    }
    if (!validItemName(kind, name)) return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Invalid item name');
    const host = await usableHost(hostId, reply);
    if ('success' in host) return host;
    try {
      const item = await readMachineItem(host, kind, name, run);
      if (!item) return createErrorResponse(ApiErrorCode.NOT_FOUND, `${host.label} does not have ${name}`);
      await withStoreLock(() => writeStoreItem(configDir, kind, name, item, { importedFrom: host.id }));
      const withheld = kind === 'setting' && name === 'env' ? shareableEnv(item.value).withheld : [];
      return { success: true, data: { kind, name, withheld } };
    } catch (err) {
      return createErrorResponse(ApiErrorCode.OPERATION_FAILED, lastLine(err));
    }
  });

  const itemParams = (req: FastifyRequest): { kind: SharedKind; name: string } | null => {
    const { kind, name } = req.params as { kind: string; name: string };
    return isSharedKind(kind) && validItemName(kind, name) ? { kind, name } : null;
  };

  app.put('/api/shared-config/items/:kind/:name', async (req, reply) => {
    const no = denied(req, reply);
    if (no) return no;
    const ref = itemParams(req);
    const body = SharedSchema.safeParse(req.body);
    if (!ref || !body.success) return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Invalid item');
    const ok = await withStoreLock(() => setItemShared(configDir, ref.kind, ref.name, body.data.shared));
    if (!ok) return createErrorResponse(ApiErrorCode.NOT_FOUND, 'Not in the store');
    return { success: true };
  });

  app.delete('/api/shared-config/items/:kind/:name', async (req, reply) => {
    const no = denied(req, reply);
    if (no) return no;
    const ref = itemParams(req);
    if (!ref) return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Invalid item');
    const ok = await withStoreLock(() => removeStoreItem(configDir, ref.kind, ref.name));
    if (!ok) return createErrorResponse(ApiErrorCode.NOT_FOUND, 'Not in the store');
    return { success: true };
  });

  app.put('/api/shared-config/targets', async (req, reply) => {
    const no = denied(req, reply);
    if (no) return no;
    const parsed = TargetsSchema.safeParse(req.body);
    if (!parsed.success) return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Invalid machines');
    const known = new Set((await readRemoteHosts(configDir)).map((h) => h.id));
    const unknown = parsed.data.hostIds.find((id) => !known.has(id));
    if (unknown) return createErrorResponse(ApiErrorCode.NOT_FOUND, `Unknown machine ${unknown}`);
    await withStoreLock(() => setTargets(configDir, parsed.data.hostIds));
    return { success: true };
  });

  app.post('/api/shared-config/sync', async (req, reply) => {
    const no = denied(req, reply);
    if (no) return no;
    const parsed = SyncSchema.safeParse(req.body ?? {});
    if (!parsed.success) return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Invalid machines');
    const hosts = await readRemoteHosts(configDir);
    const ids = parsed.data.hostIds ?? (await readStore(configDir)).targets;
    if (!ids.length) return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Pick at least one machine');
    const results = await Promise.all(
      ids.map(async (id) => {
        const host = hosts.find((h) => h.id === id);
        if (!host) return { hostId: id, ok: false, error: 'Machine not found', results: [], unchanged: 0 };
        if (syncing.has(id))
          return { hostId: id, ok: false, error: 'A sync is already running', results: [], unchanged: 0 };
        syncing.add(id);
        try {
          const report = await syncToHost(configDir, host, run);
          return { hostId: id, ok: !report.results.some((r) => r.outcome === 'fail'), ...report };
        } catch (err) {
          return { hostId: id, ok: false, error: lastLine(err), results: [], unchanged: 0 };
        } finally {
          syncing.delete(id);
        }
      })
    );
    return { success: true, data: { hosts: results } };
  });
}
