import { GAME, ARENA } from '../../shared/constants.js';
import { FIGHTERS } from '../../shared/fighters.js';
import { advanceKinematics, normalizeAxes } from '../../shared/kinematics.js';
import type { Vec2 } from '../../shared/model.js';
import {
  distance,
  nearestEdgeNormal,
  pointInConvexPolygon,
  scale,
  separateCircles
} from './geometry.js';
import type { MatchState, MutableMatchPlayer } from './state.js';

export type PlatformGeometry = Readonly<{ vertices: readonly Vec2[] }>;

const compareStableIds = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0);

export function platformAt(progress: number): PlatformGeometry {
  const contraction = Math.max(0, Math.min(1, progress));
  return {
    vertices: ARENA.regulationVertices.map((regulation, index) => {
      const minimum = ARENA.minimumVertices[index];
      return {
        x: regulation.x + (minimum.x - regulation.x) * contraction,
        y: regulation.y + (minimum.y - regulation.y) * contraction
      };
    })
  };
}

function isActive(player: MutableMatchPlayer): boolean {
  return player.connected && player.respawnRemainingMs <= 0;
}

function dashDirection(player: MutableMatchPlayer): Vec2 {
  const movement = normalizeAxes(player.latestInput.moveX, player.latestInput.moveY);
  if (movement.x === 0 && movement.y === 0) return player.facing;
  return movement;
}

export type PulseBurstActivation = Readonly<{ playerId: string; activationId: number }>;

function startDash(state: MatchState, player: MutableMatchPlayer): PulseBurstActivation | null {
  if (
    !player.latestInput.dash ||
    player.previousDash ||
    player.dashRemainingMs > 0 ||
    player.dashCooldownRemainingMs > 0
  ) {
    return null;
  }

  const fighter = FIGHTERS[player.chassis];
  player.dashDirection = dashDirection(player);
  player.dashRemainingMs = fighter.dashDurationMs;
  player.dashInvulnerabilityRemainingMs = fighter.dashInvulnerabilityMs;
  player.dashCooldownRemainingMs = fighter.dashCooldownMs;
  player.perfectDodgeConsumed = false;
  if (player.chassis !== 'PULSE') return null;
  player.protectionRemainingMs = 0;
  return { playerId: player.playerId, activationId: state.nextAttackId++ };
}

function advanceDashTimers(player: MutableMatchPlayer, stepMs: number): void {
  const elapsedMs = Math.max(0, stepMs);
  player.dashRemainingMs = Math.max(0, player.dashRemainingMs - elapsedMs);
  player.dashInvulnerabilityRemainingMs = Math.max(0, player.dashInvulnerabilityRemainingMs - elapsedMs);
  player.dashCooldownRemainingMs = Math.max(0, player.dashCooldownRemainingMs - elapsedMs);
}

export function advancePlayers(state: MatchState, stepMs: number): readonly PulseBurstActivation[] {
  if (state.phase !== 'REGULATION' && state.phase !== 'SUDDEN_DEATH') return [];

  const platform = platformAt(state.contraction);
  const pulseBurstActivations: PulseBurstActivation[] = [];
  for (const playerId of Object.keys(state.players).sort(compareStableIds)) {
    const player = state.players[playerId];
    if (!isActive(player)) continue;

    advanceDashTimers(player, stepMs);
    const pulseBurstActivation = startDash(state, player);
    if (pulseBurstActivation) pulseBurstActivations.push(pulseBurstActivation);
    const fighter = FIGHTERS[player.chassis];
    const outsidePlatform = !pointInConvexPolygon(player.position, platform.vertices);
    const currentDashDirection = player.dashDirection;
    const next = advanceKinematics(
      { position: player.position, velocity: player.velocity, facing: player.facing },
      player.hitstunRemainingMs > 0
        ? { ...player.latestInput, moveX: 0, moveY: 0 }
        : player.latestInput,
      stepMs,
      {
        moveSpeed: fighter.moveSpeed,
        dashVelocity:
          player.dashRemainingMs > 0 ? scale(currentDashDirection, fighter.dashSpeed) : null,
        steeringScale:
          (outsidePlatform ? GAME.voidRecoverySteerMultiplier : 1) *
          (player.charging ? GAME.heavyChargeMoveMultiplier : 1),
        voidPull: outsidePlatform
          ? scale(nearestEdgeNormal(player.position, platform.vertices), GAME.voidPullAcceleration)
          : { x: 0, y: 0 }
      }
    );
    player.position = next.position;
    player.velocity = next.velocity;
    player.facing = next.facing;
    player.previousDash = player.latestInput.dash;
  }
  return pulseBurstActivations;
}

export function separateActivePlayers(state: MatchState): void {
  const playerIds = Object.keys(state.players)
    .filter((playerId) => isActive(state.players[playerId]))
    .sort(compareStableIds);

  for (let pass = 0; pass < 2; pass += 1) {
    const positions = Object.fromEntries(playerIds.map((playerId) => [playerId, state.players[playerId].position]));
    const corrections = Object.fromEntries(playerIds.map((playerId) => [playerId, { x: 0, y: 0 }]));
    for (let leftIndex = 0; leftIndex < playerIds.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < playerIds.length; rightIndex += 1) {
        const leftId = playerIds[leftIndex];
        const rightId = playerIds[rightIndex];
        const left = positions[leftId];
        const right = positions[rightId];
        const separated = separateCircles(left, right, GAME.collisionRadius);
        corrections[leftId].x += separated.left.x - left.x;
        corrections[leftId].y += separated.left.y - left.y;
        corrections[rightId].x += separated.right.x - right.x;
        corrections[rightId].y += separated.right.y - right.y;
      }
    }
    for (const playerId of playerIds) {
      state.players[playerId].position = {
        x: positions[playerId].x + corrections[playerId].x,
        y: positions[playerId].y + corrections[playerId].y
      };
    }
  }
}

export function chooseSafestSpawn(state: MatchState, playerId: string): Vec2 {
  const opponents = Object.values(state.players).filter(
    (player) => player.playerId !== playerId && isActive(player)
  );
  let safest = ARENA.spawnAnchors[0];
  let greatestMinimumDistance = Number.NEGATIVE_INFINITY;

  for (const anchor of ARENA.spawnAnchors) {
    const minimumDistance = opponents.length === 0
      ? Number.POSITIVE_INFINITY
      : Math.min(...opponents.map((opponent) => distance(anchor, opponent.position)));
    if (minimumDistance > greatestMinimumDistance) {
      safest = anchor;
      greatestMinimumDistance = minimumDistance;
    }
  }

  return { ...safest };
}
