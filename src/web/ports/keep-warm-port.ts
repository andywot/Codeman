/**
 * @fileoverview Port for the prompt-cache keep-warm scheduler (`prompt-cache-keepwarm.ts`).
 * Routes only ever trigger a re-evaluation; the rulebook and the timers stay in the service.
 */

import type { KeepWarmScheduler } from '../../prompt-cache-keepwarm.js';
import type { RefreshOptions } from '../../remote-transcript-telemetry.js';

export interface KeepWarmPort {
  readonly keepWarm: KeepWarmScheduler;
  /**
   * Fork: re-read a remote session's conversation log for its cache state and a usage-limit pause
   * (remote-transcript-telemetry.ts), e.g. when one of the two switches is turned on. Optional so
   * route tests can leave it out.
   */
  readonly remoteTelemetry?: { refresh(sessionId: string, opts?: RefreshOptions): Promise<void> };
}
