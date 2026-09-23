import { calculateAdaptiveNetcodeTarget, NEUTRAL_ADAPTIVE_NETCODE_BUDGET } from '../../shared/netcodePolicy.js';

export function clampClaimedViewTick(options: Readonly<{
  currentTick: number;
  claimedViewTick: number;
  medianRttMs: number | null;
  jitterMs: number | null;
  historyOldestTick: number | null;
  trustedNetworkTelemetry: boolean;
}>): number {
  const rollbackFrames = !options.trustedNetworkTelemetry || options.medianRttMs === null || options.jitterMs === null
    ? NEUTRAL_ADAPTIVE_NETCODE_BUDGET.rollbackFrames
    : calculateAdaptiveNetcodeTarget({
      medianRttMs: options.medianRttMs,
      transportJitterMs: options.jitterMs,
      arrivalJitterMs: 0,
      bufferUnderrun: false
    }).rollbackFrames;
  const legalOldestTick = Math.max(0, options.currentTick - rollbackFrames);
  const retainedOldestTick = options.historyOldestTick ?? legalOldestTick;
  return Math.min(
    options.currentTick,
    Math.max(Math.floor(options.claimedViewTick), legalOldestTick, retainedOldestTick)
  );
}
