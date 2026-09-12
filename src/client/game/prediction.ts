import { ARENA, GAME } from '../../shared/constants.js';
import { FIGHTERS } from '../../shared/fighters.js';
import { advanceKinematics, normalizeAim, normalizeAxes, type KinematicState } from '../../shared/kinematics.js';
import type { InputFrame, MatchAction, MatchPlayer, MatchSnapshot, Vec2 } from '../../shared/model.js';
import { AdaptiveNetcodePolicy } from '../../shared/netcodePolicy.js';

export const MIN_INTERPOLATION_DELAY_MS = 1_000 / 60;
export const MAX_INTERPOLATION_DELAY_MS = 5_000 / 60;
export const REMOTE_SNAP_DISTANCE = 160;
export const LOCAL_CORRECTION_SNAP_DISTANCE = 160;
const LOCAL_CORRECTION_BLEND = 0.35;
const INTERVAL_EWMA_ALPHA = 0.2;
const JITTER_EWMA_ALPHA = 0.25;
const SNAPSHOT_CAPACITY = 16;
const MAX_EXTRAPOLATION_FRAMES = 2;
const MIN_ROLLBACK_FRAMES = 2;
const MAX_ROLLBACK_FRAMES = 10;
const PENDING_INPUT_CAPACITY = 12;
const TICK_MS = 1_000 / 60;

export type PlayerPresentation = Readonly<KinematicState & { actionStart: MatchAction | null }>;

export type InterpolationFrame = Readonly<{
  previous: MatchSnapshot;
  current: MatchSnapshot;
  alpha: number;
}>;

export type TimelineNetworkSample = Readonly<{
  medianRttMs: number | null;
  transportJitterMs: number | null;
  arrivalJitterMs: number;
  bufferUnderrun: boolean;
  sampledAtMs: number;
}>;

export type TimelineSample = Readonly<{
  frame: InterpolationFrame | null;
  targetTick: number | null;
  delayFrames: number;
  extrapolatedFrames: number;
  bufferUnderrun: boolean;
}>;

export type ReconciliationResult = Readonly<{
  authoritativeTick: number;
  rollbackFrames: number;
  correctionDistancePx: number;
  hardSnap: boolean;
}>;

export type PredictionReconciliation = Readonly<{
  presentation: PlayerPresentation;
  result: ReconciliationResult;
}>;

type PendingInput = Readonly<{
  frame: InputFrame;
  elapsedMs: number;
  platformProgress: number;
  actionEdge: boolean;
}>;
type TimedSnapshot = Readonly<{ snapshot: MatchSnapshot; receivedAtMs: number }>;
type PredictionRuntime = KinematicState & {
  dashRemainingMs: number;
  dashCooldownRemainingMs: number;
  dashDirection: Vec2;
  hitstunRemainingMs: number;
  respawnRemainingMs: number;
  action: MatchAction;
  heavyChargeMs: number;
  heavyHeld: boolean;
  heavyAim: Vec2;
};

const NEUTRAL_ACTION_METADATA = {
  charging: false,
  attackId: null,
  profileId: null,
  lockedFacing: null,
  activeProgress: 0,
  hitTargetIds: []
} as const;

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function subtract(left: Vec2, right: Vec2): Vec2 {
  return { x: left.x - right.x, y: left.y - right.y };
}

function dot(left: Vec2, right: Vec2): number {
  return left.x * right.x + left.y * right.y;
}

function normalize(vector: Vec2, fallback: Vec2): Vec2 {
  const length = Math.hypot(vector.x, vector.y);
  if (length < 0.000001) return fallback;
  return { x: vector.x / length, y: vector.y / length };
}

function platformVertices(progress: number): readonly Vec2[] {
  const contraction = clamp(progress, 0, 1);
  return ARENA.regulationVertices.map((regulation, index) => {
    const minimum = ARENA.minimumVertices[index]!;
    return {
      x: regulation.x + (minimum.x - regulation.x) * contraction,
      y: regulation.y + (minimum.y - regulation.y) * contraction
    };
  });
}

function pointInConvexPolygon(point: Vec2, vertices: readonly Vec2[]): boolean {
  let direction = 0;
  for (let index = 0; index < vertices.length; index += 1) {
    const start = vertices[index]!;
    const end = vertices[(index + 1) % vertices.length]!;
    const cross = (end.x - start.x) * (point.y - start.y) - (end.y - start.y) * (point.x - start.x);
    if (Math.abs(cross) <= 0.000000001) continue;
    const currentDirection = Math.sign(cross);
    if (direction !== 0 && currentDirection !== direction) return false;
    direction = currentDirection;
  }
  return true;
}

function closestPointOnSegment(point: Vec2, start: Vec2, end: Vec2): Vec2 {
  const segment = subtract(end, start);
  const lengthSquared = dot(segment, segment);
  if (lengthSquared <= 0.000000001) return start;
  const projection = clamp(dot(subtract(point, start), segment) / lengthSquared, 0, 1);
  return { x: start.x + segment.x * projection, y: start.y + segment.y * projection };
}

function nearestOutwardNormal(point: Vec2, vertices: readonly Vec2[]): Vec2 {
  let nearestStart = vertices[0]!;
  let nearestEnd = vertices[1]!;
  let nearestDistance = Number.POSITIVE_INFINITY;
  for (let index = 0; index < vertices.length; index += 1) {
    const start = vertices[index]!;
    const end = vertices[(index + 1) % vertices.length]!;
    const edgePoint = closestPointOnSegment(point, start, end);
    const distance = Math.hypot(point.x - edgePoint.x, point.y - edgePoint.y);
    if (distance < nearestDistance) {
      nearestDistance = distance;
      nearestStart = start;
      nearestEnd = end;
    }
  }
  const signedArea = vertices.reduce((total, vertex, index) => {
    const next = vertices[(index + 1) % vertices.length]!;
    return total + vertex.x * next.y - next.x * vertex.y;
  }, 0);
  const edge = subtract(nearestEnd, nearestStart);
  return normalize(
    signedArea >= 0 ? { x: edge.y, y: -edge.x } : { x: -edge.y, y: edge.x },
    { x: 0, y: -1 }
  );
}

function runtimeOf(player: MatchPlayer): PredictionRuntime {
  const velocityDirection = normalize(player.velocity, player.facing);
  const lockedHeavyFacing = player.action.kind === 'HEAVY' && player.action.lockedFacing
    ? normalize(player.action.lockedFacing, player.facing)
    : null;
  return {
    position: player.position,
    velocity: player.velocity,
    facing: lockedHeavyFacing ?? player.facing,
    dashRemainingMs: player.dashRemainingMs,
    dashCooldownRemainingMs: player.dashCooldownRemainingMs,
    dashDirection: player.dashRemainingMs > 0 ? velocityDirection : player.facing,
    hitstunRemainingMs: player.hitstunRemainingMs,
    respawnRemainingMs: player.respawnRemainingMs,
    action: player.action,
    heavyChargeMs: player.action.kind === null ? player.action.chargeMs : 0,
    heavyHeld: player.action.kind === null && player.action.chargeMs > 0,
    heavyAim: lockedHeavyFacing ?? player.facing
  };
}

function dashDirection(frame: InputFrame, facing: Vec2): Vec2 {
  const movement = normalizeAxes(frame.moveX, frame.moveY);
  return movement.x === 0 && movement.y === 0 ? facing : movement;
}

function quickActionStart(player: MatchPlayer): MatchAction {
  const comboStep: 1 | 2 | 3 = player.action.comboStep === 1 ? 2 : player.action.comboStep === 2 ? 3 : 1;
  const kind = comboStep === 1 ? 'QUICK_1' : comboStep === 2 ? 'QUICK_2' : 'QUICK_3';
  return { kind, phase: 'WINDUP', comboStep, chargeMs: 0, ...NEUTRAL_ACTION_METADATA };
}

function advanceRuntime(
  runtime: PredictionRuntime,
  canonicalPlayer: MatchPlayer,
  frame: InputFrame,
  elapsedMs: number,
  platformProgress: number
): Readonly<{ runtime: PredictionRuntime; actionStart: MatchAction | null }> {
  const elapsed = Math.max(0, elapsedMs);
  const fighter = FIGHTERS[canonicalPlayer.chassis];
  if (runtime.action.kind === 'RESPAWNING' || runtime.respawnRemainingMs > 0) {
    return {
      runtime: { ...runtime, respawnRemainingMs: Math.max(0, runtime.respawnRemainingMs - elapsed) },
      actionStart: null
    };
  }

  let dashRemainingMs = Math.max(0, runtime.dashRemainingMs - elapsed);
  let dashCooldownRemainingMs = Math.max(0, runtime.dashCooldownRemainingMs - elapsed);
  const hitstunRemainingMs = Math.max(0, runtime.hitstunRemainingMs - elapsed);
  const committedAction = runtime.action.kind !== null && runtime.action.kind !== 'HITSTUN' &&
    runtime.action.kind !== 'DASH';
  const canStartAction = hitstunRemainingMs <= 0 && !committedAction && dashRemainingMs <= 0;
  let dashDirectionValue = runtime.dashDirection;
  let actionStart: MatchAction | null = null;
  let commitsAction = false;
  let heavyChargeMs = runtime.heavyChargeMs;
  const heavyRelease = runtime.heavyHeld && !frame.heavy;
  let heavyAim = runtime.heavyAim;

  if (!committedAction && (frame.heavy || heavyRelease)) {
    heavyAim = normalizeAim(frame.aimX, frame.aimY, heavyAim);
  }

  if (frame.dash && canStartAction) {
    heavyChargeMs = 0;
    if (dashCooldownRemainingMs <= 0) {
      dashDirectionValue = dashDirection(frame, runtime.facing);
      dashRemainingMs = fighter.dashDurationMs;
      dashCooldownRemainingMs = fighter.dashCooldownMs;
      actionStart = { kind: 'DASH', phase: 'ACTIVE', comboStep: 0, chargeMs: 0, ...NEUTRAL_ACTION_METADATA };
      commitsAction = true;
    }
  } else if (canStartAction && frame.heavy) {
    heavyChargeMs = Math.min(GAME.heavyMaxChargeMs, heavyChargeMs + elapsed);
    actionStart = {
      kind: 'HEAVY', phase: 'WINDUP', comboStep: 0, chargeMs: heavyChargeMs,
      ...NEUTRAL_ACTION_METADATA, charging: true
    };
  } else if (canStartAction && heavyRelease && heavyChargeMs > 0) {
    actionStart = {
      kind: 'HEAVY', phase: 'WINDUP', comboStep: 0, chargeMs: heavyChargeMs,
      ...NEUTRAL_ACTION_METADATA, lockedFacing: heavyAim
    };
    commitsAction = true;
  } else if (canStartAction && frame.quick && heavyChargeMs === 0) {
    actionStart = quickActionStart(canonicalPlayer);
    commitsAction = true;
  } else if (!frame.heavy) {
    heavyChargeMs = 0;
  }

  const vertices = platformVertices(platformProgress);
  const outsidePlatform = !pointInConvexPolygon(runtime.position, vertices);
  const charging = canStartAction && frame.heavy && heavyChargeMs > 0;
  const movementInput = hitstunRemainingMs > 0
    ? { ...frame, moveX: 0, moveY: 0 }
    : frame;
  const locksHeavyFacing = (runtime.action.kind === 'HEAVY' && !runtime.action.charging) ||
    (commitsAction && actionStart?.kind === 'HEAVY' && !actionStart.charging);
  const kinematicInput = locksHeavyFacing
    ? { ...movementInput, aimX: heavyAim.x, aimY: heavyAim.y }
    : movementInput;
  const next = advanceKinematics(runtime, kinematicInput, elapsed, {
    moveSpeed: fighter.moveSpeed,
    dashVelocity: dashRemainingMs > 0
      ? { x: dashDirectionValue.x * fighter.dashSpeed, y: dashDirectionValue.y * fighter.dashSpeed }
      : null,
    steeringScale:
      (outsidePlatform ? GAME.voidRecoverySteerMultiplier : 1) *
      (charging ? GAME.heavyChargeMoveMultiplier : 1),
    voidPull: outsidePlatform
      ? (() => {
          const normal = nearestOutwardNormal(runtime.position, vertices);
          return { x: normal.x * GAME.voidPullAcceleration, y: normal.y * GAME.voidPullAcceleration };
        })()
      : { x: 0, y: 0 }
  });

  return {
    runtime: {
      ...next,
      dashRemainingMs,
      dashCooldownRemainingMs,
      dashDirection: dashDirectionValue,
      hitstunRemainingMs,
      respawnRemainingMs: runtime.respawnRemainingMs,
      action: commitsAction && actionStart ? actionStart : runtime.action,
      heavyChargeMs,
      heavyHeld: frame.heavy,
      heavyAim
    },
    actionStart
  };
}

function blendPosition(current: Vec2, target: Vec2): Vec2 {
  const dx = target.x - current.x;
  const dy = target.y - current.y;
  if (Math.hypot(dx, dy) >= LOCAL_CORRECTION_SNAP_DISTANCE) return target;
  return { x: current.x + dx * LOCAL_CORRECTION_BLEND, y: current.y + dy * LOCAL_CORRECTION_BLEND };
}

export class PredictionBuffer {
  private readonly pending: PendingInput[] = [];
  private runtime: PredictionRuntime | null = null;
  private actionStart: MatchAction | null = null;
  private lastPresentedAttackId: number | null = null;
  private lastRollbackFrames = 0;
  private rollbackWindowFrames = 4;
  private lastHeavyInput = false;

  constructor(readonly playerId: string) {}

  predict(
    frame: InputFrame,
    player: MatchPlayer,
    elapsedMs: number,
    platformProgress = 0
  ): PlayerPresentation {
    const last = this.pending[this.pending.length - 1];
    if (!last || frame.seq > last.frame.seq) {
      this.pending.push({
        frame,
        elapsedMs,
        platformProgress,
        actionEdge: frame.quick || frame.dash || frame.heavy !== this.lastHeavyInput
      });
      this.lastHeavyInput = frame.heavy;
      this.compactPending(PENDING_INPUT_CAPACITY);
    }
    const advanced = advanceRuntime(this.runtime ?? runtimeOf(player), player, frame, elapsedMs, platformProgress);
    this.runtime = advanced.runtime;
    this.actionStart = advanced.actionStart;
    return { position: this.runtime.position, velocity: this.runtime.velocity, facing: this.runtime.facing, actionStart: this.actionStart };
  }

  reconcile(
    authoritativePlayer: MatchPlayer,
    authoritativeTick: number,
    fallbackElapsedMs: number,
    platformProgress = 0
  ): PredictionReconciliation {
    while (
      this.pending.length > 0 &&
      (this.pending[0]?.frame.seq ?? Number.POSITIVE_INFINITY) <= authoritativePlayer.lastProcessedInputSeq
    ) this.pending.shift();
    const newestPendingSequence = this.pending[this.pending.length - 1]?.frame.seq;
    const replayStartSequence = newestPendingSequence === undefined
      ? Number.POSITIVE_INFINITY
      : newestPendingSequence - this.rollbackWindowFrames + 1;
    const replayPending = this.pending.filter(({ frame }) => frame.seq >= replayStartSequence);

    let replay = runtimeOf(authoritativePlayer);
    let replayedAction: MatchAction | null = null;
    this.lastRollbackFrames = replayPending.length;
    for (const pending of replayPending) {
      const advanced = advanceRuntime(
        replay,
        authoritativePlayer,
        pending.frame,
        pending.elapsedMs || fallbackElapsedMs,
        pending.platformProgress ?? platformProgress
      );
      replay = advanced.runtime;
      replayedAction = advanced.actionStart;
    }
    const previousRuntime = this.runtime;
    const correctionDistancePx = previousRuntime
      ? Math.hypot(
          previousRuntime.position.x - replay.position.x,
          previousRuntime.position.y - replay.position.y
        )
      : 0;
    const respawnTransition = previousRuntime !== null && (
      previousRuntime.respawnRemainingMs > 0 ||
      previousRuntime.action.kind === 'RESPAWNING' ||
      authoritativePlayer.respawnRemainingMs > 0 ||
      authoritativePlayer.action.kind === 'RESPAWNING'
    );
    const hardSnap = previousRuntime !== null && (
      respawnTransition || correctionDistancePx >= LOCAL_CORRECTION_SNAP_DISTANCE
    );
    const position = previousRuntime
      ? hardSnap ? replay.position : blendPosition(previousRuntime.position, replay.position)
      : replay.position;
    this.runtime = { ...replay, position };
    const authoritativeAttackId = authoritativePlayer.action.attackId;
    if (authoritativeAttackId !== null && authoritativeAttackId !== this.lastPresentedAttackId) {
      this.lastPresentedAttackId = authoritativeAttackId;
      this.actionStart = authoritativePlayer.action;
    } else {
      this.actionStart = authoritativePlayer.action.kind === null ? replayedAction : null;
    }
    return {
      presentation: {
        position,
        velocity: replay.velocity,
        facing: replay.facing,
        actionStart: this.actionStart
      },
      result: {
        authoritativeTick,
        rollbackFrames: this.lastRollbackFrames,
        correctionDistancePx,
        hardSnap
      }
    };
  }

  setRollbackWindow(frames: number): void {
    this.rollbackWindowFrames = clamp(Math.trunc(frames), MIN_ROLLBACK_FRAMES, MAX_ROLLBACK_FRAMES);
  }

  pendingSequences(): number[] {
    return this.pending.map(({ frame }) => frame.seq);
  }

  rollbackFrames(): number {
    return this.lastRollbackFrames;
  }

  reset(player?: MatchPlayer): void {
    this.pending.length = 0;
    this.runtime = player ? runtimeOf(player) : null;
    this.actionStart = null;
    this.lastPresentedAttackId = null;
    this.lastRollbackFrames = 0;
    this.lastHeavyInput = player?.action.kind === null && player.action.chargeMs > 0;
  }

  private compactPending(capacity: number): void {
    while (this.pending.length > capacity) {
      // Action edges outrank the numeric limit; only obsolete continuous history may be removed.
      const newestSequence = this.pending[this.pending.length - 1]?.frame.seq ?? 0;
      const oldestHeavyReplaySequence = newestSequence - MAX_ROLLBACK_FRAMES + 1;
      let newestMovementIndex = -1;
      for (let index = this.pending.length - 1; index >= 0; index -= 1) {
        const candidate = this.pending[index];
        if (candidate?.actionEdge === false && !candidate.frame.heavy) {
          newestMovementIndex = index;
          break;
        }
      }
      const removableIndex = this.pending.findIndex(
        ({ actionEdge, frame }, index) =>
          !actionEdge &&
          index !== newestMovementIndex &&
          (!frame.heavy || frame.seq < oldestHeavyReplaySequence)
      );
      if (removableIndex < 0) return;
      this.pending.splice(removableIndex, 1);
    }
  }
}

export class SnapshotTimeline {
  private readonly samples: TimedSnapshot[] = [];
  private readonly policy = new AdaptiveNetcodePolicy();
  private averageIntervalMs: number | null = null;
  private jitterMs = 0;
  private delayFrames = 1;
  private rollbackFrames = 4;
  private lastTargetProgress: number | null = null;
  private lastTargetTick: number | null = null;
  private lastBufferUnderrun = false;

  push(snapshot: MatchSnapshot, receivedAtMs: number): void {
    const last = this.samples[this.samples.length - 1];
    if (last && snapshot.tick <= last.snapshot.tick) return;
    const timestamp = last ? Math.max(receivedAtMs, last.receivedAtMs) : receivedAtMs;
    if (last) this.recordArrivalInterval(timestamp - last.receivedAtMs);
    this.samples.push({ snapshot, receivedAtMs: timestamp });
    if (this.samples.length > SNAPSHOT_CAPACITY) this.samples.shift();
  }

  updateNetwork(sample: TimelineNetworkSample): void {
    const budget = this.policy.update(sample);
    this.delayFrames = budget.delayFrames;
    this.rollbackFrames = budget.rollbackFrames;
  }

  sample(renderNowMs: number): TimelineSample {
    if (this.samples.length === 0) {
      return {
        frame: null,
        targetTick: null,
        delayFrames: this.delayFrames,
        extrapolatedFrames: 0,
        bufferUnderrun: false
      };
    }
    const first = this.samples[0]!;
    const last = this.samples[this.samples.length - 1]!;
    const elapsedFrames = clamp((renderNowMs - last.receivedAtMs) / TICK_MS, 0, MAX_EXTRAPOLATION_FRAMES + this.delayFrames);
    const requestedTargetProgress = last.snapshot.tick + elapsedFrames - this.delayFrames;
    const targetProgress = this.lastTargetProgress === null
      ? requestedTargetProgress
      : Math.max(this.lastTargetProgress, requestedTargetProgress);
    this.lastTargetProgress = targetProgress;

    if (targetProgress <= first.snapshot.tick) {
      this.lastTargetTick = first.snapshot.tick;
      this.lastBufferUnderrun = false;
      return {
        frame: { previous: first.snapshot, current: first.snapshot, alpha: 1 },
        targetTick: this.lastTargetTick,
        delayFrames: this.delayFrames,
        extrapolatedFrames: 0,
        bufferUnderrun: false
      };
    }

    for (let index = 1; index < this.samples.length; index += 1) {
      const current = this.samples[index]!;
      if (targetProgress > current.snapshot.tick) continue;
      const previous = this.samples[index - 1]!;
      const tickSpan = Math.max(1, current.snapshot.tick - previous.snapshot.tick);
      this.lastTargetTick = targetProgress >= current.snapshot.tick - 0.000000001
        ? current.snapshot.tick
        : Math.max(previous.snapshot.tick, Math.floor(targetProgress));
      this.lastBufferUnderrun = false;
      return {
        frame: {
          previous: previous.snapshot,
          current: current.snapshot,
          alpha: clamp((targetProgress - previous.snapshot.tick) / tickSpan, 0, 1)
        },
        targetTick: this.lastTargetTick,
        delayFrames: this.delayFrames,
        extrapolatedFrames: 0,
        bufferUnderrun: false
      };
    }

    const canExtrapolate = last.snapshot.phase === 'REGULATION' || last.snapshot.phase === 'SUDDEN_DEATH';
    const extrapolatedFrames = canExtrapolate
      ? clamp(targetProgress - last.snapshot.tick, 0, MAX_EXTRAPOLATION_FRAMES)
      : 0;
    this.lastTargetTick = last.snapshot.tick;
    this.lastBufferUnderrun = targetProgress > last.snapshot.tick;
    return {
      frame: { previous: last.snapshot, current: last.snapshot, alpha: 1 },
      targetTick: this.lastTargetTick,
      delayFrames: this.delayFrames,
      extrapolatedFrames,
      bufferUnderrun: this.lastBufferUnderrun
    };
  }

  clear(): void {
    this.samples.length = 0;
    this.averageIntervalMs = null;
    this.jitterMs = 0;
    const budget = this.policy.reset();
    this.delayFrames = budget.delayFrames;
    this.rollbackFrames = budget.rollbackFrames;
    this.lastTargetProgress = null;
    this.lastTargetTick = null;
    this.lastBufferUnderrun = false;
  }

  delayMs(): number {
    return this.delayFrames * TICK_MS;
  }

  rollbackWindowFrames(): number {
    return this.rollbackFrames;
  }

  arrivalJitterMs(): number {
    return this.jitterMs;
  }

  bufferUnderrun(): boolean {
    return this.lastBufferUnderrun;
  }

  targetTick(): number | null {
    return this.lastTargetTick;
  }

  private recordArrivalInterval(intervalMs: number): void {
    if (this.averageIntervalMs === null) {
      this.averageIntervalMs = intervalMs;
      return;
    }
    const deviation = Math.abs(intervalMs - this.averageIntervalMs);
    this.averageIntervalMs += (intervalMs - this.averageIntervalMs) * INTERVAL_EWMA_ALPHA;
    this.jitterMs += (deviation - this.jitterMs) * JITTER_EWMA_ALPHA;
  }
}

export function interpolateRemotePlayer(
  previous: MatchPlayer,
  current: MatchPlayer,
  alpha: number,
  snapDistance = REMOTE_SNAP_DISTANCE
): Vec2 {
  const dx = current.position.x - previous.position.x;
  const dy = current.position.y - previous.position.y;
  const semanticTeleport = current.respawnRemainingMs > 0 || current.action.kind === 'RESPAWNING' ||
    previous.respawnRemainingMs > 0 || previous.action.kind === 'RESPAWNING';
  if (semanticTeleport || Math.hypot(dx, dy) >= snapDistance) return current.position;
  const progress = Math.max(0, Math.min(1, alpha));
  return { x: previous.position.x + dx * progress, y: previous.position.y + dy * progress };
}

export function extrapolateRemotePlayer(player: MatchPlayer, extrapolatedFrames: number): Vec2 {
  if (player.respawnRemainingMs > 0 || player.action.kind === 'RESPAWNING') return player.position;
  const elapsedSeconds = clamp(extrapolatedFrames, 0, MAX_EXTRAPOLATION_FRAMES) * TICK_MS / 1_000;
  return {
    x: player.position.x + player.velocity.x * elapsedSeconds,
    y: player.position.y + player.velocity.y * elapsedSeconds
  };
}
