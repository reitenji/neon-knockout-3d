import { describe, expect, it } from 'vitest';
import { clampClaimedViewTick } from './netcodeCompensation.js';

describe('clampClaimedViewTick', () => {
  it('uses the neutral four-frame window', () => {
    expect(clampClaimedViewTick({
      currentTick: 100,
      claimedViewTick: 50,
      historyOldestTick: 0
    })).toBe(96);
  });

  it('does not expand the window based on client-influenced RTT telemetry', () => {
    expect(clampClaimedViewTick({
      currentTick: 100,
      claimedViewTick: 40,
      historyOldestTick: 0
    })).toBe(96);
  });

  it('respects the oldest retained history within the fixed window', () => {
    expect(clampClaimedViewTick({
      currentTick: 100,
      claimedViewTick: 40,
      historyOldestTick: 98
    })).toBe(98);
  });

  it('clamps future claims to the current authoritative tick', () => {
    expect(clampClaimedViewTick({
      currentTick: 100,
      claimedViewTick: 120,
      historyOldestTick: 90
    })).toBe(100);
  });
});
