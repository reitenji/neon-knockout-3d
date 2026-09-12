import { describe, expect, it } from 'vitest';
import { ARENA } from '../../../shared/constants.js';
import { DEFAULT_ROOM_SETTINGS, type MatchDurationMs } from '../../../shared/roomSettings.js';
import { buildArenaVisualModel, interpolateArenaVertices } from './arenaVisualPlan.js';

function visualState(durationMs: MatchDurationMs, remainingMs: number, platformProgress = 0) {
  return {
    phase: 'REGULATION' as const,
    remainingMs,
    platformProgress,
    settings: { ...DEFAULT_ROOM_SETTINGS, durationMs }
  };
}

describe('arenaVisualPlan', () => {
  it('reuses frozen arena geometry that does not depend on match state', () => {
    const first = buildArenaVisualModel(visualState(90_000, 60_000));
    const second = buildArenaVisualModel(visualState(180_000, 100_000, 0.4));

    expect(second.regulationVertices).toBe(first.regulationVertices);
    expect(second.minimumVertices).toBe(first.minimumVertices);
    expect(second.recessedVertices).toBe(first.recessedVertices);
    expect(second.corePlatformVertices).toBe(first.corePlatformVertices);
    expect(second.panelBands).toBe(first.panelBands);
    expect(second.voidShadowOffset).toBe(first.voidShadowOffset);
    expect(Object.isFrozen(first.recessedVertices)).toBe(true);
    expect(Object.isFrozen(first.recessedVertices[0])).toBe(true);
    expect(Object.isFrozen(first.panelBands)).toBe(true);
    expect(first.panelBands.every((band) => Object.isFrozen(band))).toBe(true);
  });

  it('interpolates the arena footprint exactly between regulation and minimum octagons', () => {
    expect(interpolateArenaVertices(0)).toEqual(ARENA.regulationVertices);
    expect(interpolateArenaVertices(1)).toEqual(ARENA.minimumVertices);

    const midpoint = interpolateArenaVertices(0.5);
    expect(midpoint[0]).toEqual({ x: 280, y: 120 });
    expect(midpoint[4]).toEqual({ x: 1_000, y: 600 });
  });

  it('arms a readable contraction warning with brighter current edges and corner nodes during the lead window', () => {
    const visuals = buildArenaVisualModel(
      visualState(90_000, 57_500, 0.5),
      { nowMs: 420, reducedMotion: false }
    );

    expect(visuals.currentVertices[0]).toEqual({ x: 280, y: 120 });
    expect(visuals.currentVertices[7]).toEqual({ x: 200, y: 200 });
    expect(visuals.panelBands).toHaveLength(4);
    expect(visuals.minimumOutlineAlpha).toBeGreaterThan(0.3);
    expect(visuals.activeBoundaryAlpha).toBeGreaterThan(0.6);
    expect(visuals.activeBoundaryWidth).toBeGreaterThan(6);
    expect(visuals.cornerNodeRadius).toBeGreaterThan(8);
    expect(visuals.warningPulse).toBeGreaterThan(0);
    expect(visuals.dangerChevronCount).toBe(8);
  });

  it('keeps the warning readable but suppresses telegraph pulsing under reduced motion', () => {
    const visuals = buildArenaVisualModel(
      visualState(90_000, 57_500, 0.5),
      { nowMs: 420, reducedMotion: true }
    );

    expect(visuals.minimumOutlineAlpha).toBeGreaterThan(0.2);
    expect(visuals.warningPulse).toBe(0);
    expect(visuals.cornerNodeRadius).toBe(9);
  });

  it.each([
    [90_000, 58_500, 56_250],
    [120_000, 78_000, 75_000],
    [180_000, 117_000, 112_500]
  ] as const)('derives warning emphasis proportionally for a %i ms match', (durationMs, warningAt, startsAt) => {
    const before = buildArenaVisualModel(
      visualState(durationMs, warningAt + 1),
      { reducedMotion: true }
    );
    const start = buildArenaVisualModel(
      visualState(durationMs, warningAt),
      { reducedMotion: true }
    );
    const midpoint = buildArenaVisualModel(
      visualState(durationMs, (warningAt + startsAt) / 2),
      { reducedMotion: true }
    );
    const complete = buildArenaVisualModel(
      visualState(durationMs, startsAt),
      { reducedMotion: true }
    );

    expect(before.minimumOutlineAlpha).toBe(0.18);
    expect(start.minimumOutlineAlpha).toBe(0.18);
    expect(midpoint.minimumOutlineAlpha).toBeCloseTo(0.37, 8);
    expect(complete.minimumOutlineAlpha).toBeCloseTo(0.56, 8);
  });
});
