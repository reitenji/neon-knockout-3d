import { describe, expect, it } from 'vitest';
import { clampClaimedViewTick } from './netcodeCompensation.js';

describe('clampClaimedViewTick', () => {
  it('uses the neutral four-frame window when authoritative network telemetry is stale', () => {
    expect(clampClaimedViewTick({
      currentTick: 100,
      claimedViewTick: 50,
      medianRttMs: null,
      jitterMs: null,
      historyOldestTick: 0,
      trustedNetworkTelemetry: true
    })).toBe(96);
  });

  it('uses the shared fresh RTT and jitter budget, then respects retained history', () => {
    expect(clampClaimedViewTick({
      currentTick: 100,
      claimedViewTick: 40,
      medianRttMs: 100,
      jitterMs: 20,
      historyOldestTick: 94,
      trustedNetworkTelemetry: true
    })).toBe(94);
  });

  it('does not expand rollback from peer-controlled network telemetry', () => {
    expect(clampClaimedViewTick({
      currentTick: 100,
      claimedViewTick: 40,
      medianRttMs: 300,
      jitterMs: 0,
      historyOldestTick: 0,
      trustedNetworkTelemetry: false
    })).toBe(96);
  });

  it('clamps future claims to the current authoritative tick', () => {
    expect(clampClaimedViewTick({
      currentTick: 100,
      claimedViewTick: 120,
      medianRttMs: 20,
      jitterMs: 0,
      historyOldestTick: 90,
      trustedNetworkTelemetry: true
    })).toBe(100);
  });
});
