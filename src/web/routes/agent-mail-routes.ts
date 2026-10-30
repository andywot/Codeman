/**
 * @fileoverview Agent mail routes (fork): what the dashboard shows of the `rc-mail` relay
 * (web/agent-mail-relay.ts). The messages themselves move between machines through files and the
 * relay; nothing here sends one.
 *
 * - GET /api/agent-mail                      machines (reachable, CLI installed), the address
 *                                            directory with per-mailbox counts and each dashboard
 *                                            session's wake-up switch, queued count, recent traffic
 *                                            (sender, recipient, subject, state; never bodies)
 * - PUT /api/agent-mail/nudge/:sessionId     { enabled } the per-session wake-up switch
 *
 * Machine-level like the fleet routes, so admin-only in multi-user mode. Subjects are untrusted
 * agent text: the browser renders them with textContent.
 *
 * @module web/routes/agent-mail-routes
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ApiErrorCode, createErrorResponse } from '../../types.js';
import { isMultiUserMode } from '../../config/multiuser.js';
import { isAdmin } from '../route-helpers.js';
import type { AgentMailRelay } from '../agent-mail-relay.js';

const NudgeSchema = z.object({ enabled: z.boolean() }).strict();
const SESSION_ID_RE = /^[A-Za-z0-9-]{8,64}$/;

function denied(req: FastifyRequest, reply: FastifyReply) {
  if (isMultiUserMode() && !isAdmin(req)) {
    reply.code(403);
    return createErrorResponse(ApiErrorCode.FORBIDDEN, 'Admin only in multi-user mode');
  }
  return null;
}

export function registerAgentMailRoutes(app: FastifyInstance, relay: AgentMailRelay): void {
  app.get('/api/agent-mail', async (req, reply) => {
    const no = denied(req, reply);
    if (no) return no;
    return { success: true, data: relay.status() };
  });

  app.put('/api/agent-mail/nudge/:sessionId', async (req, reply) => {
    const no = denied(req, reply);
    if (no) return no;
    const { sessionId } = req.params as { sessionId: string };
    if (!SESSION_ID_RE.test(sessionId)) {
      reply.code(400);
      return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Invalid session id');
    }
    const parsed = NudgeSchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Expected { enabled: boolean }');
    }
    relay.setNudge(sessionId, parsed.data.enabled);
    return { success: true, data: { sessionId, enabled: parsed.data.enabled } };
  });
}
