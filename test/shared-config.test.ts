// Port: none (pure functions + the remote scripts run locally under a temp HOME).
//
// Shared Claude config (src/shared-config.ts): the store's hashes match what a machine
// reports, settings.json is MERGED (only the shared keys, env per variable, backup kept,
// refused when the file changed since it was read), credentials are never read or
// written, and the remote scripts really work when run by a shell, as the pooled
// shell runs them. Nothing here touches the real ~/.claude: every machine is a temp HOME.
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { RemoteHost } from '../src/types/index.js';
import {
  buildReadItemScript,
  buildSyncScript,
  buildTar,
  canonicalJson,
  compareWithMachine,
  hashJson,
  INVENTORY_SCRIPT,
  lineDiff,
  machineItems,
  mergeSettings,
  parseInventory,
  parseSyncOutput,
  readMachineInventory,
  readMachineItem,
  readStore,
  setItemShared,
  settingKeyRefusal,
  sha256,
  syncToHost,
  validSkillFilePath,
  writeStoreItem,
  type HostRunner,
} from '../src/shared-config.js';

const host = { id: 'laptop-wsl', label: 'Laptop · WSL', host: 'x', username: 'u', system: 'wsl' } as RemoteHost;

/** A fake machine: its own HOME, scripts run by /bin/sh exactly as the pooled shell would. */
function machine(): { home: string; claude: string; run: HostRunner } {
  const home = mkdtempSync(join(tmpdir(), 'rc-shared-home-'));
  const claude = join(home, '.claude');
  mkdirSync(claude);
  const run: HostRunner = async (_host, script, input) => {
    try {
      const stdout = execFileSync('sh', ['-c', script], {
        input: input ?? '',
        env: { PATH: process.env.PATH, HOME: home, SHELL: '/bin/sh' },
        maxBuffer: 64 * 1024 * 1024,
      });
      return { code: 0, stdout: stdout.toString('utf8'), stderr: '' };
    } catch (err) {
      const e = err as { status: number; stdout?: Buffer; stderr?: Buffer };
      return { code: e.status, stdout: e.stdout?.toString() ?? '', stderr: e.stderr?.toString() ?? '' };
    }
  };
  return { home, claude, run };
}

function write(path: string, text: string, mode?: number): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, text, mode ? { mode } : undefined);
}

/** A machine with one of everything, plus credentials that must never be touched. */
function populated() {
  const m = machine();
  write(join(m.claude, 'CLAUDE.md'), '# Me\nPrefer small diffs.\n');
  write(join(m.claude, 'agents', 'reviewer.md'), '---\nname: reviewer\n---\nReview.\n');
  write(join(m.claude, 'commands', 'ship.md'), 'Ship it.\n');
  write(join(m.claude, 'skills', 'deploy', 'SKILL.md'), '---\nname: deploy\n---\nDeploy.\n');
  write(join(m.claude, 'skills', 'deploy', 'scripts', 'run.sh'), '#!/bin/sh\necho hi\n', 0o755);
  write(join(m.claude, 'skills', 'deploy', '.env'), 'TOKEN=abc\n');
  write(join(m.claude, 'skills', 'deploy', 'node_modules', 'x', 'index.js'), 'x\n');
  write(join(m.claude, 'skills', 'deploy', 'key.secret'), 'shh\n');
  write(join(m.claude, '.credentials.json'), '{"claudeAiOauth":{"accessToken":"sk-ant-oat01-REAL"}}');
  write(join(m.home, '.claude.json'), '{"oauthAccount":{}}');
  write(join(m.home, '.config', 'claude-rc', 'personal.secret'), 'sk-ant-oat01-FLEET\n');
  write(
    join(m.claude, 'settings.json'),
    JSON.stringify(
      {
        model: 'opus',
        permissions: { allow: ['Bash(ls:*)'] },
        env: { FOO: '1', ANTHROPIC_AUTH_TOKEN: 'secret-value' },
        apiKeyHelper: '/bin/key',
        statusLine: { type: 'command', command: 'x' },
      },
      null,
      2
    ) + '\n'
  );
  return m;
}

function untouched(m: ReturnType<typeof machine>): void {
  expect(readFileSync(join(m.claude, '.credentials.json'), 'utf8')).toContain('sk-ant-oat01-REAL');
  expect(readFileSync(join(m.home, '.claude.json'), 'utf8')).toBe('{"oauthAccount":{}}');
  expect(readFileSync(join(m.home, '.config', 'claude-rc', 'personal.secret'), 'utf8')).toBe('sk-ant-oat01-FLEET\n');
}

async function importAll(configDir: string, run: HostRunner, ids: Array<[string, string]>): Promise<void> {
  for (const [kind, name] of ids) {
    const item = await readMachineItem(host, kind as never, name, run);
    expect(item, `${kind}:${name}`).not.toBeNull();
    await writeStoreItem(configDir, kind as never, name, item!, { importedFrom: host.id });
  }
}

describe('hashes', () => {
  it('canonical JSON ignores key order at every level', () => {
    expect(canonicalJson({ b: 1, a: { d: [1, { y: 1, x: 2 }], c: null } })).toBe(
      '{"a":{"c":null,"d":[1,{"x":2,"y":1}]},"b":1}'
    );
    expect(hashJson({ a: 1, b: 2 })).toBe(hashJson({ b: 2, a: 1 }));
    expect(hashJson({ a: 1 })).not.toBe(hashJson({ a: 2 }));
  });

  it('refuses settings keys that hold credentials and skill files that look like keys', () => {
    expect(settingKeyRefusal('permissions')).toBeNull();
    expect(settingKeyRefusal('env')).toBeNull();
    expect(settingKeyRefusal('apiKeyHelper')).not.toBeNull();
    expect(settingKeyRefusal('awsAuthRefresh')).not.toBeNull();
    expect(settingKeyRefusal('fooToken')).not.toBeNull();
    for (const bad of [
      '.env',
      '.env.local',
      'a/b.secret',
      '.credentials.json',
      'id.pem',
      '../x',
      'a//b',
      'node_modules/x',
    ]) {
      expect(validSkillFilePath(bad), bad).toBe(false);
    }
    expect(validSkillFilePath('scripts/run.sh')).toBe(true);
  });
});

describe('settings merge', () => {
  const machineText =
    '{\n    "model": "sonnet",\n    "hooks": {"Stop": []},\n    "env": {"A": "machine", "MY_TOKEN": "keep"}\n}\n';

  it('changes only the shared keys, keeps the rest and their order', () => {
    const store = { model: 'opus', permissions: { allow: ['Read'] }, hooks: { X: 1 } };
    const { text, changed } = mergeSettings(machineText, store, ['model', 'permissions']);
    expect(changed).toEqual(['model', 'permissions']);
    const out = JSON.parse(text);
    expect(Object.keys(out)).toEqual(['model', 'hooks', 'env', 'permissions']);
    expect(out.model).toBe('opus');
    expect(out.hooks).toEqual({ Stop: [] }); // not selected: untouched
    expect(out.permissions).toEqual({ allow: ['Read'] });
    expect(text).toContain('\n    "model"'); // the file's own indentation
  });

  it('merges env per variable and never removes or ships credential-looking variables', () => {
    const store = { env: { A: 'store', B: 'new', OTHER_SECRET: 'leak' } };
    const out = JSON.parse(mergeSettings(machineText, store, ['env']).text);
    expect(out.env).toEqual({ A: 'store', MY_TOKEN: 'keep', B: 'new' });
  });

  it('returns the file unchanged when nothing differs, and refuses a file that does not parse', () => {
    const same = mergeSettings(machineText, { model: 'sonnet' }, ['model']);
    expect(same).toEqual({ text: machineText, changed: [] });
    expect(() => mergeSettings('{"model": ', { model: 'x' }, ['model'])).toThrow(/does not parse/);
    expect(() => mergeSettings('[1]', { model: 'x' }, ['model'])).toThrow(/not a JSON object/);
    expect(JSON.parse(mergeSettings(null, { model: 'x' }, ['model']).text)).toEqual({ model: 'x' });
  });

  it('never writes a credential key even if one reached the store', () => {
    const { changed } = mergeSettings('{}', { apiKeyHelper: '/x' }, ['apiKeyHelper']);
    expect(changed).toEqual([]);
  });
});

describe('remote scripts (run locally under a temp HOME)', () => {
  it('inventories a machine and skips credentials, pruned folders and key files', async () => {
    const m = populated();
    const inv = parseInventory((await m.run(host, INVENTORY_SCRIPT)).stdout);
    const items = machineItems(inv);
    expect([...items.keys()].sort()).toEqual(
      [
        'agent:reviewer.md',
        'command:ship.md',
        'memory:CLAUDE.md',
        'skill:deploy',
        'setting:apiKeyHelper',
        'setting:env',
        'setting:model',
        'setting:permissions',
        'setting:statusLine',
      ].sort()
    );
    expect(
      inv.skills
        .get('deploy')!
        .files.map((f) => f.path)
        .sort()
    ).toEqual(['SKILL.md', 'scripts/run.sh']);
    expect(items.get('setting:apiKeyHelper')!.problem).toMatch(/credentials/);
    expect(items.get('memory:CLAUDE.md')!.hash).toBe(sha256('# Me\nPrefer small diffs.\n'));
    untouched(m);
  });

  it('reports a machine without ~/.claude', async () => {
    const m = machine();
    execFileSync('rmdir', [m.claude]);
    const inv = parseInventory((await m.run(host, INVENTORY_SCRIPT)).stdout);
    expect(inv.hasClaudeDir).toBe(false);
    expect(machineItems(inv).size).toBe(0);
  });

  it('imports into the store with the same hashes the machine reports (all in sync)', async () => {
    const m = populated();
    const configDir = mkdtempSync(join(tmpdir(), 'rc-shared-store-'));
    await importAll(configDir, m.run, [
      ['skill', 'deploy'],
      ['memory', 'CLAUDE.md'],
      ['agent', 'reviewer.md'],
      ['command', 'ship.md'],
      ['setting', 'permissions'],
      ['setting', 'env'],
    ]);
    const store = await readStore(configDir);
    // env reached the store without the credential-looking variable.
    expect(store.settings.env).toEqual({ FOO: '1' });
    expect(store.items.find((i) => i.name === 'env')!.envKeys).toEqual(['FOO']);
    expect(existsSync(join(configDir, 'shared-claude', 'skills', 'deploy', '.env'))).toBe(false);
    expect(
      statSync(join(configDir, 'shared-claude', 'skills', 'deploy', 'scripts', 'run.sh')).mode & 0o100
    ).toBeTruthy();
    const inv = await readMachineInventory(host, m.run);
    const states = compareWithMachine(store, inv).filter((s) => s.inStore);
    expect(states.map((s) => `${s.kind}:${s.name}=${s.state}`).sort()).toEqual(
      [
        'agent:reviewer.md=in-sync',
        'command:ship.md=in-sync',
        'memory:CLAUDE.md=in-sync',
        'setting:env=in-sync',
        'setting:permissions=in-sync',
        'skill:deploy=in-sync',
      ].sort()
    );
    // A credential key cannot be imported.
    await expect(writeStoreItem(configDir, 'setting', 'apiKeyHelper', { value: '/x' })).rejects.toThrow();
  });

  it('read-item reports a missing item', async () => {
    const m = machine();
    expect(await readMachineItem(host, 'skill', 'nope', m.run)).toBeNull();
    expect(await readMachineItem(host, 'memory', 'CLAUDE.md', m.run)).toBeNull();
    expect(() => buildReadItemScript('skill', "x'; rm -rf ~")).toThrow();
  });
});

describe('sync', () => {
  async function storeFrom(m: ReturnType<typeof machine>): Promise<string> {
    const configDir = mkdtempSync(join(tmpdir(), 'rc-shared-store-'));
    await importAll(configDir, m.run, [
      ['skill', 'deploy'],
      ['memory', 'CLAUDE.md'],
      ['agent', 'reviewer.md'],
      ['setting', 'permissions'],
      ['setting', 'env'],
      ['setting', 'model'],
    ]);
    return configDir;
  }

  it('pushes missing and differing items, merges settings and keeps backups', async () => {
    const source = populated();
    const configDir = await storeFrom(source);
    await setItemShared(configDir, 'setting', 'model', false); // in the store but not shared

    const target = machine();
    write(join(target.claude, 'CLAUDE.md'), '# Old memory\n');
    write(join(target.claude, 'skills', 'deploy', 'SKILL.md'), 'old\n');
    write(join(target.claude, 'skills', 'deploy', 'stale.txt'), 'stale\n');
    const settingsBefore =
      '{\n  "model": "haiku",\n  "hooks": {"Stop": []},\n  "env": {"BAR": "2", "ANTHROPIC_AUTH_TOKEN": "theirs"}\n}\n';
    write(join(target.claude, 'settings.json'), settingsBefore);
    write(join(target.claude, '.credentials.json'), '{"claudeAiOauth":{"accessToken":"sk-ant-oat01-REAL"}}');
    write(join(target.home, '.claude.json'), '{"oauthAccount":{}}');
    write(join(target.home, '.config', 'claude-rc', 'personal.secret'), 'sk-ant-oat01-FLEET\n');

    const report = await syncToHost(configDir, host, target.run);
    expect(report.results.filter((r) => r.outcome !== 'ok')).toEqual([]);
    expect(report.results.map((r) => r.path).sort()).toEqual(
      ['CLAUDE.md', 'agents/reviewer.md', 'settings.json', 'skills/deploy'].sort()
    );

    expect(readFileSync(join(target.claude, 'CLAUDE.md'), 'utf8')).toBe('# Me\nPrefer small diffs.\n');
    expect(existsSync(join(target.claude, 'skills', 'deploy', 'stale.txt'))).toBe(false);
    expect(statSync(join(target.claude, 'skills', 'deploy', 'scripts', 'run.sh')).mode & 0o100).toBeTruthy();
    const settings = JSON.parse(readFileSync(join(target.claude, 'settings.json'), 'utf8'));
    expect(settings).toEqual({
      model: 'haiku', // not shared: untouched
      hooks: { Stop: [] }, // not in the store: untouched
      env: { BAR: '2', ANTHROPIC_AUTH_TOKEN: 'theirs', FOO: '1' },
      permissions: { allow: ['Bash(ls:*)'] },
    });

    // Backups: settings next to the file, everything else in .rc-sync-backup/<stamp>/.
    const backups = readdirSync(target.claude).filter((f) => f.startsWith('settings.json.rc-backup-'));
    expect(backups).toHaveLength(1);
    expect(readFileSync(join(target.claude, backups[0]), 'utf8')).toBe(settingsBefore);
    const [stamp] = readdirSync(join(target.claude, '.rc-sync-backup'));
    expect(readFileSync(join(target.claude, '.rc-sync-backup', stamp, 'CLAUDE.md'), 'utf8')).toBe('# Old memory\n');
    expect(readFileSync(join(target.claude, '.rc-sync-backup', stamp, 'skills', 'deploy', 'stale.txt'), 'utf8')).toBe(
      'stale\n'
    );
    // No staging folder left behind; credentials untouched.
    expect(readdirSync(target.claude).filter((f) => f.startsWith('.rc-sync-') && f !== '.rc-sync-backup')).toEqual([]);
    untouched(target);

    // Now everything shared is in sync, and a second sync writes nothing.
    const store = await readStore(configDir);
    const states = compareWithMachine(store, await readMachineInventory(host, target.run)).filter((s) => s.shared);
    expect(states.every((s) => s.state === 'in-sync')).toBe(true);
    const again = await syncToHost(configDir, host, target.run);
    expect(again.results).toEqual([]);
    expect(readdirSync(target.claude).filter((f) => f.startsWith('settings.json.rc-backup-'))).toHaveLength(1);
  });

  it('skips a symlinked target and a settings.json that changed since it was read', async () => {
    const target = machine();
    const elsewhere = mkdtempSync(join(tmpdir(), 'rc-shared-dotfiles-'));
    write(join(elsewhere, 'SKILL.md'), 'mine\n');
    mkdirSync(join(target.claude, 'skills'));
    symlinkSync(elsewhere, join(target.claude, 'skills', 'deploy'));
    write(join(target.claude, 'settings.json'), '{"model":"x"}\n');

    const tar = buildTar([
      { path: 'skills/deploy/SKILL.md', content: Buffer.from('new\n') },
      { path: 'settings.json', content: Buffer.from('{"model":"y"}\n') },
    ]);
    const script = buildSyncScript({
      stamp: '20261030-120000',
      puts: ['skills/deploy'],
      settingsExpectedSha: sha256('stale'),
    });
    const out = parseSyncOutput((await target.run(host, script, tar)).stdout);
    expect(out).toEqual([
      { outcome: 'skip', path: 'skills/deploy', reason: 'symlink' },
      { outcome: 'skip', path: 'settings.json', reason: 'changed' },
    ]);
    expect(lstatSync(join(target.claude, 'skills', 'deploy')).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(elsewhere, 'SKILL.md'), 'utf8')).toBe('mine\n');
    expect(readFileSync(join(target.claude, 'settings.json'), 'utf8')).toBe('{"model":"x"}\n');
  });

  it('writes through a symlinked settings.json and keeps its mode', async () => {
    const target = machine();
    const elsewhere = mkdtempSync(join(tmpdir(), 'rc-shared-dotfiles-'));
    write(join(elsewhere, 'settings.json'), '{"model":"x"}\n', 0o640);
    symlinkSync(join(elsewhere, 'settings.json'), join(target.claude, 'settings.json'));
    const tar = buildTar([{ path: 'settings.json', content: Buffer.from('{"model":"y"}\n') }]);
    const script = buildSyncScript({
      stamp: '20261030-120000',
      puts: [],
      settingsExpectedSha: sha256('{"model":"x"}\n'),
    });
    expect(parseSyncOutput((await target.run(host, script, tar)).stdout)).toEqual([
      { outcome: 'ok', path: 'settings.json' },
    ]);
    expect(lstatSync(join(target.claude, 'settings.json')).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(elsewhere, 'settings.json'), 'utf8')).toBe('{"model":"y"}\n');
    expect(statSync(join(elsewhere, 'settings.json')).mode & 0o777).toBe(0o640);
  });

  it('keeps only the newest ten backups', async () => {
    const target = machine();
    for (let i = 0; i < 12; i++) {
      mkdirSync(join(target.claude, '.rc-sync-backup', `202610${String(i + 10).padStart(2, '0')}-000000`), {
        recursive: true,
      });
      write(join(target.claude, `settings.json.rc-backup-202610${String(i + 10).padStart(2, '0')}-000000`), '{}');
    }
    write(join(target.claude, '.rc-sync-backup', 'keep-me'), 'not a stamp');
    const tar = buildTar([{ path: 'CLAUDE.md', content: Buffer.from('x\n') }]);
    await target.run(host, buildSyncScript({ stamp: '20261031-000000', puts: ['CLAUDE.md'] }), tar);
    const left = readdirSync(join(target.claude, '.rc-sync-backup')).sort();
    expect(left).toHaveLength(11); // ten stamps + the unrelated file
    expect(left).toContain('keep-me');
    expect(left).not.toContain('20261010-000000');
    expect(readdirSync(target.claude).filter((f) => f.startsWith('settings.json.rc-backup-'))).toHaveLength(10);
  });

  it('refuses paths outside the shareable set in the write script', () => {
    for (const bad of ['.credentials.json', '../x', 'skills/a/b', 'settings.json', 'projects/x']) {
      expect(() => buildSyncScript({ stamp: '20261030-120000', puts: [bad] }), bad).toThrow();
    }
    expect(() => buildSyncScript({ stamp: '$(id)', puts: [] })).toThrow();
  });

  it('builds a tar the system tar extracts, long paths included', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rc-shared-tar-'));
    const long = `skills/${'a'.repeat(60)}/${'b'.repeat(60)}/${'c'.repeat(70)}.md`;
    execFileSync('tar', ['-xf', '-', '-C', dir], {
      input: buildTar([
        { path: long, content: Buffer.from('long\n') },
        { path: 'x.sh', content: Buffer.from('#!/bin/sh\n'), executable: true },
      ]),
    });
    expect(readFileSync(join(dir, long), 'utf8')).toBe('long\n');
    expect(statSync(join(dir, 'x.sh')).mode & 0o100).toBeTruthy();
  });
});

describe('diffs for the browser', () => {
  it('shows changed lines with context and hides secret-looking lines', () => {
    const machineText = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'token = sk-ant-oat01-abcdefgh', 'z'].join('\n');
    const storeText = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'H', 'z'].join('\n');
    const { lines } = lineDiff(machineText, storeText);
    expect(lines[0]).toEqual({ op: '@', text: '…' });
    expect(lines.filter((l) => l.op !== ' ' && l.op !== '@')).toEqual([
      { op: '-', text: 'h' },
      { op: '-', text: '[hidden: looks like a secret]' },
      { op: '+', text: 'H' },
    ]);
    expect(JSON.stringify(lines)).not.toContain('sk-ant');
  });

  it('shows a missing file as all added, and a final-newline-only change as a note', () => {
    expect(lineDiff('', 'a\nb\n').lines).toEqual([
      { op: '+', text: 'a' },
      { op: '+', text: 'b' },
    ]);
    expect(lineDiff('a', 'a\n').lines).toEqual([{ op: '@', text: 'Only the final newline differs.' }]);
    expect(lineDiff('x\n'.repeat(3000), 'y\n'.repeat(3000)).tooLarge).toBe(true);
  });
});
