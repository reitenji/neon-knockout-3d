import { NEUTRAL_ADAPTIVE_NETCODE_BUDGET } from '../../shared/netcodePolicy.js';

export function clampClaimedViewTick(options: Readonly<{
  currentTick: number;
  claimedViewTick: number;
  historyOldestTick: number | null;
}>): number {
  // Probe acknowledgements are supplied by the client and can be intentionally
  // delayed, so they must not grant additional authoritative melee rewind.
  const legalOldestTick = Math.max(
    0,
    options.currentTick - NEUTRAL_ADAPTIVE_NETCODE_BUDGET.rollbackFrames
  );
  const retainedOldestTick = options.historyOldestTick ?? legalOldestTick;
  return Math.min(
    options.currentTick,
    Math.max(Math.floor(options.claimedViewTick), legalOldestTick, retainedOldestTick)
  );
}
