// Port: none (pure functions + a local http server).
//
// A GLM-style account's usage comes from a quota-throttle gateway's /api/status (src/fleet.ts):
// the usage pass curls the account's quotaUrl ON each machine (the gateway binds loopback) and
// the key pool becomes one account's 5h/7d windows. Pinned: the pooled math (shared org/project
// pools counted once, errored keys skipped, soonest future reset), the script really fetches and
// tags the body even on a machine with no status folder, and validation keeps the URL quote-free.
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildStatusReadScript,
  parseStatusRead,
  parseThrottleQuota,
  validateAccount,
  type FleetAccount,
} from '../src/fleet.js';

const later = Date.now() + 3_600_000;
const status = {
  keys: [
    {
      name: 'a',
      org: 'o1',
      project: 'p1',
      five_hour_pct: 10,
      weekly_pct: 40,
      five_hour_reset: later,
      weekly_reset: later * 2,
      error: null,
    },
    {
      name: 'b',
      org: 'o1',
      project: 'p1',
      five_hour_pct: 10,
      weekly_pct: 40,
      five_hour_reset: later,
      weekly_reset: later * 2,
      error: null,
    },
    {
      name: 'c',
      org: 'o2',
      project: 'p2',
      five_hour_pct: 30,
      weekly_pct: 20,
      five_hour_reset: later + 1,
      weekly_reset: 1,
      error: null,
    },
    { name: 'd', org: 'o3', project: 'p3', five_hour_pct: 99, weekly_pct: 99, error: 'quota read failed' },
  ],
};
const glm: FleetAccount = { id: 'glm', label: 'GLM', kind: 'shell', setupCommand: 'use-glm' };

describe('quota-throttle usage', () => {
  it('pools the keys: one reading per org/project, errors skipped, soonest future reset', () => {
    const usage = parseThrottleQuota(JSON.stringify(status), 'now');
    expect(usage).toMatchObject({ fiveHour: 20, sevenDay: 30, fetchedAt: 'now' });
    expect(usage?.fiveHourResetsAt).toBe(new Date(later).toISOString());
    expect(usage?.sevenDayResetsAt).toBe(new Date(later * 2).toISOString());
    expect(parseThrottleQuota('<html>', 'now')).toBeNull();
    expect(parseThrottleQuota(JSON.stringify({ keys: [] }), 'now')).toBeNull();
  });

  it('the read script fetches the URL on the machine, even with no status folder', async () => {
    const server = createServer((_req, res) => res.end(JSON.stringify(status)));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as { port: number }).port;
    try {
      const script = buildStatusReadScript([{ ...glm, quotaUrl: `http://127.0.0.1:${port}/api/status` }]);
      const home = mkdtempSync(join(tmpdir(), 'rc-quota-'));
      const out = await new Promise<string>((resolve, reject) => {
        import('node:child_process').then(({ execFile }) =>
          execFile('sh', ['-c', script], { env: { ...process.env, HOME: home } }, (err, stdout) =>
            err ? reject(err) : resolve(stdout)
          )
        );
      });
      expect(parseStatusRead(out).byAccount.get('glm')).toMatchObject({ fiveHour: 20, sevenDay: 30 });
    } finally {
      server.close();
    }
  });

  it('a machine without the gateway yields no reading', () => {
    const script = buildStatusReadScript([{ ...glm, quotaUrl: 'http://127.0.0.1:1/api/status' }]);
    const out = execFileSync('sh', ['-c', script], {
      env: { ...process.env, HOME: mkdtempSync(join(tmpdir(), 'rc-q-')) },
    });
    expect(parseStatusRead(out.toString()).byAccount.has('glm')).toBe(false);
  });

  it('accepts only a plain http(s) URL, on GLM-style accounts', () => {
    expect(validateAccount({ ...glm, quotaUrl: 'http://127.0.0.1:3001/api/status' })).toBeNull();
    expect(validateAccount({ ...glm, quotaUrl: "http://x/';rm -rf ~;'" })).not.toBeNull();
    expect(validateAccount({ ...glm, kind: 'token', quotaUrl: 'http://127.0.0.1:3001/api/status' })).not.toBeNull();
  });
});
