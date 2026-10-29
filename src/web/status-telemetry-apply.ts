/**
 * @fileoverview What one statusline report does to a session, shared by the local exporter's
 * `POST /api/status-telemetry` (status-telemetry-routes.ts) and, in the fork, a remote (ssh)
 * session's per-session statusline file read over ssh (remote-session-signals.ts).
 *
 * - the model the CLI says it runs (`displayModel`) and its running version;
 * - this session's token, context and cost figures (`SessionState.statusUsage`), broadcast on
 *   change with the session state;
 * - optionally the prompt-cache report (`promptCache`) and the account-wide plan-usage chip.
 *   A remote session leaves both off: its cache state has one writer already (the conversation
 *   log, remote-transcript-telemetry.ts), and its account is not necessarily the one the chip
 *   shows (the fleet reads every account's usage on its own).
 *
 * All of it is gated on `capabilities.statusLineTelemetry`, as the route always was: only a CLI
 * that reports a statusline speaks for these fields.
 */

import type { Session } from '../session.js';
import {
  parsePromptCache,
  parseStatusTelemetry,
  parseStatusUsage,
  telemetrySignature,
  type RawStatuslinePayload,
} from '../usage-telemetry.js';
import { SessionPromptCache, SessionStatusTelemetry } from './sse-events.js';
import { setLatestPlanUsage } from './plan-usage-latest.js';
import type { SessionPort, EventPort, KeepWarmPort } from './ports/index.js';
import { getCli } from '../config/cli-registry/index.js';

export interface StatuslineApplyOptions {
  /** Apply the `prompt_cache` report (local exporter only). */
  promptCache: boolean;
  /** Broadcast plan-usage limits to the header chip (local exporter only). */
  planUsage: boolean;
}

export interface StatuslineApplier {
  apply(session: Session, payload: RawStatuslinePayload | undefined, opts: StatuslineApplyOptions): void;
  /** Drop what is remembered for a session (unknown or closed). */
  forget(sessionId: string): void;
}

export function createStatuslineApplier(ctx: SessionPort & EventPort & KeepWarmPort): StatuslineApplier {
  // Last broadcast plan-usage signature per session: the statusline fires on every assistant
  // message, so the chip is only rebroadcast when the value changes.
  const lastSig = new Map<string, string>();

  return {
    forget(sessionId) {
      lastSig.delete(sessionId);
    },
    apply(session, payload, opts) {
      const sessionId = session.id;
      const reportsStatusLine = !!getCli(session.mode)?.capabilities.statusLineTelemetry;
      if (reportsStatusLine) applySessionFields(session, payload, opts);
      // Plan-usage limits (account-wide) → broadcast to the header chip, when present and changed.
      const telemetry = opts.planUsage ? parseStatusTelemetry(payload) : null;
      if (telemetry) {
        const sig = telemetrySignature(telemetry);
        if (lastSig.get(sessionId) !== sig) {
          lastSig.set(sessionId, sig);
          // Bound the map across long multi-session runs: prune dead sessions.
          if (lastSig.size > 256) {
            for (const id of [...lastSig.keys()]) {
              if (!ctx.sessions.has(id)) lastSig.delete(id);
            }
          }
          const update = { sessionId, ...telemetry };
          const snapshot = setLatestPlanUsage(update); // replayed in the SSE init snapshot for fresh loads
          ctx.broadcast(SessionStatusTelemetry, snapshot);
        }
      }
    },
  };

  function applySessionFields(
    session: Session,
    payload: RawStatuslinePayload | undefined,
    opts: StatuslineApplyOptions
  ): void {
    const sessionId = session.id;
    // The model the CLI says it is running, for the session headers (displayModel). It rides
    // every render, so it follows an in-session `/model`; the session dedupes and broadcasts
    // only a change.
    session.noteReportedModel('statusline', payload?.model?.display_name);
    // The version of the CLI actually running in the pane. The launch-time `--version` probe
    // is cached for the server's lifetime, so after Claude Code updates itself this is the only
    // source that follows it; it feeds the "detection untested on this version" hint
    // (SessionState.cliVersionUntested).
    session.noteReportedCliVersion(payload?.version);

    // This session's tokens, context and cost (fork). Live state: broadcast with the session
    // state on change, no persist of its own and never restored (the next render refreshes it).
    const usage = parseStatusUsage(payload, Date.now());
    if (usage && session.noteStatusUsage(usage)) ctx.broadcastSessionStateDebounced(sessionId);

    // Prompt-cache state of the main conversation (Claude Code v2.1.251+): kept on the session
    // for the Session Options readout and `toState()`, broadcast only when the report changes.
    // The broadcast carries the STORED object, so a compaction stamp set in setPromptCache rides
    // along. Reports are applied in arrival order. When the exporter wraps a user's own
    // statusline it backgrounds its POST (hooks-config.ts), so two sub-second loopback reports
    // can arrive out of order; a stale one then briefly overwrites newer state until the next
    // render corrects it. Accepted for a display-only readout rather than ordered here.
    const promptCache = opts.promptCache ? parsePromptCache(payload) : null;
    if (promptCache) {
      if (session.setPromptCache(promptCache)) {
        ctx.broadcast(SessionPromptCache, { sessionId, ...session.promptCache });
        // Persisted on change, like a model change, so a crash restores the latest report.
        ctx.persistSessionState(session);
      }
      // Every report moves `expires_at`, so the keep-warm re-evaluates on each one.
      void ctx.keepWarm.schedule(sessionId);
    }
  }
}
