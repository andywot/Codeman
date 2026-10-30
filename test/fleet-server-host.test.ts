// Port: none (route tests use app.inject()).
//
// The "This is the dashboard's host" flag of a fleet machine (RemoteHost.serverHost): PUT
// /api/fleet/machines/:slug stores it on every system's host, GET /api/fleet reports it per
// machine, and a machine saved without it carries none. The browser reads it to show the
// server and the machine it runs on as one entry (machine-status-ui.js).
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { getDataDir } from '../src/config/instance.js';
import { registerFleetRoutes } from '../src/web/routes/fleet-routes.js';
import { createRouteTestHarness } from './routes/_route-test-utils.js';

const HOSTS_FILE = () => join(getDataDir(), 'remote-hosts.json');

async function savedHosts(): Promise<Array<Record<string, unknown>>> {
  return JSON.parse(await readFile(HOSTS_FILE(), 'utf8'));
}

describe('fleet machines: the dashboard host flag', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    await mkdir(getDataDir(), { recursive: true });
    await writeFile(HOSTS_FILE(), '[]');
    ({ app } = await createRouteTestHarness((a) => registerFleetRoutes(a)));
  });

  afterEach(async () => {
    await app.close();
  });

  const put = (slug: string, body: Record<string, unknown>) =>
    app.inject({ method: 'PUT', url: `/api/fleet/machines/${slug}`, payload: body });

  it('stores serverHost on every system of the machine and reports it', async () => {
    const res = await put('new', {
      name: 'arr',
      host: '192.168.0.50',
      username: 'andy',
      systems: ['linux'],
      serverHost: true,
    });
    expect(res.json().success).toBe(true);
    expect((await savedHosts()).map((h) => h.serverHost)).toEqual([true]);

    const fleet = (await app.inject({ method: 'GET', url: '/api/fleet' })).json().data;
    expect(fleet.machines).toEqual([expect.objectContaining({ name: 'arr', serverHost: true })]);
  });

  it('a machine saved without the flag has none, and un-ticking it clears it', async () => {
    await put('new', { name: 'arr', host: '192.168.0.50', username: 'andy', systems: ['linux'], serverHost: true });
    const res = await put('arr', { name: 'arr', host: '192.168.0.50', username: 'andy', systems: ['linux'] });
    expect(res.json().success).toBe(true);
    expect('serverHost' in (await savedHosts())[0]).toBe(false);
    const fleet = (await app.inject({ method: 'GET', url: '/api/fleet' })).json().data;
    expect(fleet.machines[0].serverHost).toBe(false);
  });

  it('rejects a non-boolean flag', async () => {
    const res = await put('new', {
      name: 'arr',
      host: '192.168.0.50',
      username: 'andy',
      systems: ['linux'],
      serverHost: 'yes',
    });
    expect(res.json().success).toBe(false);
  });
});
