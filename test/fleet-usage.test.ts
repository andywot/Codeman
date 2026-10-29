// Port: none (pure function).
//
// An account's 5-hour and 7-day usage comes from its own sessions (src/fleet.ts): a
// WSL/Linux session launched with the account gets a statusLine command that saves
// Claude's statusline JSON per account, and the server reads it back. Pinned: the
// command really writes the file when run by a shell (as Claude runs it), it survives
// the launch's single quoting, Windows and api/shell accounts get none, and the saved
// JSON parses into percentages with ISO reset times.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildLaunch,
  parseStatuslineUsage,
  parseStatusReadOutput,
  STATUS_READ_SCRIPT,
  type FleetAccount,
} from '../src/fleet.js';

const account: FleetAccount = { id: 'personal', label: 'Personal', kind: 'token', secret: 'x' };
const payload = JSON.stringify({
  model: { display_name: 'Opus' },
  rate_limits: { five_hour: { used_percentage: 11, resets_at: 1793301000 }, seven_day: { used_percentage: 6 } },
});

describe('usage from session statuslines', () => {
  it('launches WSL/Linux sessions with a statusLine that saves the JSON per account', () => {
    const { args } = buildLaunch({ system: 'linux' }, account, undefined);
    const json = args.match(/--settings '([^']*)'/)?.[1];
    expect(json).toBeTruthy();
    const command = JSON.parse(json as string).statusLine.command as string;
    const home = mkdtempSync(join(tmpdir(), 'rc-status-'));
    const printed = execFileSync('sh', ['-c', command], { input: payload, env: { ...process.env, HOME: home } });
    expect(printed.toString()).toBe('');
    const saved = readFileSync(join(home, '.config/claude-rc/status/personal.json'), 'utf8');
    // The server's read script, run on that machine, returns it per account.
    const read = execFileSync('sh', ['-c', STATUS_READ_SCRIPT], { env: { ...process.env, HOME: home } }).toString();
    expect(parseStatusReadOutput(read).get('personal')).toMatchObject({ fiveHour: 11, sevenDay: 6 });
    expect(parseStatuslineUsage(saved, 'now')).toEqual({
      fiveHour: 11,
      fiveHourResetsAt: new Date(1793301000 * 1000).toISOString(),
      sevenDay: 6,
      sevenDayResetsAt: null,
      fetchedAt: 'now',
    });
  });

  it('adds nothing for Windows sessions or for api/shell accounts', () => {
    expect(buildLaunch({ system: 'windows' }, account, undefined).args).not.toContain('--settings');
    expect(
      buildLaunch({ system: 'linux' }, { ...account, kind: 'shell', setupCommand: 'use-glm' }, undefined).args
    ).toBe('');
  });

  it('reads no usage from a statusline without rate limits or from broken JSON', () => {
    expect(parseStatuslineUsage(JSON.stringify({ model: {} }), 'now')).toBeNull();
    expect(parseStatuslineUsage('{"rate_limits":', 'now')).toBeNull();
  });
});
