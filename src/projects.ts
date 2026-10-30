/**
 * @fileoverview Projects (fork): saved "start a session here" links.
 *
 * A project is machine + system + folder (+ optional account and model) with a name.
 * One click in the side rail starts a session there. They live in `projects.json` in
 * the config dir so every device sees the same list. No secrets: an account is named by
 * id only, and the account's label is kept so the session name needs no fleet lookup.
 */

import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';

/** What the browser may send to create a project. `target` is a remote host id or `local`. */
export const ProjectInputSchema = z.object({
  name: z.string().trim().min(1).max(60),
  target: z.string().min(1).max(80),
  /** Machine and system as shown at save time; the rail displays them without a fleet lookup. */
  machine: z.string().max(60).optional(),
  system: z.string().max(40).optional(),
  path: z
    .string()
    .min(1)
    .max(1024)
    .refine((p) => p.startsWith('/'), 'Folder must be an absolute path'),
  mode: z.enum(['claude', 'shell']).default('claude'),
  accountId: z.string().max(40).optional(),
  accountLabel: z.string().max(60).optional(),
  model: z.string().max(70).optional(),
});

export const ProjectRenameSchema = z.object({ name: z.string().trim().min(1).max(60) });

export const ProjectOrderSchema = z.object({ ids: z.array(z.string().max(40)).max(200) });

export type ProjectInput = z.infer<typeof ProjectInputSchema>;
export interface Project extends ProjectInput {
  id: string;
  createdAt: number;
}

export const MAX_PROJECTS = 100;

export function projectsPath(configDir: string): string {
  return join(configDir, 'projects.json');
}

export async function readProjects(configDir: string): Promise<Project[]> {
  try {
    const raw = JSON.parse(await fs.readFile(projectsPath(configDir), 'utf8')) as { projects?: unknown };
    if (!Array.isArray(raw.projects)) return [];
    // Drop anything malformed rather than failing the whole list.
    return raw.projects.flatMap((p) => {
      const parsed = ProjectInputSchema.safeParse(p);
      const meta = p as { id?: unknown; createdAt?: unknown };
      if (!parsed.success || typeof meta.id !== 'string') return [];
      return [{ ...parsed.data, id: meta.id, createdAt: typeof meta.createdAt === 'number' ? meta.createdAt : 0 }];
    });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    if (err instanceof SyntaxError) return [];
    throw err;
  }
}

export async function writeProjects(configDir: string, projects: Project[]): Promise<void> {
  const path = projectsPath(configDir);
  const tmp = `${path}.${process.pid}.tmp`;
  await fs.mkdir(configDir, { recursive: true });
  await fs.writeFile(tmp, JSON.stringify({ projects }, null, 2) + '\n');
  await fs.rename(tmp, path);
}

export function newProjectId(): string {
  return `p-${randomBytes(5).toString('hex')}`;
}

/** Same pick (target, folder, mode, account, model) saved twice is one project. */
export function sameProject(a: ProjectInput, b: ProjectInput): boolean {
  return (
    a.target === b.target &&
    a.path === b.path &&
    a.mode === b.mode &&
    (a.accountId || '') === (b.accountId || '') &&
    (a.model || '') === (b.model || '')
  );
}

/**
 * Put `projects` in the order of `ids`. Unknown ids and repeats are ignored; a project the
 * list does not name (saved from another device meanwhile) keeps its relative place after
 * the named ones, so a stale drag can never drop a project.
 */
export function reorderProjects<T extends { id: string }>(projects: T[], ids: string[]): T[] {
  const byId = new Map(projects.map((p) => [p.id, p]));
  const seen = new Set<string>();
  const out: T[] = [];
  for (const id of ids) {
    const p = byId.get(id);
    if (p && !seen.has(id)) {
      seen.add(id);
      out.push(p);
    }
  }
  for (const p of projects) if (!seen.has(p.id)) out.push(p);
  return out;
}
