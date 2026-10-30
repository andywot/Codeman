import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { quotePaneLaunch } from '../src/tmux-manager.js';
import { shellescape } from '../src/remote-hosts.js';

// A remote launch is `ssh host '<far-side command>'`. Its `$VAR` and `$(...)` (an account
// token's `$(cat ~/.config/claude-rc/<id>.secret)`) must expand on the FAR side, not on the
// server that runs tmux's `bash -c`. Here an inner `bash -c` stands in for ssh.
function run(verbatim: boolean): string {
  const far = 'echo "far=$FAR_ONLY"';
  const launch = `FAR_ONLY=yes bash -c ${shellescape(far)}`;
  return execFileSync('sh', ['-c', `bash -c ${quotePaneLaunch(launch, verbatim)}`])
    .toString()
    .trim();
}

describe('quotePaneLaunch', () => {
  it('passes a remote launch through verbatim so the far side expands it', () => {
    expect(run(true)).toBe('far=yes');
  });

  it('a double-quoted launch expands early (why remote launches must not use it)', () => {
    expect(run(false)).toBe('far=');
  });
});
