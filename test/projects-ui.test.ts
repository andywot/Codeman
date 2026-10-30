/**
 * @fileoverview Projects UI pure helpers (src/web/public/projects.js), loaded as the page loads them.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';

const src = readFileSync(join(process.cwd(), 'src/web/public/projects.js'), 'utf8');
// A browser script: run it against stubs and take its pure helper object.
const P = new Function('window', 'document', 'CodemanApp', `${src}\nreturn CodemanProjects;`)(
  {},
  { addEventListener() {} },
  { prototype: {} }
) as {
  defaultName(p: string): string;
  subtitle(p: Record<string, unknown>): string;
  toPick(p: Record<string, unknown>): Record<string, unknown>;
  fromPick(pick: Record<string, unknown>, o: Record<string, unknown>): Record<string, unknown>;
  hereLaunch(s: Record<string, unknown> | undefined, mode: string): Record<string, any> | null;
};

describe('CodemanProjects', () => {
  it('names a project after its folder by default', () => {
    expect(P.defaultName('/home/a/api')).toBe('api');
    expect(P.defaultName('/')).toBe('/');
  });

  it('builds a terse, machine-first subtitle', () => {
    expect(P.subtitle({ machine: 'PC', system: 'WSL', accountLabel: 'Work', model: 'opus', mode: 'claude' })).toBe(
      'PC · WSL · Work · Opus'
    );
    expect(P.subtitle({ target: 'local', mode: 'shell' })).toBe('This server · Shell');
  });

  it('turns a pick into a request body with no nulls and back into a pick', () => {
    const body = P.fromPick(
      { target: 'pc-wsl', path: '/x/y', mode: 'claude', accountId: undefined, model: undefined },
      { name: '  ', machine: 'PC', system: '', accountLabel: 'ignored' }
    );
    expect(body).toMatchObject({ name: 'y', machine: 'PC', accountId: undefined, accountLabel: undefined });
    expect(Object.values(body)).not.toContain(null);
    expect(P.toPick({ ...body, id: 'p-1' })).toEqual({
      target: 'pc-wsl',
      path: '/x/y',
      mode: 'claude',
      accountId: undefined,
      model: undefined,
    });
  });
});

describe('CodemanProjects.moveId', () => {
  const M = P as unknown as { moveId(ids: string[], d: string, t: string, after: boolean): string[] | null };
  it('moves a row before or after another', () => {
    expect(M.moveId(['a', 'b', 'c'], 'c', 'a', false)).toEqual(['c', 'a', 'b']);
    expect(M.moveId(['a', 'b', 'c'], 'a', 'b', true)).toEqual(['b', 'a', 'c']);
  });
  it('returns null when nothing changes', () => {
    expect(M.moveId(['a', 'b', 'c'], 'a', 'a', true)).toBeNull();
    expect(M.moveId(['a', 'b', 'c'], 'a', 'b', false)).toBeNull();
    expect(M.moveId(['a', 'b'], 'x', 'b', false)).toBeNull();
  });

  describe('hereLaunch ("New terminal here")', () => {
    it('local: same folder, target local, shell named "<folder> shell"', () => {
      expect(P.hereLaunch({ workingDir: '/home/a/api' }, 'shell')).toEqual({
        kind: 'pick',
        pick: { target: 'local', path: '/home/a/api', mode: 'shell', sessionName: 'api shell' },
      });
      expect(P.hereLaunch({ workingDir: '/home/a/api' }, 'claude')?.pick.sessionName).toBe('api');
    });

    it('remote: the session host (one system) and its remote folder, not the local pane dir', () => {
      const r = P.hereLaunch(
        { workingDir: '/tmp/local-pane', remote: { hostId: 'pc-win', remotePath: '/mnt/c/Users/x/proj' } },
        'shell'
      );
      expect(r).toEqual({
        kind: 'pick',
        pick: { target: 'pc-win', path: '/mnt/c/Users/x/proj', mode: 'shell', sessionName: 'proj shell' },
      });
    });

    it('docker goes through its case; unknown session is null', () => {
      expect(P.hereLaunch({ workingDir: '/w/app', docker: { hostId: 'h', containerName: 'c' } }, 'shell')?.kind).toBe(
        'case'
      );
      expect(P.hereLaunch(undefined, 'shell')).toBeNull();
      expect(P.hereLaunch({ remote: { hostId: '', remotePath: '/x' } }, 'shell')).toBeNull();
    });
  });
});
