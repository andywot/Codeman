/**
 * @fileoverview Chat view routes (fork): a session's Claude conversation as chat items.
 *
 * - GET /api/sessions/:id/chat?after=<offset>   lines appended since `after` (-1 or absent = the tail)
 * - GET /api/sessions/:id/chat?before=<offset>  the chunk ending at `before` ("load earlier")
 *
 * Works for local and remote (ssh) Claude sessions; see src/chat-transcript.ts. Other CLIs
 * answer `found: false` and the page stays on the terminal.
 */

import { FastifyInstance } from 'fastify';
import { ApiErrorCode, createErrorResponse } from '../../types.js';
import { findSessionOrFail } from '../route-helpers.js';
import { readChat } from '../../chat-transcript.js';
import { getCli } from '../../config/cli-registry/registry.js';
import { remoteTmuxSessionName } from '../../tmux-manager.js';
import type { ConfigPort, SessionPort } from '../ports/index.js';

function offsetParam(value: unknown): number | undefined {
  if (value === undefined || value === '') return undefined;
  const n = Number(value);
  return Number.isInteger(n) && n >= -1 ? n : undefined;
}

export function registerChatRoutes(app: FastifyInstance, ctx: SessionPort & ConfigPort): void {
  app.get('/api/sessions/:id/chat', async (req) => {
    const { id } = req.params as { id: string };
    const query = req.query as Record<string, unknown>;
    const session = findSessionOrFail(ctx, id, req);
    if (getCli(session.mode)?.capabilities.transcript !== 'claude-jsonl') {
      return { success: true, data: { log: '', start: 0, end: 0, size: 0, entries: [], found: false } };
    }
    try {
      const data = await readChat(
        {
          sessionId: session.id,
          claudeSessionId: session.claudeSessionId ?? session.id,
          remote: session.remote,
          muxName: session.remote
            ? (session.remote.remoteSessionName ?? remoteTmuxSessionName(session.id))
            : session.muxName,
          hookPath: session.remote ? null : ctx.getTranscriptPath(session.id),
        },
        { after: offsetParam(query.after), before: offsetParam(query.before) }
      );
      return { success: true, data };
    } catch (err) {
      return createErrorResponse(
        ApiErrorCode.OPERATION_FAILED,
        `Could not read the conversation: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  });
}
