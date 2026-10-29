/**
 * Remote (ssh) sessions get auto-resume on usage limit and the prompt-cache keep-warm (fork,
 * src/remote-transcript-telemetry.ts). Pinned here, all on FAKE remote output (nothing reaches a
 * real host: the pooled shell is mocked, and the service runs on fake ports):
 *
 * - the conversation-log readers: the prompt-cache state derived from a log tail, and the usage-limit
 *   API error a conversation ends on;
 * - `readTranscriptTail` over the pooled shell (chat-transcript.ts), fed a fake `remoteExec` answer;
 * - a remote Session: `statusLineExporter` reads `transcript`, its pane stream still arms auto-resume,
 *   and `noteUsageLimitText()` arms only on a reset still ahead;
 * - the service: what it reads when, what it applies, and that nothing runs while neither feature is on;
 * - the keep-warm service re-reading a remote session's log before a nudge.
 *
 * Port: N/A (no server, no tmux, no ssh).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const remoteExec = vi.hoisted(() => vi.fn());
vi.mock('../src/remote-shell-pool.js', () => ({ remoteExec }));

import {
  derivePromptCacheFromTranscript,
  findTranscriptUsageLimit,
  RemoteTranscriptTelemetry,
  TRANSCRIPT_TAIL_BYTES,
  TRANSCRIPT_TAIL_MAX_BYTES,
  type RemoteTelemetryPorts,
} from '../src/remote-transcript-telemetry.js';
import { readTranscriptTail } from '../src/chat-transcript.js';
import { Session } from '../src/session.js';
import {
  PromptCacheKeepWarmService,
  KEEP_WARM_LEAD_MS,
  KEEP_WARM_NUDGE,
  type KeepWarmPorts,
  type KeepWarmSessionView,
} from '../src/prompt-cache-keepwarm.js';
import type { KeepWarmStatus, PromptCacheStatus, SessionRemote } from '../src/types.js';

const NOW = Date.UTC(2026, 9, 30, 2, 0, 0);
const MIN = 60_000;
const HOUR = 60 * MIN;
const iso = (ms: number) => new Date(ms).toISOString();

const REMOTE: SessionRemote = {
  hostId: 'pc-wsl',
  label: 'PC (WSL)',
  host: '192.0.2.10',
  username: 'andy',
  remotePath: '/home/andy/project',
};

/** One API response as Claude Code logs it: one line per content block, sharing the message id and usage. */
function response(
  at: number,
  opts: {
    id?: string;
    blocks?: number;
    input?: number;
    read?: number;
    create1h?: number;
    create5m?: number;
    output?: number;
    sidechain?: boolean;
  } = {}
): string[] {
  const { id = `msg_${at}`, blocks = 1, input = 2, read = 90_000, create1h = 1_500, create5m = 0, output = 300 } = opts;
  const usage = {
    input_tokens: input,
    cache_creation_input_tokens: create1h + create5m,
    cache_read_input_tokens: read,
    output_tokens: output,
    cache_creation: { ephemeral_1h_input_tokens: create1h, ephemeral_5m_input_tokens: create5m },
  };
  return Array.from({ length: blocks }, (_, i) =>
    JSON.stringify({
      type: 'assistant',
      timestamp: iso(at + i * 1_000),
      isSidechain: opts.sidechain === true,
      message: { id, model: 'claude-opus-5-5', usage, content: [{ type: 'text', text: `block ${i}` }] },
    })
  );
}

const userPrompt = (at: number, text = 'next') =>
  JSON.stringify({ type: 'user', timestamp: iso(at), isSidechain: false, message: { content: text } });
const systemLine = (at: number, subtype: string) =>
  JSON.stringify({ type: 'system', subtype, timestamp: iso(at), isSidechain: false, content: subtype });
/** The line Claude Code logs when it stops on a usage limit (copied from a real log, times moved). */
const limitError = (at: number, text: string) =>
  JSON.stringify({
    type: 'assistant',
    timestamp: iso(at),
    isSidechain: false,
    isApiErrorMessage: true,
    error: 'rate_limit',
    apiErrorStatus: 429,
    message: {
      id: `err_${at}`,
      model: '<synthetic>',
      usage: { input_tokens: 0, output_tokens: 0 },
      content: [{ type: 'text', text }],
    },
  });

/** "resets 3:00am (UTC)", NOW + 1h, in the footer's own words. */
const LIMIT_TEXT = "You've hit your session limit · resets 3am (UTC)";

describe('derivePromptCacheFromTranscript', () => {
  it('expires one cache lifetime after the last request, the first line of its response', () => {
    const last = NOW - 10 * MIN;
    const lines = [
      userPrompt(NOW - 30 * MIN),
      ...response(NOW - 29 * MIN, { read: 50_000 }),
      ...response(last, { blocks: 3, read: 100_000, create1h: 2_000, output: 400 }),
      systemLine(last + 5_000, 'turn_duration'),
    ];
    expect(derivePromptCacheFromTranscript(lines, NOW)).toEqual({
      warm: true,
      ttl: '1h',
      expiresAt: last + HOUR,
      recacheTokensIfCold: 2 + 100_000 + 2_000 + 400,
    });
  });

  it('reads cold once the lifetime has passed', () => {
    const lines = response(NOW - 61 * MIN);
    expect(derivePromptCacheFromTranscript(lines, NOW)).toMatchObject({ warm: false, expiresAt: NOW - MIN });
  });

  it('takes the lifetime from the newest response that wrote to the cache, and reads a 5-minute one', () => {
    const pureRead = response(NOW - MIN, { create1h: 0, create5m: 0 });
    expect(derivePromptCacheFromTranscript([...response(NOW - 2 * MIN), ...pureRead], NOW)).toMatchObject({
      ttl: '1h',
      expiresAt: NOW - MIN + HOUR,
    });
    expect(derivePromptCacheFromTranscript(response(NOW - MIN, { create1h: 0, create5m: 800 }), NOW)).toMatchObject({
      ttl: '5m',
      expiresAt: NOW - MIN + 5 * MIN,
    });
    // Nothing says which lifetime: no report rather than a guess.
    expect(derivePromptCacheFromTranscript(pureRead, NOW)).toBeNull();
  });

  it("ignores subagents' responses and the synthetic error lines", () => {
    const main = NOW - 20 * MIN;
    const lines = [
      ...response(main),
      ...response(NOW - 2 * MIN, { sidechain: true }),
      limitError(NOW - MIN, LIMIT_TEXT),
    ];
    expect(derivePromptCacheFromTranscript(lines, NOW)).toMatchObject({ expiresAt: main + HOUR });
  });

  it('leaves out the tokens at stake after a compaction, so the session stamps it and the keep-warm stops', () => {
    const lines = [...response(NOW - 5 * MIN), systemLine(NOW - 4 * MIN, 'compact_boundary')];
    const cache = derivePromptCacheFromTranscript(lines, NOW);
    expect(cache).toMatchObject({ warm: true, ttl: '1h' });
    expect(cache?.recacheTokensIfCold).toBeUndefined();
  });

  it('returns null for a log with no response yet, and survives lines that do not parse', () => {
    expect(derivePromptCacheFromTranscript([userPrompt(NOW), '{not json', ''], NOW)).toBeNull();
  });
});

describe('findTranscriptUsageLimit', () => {
  it('returns the text of the usage-limit error the conversation ends on, past bookkeeping lines', () => {
    const lines = [
      ...response(NOW - 5 * MIN),
      limitError(NOW - MIN, LIMIT_TEXT),
      systemLine(NOW - MIN + 10, 'turn_duration'),
      systemLine(NOW - MIN + 20, 'stop_hook_summary'),
    ];
    expect(findTranscriptUsageLimit(lines)).toBe(LIMIT_TEXT);
  });

  it('returns null once the conversation moved on, so an old limit is never read as a pause', () => {
    expect(findTranscriptUsageLimit([limitError(NOW - HOUR, LIMIT_TEXT), userPrompt(NOW - 30 * MIN)])).toBeNull();
    expect(findTranscriptUsageLimit([limitError(NOW - HOUR, LIMIT_TEXT), ...response(NOW - 30 * MIN)])).toBeNull();
    expect(findTranscriptUsageLimit(response(NOW))).toBeNull();
  });
});

describe('readTranscriptTail over the pooled shell (fake remote output)', () => {
  beforeEach(() => remoteExec.mockReset());

  it('locates the log, reads its tail in one round trip, and keeps only whole lines', async () => {
    const path = '/home/andy/.claude/projects/-home-andy-project/conv-1.jsonl';
    const whole = ['{"a":1}', '{"b":2}', '{"c":3}'];
    // The tail starts inside the first line and ends inside a line still being written.
    const tail = `partial-first"}\n${whole.join('\n')}\n{"d":`;
    remoteExec
      .mockResolvedValueOnce({ code: 0, stdout: Buffer.from(`${path}\n`), stderr: '' })
      .mockResolvedValueOnce({ code: 0, stdout: Buffer.from(`900000\n${tail}`), stderr: '' });

    const out = await readTranscriptTail(
      { sessionId: 'tail-1', claudeSessionId: 'conv-1', remote: REMOTE, muxName: 'codeman-ssh-tail1' },
      64
    );

    expect(out).toEqual({ log: 'conv-1', lines: whole, size: 900_000 });
    expect(remoteExec).toHaveBeenCalledTimes(2);
    const [host, script] = remoteExec.mock.calls[1];
    expect(host).toBe(REMOTE);
    expect(script).toContain(`tail -c 64 '${path}'`);
  });

  it('keeps the first line of a log shorter than the read, and answers null before the log exists', async () => {
    const path = '/home/andy/.claude/projects/p/conv-2.jsonl';
    remoteExec
      .mockResolvedValueOnce({ code: 0, stdout: Buffer.from(`${path}\n`), stderr: '' })
      .mockResolvedValueOnce({ code: 0, stdout: Buffer.from('16\n{"a":1}\n{"b":2}\n'), stderr: '' });
    expect(
      await readTranscriptTail({ sessionId: 'tail-2', claudeSessionId: 'conv-2', remote: REMOTE, muxName: 'm' }, 4096)
    ).toEqual({ log: 'conv-2', lines: ['{"a":1}', '{"b":2}'], size: 16 });

    remoteExec.mockResolvedValueOnce({ code: 0, stdout: Buffer.from(''), stderr: '' });
    expect(
      await readTranscriptTail({ sessionId: 'tail-3', claudeSessionId: 'conv-3', remote: REMOTE, muxName: 'm' }, 4096)
    ).toBeNull();
  });
});

describe('a remote Session', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => vi.useRealTimers());

  it('reads its cache state from the transcript; a local or Docker session does not', () => {
    const remote = new Session({ workingDir: '/home/andy/project', remote: REMOTE });
    expect(remote.statusLineExporter).toBe('transcript');
    expect(new Session({ workingDir: '/tmp' }).statusLineExporter).toBeUndefined();
    expect(new Session({ workingDir: '/tmp', mode: 'shell', remote: REMOTE }).statusLineExporter).toBeUndefined();
  });

  it("still arms auto-resume from its pane's output stream (the local pane runs the ssh client)", () => {
    const session = new Session({ workingDir: '/home/andy/project', remote: REMOTE });
    session.setAutoResume(true);
    // What the ssh pane prints once Claude stops on the limit on the remote machine.
    (session as unknown as { _processExpensiveParsers(d: string): void })._processExpensiveParsers(
      `\x1b[2K\x1b[31m${LIMIT_TEXT}\x1b[0m\r\n`
    );
    expect(session.isLimitPaused).toBe(true);
    expect(session.autoResumeAt).toBe(NOW + HOUR + 2 * MIN);
    session.setAutoResume(false);
  });

  it('noteUsageLimitText arms only with auto-resume on and a reset still ahead', () => {
    const session = new Session({ workingDir: '/home/andy/project', remote: REMOTE });
    expect(session.noteUsageLimitText(LIMIT_TEXT)).toBe(false); // switched off
    session.setAutoResume(true);
    expect(session.noteUsageLimitText('Claude AI usage limit reached|' + Math.floor((NOW - MIN) / 1000))).toBe(false);
    expect(session.isLimitPaused).toBe(false);
    expect(session.noteUsageLimitText(LIMIT_TEXT)).toBe(true);
    expect(session.autoResumeAt).toBe(NOW + HOUR + 2 * MIN);
    session.setAutoResume(false);
  });
});

/** The service on fake ports and a real remote Session. */
function harness(over: Partial<RemoteTelemetryPorts> = {}, keepWarm = false) {
  const session = new Session({ workingDir: '/home/andy/project', remote: REMOTE });
  const applied: Array<{ cache: PromptCacheStatus; schedule: boolean }> = [];
  const reads: number[] = [];
  let lines: string[] = [];
  let size = 0;
  let screen: string | null = null;
  const ports: RemoteTelemetryPorts = {
    getSession: (id) => (id === session.id ? session : undefined),
    keepWarmWanted: () => keepWarm,
    readTail: async (_s, maxBytes) => {
      reads.push(maxBytes);
      return { lines, size: size || lines.join('\n').length };
    },
    captureScreen: () => screen,
    applyPromptCache: (s, cache, schedule) => {
      (s as Session).setPromptCache(cache);
      applied.push({ cache, schedule });
    },
    ...over,
  };
  const service = new RemoteTranscriptTelemetry(ports);
  return {
    session,
    service,
    applied,
    reads,
    setLog: (l: string[], s = 0) => {
      lines = l;
      size = s;
    },
    setScreen: (s: string | null) => {
      screen = s;
    },
  };
}

describe('RemoteTranscriptTelemetry', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => vi.useRealTimers());

  it('reads nothing while neither keep-warm nor auto-resume is on', async () => {
    const h = harness();
    h.setLog(response(NOW - MIN));
    await h.service.refresh(h.session.id);
    expect(h.reads).toEqual([]);
    expect(h.applied).toEqual([]);
  });

  it('keep-warm on: applies the derived report and asks for a re-evaluation', async () => {
    const h = harness({}, true);
    h.setLog(response(NOW - 10 * MIN));
    await h.service.refresh(h.session.id);
    expect(h.reads).toEqual([TRANSCRIPT_TAIL_BYTES]);
    expect(h.applied).toEqual([
      { cache: expect.objectContaining({ warm: true, expiresAt: NOW - 10 * MIN + HOUR }), schedule: true },
    ]);
    expect(h.session.promptCache).toMatchObject({ ttl: '1h' });
    // The keep-warm's own pre-nudge read must not re-schedule.
    await h.service.refresh(h.session.id, { schedule: false });
    expect(h.applied[1].schedule).toBe(false);
  });

  it('widens the read once when the tail held no response (a big tool output at the end)', async () => {
    const h = harness({}, true);
    h.setLog([userPrompt(NOW)], 5 * TRANSCRIPT_TAIL_BYTES);
    await h.service.refresh(h.session.id);
    expect(h.reads).toEqual([TRANSCRIPT_TAIL_BYTES, TRANSCRIPT_TAIL_MAX_BYTES]);
  });

  it('auto-resume on: arms from the usage-limit error the remote conversation ends on', async () => {
    const h = harness();
    h.session.setAutoResume(true);
    h.setLog([...response(NOW - 20 * MIN), limitError(NOW - MIN, LIMIT_TEXT)]);
    await h.service.refresh(h.session.id);
    expect(h.session.isLimitPaused).toBe(true);
    expect(h.session.autoResumeAt).toBe(NOW + HOUR + 2 * MIN);
    // The readout still gets the cache state, but the keep-warm is off, so no re-evaluation.
    expect(h.applied.map((a) => a.schedule)).toEqual([false]);
    h.session.setAutoResume(false);
  });

  it("auto-resume on: arms from the pane's visible frame when the log says nothing", async () => {
    const h = harness();
    h.session.setAutoResume(true);
    h.setLog(response(NOW - 20 * MIN));
    h.setScreen(`  ⎿  ${LIMIT_TEXT}\n\n❯ \n`);
    await h.service.refresh(h.session.id);
    expect(h.session.autoResumeAt).toBe(NOW + HOUR + 2 * MIN);
    h.session.setAutoResume(false);
  });

  it('never arms on a limit the conversation already moved past', async () => {
    const h = harness();
    h.session.setAutoResume(true);
    h.setLog([limitError(NOW - 3 * HOUR, LIMIT_TEXT), userPrompt(NOW - 2 * HOUR), ...response(NOW - 2 * HOUR)]);
    await h.service.refresh(h.session.id);
    expect(h.session.isLimitPaused).toBe(false);
    h.session.setAutoResume(false);
  });

  it('waits after a turn ends, runs one read at a time, and folds triggers that land meanwhile into one more', async () => {
    let release: () => void = () => {};
    let started = 0;
    const h = harness(
      {
        readTail: async () => {
          started++;
          await new Promise<void>((r) => (release = r));
          return { lines: response(NOW - MIN), size: 1 };
        },
      },
      true
    );
    void h.service.refresh(h.session.id, { delayMs: 3_000 });
    await vi.advanceTimersByTimeAsync(2_999);
    expect(started).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(started).toBe(1);
    void h.service.refresh(h.session.id);
    void h.service.refresh(h.session.id);
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(started).toBe(2);
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(started).toBe(2);
  });

  it('skips a local session, and logs a failing host once', async () => {
    const logs: string[] = [];
    const h = harness(
      {
        readTail: async () => {
          throw new Error('ssh: connect to host 192.0.2.10 port 22: No route to host');
        },
        log: (m) => logs.push(m),
      },
      true
    );
    await h.service.refresh(h.session.id);
    await h.service.refresh(h.session.id);
    expect(logs).toHaveLength(1);

    const local = new Session({ workingDir: '/tmp' });
    const reads: string[] = [];
    const service = new RemoteTranscriptTelemetry({
      getSession: () => local,
      keepWarmWanted: () => true,
      readTail: async () => {
        reads.push('read');
        return null;
      },
      captureScreen: () => null,
      applyPromptCache: () => {},
    });
    await service.refresh(local.id);
    expect(reads).toEqual([]);
  });
});

/** A remote session as the keep-warm service sees it. */
class FakeRemote implements KeepWarmSessionView {
  id = 'remote-1';
  createdAt = NOW - 2 * HOUR;
  pid: number | null = 4242;
  paneExit: unknown = undefined;
  parentSessionId: string | undefined = undefined;
  promptCache: PromptCacheStatus | null = null;
  statusLineExporter = 'transcript' as const;
  idleCompactionOptOut = false;
  keepWarmEnabled: boolean | undefined = true;
  isWorking = false;
  isLimitPaused = false;
  lastHumanInputAt = NOW - 2 * HOUR;
  lastRealPromptAt = NOW - HOUR;
  keepAliveTurnActive = false;
  writes: string[] = [];
  isIdle(): boolean {
    return true;
  }
  beginKeepAliveTurn(): void {
    this.keepAliveTurnActive = true;
  }
  endKeepAliveTurn(): void {
    this.keepAliveTurnActive = false;
  }
  async writeViaMux(data: string): Promise<boolean> {
    this.writes.push(data);
    return true;
  }
}

describe('the keep-warm on a remote session', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => vi.useRealTimers());

  function keepWarm(session: FakeRemote, refreshCache: KeepWarmPorts['refreshCache']) {
    const published: KeepWarmStatus[] = [];
    const service = new PromptCacheKeepWarmService({
      getSession: (id) => (id === session.id ? session : undefined),
      sessionIds: () => [session.id],
      readSettings: async () => ({ keepWarmDefault: false, maxHours: 2 }),
      isAutomationActive: () => false,
      hasPendingApproval: () => false,
      readPane: () => ({ composerEmpty: true, limitShown: false }),
      publish: (_id, status) => published.push(status),
      refreshCache,
    });
    return { service, last: () => published[published.length - 1] };
  }
  const settle = async () => {
    for (let i = 0; i < 8; i++) await Promise.resolve();
  };

  it('re-reads the log before a nudge, and nudges through the session input path when it still holds', async () => {
    const session = new FakeRemote();
    session.promptCache = derivePromptCacheFromTranscript(response(NOW - HOUR + KEEP_WARM_LEAD_MS - MIN), NOW);
    const refreshCache = vi.fn(async () => {});
    const { service, last } = keepWarm(session, refreshCache);
    await service.schedule(session.id);
    await settle();
    expect(refreshCache).toHaveBeenCalledTimes(1);
    expect(session.writes).toEqual([`${KEEP_WARM_NUDGE}\r`]);
    expect(last()).toMatchObject({ state: 'nudged', nudges: 1 });

    // A trigger right after the nudge, before its turn reported back: no second nudge.
    await service.schedule(session.id);
    await settle();
    expect(session.writes).toHaveLength(1);
    expect(last()).toMatchObject({ state: 'waiting', reason: expect.stringContaining('keep-alive turn') });
    service.stop();
  });

  it('sends nothing when the fresh read shows a turn the screen never reported', async () => {
    const session = new FakeRemote();
    session.promptCache = derivePromptCacheFromTranscript(response(NOW - HOUR + KEEP_WARM_LEAD_MS - MIN), NOW);
    const { service, last } = keepWarm(session, async () => {
      session.promptCache = derivePromptCacheFromTranscript(response(NOW - 2 * MIN), Date.now());
    });
    await service.schedule(session.id);
    await settle();
    expect(session.writes).toEqual([]);
    expect(last()).toMatchObject({ state: 'armed', nextCheckAt: NOW - 2 * MIN + HOUR - KEEP_WARM_LEAD_MS });
    service.stop();
  });
});
