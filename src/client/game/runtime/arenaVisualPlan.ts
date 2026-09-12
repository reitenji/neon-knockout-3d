import { ARENA } from '../../../shared/constants.js';
import type { MatchSnapshot, Vec2 } from '../../../shared/model.js';
import { matchTimingFor } from '../../../shared/roomSettings.js';

export type ArenaVisualState = Pick<MatchSnapshot, 'phase' | 'remainingMs' | 'platformProgress' | 'settings'>;

export type ArenaVisualOptions = Readonly<{
  nowMs?: number;
  reducedMotion?: boolean;
}>;

export type ArenaVisualModel = Readonly<{
  regulationVertices: readonly Vec2[];
  minimumVertices: readonly Vec2[];
  currentVertices: readonly Vec2[];
  recessedVertices: readonly Vec2[];
  corePlatformVertices: readonly Vec2[];
  panelBands: readonly (readonly Vec2[])[];
  voidShadowOffset: Vec2;
  warningPulse: number;
  minimumOutlineAlpha: number;
  activeBoundaryAlpha: number;
  activeBoundaryWidth: number;
  cornerNodeRadius: number;
  dangerFillAlpha: number;
  dangerChevronCount: number;
}>;

const PANEL_STOPS = Object.freeze([0.18, 0.3, 0.42, 0.54]);

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function lerp(start: number, end: number, amount: number): number {
  return start + (end - start) * amount;
}

function freezeVertices(vertices: readonly Vec2[]): readonly Vec2[] {
  return Object.freeze(vertices.map((vertex) => Object.freeze(vertex)));
}

export function interpolateArenaVertices(progress: number): readonly Vec2[] {
  const contraction = clamp(progress, 0, 1);
  if (contraction === 0) return ARENA.regulationVertices;
  if (contraction === 1) return ARENA.minimumVertices;
  return freezeVertices(ARENA.regulationVertices.map((regulation, index) => {
    const minimum = ARENA.minimumVertices[index]!;
    return {
      x: lerp(regulation.x, minimum.x, contraction),
      y: lerp(regulation.y, minimum.y, contraction)
    };
  }));
}

const RECESSED_VERTICES = interpolateArenaVertices(0.12);
const CORE_PLATFORM_VERTICES = interpolateArenaVertices(0.24);
const PANEL_BANDS = Object.freeze(PANEL_STOPS.map((stop) => interpolateArenaVertices(stop)));
const VOID_SHADOW_OFFSET = Object.freeze({ x: 16, y: 20 });

function warningLeadProgress(state: ArenaVisualState): number {
  if (state.phase !== 'REGULATION' && state.phase !== 'SUDDEN_DEATH') return 0;
  if (state.phase === 'SUDDEN_DEATH') return 1;
  const timing = matchTimingFor(state.settings.durationMs);
  const leadWindow = timing.contractionWarningRemainingMs - timing.contractionStartRemainingMs;
  if (leadWindow <= 0) return 0;
  return clamp((timing.contractionWarningRemainingMs - state.remainingMs) / leadWindow, 0, 1);
}

export function buildArenaVisualModel(
  state: ArenaVisualState,
  options: ArenaVisualOptions = {}
): ArenaVisualModel {
  const reducedMotion = options.reducedMotion ?? false;
  const nowMs = options.nowMs ?? 0;
  const platformProgress = clamp(state.platformProgress, 0, 1);
  const leadProgress = warningLeadProgress(state);
  const emphasis = Math.max(platformProgress, leadProgress);
  const warningPulse = reducedMotion ? 0 : (Math.sin(nowMs / 280) + 1) / 2;

  return {
    regulationVertices: ARENA.regulationVertices,
    minimumVertices: ARENA.minimumVertices,
    currentVertices: interpolateArenaVertices(platformProgress),
    recessedVertices: RECESSED_VERTICES,
    corePlatformVertices: CORE_PLATFORM_VERTICES,
    panelBands: PANEL_BANDS,
    voidShadowOffset: VOID_SHADOW_OFFSET,
    warningPulse,
    minimumOutlineAlpha: clamp(0.18 + emphasis * 0.38 + warningPulse * 0.06, 0.18, 0.62),
    activeBoundaryAlpha: clamp(0.34 + platformProgress * 0.4 + warningPulse * 0.08, 0.34, 0.82),
    activeBoundaryWidth: 6 + platformProgress * 5,
    cornerNodeRadius: 8 + platformProgress * 2 + warningPulse * 1.5,
    dangerFillAlpha: clamp(0.08 + emphasis * 0.18, 0.08, 0.3),
    dangerChevronCount: ARENA.regulationVertices.length
  };
}
