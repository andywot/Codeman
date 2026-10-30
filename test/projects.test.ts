/**
 * @fileoverview Projects (fork): storage (src/projects.ts) and routes (project-routes.ts).
 * Real files in a temp data dir; routes via app.inject().
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { dirRef } = vi.hoisted(() => ({ dirRef: { dir: '' } }));
vi.mock('../src/config/instance.js', async (orig) => ({
  ...(await orig<typeof import('../src/config/instance.js')>()),
  getDataDir: () => dirRef.dir,
}));

import { createRouteTestHarness, type RouteTestHarness } from './routes/_route-test-utils.js';
import { registerProjectRoutes } from '../src/web/routes/project-routes.js';
import { readProjects, writeProjects, sameProject, ProjectInputSchema } from '../src/projects.js';

const pick = { name: 'api', target: 'pc-wsl', machine: 'PC', path: '/home/a/api', mode: 'claude' as const };

describe('projects storage', () => {
  beforeEach(async () => {
    dirRef.dir = await mkdtemp(join(tmpdir(), 'projects-'));
  });
  afterEach(async () => rm(dirRef.dir, { recursive: true, force: true }));

  it('reads nothing when the file is missing or unparsable', async () => {
    expect(await readProjects(dirRef.dir)).toEqual([]);
    await writeFile(join(dirRef.dir, 'projects.json'), '{nope');
    expect(await readProjects(dirRef.dir)).toEqual([]);
  });

  it('round-trips and drops malformed entries', async () => {
    await writeProjects(dirRef.dir, [{ ...pick, id: 'p-1', createdAt: 1 }]);
    const raw = JSON.parse(await readFile(join(dirRef.dir, 'projects.json'), 'utf8'));
    raw.projects.push({ id: 'p-bad', name: '', target: 'x', path: 'relative' });
    await writeFile(join(dirRef.dir, 'projects.json'), JSON.stringify(raw));
    expect((await readProjects(dirRef.dir)).map((p) => p.id)).toEqual(['p-1']);
  });

  it('validates input: absolute folder, trimmed name, no null fields', () => {
    expect(ProjectInputSchema.safeParse({ ...pick, path: 'rel' }).success).toBe(false);
    expect(ProjectInputSchema.safeParse({ ...pick, name: '  x  ' }).data?.name).toBe('x');
    expect(ProjectInputSchema.safeParse({ ...pick, accountId: null }).success).toBe(false);
  });

  it('treats the same pick as the same project', () => {
    const a = ProjectInputSchema.parse(pick);
    expect(sameProject(a, { ...a, name: 'other' })).toBe(true);
    expect(sameProject(a, { ...a, model: 'opus' })).toBe(false);
  });
});

describe('project routes', () => {
  let h: RouteTestHarness;
  beforeEach(async () => {
    dirRef.dir = await mkdtemp(join(tmpdir(), 'projects-'));
    h = await createRouteTestHarness((app) => registerProjectRoutes(app));
  });
  afterEach(async () => {
    await h.app.close();
    await rm(dirRef.dir, { recursive: true, force: true });
  });

  const post = (payload: unknown) => h.app.inject({ method: 'POST', url: '/api/projects', payload: payload as object });

  it('creates, lists, renames and deletes', async () => {
    const created = await post(pick);
    expect(created.statusCode).toBe(201);
    const id = created.json().data.project.id as string;

    const list = await h.app.inject({ method: 'GET', url: '/api/projects' });
    expect(list.json().data.projects).toHaveLength(1);

    const renamed = await h.app.inject({ method: 'PATCH', url: `/api/projects/${id}`, payload: { name: ' web ' } });
    expect(renamed.json().data.project.name).toBe('web');
    expect((await readProjects(dirRef.dir))[0].name).toBe('web');

    expect((await h.app.inject({ method: 'DELETE', url: `/api/projects/${id}` })).statusCode).toBe(200);
    expect((await h.app.inject({ method: 'DELETE', url: `/api/projects/${id}` })).statusCode).toBe(404);
    expect(await readProjects(dirRef.dir)).toEqual([]);
  });

  it('saving the same pick twice returns the existing project', async () => {
    const first = (await post(pick)).json().data.project;
    const second = await post({ ...pick, name: 'again' });
    expect(second.json().data).toMatchObject({ created: false, project: { id: first.id, name: 'api' } });
    expect(await readProjects(dirRef.dir)).toHaveLength(1);
  });

  it('rejects bad input with 400 and an unknown id with 404', async () => {
    expect((await post({ ...pick, path: 'relative' })).statusCode).toBe(400);
    expect((await post({ ...pick, name: '' })).statusCode).toBe(400);
    const r = await h.app.inject({ method: 'PATCH', url: '/api/projects/p-nope', payload: { name: 'x' } });
    expect(r.statusCode).toBe(404);
    const bad = await h.app.inject({ method: 'PATCH', url: '/api/projects/p-nope', payload: {} });
    expect(bad.statusCode).toBe(400);
  });

  it('concurrent saves of different picks all land', async () => {
    await Promise.all([1, 2, 3, 4, 5].map((n) => post({ ...pick, path: `/home/a/p${n}` })));
    expect(await readProjects(dirRef.dir)).toHaveLength(5);
  });
  it('reorders by id list, keeps unnamed projects after, ignores unknown ids', async () => {
    const ids: string[] = [];
    for (const n of [1, 2, 3]) ids.push((await post({ ...pick, path: `/home/a/p${n}` })).json().data.project.id);
    const put = (payload: unknown) =>
      h.app.inject({ method: 'PUT', url: '/api/projects/order', payload: payload as object });
    const r = await put({ ids: [ids[2], 'p-gone', ids[0]] });
    expect(r.statusCode).toBe(200);
    expect((await readProjects(dirRef.dir)).map((p) => p.id)).toEqual([ids[2], ids[0], ids[1]]);
    const list = await h.app.inject({ method: 'GET', url: '/api/projects' });
    expect(list.json().data.projects.map((p: { id: string }) => p.id)).toEqual([ids[2], ids[0], ids[1]]);
    expect((await put({ ids: 'nope' })).statusCode).toBe(400);
  });
});
