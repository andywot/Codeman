/**
 * @fileoverview Recent picks routes (fork): the New session dialog's recent machine + folder
 * choices, shared across devices.
 *
 * - GET  /api/recent-picks         the picks, newest first (at most 8)
 * - POST /api/recent-picks         { pick } remember one (moves it to the top)
 * - POST /api/recent-picks/import  { picks } merge a browser's old local picks, once
 *
 * Stored in ~/.codeman/recent-picks.json (src/recent-picks.ts). Admin-only in multi-user
 * mode, like the projects and fleet routes the picks point into.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ApiResponse } from '../../types.js';
import { ApiErrorCode, createErrorResponse } from '../../types.js';
import { getDataDir } from '../../config/instance.js';
import { isMultiUserMode } from '../../config/multiuser.js';
import { isAdmin } from '../route-helpers.js';
import {
  RecentPickImportSchema,
  mergeRecentPicks,
  parseRecentPick,
  readRecentPicks,
  writeRecentPicks,
} from '../../recent-picks.js';

function denied(req: FastifyRequest, reply: FastifyReply): ApiResponse<never> | null {
  if (isMultiUserMode() && !isAdmin(req)) {
    reply.code(403);
    return createErrorResponse(ApiErrorCode.FORBIDDEN, 'Admin only in multi-user mode');
  }
  return null;
}

export function registerRecentPicksRoutes(app: FastifyInstance): void {
  const dir = () => getDataDir();
  // Read-modify-write of one file: serialize so two quick requests cannot lose an edit.
  let chain: Promise<unknown> = Promise.resolve();
  const exclusive = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = chain.then(fn, fn);
    chain = run.catch(() => undefined);
    return run;
  };

  app.get('/api/recent-picks', async (req, reply) => {
    const no = denied(req, reply);
    if (no) return no;
    return { success: true, data: { picks: await readRecentPicks(dir()) } };
  });

  app.post('/api/recent-picks', async (req, reply) => {
    const no = denied(req, reply);
    if (no) return no;
    const pick = parseRecentPick((req.body as { pick?: unknown } | null)?.pick, Date.now());
    if (!pick) {
      reply.code(400);
      return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Send { pick: { target, path (absolute), mode } }');
    }
    // A pick being made now is the newest, whatever clock the browser has.
    const now = Date.now();
    return exclusive(async () => {
      const picks = mergeRecentPicks([[{ ...pick, at: now }], await readRecentPicks(dir())]);
      await writeRecentPicks(dir(), picks);
      return { success: true, data: { picks } };
    });
  });

  app.post('/api/recent-picks/import', async (req, reply) => {
    const no = denied(req, reply);
    if (no) return no;
    const parsed = RecentPickImportSchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Send { picks: [ ... ] }');
    }
    // A pick without a time counts as the oldest, so it never outranks a real one.
    const incoming = parsed.data.picks.flatMap((p) => {
      const pick = parseRecentPick(p, 0);
      return pick ? [pick] : [];
    });
    return exclusive(async () => {
      const picks = mergeRecentPicks([await readRecentPicks(dir()), incoming]);
      await writeRecentPicks(dir(), picks);
      return { success: true, data: { picks } };
    });
  });
}
