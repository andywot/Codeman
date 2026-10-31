/**
 * @fileoverview Recent picks (fork): the last few machine + folder choices from the New
 * session dialog, shared by every device.
 *
 * They used to live in each browser's localStorage, so a phone and a laptop never agreed.
 * Now they are stored in `recent-picks.json` in the config dir, next to `projects.json`
 * (same atomic write, same admin-only rule in multi-user mode). A pick is machine id,
 * folder, mode and optional account id / model. No secrets: an account is named by id only.
 */

import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

export const MAX_RECENT_PICKS = 8;

export const RecentPickInputSchema = z.object({
  /** A remote host id or `local`. */
  target: z.string().min(1).max(80),
  path: z
    .string()
    .min(1)
    .max(1024)
    .refine((p) => p.startsWith('/'), 'Folder must be an absolute path'),
  mode: z.enum(['claude', 'shell']).default('claude'),
  accountId: z.string().max(40).optional(),
  model: z.string().max(70).optional(),
  /** When it was picked (ms since epoch). The newest wins on a merge. */
  at: z.number().int().nonnegative().max(8.64e15).optional(),
});

export const RecentPickImportSchema = z.object({ picks: z.array(z.unknown()).max(100) });

export type RecentPick = z.infer<typeof RecentPickInputSchema> & { at: number };

export function recentPicksPath(configDir: string): string {
  return join(configDir, 'recent-picks.json');
}

/** Same machine, folder, mode and account is one pick (the model does not make a new one). */
export function recentPickKey(p: { target: string; path: string; mode?: string; accountId?: string }): string {
  return `${p.target}\n${p.path}\n${p.mode ?? 'claude'}\n${p.accountId || ''}`;
}

/** Validate one untrusted pick; null when it is not a usable one. `now` stands in for a missing time. */
export function parseRecentPick(raw: unknown, now: number): RecentPick | null {
  const parsed = RecentPickInputSchema.safeParse(raw);
  if (!parsed.success) return null;
  return { ...parsed.data, at: parsed.data.at ?? now };
}

/**
 * Newest first, one entry per key (the newest of any repeats), at most `max`.
 * Ties on `at` keep the order given, so an earlier list wins over a later one.
 */
export function mergeRecentPicks(lists: RecentPick[][], max = MAX_RECENT_PICKS): RecentPick[] {
  const all = lists.flat().map((p, i) => ({ p, i }));
  all.sort((a, b) => b.p.at - a.p.at || a.i - b.i);
  const seen = new Set<string>();
  const out: RecentPick[] = [];
  for (const { p } of all) {
    const key = recentPickKey(p);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
    if (out.length >= max) break;
  }
  return out;
}

export async function readRecentPicks(configDir: string): Promise<RecentPick[]> {
  try {
    const raw = JSON.parse(await fs.readFile(recentPicksPath(configDir), 'utf8')) as { picks?: unknown };
    if (!Array.isArray(raw.picks)) return [];
    // Drop anything malformed rather than failing the whole list.
    const picks = raw.picks.flatMap((p) => {
      const pick = parseRecentPick(p, 0);
      return pick ? [pick] : [];
    });
    return mergeRecentPicks([picks]);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    if (err instanceof SyntaxError) return [];
    throw err;
  }
}

export async function writeRecentPicks(configDir: string, picks: RecentPick[]): Promise<void> {
  const path = recentPicksPath(configDir);
  const tmp = `${path}.${process.pid}.tmp`;
  await fs.mkdir(configDir, { recursive: true });
  await fs.writeFile(tmp, JSON.stringify({ picks }, null, 2) + '\n');
  await fs.rename(tmp, path);
}
