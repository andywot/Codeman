/**
 * @fileoverview Keep a laptop awake while Claude works on it (fork).
 *
 * Once a minute, each machine with a busy Claude session gets a heartbeat over its pooled
 * shell. The heartbeat touches a stamp file and, if none is running, starts a small holder
 * on that machine, which keeps sleep off only while the stamp is recent. So it needs no
 * clean-up: when work ends, or this server or the network goes away, the holder stops by
 * itself within {@link KEEP_AWAKE_STAMP_SECONDS} and the machine sleeps as usual.
 *
 * Only machines with a battery get a holder; a desktop is left alone.
 *
 * - Windows (WSL): a hidden PowerShell calling SetThreadExecutionState, fed one line every
 *   30 s from WSL. Its input closing ends it, and Windows drops the request with it. This
 *   stops idle sleep. It does NOT override closing the lid: that follows the Windows power
 *   setting "When I close the lid".
 * - Linux: `systemd-inhibit --what=idle:sleep`, which covers a lid close only as far as
 *   logind's own lid settings allow.
 *
 * The heartbeat goes through `remoteExecIfIdle`, so it never competes with other work, and
 * it asks no more of a machine than the alert reader already does for the same session
 * (remote-session-signals.ts). A skipped beat is harmless: the stamp allows for several.
 */

import { machineNameOf } from './machine-status.js';
import type { RemoteHost } from './types.js';

export const KEEP_AWAKE_INTERVAL_MS = 60_000;
/** How long after the last heartbeat a holder keeps going. */
export const KEEP_AWAKE_STAMP_SECONDS = 300;

const PS_HOLD =
  `Add-Type -Name P -Namespace W -MemberDefinition '[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint f);'; ` +
  `while ($null -ne [Console]::In.ReadLine()) { [void][W.P]::SetThreadExecutionState(2147483649) }`;

/** The heartbeat, one shell script. Exported for its test, which runs it with a stand-in holder. */
export function buildKeepAwakeScript(opts: { dir?: string; powershell?: string; inhibit?: string } = {}): string {
  const dir = opts.dir ?? '"$HOME/.config/claude-rc"';
  const ps = opts.powershell ?? '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe';
  const inhibit = opts.inhibit ?? 'systemd-inhibit';
  const fresh = `[ $(( $(date +%s) - $(stat -c %Y "$s" 2>/dev/null || echo 0) )) -lt ${KEEP_AWAKE_STAMP_SECONDS} ]`;
  // Single quotes around the PowerShell text are closed and reopened around its own.
  const psArg = `'${PS_HOLD.replace(/'/g, `'\\''`)}'`;
  return [
    `d=${dir}; mkdir -p "$d" || exit 0; s="$d/keep-awake.stamp"; p="$d/keep-awake.pid"; touch "$s"`,
    `[ -f "$p" ] && kill -0 "$(cat "$p")" 2>/dev/null && exit 0`,
    `if ls -d /sys/class/power_supply/BAT* >/dev/null 2>&1 && command -v ${inhibit} >/dev/null 2>&1; then`,
    `  nohup setsid ${inhibit} --what=idle:sleep --who=claude-rc --why='Claude is working' sh -c 's=$1; while [ $(( $(date +%s) - $(stat -c %Y "$s" 2>/dev/null || echo 0) )) -lt ${KEEP_AWAKE_STAMP_SECONDS} ]; do sleep 30; done' _ "$s" >/dev/null 2>&1 </dev/null &`,
    `  echo $! > "$p"`,
    `elif [ -x "${ps}" ] && "${ps}" -NoProfile -NonInteractive -Command 'if (Get-CimInstance Win32_Battery) { "yes" }' 2>/dev/null </dev/null | grep -q yes; then`,
    `  nohup setsid sh -c 'while ${fresh.replace(/"\$s"/g, '"$1"')}; do echo k; sleep 30; done | "$2" -NoProfile -NonInteractive -WindowStyle Hidden -Command "$3"' _ "$s" "${ps}" ${psArg} >/dev/null 2>&1 </dev/null &`,
    `  echo $! > "$p"`,
    `fi`,
    `true`,
  ].join('\n');
}

/** One host per machine that has a busy session. Pure. */
export function keepAwakeTargets(hosts: RemoteHost[], activeHostIds: string[]): RemoteHost[] {
  const active = new Set(activeHostIds);
  const byMachine = new Map<string, RemoteHost>();
  for (const host of hosts) {
    if (!active.has(host.id)) continue;
    const name = machineNameOf(host);
    if (!byMachine.has(name)) byMachine.set(name, host);
  }
  return [...byMachine.values()];
}

export function startKeepAwake(deps: {
  readHosts: () => Promise<RemoteHost[]>;
  activeHostIds: () => string[];
  exec: (host: RemoteHost, script: string) => Promise<unknown>;
}): () => void {
  const script = buildKeepAwakeScript();
  const beat = async () => {
    const ids = deps.activeHostIds();
    if (!ids.length) return;
    const hosts = await deps.readHosts();
    const targets = keepAwakeTargets(hosts, ids);
    await Promise.all(targets.map((h) => deps.exec(h, script).catch(() => {})));
  };
  const timer = setInterval(() => void beat().catch(() => {}), KEEP_AWAKE_INTERVAL_MS);
  timer.unref();
  return () => clearInterval(timer);
}
