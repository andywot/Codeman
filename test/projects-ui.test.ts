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
