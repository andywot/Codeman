// Port: none (no server; a fake `ssh` on PATH runs the pooled shell locally).
//
// The pooled remote shell (src/remote-shell-pool.ts) replaces a fresh ssh login per
// command. Pinned here: output, stdin and exit codes come back exactly like `exec`;
// the maxBuffer limit is exact (base64 line breaks and the end marker are not output);
// a timeout or an oversized answer costs only that shell; later commands still run.
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeRemoteShells, remoteExec, remoteExecStatus } from '../src/remote-shell-pool.js';

const target = { host: 'pool.test', username: 'tester' } as const;
let savedPath: string | undefined;

beforeAll(() => {
  const bin = mkdtempSync(join(tmpdir(), 'rcpool-ssh-'));
  // ssh's last argument is the remote command; run it with sh, as sshd would.
  writeFileSync(
    join(bin, 'ssh'),
    '#!/bin/sh\nfor a; do last=$a; case $a in *SlowLogin*) sleep 0.5;; esac; done\nexec sh -c "$last"\n'
  );
  chmodSync(join(bin, 'ssh'), 0o755);
  savedPath = process.env.PATH;
  process.env.PATH = `${bin}:${process.env.PATH}`;
  process.env.CODEMAN_TEST_SHELL_POOL = '1';
});

afterAll(() => {
  closeRemoteShells();
  process.env.PATH = savedPath;
  delete process.env.CODEMAN_TEST_SHELL_POOL;
});

describe('remoteExec', () => {
  it('returns stdout, takes stdin, and survives quoting and binary bytes', async () => {
    expect((await remoteExec(target, `printf '%s|' "it's" $((1+2))`)).stdout.toString()).toBe("it's|3|");
    expect((await remoteExec(target, 'cat', { input: 'a\u0000b\n' })).stdout.toString()).toBe('a\u0000b\n');
  });

  it('rejects a failing command like exec, and remoteExecStatus resolves its code', async () => {
    await expect(remoteExec(target, 'echo no >&2; exit 4')).rejects.toMatchObject({ code: 4, stderr: 'no\n' });
    expect(await remoteExecStatus(target, 'echo part; exit 2')).toMatchObject({ code: 2 });
  });

  it('enforces maxBuffer exactly, and the next command still runs', async () => {
    expect((await remoteExec(target, 'head -c 300000 /dev/zero', { maxBuffer: 300000 })).stdout.length).toBe(300000);
    await expect(remoteExec(target, 'head -c 300001 /dev/zero', { maxBuffer: 300000 })).rejects.toMatchObject({
      code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
    });
    expect((await remoteExec(target, 'echo ok')).stdout.toString()).toBe('ok\n');
  });

  it('keeps a shell that was still connecting when a command timed out', async () => {
    const slow = { host: 'slow.test', username: 'tester', extraSshOptions: ['SlowLogin=yes'] };
    await expect(remoteExec(slow, 'echo never', { timeout: 100 })).rejects.toMatchObject({ killed: true });
    const started = Date.now();
    expect((await remoteExec(slow, 'echo ok')).stdout.toString()).toBe('ok\n');
    // Served by the shell that finished logging in, not a second slow login.
    expect(Date.now() - started).toBeLessThan(450);
  });

  it('times out one command without breaking later ones, and runs commands in parallel', async () => {
    await expect(remoteExec(target, 'sleep 5', { timeout: 300 })).rejects.toMatchObject({ killed: true });
    const out = await Promise.all([1, 2, 3, 4].map((i) => remoteExec(target, `sleep 0.1; echo ${i}`)));
    expect(out.map((r) => r.stdout.toString().trim())).toEqual(['1', '2', '3', '4']);
  });
});
