/**
 * @fileoverview Project routes (fork): saved "start a session here" links.
 *
 * - GET    /api/projects        the saved projects, oldest first
 * - POST   /api/projects        save one (the same pick twice returns the existing one)
 * - PATCH  /api/projects/:id    { name } rename
 * - DELETE /api/projects/:id
 *
 * Stored in ~/.codeman/projects.json (src/projects.ts). Admin-only in multi-user mode,
 * like the fleet routes the projects point into.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ApiResponse } from '../../types.js';
import { ApiErrorCode, createErrorResponse } from '../../types.js';
import { getDataDir } from '../../config/instance.js';
import { isMultiUserMode } from '../../config/multiuser.js';
import { isAdmin } from '../route-helpers.js';
import {
  MAX_PROJECTS,
  ProjectInputSchema,
  ProjectRenameSchema,
  newProjectId,
  readProjects,
  sameProject,
  writeProjects,
} from '../../projects.js';

function denied(req: FastifyRequest, reply: FastifyReply): ApiResponse<never> | null {
  if (isMultiUserMode() && !isAdmin(req)) {
    reply.code(403);
    return createErrorResponse(ApiErrorCode.FORBIDDEN, 'Admin only in multi-user mode');
  }
  return null;
}

export function registerProjectRoutes(app: FastifyInstance): void {
  const dir = () => getDataDir();
  // Read-modify-write of one file: serialize so two quick requests cannot lose an edit.
  let chain: Promise<unknown> = Promise.resolve();
  const exclusive = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = chain.then(fn, fn);
    chain = run.catch(() => undefined);
    return run;
  };

  app.get('/api/projects', async (req, reply) => {
    const no = denied(req, reply);
    if (no) return no;
    return { success: true, data: { projects: await readProjects(dir()) } };
  });

  app.post('/api/projects', async (req, reply) => {
    const no = denied(req, reply);
    if (no) return no;
    const parsed = ProjectInputSchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return createErrorResponse(ApiErrorCode.INVALID_INPUT, parsed.error.issues[0]?.message ?? 'Invalid project');
    }
    return exclusive(async () => {
      const projects = await readProjects(dir());
      const existing = projects.find((p) => sameProject(p, parsed.data));
      if (existing) return { success: true, data: { project: existing, created: false } };
      if (projects.length >= MAX_PROJECTS) {
        reply.code(400);
        return createErrorResponse(ApiErrorCode.INVALID_INPUT, `At most ${MAX_PROJECTS} projects`);
      }
      const project = { ...parsed.data, id: newProjectId(), createdAt: Date.now() };
      await writeProjects(dir(), [...projects, project]);
      reply.code(201);
      return { success: true, data: { project, created: true } };
    });
  });

  app.patch<{ Params: { id: string } }>('/api/projects/:id', async (req, reply) => {
    const no = denied(req, reply);
    if (no) return no;
    const parsed = ProjectRenameSchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Give the project a name (60 characters at most)');
    }
    return exclusive(async () => {
      const projects = await readProjects(dir());
      const project = projects.find((p) => p.id === req.params.id);
      if (!project) {
        reply.code(404);
        return createErrorResponse(ApiErrorCode.NOT_FOUND, 'No such project');
      }
      project.name = parsed.data.name;
      await writeProjects(dir(), projects);
      return { success: true, data: { project } };
    });
  });

  app.delete<{ Params: { id: string } }>('/api/projects/:id', async (req, reply) => {
    const no = denied(req, reply);
    if (no) return no;
    return exclusive(async () => {
      const projects = await readProjects(dir());
      if (!projects.some((p) => p.id === req.params.id)) {
        reply.code(404);
        return createErrorResponse(ApiErrorCode.NOT_FOUND, 'No such project');
      }
      await writeProjects(
        dir(),
        projects.filter((p) => p.id !== req.params.id)
      );
      return { success: true };
    });
  });
}
