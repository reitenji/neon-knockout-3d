import {
  buildAttackCapsule,
  capsuleIntersectsCircle,
  capsulesIntersect,
  nearestCircleBoundaryPointToCapsule,
  type SweptCapsule
} from '../../shared/combat/geometry.js';
import { profileForAttack, type AttackProfile } from '../../shared/combat/profiles.js';
import { GAME } from '../../shared/constants.js';
import { FIGHTERS } from '../../shared/fighters.js';
import type { AttackKind, GameEvent } from '../../shared/model.js';
import { clamp, normalize, subtract } from './geometry.js';
import type { AttackRuntime, MatchState, MutableMatchPlayer } from './state.js';
import { removePulse } from './projectiles.js';
import type { CombatFrameHistory } from './CombatFrameHistory.js';
import type { PulseBurstActivation } from './movement.js';

export type ActiveAttackShape = Readonly<{
  playerId: string;
  attackId: number;
  kind: AttackKind;
  capsule: SweptCapsule;
}>;

export type ActiveAttackSlice = Readonly<{
  playerId: string;
  attack: AttackRuntime;
  previousProgress: number;
  currentProgress: number;
  enteredActive: boolean;
}>;

const shapeRuntimeAssociations = new WeakMap<
  ActiveAttackShape,
  Readonly<{ state: MatchState; tick: number; attack: AttackRuntime }>
>();
const canceledAttacks = new WeakSet<AttackRuntime>();

export function buildActiveAttackShapes(
  state: MatchState,
  slices: readonly ActiveAttackSlice[]
): readonly ActiveAttackShape[] {
  return slices.map((slice) => {
    const shape: ActiveAttackShape = {
      playerId: slice.playerId,
      attackId: slice.attack.attackId,
      kind: slice.attack.kind,
      capsule: buildAttackCapsule(
        state.players[slice.playerId].position,
        slice.attack.lockedFacing,
        profileForAttack(slice.attack.kind),
        slice.previousProgress,
        slice.currentProgress
      )
    };
    shapeRuntimeAssociations.set(shape, { state, tick: state.tick, attack: slice.attack });
    return shape;
  });
}

const compareStableIds = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;
const QUICK_ONE_PROFILE = profileForAttack('QUICK_1');
const HEAVY_PROFILE = profileForAttack('HEAVY');
const QUICK_ONE_OVERLOAD = chargedValue(QUICK_ONE_PROFILE.overloadGain, 0);
const MIN_EFFECTIVE_IMPULSE = chargedValue(QUICK_ONE_PROFILE.baseImpulse, 0) *
  overloadMultiplier(QUICK_ONE_OVERLOAD);
const MAX_EFFECTIVE_IMPULSE = chargedValue(HEAVY_PROFILE.baseImpulse, GAME.heavyMaxChargeMs) *
  overloadMultiplier(GAME.maxOverload);

function activePlayer(player: MutableMatchPlayer): boolean {
  return player.connected && player.respawnRemainingMs <= 0;
}

function runtimeForShape(
  state: MatchState,
  shape: ActiveAttackShape
): Readonly<{ player: MutableMatchPlayer; attack: AttackRuntime }> | null {
  const player = state.players[shape.playerId];
  if (!player || !activePlayer(player)) return null;
  const association = shapeRuntimeAssociations.get(shape);
  if (association) {
    if (association.state !== state || association.tick !== state.tick ||
      association.attack.attackId !== shape.attackId || association.attack.kind !== shape.kind) {
      return null;
    }
    return { player, attack: association.attack };
  }
  if (player.attack?.attackId !== shape.attackId || player.attack.kind !== shape.kind) return null;
  return { player, attack: player.attack };
}

function shapeMidpoint(shape: ActiveAttackShape): Readonly<{ x: number; y: number }> {
  return {
    x: (shape.capsule.from.x + shape.capsule.to.x) / 2,
    y: (shape.capsule.from.y + shape.capsule.to.y) / 2
  };
}

function clashImpact(left: ActiveAttackShape, right: ActiveAttackShape): Readonly<{ x: number; y: number }> {
  const leftMidpoint = shapeMidpoint(left);
  const rightMidpoint = shapeMidpoint(right);
  return {
    x: (leftMidpoint.x + rightMidpoint.x) / 2,
    y: (leftMidpoint.y + rightMidpoint.y) / 2
  };
}

function moveToRecovery(player: MutableMatchPlayer, attack: AttackRuntime): void {
  if (attack.phase === 'RECOVERY') return;
  attack.phase = 'RECOVERY';
  attack.phaseRemainingMs = profileForAttack(attack.kind).recoveryMs;
  attack.phaseElapsedMs = 0;
  attack.previousActiveProgress = 1;
  player.stats.completedAttacks += 1;
}

function applyOppositeRecoil(left: MutableMatchPlayer, right: MutableMatchPlayer, amount: number): void {
  const fallback = compareStableIds(left.playerId, right.playerId) <= 0
    ? { x: 1, y: 0 }
    : { x: -1, y: 0 };
  const direction = normalize(subtract(right.position, left.position), fallback);
  left.velocity = {
    x: left.velocity.x - direction.x * amount,
    y: left.velocity.y - direction.y * amount
  };
  right.velocity = {
    x: right.velocity.x + direction.x * amount,
    y: right.velocity.y + direction.y * amount
  };
}

function chargedValue(
  value: number | Readonly<{ minimum: number; maximum: number }>,
  chargeMs: number
): number {
  if (typeof value === 'number') return value;
  const progress = clamp(chargeMs / GAME.heavyMaxChargeMs, 0, 1);
  return value.minimum + (value.maximum - value.minimum) * progress;
}

function overloadMultiplier(overload: number): number {
  return 1 + clamp(overload, 0, GAME.maxOverload) / 100;
}

function attackEffects(profile: AttackProfile, attack: AttackRuntime): Readonly<{
  overloadGain: number;
  baseImpulse: number;
}> {
  return {
    overloadGain: chargedValue(profile.overloadGain, attack.chargeMs),
    baseImpulse: chargedValue(profile.baseImpulse, attack.chargeMs)
  };
}

function hitstunFor(impulse: number): number {
  const progress = clamp(
    (impulse - MIN_EFFECTIVE_IMPULSE) / (MAX_EFFECTIVE_IMPULSE - MIN_EFFECTIVE_IMPULSE),
    0,
    1
  );
  return 90 + progress * 140;
}

function orderedAttackShapes(shapes: readonly ActiveAttackShape[]): ActiveAttackShape[] {
  return [...shapes].sort((left, right) =>
    left.attackId - right.attackId || compareStableIds(left.playerId, right.playerId));
}

function pulseCapsule(state: MatchState, projectileId: number): SweptCapsule | null {
  const pulse = state.pulses[projectileId];
  return pulse ? { from: pulse.previousPosition, to: pulse.position, radius: pulse.radius } : null;
}

export function resolveClashesAndPulseBreaks(
  state: MatchState,
  shapes: readonly ActiveAttackShape[]
): readonly GameEvent[] {
  const events: GameEvent[] = [];
  const canceledAttackIds = new Set<number>();
  const orderedShapes = orderedAttackShapes(shapes);

  for (let leftIndex = 0; leftIndex < orderedShapes.length; leftIndex += 1) {
    const leftShape = orderedShapes[leftIndex];
    const leftRuntime = runtimeForShape(state, leftShape);
    if (!leftRuntime || canceledAttackIds.has(leftShape.attackId)) continue;

    for (let rightIndex = leftIndex + 1; rightIndex < orderedShapes.length; rightIndex += 1) {
      const rightShape = orderedShapes[rightIndex];
      if (leftShape.playerId === rightShape.playerId || canceledAttackIds.has(rightShape.attackId)) continue;
      const rightRuntime = runtimeForShape(state, rightShape);
      if (!rightRuntime ||
        leftRuntime.attack.resolvedPlayerIds.has(rightShape.playerId) ||
        rightRuntime.attack.resolvedPlayerIds.has(leftShape.playerId) ||
        !capsulesIntersect(leftShape.capsule, rightShape.capsule)) {
        continue;
      }

      leftRuntime.attack.resolvedPlayerIds.add(rightShape.playerId);
      rightRuntime.attack.resolvedPlayerIds.add(leftShape.playerId);
      const leftHeavy = leftShape.kind === 'HEAVY';
      const rightHeavy = rightShape.kind === 'HEAVY';
      const strength = leftHeavy || rightHeavy ? 'HEAVY' : 'QUICK';

      if (leftHeavy === rightHeavy) {
        moveToRecovery(leftRuntime.player, leftRuntime.attack);
        moveToRecovery(rightRuntime.player, rightRuntime.attack);
        canceledAttacks.add(leftRuntime.attack);
        canceledAttacks.add(rightRuntime.attack);
        canceledAttackIds.add(leftShape.attackId);
        canceledAttackIds.add(rightShape.attackId);
        applyOppositeRecoil(
          leftRuntime.player,
          rightRuntime.player,
          leftHeavy ? GAME.heavyClashRecoil : GAME.quickClashRecoil
        );
      } else {
        const quickShape = leftHeavy ? rightShape : leftShape;
        const quickRuntime = leftHeavy ? rightRuntime : leftRuntime;
        moveToRecovery(quickRuntime.player, quickRuntime.attack);
        canceledAttacks.add(quickRuntime.attack);
        canceledAttackIds.add(quickShape.attackId);
      }

      events.push({
        type: 'CLASH',
        eventId: state.nextEventId++,
        tick: state.tick,
        playerIds: [leftShape.playerId, rightShape.playerId],
        attackIds: [leftShape.attackId, rightShape.attackId],
        impactPosition: clashImpact(leftShape, rightShape),
        strength
      });
      if (canceledAttackIds.has(leftShape.attackId)) break;
    }
  }

  for (const projectileId of Object.keys(state.pulses).map(Number).sort((left, right) => left - right)) {
    const pulse = state.pulses[projectileId];
    const capsule = pulseCapsule(state, projectileId);
    if (!pulse || !capsule) continue;
    const breaker = orderedShapes.find((shape) => {
      if (shape.playerId === pulse.ownerPlayerId || canceledAttackIds.has(shape.attackId)) return false;
      const runtime = runtimeForShape(state, shape);
      return Boolean(runtime && !canceledAttacks.has(runtime.attack) && capsulesIntersect(shape.capsule, capsule));
    });
    if (!breaker) continue;
    removePulse(state, projectileId);
    events.push({
      type: 'PULSE_BREAK',
      eventId: state.nextEventId++,
      tick: state.tick,
      projectileId,
      breakerPlayerId: breaker.playerId,
      breakerAttackId: breaker.attackId,
      impactPosition: { ...pulse.position }
    });
  }

  return events;
}

type DodgeEventData = Omit<Extract<GameEvent, { type: 'PERFECT_DODGE' }>, 'eventId' | 'tick'>;
type HitEventData = Omit<Extract<GameEvent, { type: 'HIT' }>, 'eventId' | 'tick'>;

function applyPerfectDodge(
  target: MutableMatchPlayer,
  data: DodgeEventData,
  dodges: DodgeEventData[]
): void {
  if (target.perfectDodgeConsumed) return;
  target.dashCooldownRemainingMs = Math.max(0, target.dashCooldownRemainingMs - GAME.perfectDodgeRefundMs);
  target.perfectDodgeConsumed = true;
  dodges.push(data);
}

function applyHit(
  state: MatchState,
  attacker: MutableMatchPlayer,
  target: MutableMatchPlayer,
  attack: AttackRuntime | null,
  impactPosition: Readonly<{ x: number; y: number }>,
  pulseDirection: Readonly<{ x: number; y: number }> | null,
  overloadGain: number,
  baseImpulse: number,
  hits: HitEventData[]
): void {
  const hitPlayerIds = attack?.hitPlayerIds;
  const firstLandedTarget = hitPlayerIds ? hitPlayerIds.size === 0 : false;
  if (hitPlayerIds) hitPlayerIds.add(target.playerId);
  if (firstLandedTarget) attacker.stats.landedHits += 1;
  target.overload = Math.min(GAME.maxOverload, target.overload + overloadGain);
  const knockbackMultiplier = target.chassis === 'BASTION' && target.dashRemainingMs > 0
    ? FIGHTERS.BASTION.armoredDashKnockbackMultiplier
    : FIGHTERS[target.chassis].knockbackMultiplier;
  const impulse = baseImpulse * overloadMultiplier(target.overload) * knockbackMultiplier;
  const direction = pulseDirection ?? normalize(attack?.lockedFacing ?? { x: 1, y: 0 }, { x: 1, y: 0 });
  target.velocity = {
    x: target.velocity.x + direction.x * impulse,
    y: target.velocity.y + direction.y * impulse
  };
  target.hitstunRemainingMs = Math.max(target.hitstunRemainingMs, hitstunFor(impulse));
  target.lastAttackerId = attacker.playerId;
  target.lastAttackerAtMs = state.nowMs;
  target.chargeMs = 0;
  target.charging = false;
  hits.push({
    type: 'HIT',
    attackerId: attacker.playerId,
    targetId: target.playerId,
    attack: attack?.kind ?? 'NEON_PULSE',
    impactPosition: { ...impactPosition },
    impulse,
    resultingOverload: target.overload
  });
}

export function resolvePulseBurstActivations(
  state: MatchState,
  activations: readonly PulseBurstActivation[]
): readonly GameEvent[] {
  const dodges: DodgeEventData[] = [];
  const hits: HitEventData[] = [];

  for (const activation of [...activations].sort((left, right) =>
    left.activationId - right.activationId || compareStableIds(left.playerId, right.playerId))) {
    const attacker = state.players[activation.playerId];
    if (!attacker || !activePlayer(attacker) || attacker.chassis !== 'PULSE') continue;
    const fighter = FIGHTERS.PULSE;
    let credited = false;
    const targets = Object.values(state.players)
      .filter((target) => target.playerId !== attacker.playerId && activePlayer(target) &&
        target.protectionRemainingMs <= 0 &&
        Math.hypot(target.position.x - attacker.position.x, target.position.y - attacker.position.y) <= fighter.burstRadius)
      .sort((left, right) => compareStableIds(left.playerId, right.playerId));

    for (const target of targets) {
      const direction = normalize(subtract(target.position, attacker.position), { x: 1, y: 0 });
      const impactPosition = {
        x: target.position.x - direction.x * GAME.collisionRadius,
        y: target.position.y - direction.y * GAME.collisionRadius
      };
      if (target.dashInvulnerabilityRemainingMs > 0) {
        applyPerfectDodge(target, {
          type: 'PERFECT_DODGE',
          playerId: target.playerId,
          attackerId: attacker.playerId,
          attackId: activation.activationId,
          source: 'NEON_PULSE',
          projectileId: null,
          impactPosition: { ...target.position },
          refundedMs: GAME.perfectDodgeRefundMs
        }, dodges);
        continue;
      }
      if (!credited) {
        attacker.stats.landedHits += 1;
        credited = true;
      }
      applyHit(
        state,
        attacker,
        target,
        null,
        impactPosition,
        direction,
        fighter.burstOverloadGain,
        fighter.burstBaseImpulse,
        hits
      );
    }
  }

  return [
    ...dodges.map((event) => ({ ...event, eventId: state.nextEventId++, tick: state.tick })),
    ...hits.map((event) => ({ ...event, eventId: state.nextEventId++, tick: state.tick }))
  ];
}

function pulseTravelParameter(
  from: Readonly<{ x: number; y: number }>,
  to: Readonly<{ x: number; y: number }>,
  center: Readonly<{ x: number; y: number }>,
  radius: number
): number {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) return 0;
  const offsetX = from.x - center.x;
  const offsetY = from.y - center.y;
  const projection = offsetX * dx + offsetY * dy;
  const discriminant = projection * projection - lengthSquared *
    (offsetX * offsetX + offsetY * offsetY - radius * radius);
  if (discriminant < 0) return clamp(-projection / lengthSquared, 0, 1);
  return clamp((-projection - Math.sqrt(discriminant)) / lengthSquared, 0, 1);
}

export function resolveSurvivingContacts(
  state: MatchState,
  shapes: readonly ActiveAttackShape[],
  history?: CombatFrameHistory
): readonly GameEvent[] {
  const dodges: DodgeEventData[] = [];
  const hits: HitEventData[] = [];
  const orderedShapes = orderedAttackShapes(shapes);

  for (const shape of orderedShapes) {
    const runtime = runtimeForShape(state, shape);
    if (!runtime || canceledAttacks.has(runtime.attack)) continue;
    const { player: attacker, attack } = runtime;
    const profile = profileForAttack(attack.kind);
    const effects = attackEffects(profile, attack);
    const historicalFrame = history?.get(attack.viewTick);
    const targets = Object.values(state.players)
      .map((target) => {
        if (target.playerId === attacker.playerId ||
          !activePlayer(target) ||
          target.protectionRemainingMs > 0 ||
          attack.resolvedPlayerIds.has(target.playerId) ||
          attack.hitPlayerIds.has(target.playerId)) {
          return null;
        }
        const currentCircle = {
          center: target.position,
          radius: GAME.collisionRadius
        };
        if (capsuleIntersectsCircle(shape.capsule, currentCircle)) {
          return { target, circle: currentCircle, currentContact: true };
        }
        const historical = historicalFrame?.players[target.playerId];
        if (!historical || !historical.connected || historical.respawning || historical.protected ||
          historical.dashInvulnerable || target.dashInvulnerabilityRemainingMs > 0) {
          return null;
        }
        const historicalCircle = {
          center: historical.position,
          radius: historical.collisionRadius
        };
        return capsuleIntersectsCircle(shape.capsule, historicalCircle)
          ? { target, circle: historicalCircle, currentContact: false }
          : null;
      })
      .filter((contact): contact is NonNullable<typeof contact> => contact !== null)
      .sort((left, right) => compareStableIds(left.target.playerId, right.target.playerId));

    for (const { target, circle, currentContact } of targets) {
      attack.resolvedPlayerIds.add(target.playerId);
      const impactPosition = nearestCircleBoundaryPointToCapsule(shape.capsule, circle);
      if (currentContact && target.dashInvulnerabilityRemainingMs > 0) {
        applyPerfectDodge(target, {
          type: 'PERFECT_DODGE',
          playerId: target.playerId,
          attackerId: attacker.playerId,
          attackId: attack.attackId,
          source: attack.kind,
          projectileId: null,
          impactPosition: { ...target.position },
          refundedMs: GAME.perfectDodgeRefundMs
        }, dodges);
        continue;
      }

      applyHit(state, attacker, target, attack, impactPosition, null, effects.overloadGain, effects.baseImpulse, hits);
    }
  }

  for (const projectileId of Object.keys(state.pulses).map(Number).sort((left, right) => left - right)) {
    const pulse = state.pulses[projectileId];
    if (!pulse) continue;
    const attacker = state.players[pulse.ownerPlayerId];
    if (!attacker) {
      removePulse(state, projectileId);
      continue;
    }
    const capsule = { from: pulse.previousPosition, to: pulse.position, radius: pulse.radius };
    const target = Object.values(state.players)
      .filter((candidate) =>
        candidate.playerId !== pulse.ownerPlayerId &&
        activePlayer(candidate) &&
        candidate.protectionRemainingMs <= 0 &&
        !pulse.hitPlayerIds.has(candidate.playerId) &&
        capsuleIntersectsCircle(capsule, { center: candidate.position, radius: GAME.collisionRadius }))
      .map((candidate) => ({
        candidate,
        travelParameter: pulseTravelParameter(
          pulse.previousPosition,
          pulse.position,
          candidate.position,
          pulse.radius + GAME.collisionRadius
        )
      }))
      .sort((left, right) => left.travelParameter - right.travelParameter ||
        compareStableIds(left.candidate.playerId, right.candidate.playerId))[0]?.candidate;
    if (!target) continue;

    removePulse(state, projectileId);
    const impactPosition = nearestCircleBoundaryPointToCapsule(capsule, {
      center: target.position,
      radius: GAME.collisionRadius
    });
    if (target.dashInvulnerabilityRemainingMs > 0) {
      applyPerfectDodge(target, {
        type: 'PERFECT_DODGE',
        playerId: target.playerId,
        attackerId: attacker.playerId,
        attackId: pulse.originatingAttackId,
        source: 'NEON_PULSE',
        projectileId,
        impactPosition: { ...target.position },
        refundedMs: GAME.perfectDodgeRefundMs
      }, dodges);
      continue;
    }

    const firstLandedTarget = pulse.hitPlayerIds.size === 0;
    pulse.hitPlayerIds.add(target.playerId);
    if (firstLandedTarget) attacker.stats.landedHits += 1;
    applyHit(
      state,
      attacker,
      target,
      null,
      impactPosition,
      normalize(pulse.velocity, { x: 1, y: 0 }),
      GAME.pulseOverloadGain,
      GAME.pulseBaseImpulse,
      hits
    );
  }

  for (const pulse of Object.values(state.pulses)) {
    if (pulse.remainingMs === 0) removePulse(state, pulse.projectileId);
  }

  return [
    ...dodges.map((event) => ({ ...event, eventId: state.nextEventId++, tick: state.tick })),
    ...hits.map((event) => ({ ...event, eventId: state.nextEventId++, tick: state.tick }))
  ];
}

export function resolveMeleeInteractions(
  state: MatchState,
  shapes: readonly ActiveAttackShape[],
  history?: CombatFrameHistory
): readonly GameEvent[] {
  return [
    ...resolveClashesAndPulseBreaks(state, shapes),
    ...resolveSurvivingContacts(state, shapes, history)
  ];
}
