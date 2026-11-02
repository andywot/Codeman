/**
 * Chat view against what the terminal shows: which log it follows, messages sent with
 * pictures, subagents, artifacts, the / picker; and the laptop battery and keep-awake.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { buildAgentLocateScript, buildLocateScript, parseSkillListing } from '../src/chat-transcript.js';
import { buildProbeScript, parseBatteryLine, parseProbeOutput } from '../src/machine-status.js';
import { buildKeepAwakeScript, keepAwakeTargets } from '../src/machine-keep-awake.js';
import type { RemoteHost } from '../src/types.js';

const here = (name: string) => join(process.cwd(), 'src/web/public', name);

function loadChat(): Record<string, (...args: never[]) => unknown> {
  const win: Record<string, unknown> = { addEventListener() {}, matchMedia: () => ({ matches: false }) };
  class CodemanApp {}
  const doc = { readyState: 'complete', addEventListener() {} };
  // Only the pure helpers run: the wiring at the bottom waits for window.app.
  new Function('window', 'document', 'CodemanApp', 'setTimeout', readFileSync(here('chat-view.js'), 'utf8'))(
    win,
    doc,
    CodemanApp,
    () => 0
  );
  return win.CodemanChat as never;
}
const chat = loadChat() as Record<string, (...args: unknown[]) => any>;

function reconcile() {
  const win: Record<string, any> = {};
  new Function('window', readFileSync(here('chat-core.js'), 'utf8'))(win);
  return win.CodemanChatCore.reconcileOutbox;
}

describe('which log chat follows', () => {
  const run = (records: Record<string, string>, logs: string[]) => {
    const home = mkdtempSync(join(tmpdir(), 'chat-locate-'));
    mkdirSync(join(home, '.claude/sessions'), { recursive: true });
    mkdirSync(join(home, '.claude/projects/p'), { recursive: true });
    for (const [pid, body] of Object.entries(records)) writeFileSync(join(home, `.claude/sessions/${pid}.json`), body);
    for (const log of logs) writeFileSync(join(home, `.claude/projects/p/${log}.jsonl`), '{}\n');
    return execFileSync('/bin/sh', ['-c', buildLocateScript('codeman-ssh-abc', 'launch-id')], {
      env: { HOME: home, PATH: process.env.PATH },
      encoding: 'utf8',
    }).trim();
  };
  // Pids that exist while the test runs, so the liveness check passes.
  const alive = process.pid;
  const parent = process.ppid;
  const record = (sessionId: string, startedAt: number, kind = 'interactive') =>
    JSON.stringify({ sessionId, startedAt, kind, tmux: 'codeman-ssh-abc:@1.%1' });

  it('keeps the pane’s own claude when a claude -p runs inside it', () => {
    const path = run({ [alive]: record('real', 100), [parent]: record('child', 200, 'print') }, ['real', 'child']);
    expect(path.endsWith('/real.jsonl')).toBe(true);
  });

  it('keeps the older interactive claude when another is started inside the pane', () => {
    const path = run({ [alive]: record('nested', 200), [parent]: record('real', 100) }, ['real', 'nested']);
    expect(path.endsWith('/real.jsonl')).toBe(true);
  });

  it('skips the record of a claude that has exited', () => {
    const path = run({ [alive]: record('now', 200), '999999999': record('dead', 100) }, ['now', 'dead']);
    expect(path.endsWith('/now.jsonl')).toBe(true);
  });

  it('falls back to the launch id', () => {
    expect(run({}, ['launch-id']).endsWith('/launch-id.jsonl')).toBe(true);
  });
});

describe('a message sent with a picture', () => {
  const path = '/w/.codeman-uploads/paste-1-a.png';

  it('is recognized in the log, so it is not drawn twice', () => {
    const message = {
      id: 'm',
      text: `${path} hello there`,
      matchText: 'hello there',
      state: 'sent',
      handed: true,
      createdAt: Date.parse('2026-11-02T00:00:00Z'),
    };
    const entry = {
      role: 'user',
      timestamp: '2026-11-02T00:00:01Z',
      blocks: [{ type: 'text', text: `${path} hello there` }],
    };
    expect(reconcile()([message], [entry]).seen).toEqual(['m']);
  });

  it('draws the picture instead of its path', () => {
    expect(chat.chatSplitUploads(`${path} hello`)).toEqual({ text: 'hello', uploads: [path] });
    expect(chat.chatSplitUploads('see /w/notes.png')).toEqual({ text: 'see /w/notes.png', uploads: [] });
  });
});

describe('agents and artifacts', () => {
  const assistant = (id: string, input: object, name: string) => ({
    uuid: id,
    role: 'assistant',
    timestamp: '',
    blocks: [{ type: 'tool_use', id, name, input }],
  });
  const result = (id: string, text: string, title?: string) => ({
    uuid: `r${id}`,
    role: 'user',
    timestamp: '',
    blocks: [{ type: 'tool_result', toolUseId: id, text, title }],
  });

  it('gives each agent its own row, tied to its tool call', () => {
    const items = chat.buildChatItems([
      assistant('t1', { description: 'first' }, 'Agent'),
      assistant('t2', { description: 'second' }, 'Agent'),
    ]);
    expect(items.map((i: any) => [i.kind, i.tool.id])).toEqual([
      ['agent', 't1'],
      ['agent', 't2'],
    ]);
  });

  it('finds an agent log by its tool call, and cannot be talked out of the quotes', () => {
    const script = buildAgentLocateScript('/l/abc.jsonl', `t1'; reboot; '`);
    expect(script).toContain('/l/abc/subagents');
    expect(script).not.toContain('reboot; ');
  });

  it('lists each artifact once, newest first, with its title', () => {
    const url = 'https://claude.ai/artifact/AbC';
    const items = chat.buildChatItems([
      assistant('a', { action: 'read', url }, 'Artifact'),
      result('a', 'body', 'Tracker'),
      assistant('b', { action: 'read', url: 'https://claude.ai/code/artifact/Z9' }, 'Artifact'),
      assistant('c', { action: 'list' }, 'Artifact'),
    ]);
    expect(items.filter((i: any) => i.kind === 'artifact').length).toBe(2);
    expect(chat.chatArtifacts(items)).toEqual([
      { url: 'https://claude.ai/code/artifact/Z9', title: '' },
      { url, title: 'Tracker' },
    ]);
  });
});

describe('the / picker', () => {
  it('matches only while a command is being typed', () => {
    expect(chat.chatSlashMatches('hello', [])).toBeNull();
    expect(chat.chatSlashMatches('/clear now', [])).toBeNull();
    expect(chat.chatSlashMatches('/path/to/file', [])).toBeNull();
  });

  it('puts name starts first and includes the session’s skills', () => {
    const rows = chat.chatSlashMatches('/re', [{ name: 'code-review', description: '' }]);
    const names = rows.map((r: any) => r.name);
    expect(names.indexOf('resume')).toBeLessThan(names.indexOf('code-review'));
    expect(names).toContain('code-review');
  });

  it('reads the skills from the log line', () => {
    const line = JSON.stringify({
      attachment: { type: 'skill_listing', content: '- simplify: Review code\n- impeccable:impeccable: Design\nnoise' },
    });
    expect(parseSkillListing(line)).toEqual([
      { name: 'simplify', description: 'Review code' },
      { name: 'impeccable:impeccable', description: 'Design' },
    ]);
    expect(parseSkillListing('not json')).toEqual([]);
  });
});

describe('battery', () => {
  it('reads Linux and Windows forms', () => {
    expect(parseBatteryLine('83 Discharging')).toEqual({ percent: 83, charging: false });
    expect(parseBatteryLine('100 Full')).toEqual({ percent: 100, charging: true });
    expect(parseBatteryLine('40 1')).toEqual({ percent: 40, charging: false });
    expect(parseBatteryLine('40 2')).toEqual({ percent: 40, charging: true });
    expect(parseBatteryLine('none')).toBe('none');
    expect(parseBatteryLine(' ')).toBeNull();
  });

  it('is asked for only when due, and survives a real shell', () => {
    const plain = { tools: false, stats: true, secondSample: false, windows: false };
    expect(buildProbeScript(plain)).not.toContain('@@bat');
    const out = spawnSync('/bin/sh', ['-c', buildProbeScript({ ...plain, battery: true })], { encoding: 'utf8' });
    expect(out.status).toBe(0);
    expect(parseProbeOutput(out.stdout).ok).toBe(true);
  });
});

describe('keep awake', () => {
  const host = (id: string, machine: string) => ({ id, machine, label: id }) as RemoteHost;

  it('beats once per machine, only for machines with a busy session', () => {
    const hosts = [host('a', 'laptop'), host('b', 'laptop'), host('c', 'desktop')];
    expect(keepAwakeTargets(hosts, ['a', 'b']).map((h) => h.id)).toEqual(['a']);
    expect(keepAwakeTargets(hosts, [])).toEqual([]);
  });

  it('holds while the stamp is fresh, stops by itself, and never starts two', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'keep-awake-'));
    const log = join(dir, 'held');
    // A stand-in for PowerShell: says yes to the battery question, then logs each line it gets.
    const ps = join(dir, 'ps');
    writeFileSync(
      ps,
      `#!/bin/sh\ncase "$*" in *Win32_Battery*) echo yes; exit 0;; esac\nwhile read l; do echo "$$" >> "${log}"; done\n`,
      { mode: 0o755 }
    );
    const script = buildKeepAwakeScript({ dir: `"${dir}"`, powershell: ps, inhibit: 'no-such-tool' }).replace(
      /sleep 30/g,
      'sleep 0.1'
    );
    const beat = () => spawnSync('/bin/bash', ['-c', script], { encoding: 'utf8' });
    if (existsSync('/sys/class/power_supply/BAT0')) return;
    expect(beat().status).toBe(0);
    await vi.waitFor(() => expect(existsSync(log)).toBe(true), { timeout: 3000 });
    const pid = readFileSync(join(dir, 'keep-awake.pid'), 'utf8').trim();
    expect(beat().status).toBe(0);
    expect(readFileSync(join(dir, 'keep-awake.pid'), 'utf8').trim()).toBe(pid);
    // Stamp goes stale: the holder ends without being told.
    const old = new Date(Date.now() - 3600_000);
    utimesSync(join(dir, 'keep-awake.stamp'), old, old);
    await vi.waitFor(
      () => {
        expect(spawnSync('kill', ['-0', pid]).status).not.toBe(0);
      },
      { timeout: 3000 }
    );
  });
});
