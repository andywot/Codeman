/**
 * @fileoverview Status-telemetry route.
 *
 * Receives Claude Code statusline payloads POSTed by the Codeman-managed
 * statusLine exporter (see `hooks-config.generateStatusLineCommand`) and
 * broadcasts the parsed plan-usage limits (5-hour + weekly) to SSE clients for
 * the header "Plan Usage Limits" chip. Auth-exempt like `/api/hook-event`
 * (localhost-only; hook-secret-gated while a tunnel runs — see middleware/auth).
 *
 * Also records the session's model (`model.display_name`) as its reported model, which
 * `session:updated` publishes as `displayModel` for the session headers, and (fork) the
 * session's own token/context/cost figures as `statusUsage`. What a report does to a
 * session lives in `status-telemetry-apply.ts`, shared with remote (ssh) sessions, whose
 * statusline arrives from a file on their machine instead (remote-session-signals.ts).
 *
 * Returns a compact plain-text status string for the exporter to print as the
 * in-terminal footer (print-through) when it has no statusline of the user's
 * own to wrap. An unknown session gets an EMPTY body: the old brand-word
 * answer rendered as the statusline itself (discussion #405).
 */

import { FastifyInstance } from 'fastify';
import { StatusTelemetrySchema } from '../schemas.js';
import { parseBody } from '../route-helpers.js';
import { parseSessionStatus, formatSessionStatusText, type RawStatuslinePayload } from '../../usage-telemetry.js';
import type { SessionPort, EventPort, KeepWarmPort } from '../ports/index.js';
import { createStatuslineApplier, type StatuslineApplier } from '../status-telemetry-apply.js';

export function registerStatusTelemetryRoutes(
  app: FastifyInstance,
  ctx: SessionPort & EventPort & KeepWarmPort,
  applier: StatuslineApplier = createStatuslineApplier(ctx)
): void {
  app.post('/api/status-telemetry', async (req, reply) => {
    const { sessionId, data } = parseBody(StatusTelemetrySchema, req.body);

    reply.type('text/plain; charset=utf-8');

    // Unknown session: nothing to broadcast and nothing to print. Never a brand
    // word here, it would render as the statusline.
    const session = ctx.sessions.get(sessionId);
    if (!session) {
      applier.forget(sessionId);
      return '';
    }

    const payload = data as RawStatuslinePayload | undefined;
    applier.apply(session, payload, { promptCache: true, planUsage: true });

    // In-terminal statusline footer → CURRENT SESSION status (model / tokens /
    // context %), NOT the plan limits. Available from the first render, even
    // before rate_limits appears.
    return formatSessionStatusText(parseSessionStatus(payload));
  });
}
