// Port: none (pure function).
//
// A token account's 5-hour and 7-day usage comes from the unified rate-limit headers on
// a one-token request made with that account's token (src/fleet.ts). A `claude
// setup-token` token cannot read the OAuth usage endpoint (it lacks user:profile), so
// these headers are the only source. Pinned: utilization 0..1 becomes a percentage,
// reset epochs become ISO times, and a response without the headers reads as no usage.
import { describe, expect, it } from 'vitest';
import { parseUnifiedRateLimitHeaders } from '../src/fleet.js';

describe('parseUnifiedRateLimitHeaders', () => {
  it('reads both windows as percentages with their reset times', () => {
    const headers = new Headers({
      'anthropic-ratelimit-unified-5h-utilization': '0.1',
      'anthropic-ratelimit-unified-5h-reset': '1793301000',
      'anthropic-ratelimit-unified-7d-utilization': '0.063',
      'anthropic-ratelimit-unified-7d-reset': '1793541600',
    });
    expect(parseUnifiedRateLimitHeaders(headers, 'now')).toEqual({
      fiveHour: 10,
      fiveHourResetsAt: new Date(1793301000 * 1000).toISOString(),
      sevenDay: 6.3,
      sevenDayResetsAt: new Date(1793541600 * 1000).toISOString(),
      fetchedAt: 'now',
    });
  });

  it('returns null when the response carries no usage', () => {
    expect(parseUnifiedRateLimitHeaders(new Headers({ 'content-type': 'application/json' }), 'now')).toBeNull();
  });
});
