/**
 * @fileoverview Remote (ssh) half of the paste-upload sweep (src/web/paste-image-gc.ts).
 * The script is also RUN here, with the local sh, against a real folder: it is the thing that deletes files.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, utimesSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildRemoteSweepScript, sweepRemotePasteImagesOnce } from '../src/web/paste-image-gc.js';

const remote = (hostId: string, remotePath: string) => ({
  remote: { hostId, host: `${hostId}.lan`, username: 'u', remotePath, label: hostId },
});
const hostIdOf = (host: unknown): string => (host as { hostId: string }).hostId;

describe('buildRemoteSweepScript', () => {
  it('names only paste-* regular files directly in .codeman-uploads, older than 7 days, never following links', () => {
    const script = buildRemoteSweepScript(['/home/a/proj']);
    expect(script).toContain("find '/home/a/proj/.codeman-uploads' -maxdepth 1 -type f -name 'paste-*' -mtime +7");
    expect(script).toContain("[ ! -L '/home/a/proj/.codeman-uploads' ]");
    expect(script).not.toMatch(/find -L|-follow|find -H/);
  });

  it('quotes a hostile folder name as one token', () => {
    const script = buildRemoteSweepScript(["/x/$(touch pwned); 'q"]);
    expect(script).toContain("'\\''");
    // The only unquoted text is our own fixed syntax: the payload sits inside single quotes.
    expect(script.startsWith("if [ -d '/x/$(touch pwned); ")).toBe(true);
  });

  describe('run against a real folder', () => {
    let root: string;
    const old = new Date(Date.now() - 9 * 86400_000);
    beforeEach(() => {
      root = mkdtempSync(join(tmpdir(), 'rsweep-'));
    });
    afterEach(() => rmSync(root, { recursive: true, force: true }));

    it('deletes only old paste-* regular files at the top of a real uploads dir', () => {
      const up = join(root, 'proj', '.codeman-uploads');
      mkdirSync(join(up, 'paste-sub'), { recursive: true });
      const mk = (name: string, aged: boolean) => {
        const p = join(up, name);
        writeFileSync(p, 'x');
        if (aged) utimesSync(p, old, old);
        return p;
      };
      const oldPaste = mk('paste-1-old.png', true);
      const newPaste = mk('paste-2-new.png', false);
      const oldOther = mk('notes.txt', true);
      const gitignore = mk('.gitignore', true);
      const nested = join(up, 'paste-sub', 'paste-deep.png');
      writeFileSync(nested, 'x');
      utimesSync(nested, old, old);
      const outside = join(root, 'secret.png');
      writeFileSync(outside, 'x');
      utimesSync(outside, old, old);
      symlinkSync(outside, join(up, 'paste-link.png'));

      execFileSync('sh', ['-c', buildRemoteSweepScript([join(root, 'proj')])]);

      expect(existsSync(oldPaste)).toBe(false);
      expect(existsSync(newPaste)).toBe(true);
      expect(existsSync(oldOther)).toBe(true);
      expect(existsSync(gitignore)).toBe(true);
      expect(existsSync(nested)).toBe(true);
      expect(existsSync(outside)).toBe(true);
      expect(existsSync(join(up, 'paste-link.png'))).toBe(true);
    });

    it('does nothing through a symlinked .codeman-uploads or a missing one', () => {
      const real = join(root, 'elsewhere');
      mkdirSync(real);
      const victim = join(real, 'paste-old.png');
      writeFileSync(victim, 'x');
      utimesSync(victim, old, old);
      mkdirSync(join(root, 'proj'));
      symlinkSync(real, join(root, 'proj', '.codeman-uploads'));
      mkdirSync(join(root, 'none'));
      execFileSync('sh', ['-c', buildRemoteSweepScript([join(root, 'proj'), join(root, 'none'), join(root, 'gone')])]);
      expect(existsSync(victim)).toBe(true);
    });
  });
});

describe('sweepRemotePasteImagesOnce', () => {
  it('sends ONE command per host, naming each distinct workspace of that host once', async () => {
    const calls: Array<{ host: string; script: string }> = [];
    const sessions = new Map<string, unknown>([
      ['1', remote('pc', '/home/a/x')],
      ['2', remote('pc', '/home/a/x/')],
      ['3', remote('pc', '/home/a/y')],
      ['4', remote('nas', '/srv/z')],
      ['5', {}], // a local session
    ]);
    const res = await sweepRemotePasteImagesOnce({ sessions: sessions as never }, async (host, script) => {
      calls.push({ host: hostIdOf(host), script });
    });
    expect(res).toEqual({ hosts: 2, swept: 2, failed: 0 });
    expect(calls).toHaveLength(2);
    const pc = calls.find((c) => c.host === 'pc')!;
    expect(pc.script.match(/-mtime \+7/g)).toHaveLength(2);
    expect(pc.script).toContain('/home/a/x/.codeman-uploads');
    expect(pc.script).toContain('/home/a/y/.codeman-uploads');
  });

  it('skips relative or root workspaces, and a failing host does not stop the others', async () => {
    const seen: string[] = [];
    const sessions = new Map<string, unknown>([
      ['1', remote('bad', 'relative/path')],
      ['2', remote('root', '/')],
      ['3', remote('off', '/home/a/p')],
      ['4', remote('on', '/home/b/p')],
    ]);
    const res = await sweepRemotePasteImagesOnce({ sessions: sessions as never }, async (host) => {
      seen.push(hostIdOf(host));
      if (hostIdOf(host) === 'off') throw new Error('asleep');
    });
    expect(seen).toEqual(['off', 'on']);
    expect(res).toEqual({ hosts: 2, swept: 1, failed: 1 });
  });

  it('opens no connection under test by default (the pool rejects, the sweep swallows it)', async () => {
    const sessions = new Map<string, unknown>([['1', remote('pc', '/home/a/x')]]);
    const res = await sweepRemotePasteImagesOnce({ sessions: sessions as never });
    expect(res).toEqual({ hosts: 1, swept: 0, failed: 1 });
  });
});
