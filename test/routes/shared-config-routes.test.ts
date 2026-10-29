// Port: none (app.inject). The "machines" are temp HOMEs and the runner executes the
// remote scripts locally with /bin/sh, so no ssh and no real ~/.claude is involved.
//
// Pinned: the browser never receives env values or secret-looking lines; credential
// settings keys cannot be imported; import → share → target → sync → in sync round trip;
// a Windows-native machine is refused.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRouteTestHarness } from './_route-test-utils.js';
import { registerSharedConfigRoutes } from '../../src/web/routes/shared-config-routes.js';
import type { HostRunner } from '../../src/shared-config.js';

let app: FastifyInstance;
let configDir: string;
const homes: Record<string, string> = {};

const run: HostRunner = async (host, script, input) => {
  try {
    const stdout = execFileSync('sh', ['-c', script], {
      input: input ?? '',
      env: { PATH: process.env.PATH, HOME: homes[host.id], SHELL: '/bin/sh' },
    });
    return { code: 0, stdout: stdout.toString(), stderr: '' };
  } catch (err) {
    const e = err as { status: number; stdout?: Buffer; stderr?: Buffer };
    return { code: e.status, stdout: e.stdout?.toString() ?? '', stderr: e.stderr?.toString() ?? '' };
  }
};

function file(path: string, text: string): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, text);
}

beforeEach(async () => {
  configDir = mkdtempSync(join(tmpdir(), 'rc-shared-routes-'));
  for (const id of ['laptop-wsl', 'arr-linux']) homes[id] = mkdtempSync(join(tmpdir(), `rc-${id}-`));
  const hosts = [
    { id: 'laptop-wsl', label: 'Laptop · WSL', host: '10.0.0.2', username: 'a', machine: 'Laptop', system: 'wsl' },
    { id: 'arr-linux', label: 'arr · Linux', host: '10.0.0.3', username: 'a', machine: 'arr', system: 'linux' },
    { id: 'desktop-windows', label: 'Desktop · Windows', host: '10.0.0.4', username: 'a', system: 'windows' },
  ];
  writeFileSync(join(configDir, 'remote-hosts.json'), JSON.stringify(hosts));
  const laptop = join(homes['laptop-wsl'], '.claude');
  file(join(laptop, 'skills', 'deploy', 'SKILL.md'), 'Deploy.\n');
  file(join(laptop, 'CLAUDE.md'), 'line one\napi_key = sk-ant-api03-SECRETSECRET\n');
  file(
    join(laptop, 'settings.json'),
    JSON.stringify({
      permissions: { allow: ['Read'] },
      env: { FOO: 'bar-value', GH_TOKEN: 'ghp_x' },
      apiKeyHelper: 'k',
    })
  );
  file(join(homes['arr-linux'], '.claude', 'CLAUDE.md'), 'old\n');
  ({ app } = await createRouteTestHarness((a) => registerSharedConfigRoutes(a, { configDir, run })));
});

afterEach(async () => {
  await app.close();
});

const get = async (url: string) => (await app.inject({ method: 'GET', url })).json();
const send = async (method: 'POST' | 'PUT' | 'DELETE', url: string, payload?: unknown) =>
  (await app.inject({ method, url, ...(payload ? { payload } : {}) })).json();

describe('shared config routes', () => {
  it('imports, shares and syncs to the chosen machines', async () => {
    for (const [kind, name] of [
      ['skill', 'deploy'],
      ['memory', 'CLAUDE.md'],
      ['setting', 'permissions'],
      ['setting', 'env'],
    ]) {
      const r = await send('POST', '/api/shared-config/import', { hostId: 'laptop-wsl', kind, name });
      expect(r.success, `${kind}:${name}`).toBe(true);
      if (name === 'env') expect(r.data.withheld).toEqual(['GH_TOKEN']);
    }
    const listing = await get('/api/shared-config');
    expect(listing.data.items.map((i: { kind: string; name: string }) => `${i.kind}:${i.name}`)).toEqual([
      'skill:deploy',
      'memory:CLAUDE.md',
      'setting:env',
      'setting:permissions',
    ]);
    expect(listing.data.items.find((i: { name: string }) => i.name === 'env').envKeys).toEqual(['FOO']);
    expect(JSON.stringify(listing)).not.toContain('bar-value');
    expect(listing.data.machines.find((m: { id: string }) => m.id === 'desktop-windows').unsupported).toMatch(
      /Windows/
    );

    const before = await get('/api/shared-config/hosts/arr-linux');
    const states = Object.fromEntries(
      before.data.items.map((i: { kind: string; name: string; state: string }) => [`${i.kind}:${i.name}`, i.state])
    );
    expect(states).toEqual({
      'skill:deploy': 'missing',
      'memory:CLAUDE.md': 'differs',
      'setting:env': 'missing',
      'setting:permissions': 'missing',
    });

    // The diff hides the secret-looking line; env shows names only.
    const diff = await get('/api/shared-config/hosts/arr-linux/diff?kind=memory&name=CLAUDE.md');
    expect(diff.data.mode).toBe('lines');
    expect(JSON.stringify(diff)).not.toContain('SECRETSECRET');
    const envDiff = await get('/api/shared-config/hosts/arr-linux/diff?kind=setting&name=env');
    expect(envDiff.data).toEqual({ mode: 'env', vars: [{ name: 'FOO', state: 'store-only' }] });

    expect((await send('PUT', '/api/shared-config/targets', { hostIds: ['arr-linux'] })).success).toBe(true);
    const sync = await send('POST', '/api/shared-config/sync', {});
    expect(sync.data.hosts).toHaveLength(1);
    expect(sync.data.hosts[0]).toMatchObject({ hostId: 'arr-linux', ok: true });

    const after = await get('/api/shared-config/hosts/arr-linux');
    expect(after.data.items.every((i: { state: string }) => i.state === 'in-sync')).toBe(true);
    const settings = JSON.parse(readFileSync(join(homes['arr-linux'], '.claude', 'settings.json'), 'utf8'));
    expect(settings).toEqual({ permissions: { allow: ['Read'] }, env: { FOO: 'bar-value' } });
  });

  it('refuses credential keys, unknown items and Windows-native machines', async () => {
    const key = await send('POST', '/api/shared-config/import', {
      hostId: 'laptop-wsl',
      kind: 'setting',
      name: 'apiKeyHelper',
    });
    expect(key.success).toBe(false);
    const missing = await send('POST', '/api/shared-config/import', {
      hostId: 'laptop-wsl',
      kind: 'skill',
      name: 'nope',
    });
    expect(missing.success).toBe(false);
    const win = await get('/api/shared-config/hosts/desktop-windows');
    expect(win.success).toBe(false);
    expect(win.error).toMatch(/Windows/);
    const bad = await send('PUT', '/api/shared-config/items/skill/.hidden', { shared: true });
    expect(bad.success).toBe(false);
    const noTargets = await send('POST', '/api/shared-config/sync', {});
    expect(noTargets.success).toBe(false);
  });

  it('stops sharing and removes items', async () => {
    await send('POST', '/api/shared-config/import', { hostId: 'laptop-wsl', kind: 'skill', name: 'deploy' });
    expect((await send('PUT', '/api/shared-config/items/skill/deploy', { shared: false })).success).toBe(true);
    expect((await get('/api/shared-config')).data.items[0].shared).toBe(false);
    // Not shared: a sync writes nothing.
    const sync = await send('POST', '/api/shared-config/sync', { hostIds: ['arr-linux'] });
    expect(sync.data.hosts[0].results).toEqual([]);
    expect((await send('DELETE', '/api/shared-config/items/skill/deploy')).success).toBe(true);
    expect((await get('/api/shared-config')).data.items).toEqual([]);
  });
});
