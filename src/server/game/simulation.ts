import { GAME } from '../../shared/constants.js';
import { profileForAttack } from '../../shared/combat/profiles.js';
import { normalizeAim, normalizeAxes } from '../../shared/kinematics.js';
import { matchTimingFor } from '../../shared/roomSettings.js';
import type { GameEvent, InputFrame, MatchPhase, MatchPlayer, MatchSnapshot, PlayerNetworkStatus, Vec2 } from '../../shared/model.js';
import { advanceCombatTimers, startActions } from './combat.js';
import {
  buildActiveAttackShapes,
  resolveClashesAndPulseBreaks,
  resolvePulseBurstActivations,
  resolveSurvivingContacts,
  type ActiveAttackSlice
} from './combatResolution.js';
import { clamp, isKnockedOut, platformExitPoint } from './geometry.js';
import { advancePlayers, chooseSafestSpawn, platformAt, separateActivePlayers } from './movement.js';
import { advancePulses, clearPulses, spawnNeonPulse } from './projectiles.js';
import { createEmptyInput, type MatchState, type MutableMatchPlayer } from './state.js';
import type { CombatFrameHistory } from './CombatFrameHistory.js';

const compareStableIds = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;

function eventMetadata(state: MatchState): Readonly<{ eventId: number; tick: number }> {
  return { eventId: state.nextEventId++, tick: state.tick };
}

function phaseRemaining(state: MatchState): number {
  return state.phase === 'COUNTDOWN' ? state.countdownRemainingMs : state.remainingMs;
}

function phaseEvent(state: MatchState, phase: MatchPhase): GameEvent {
  return { type: 'PHASE', ...eventMetadata(state), phase, remainingMs: phaseRemaining(state) };
}

function isFiniteInput(input: InputFrame): boolean {
  return Number.isSafeInteger(input.seq) &&
    Number.isFinite(input.moveX) && Number.isFinite(input.moveY) &&
    Number.isFinite(input.aimX) && Number.isFinite(input.aimY);
}

function acceptInputs(state: MatchState, inputs: ReadonlyMap<string, InputFrame>): void {
  for (const playerId of Object.keys(state.players).sort(compareStableIds)) {
    const player = state.players[playerId];
    const input = inputs.get(playerId);
    if (!player.connected || !input || !isFiniteInput(input) || input.seq <= player.lastProcessedInputSeq) continue;
    const movement = normalizeAxes(input.moveX, input.moveY);
    const facing = normalizeAim(input.aimX, input.aimY, player.facing);
    player.latestInput = {
      ...input,
      moveX: movement.x,
      moveY: movement.y,
      aimX: facing.x,
      aimY: facing.y
    };
    player.lastProcessedInputSeq = input.seq;
  }
}

function advanceMatchClocks(state: MatchState, stepMs: number, events: GameEvent[]): void {
  const elapsedMs = Math.max(0, stepMs);
  state.nowMs += elapsedMs;
  if (state.phase === 'COUNTDOWN') {
    state.countdownRemainingMs = Math.max(0, state.countdownRemainingMs - elapsedMs);
    if (state.countdownRemainingMs === 0) {
      state.phase = 'REGULATION';
      events.push(phaseEvent(state, 'REGULATION'));
    }
  } else if (state.phase === 'REGULATION') {
    state.remainingMs = Math.max(0, state.remainingMs - elapsedMs);
  }
}

function respawnPlayer(state: MatchState, player: MutableMatchPlayer, events: GameEvent[]): void {
  player.position = chooseSafestSpawn(state, player.playerId);
  player.velocity = { x: 0, y: 0 };
  player.hitstunRemainingMs = 0;
  player.dashRemainingMs = 0;
  player.dashInvulnerabilityRemainingMs = 0;
  player.attack = null;
  player.comboStep = 0;
  player.chargeMs = 0;
  player.charging = false;
  player.perfectDodgeConsumed = false;
  player.bufferedQuick = false;
  player.lastAttackerId = null;
  player.lastAttackerAtMs = null;
  if (player.resetOverloadOnRespawn) player.overload = 0;
  player.resetOverloadOnRespawn = false;
  player.protectionRemainingMs = GAME.respawnProtectionMs;
  events.push({ type: 'RESPAWN', ...eventMetadata(state), playerId: player.playerId, position: { ...player.position } });
}

function advanceRespawns(
  state: MatchState,
  stepMs: number,
  events: GameEvent[],
  knockoutEvents: readonly GameEvent[]
): void {
  const elapsedMs = Math.max(0, stepMs);
  const newlyKnockedOut = new Set(knockoutEvents
    .filter((event): event is Extract<GameEvent, { type: 'KNOCKOUT' }> => event.type === 'KNOCKOUT')
    .map((event) => event.targetId));
  for (const playerId of Object.keys(state.players).sort(compareStableIds)) {
    const player = state.players[playerId];
    if (!player.connected || player.respawnRemainingMs <= 0 || newlyKnockedOut.has(playerId)) continue;
    player.respawnRemainingMs = Math.max(0, player.respawnRemainingMs - elapsedMs);
    if (player.respawnRemainingMs === 0) respawnPlayer(state, player, events);
  }
}

function updateContraction(state: MatchState): void {
  if (state.phase === 'SUDDEN_DEATH') {
    state.contraction = 1;
    return;
  }
  const timing = matchTimingFor(state.settings.durationMs);
  state.contraction = clamp(
    (timing.contractionStartRemainingMs - state.remainingMs) /
      (timing.contractionStartRemainingMs - timing.contractionMinimumRemainingMs),
    0,
    1
  );
}

function recentAttacker(
  state: MatchState,
  target: MutableMatchPlayer,
  knockedOutPlayerIds: ReadonlySet<string>
): string | null {
  if (!target.lastAttackerId || target.lastAttackerAtMs === null) return null;
  if (state.nowMs - target.lastAttackerAtMs > 4_000) return null;
  const attacker = state.players[target.lastAttackerId];
  return attacker && attacker.playerId !== target.playerId && attacker.respawnRemainingMs <= 0 &&
    !knockedOutPlayerIds.has(attacker.playerId)
    ? attacker.playerId
    : null;
}

function knockoutTransition(
  state: MatchState,
  targetId: string,
  forcedAttackerId?: string,
  knockedOutPlayerIds: ReadonlySet<string> = new Set()
): readonly GameEvent[] {
  const target = state.players[targetId];
  if (!target || !target.connected || target.respawnRemainingMs > 0 || state.phase === 'FINISHED') return [];
  const forcedPlayer = forcedAttackerId ? state.players[forcedAttackerId] : undefined;
  const forced = forcedAttackerId && forcedAttackerId !== targetId && forcedPlayer &&
    forcedPlayer.respawnRemainingMs <= 0 && !knockedOutPlayerIds.has(forcedAttackerId)
    ? forcedAttackerId
    : null;
  const credited = forced ?? recentAttacker(state, target, knockedOutPlayerIds);
  target.stats.falls += 1;
  if (credited) {
    state.scores[credited] += 1;
    state.players[credited].stats.knockouts += 1;
  }
  target.respawnRemainingMs = GAME.knockoutToControlMs;
  target.resetOverloadOnRespawn = true;
  target.protectionRemainingMs = 0;
  target.velocity = { x: 0, y: 0 };
  target.hitstunRemainingMs = 0;
  target.attack = null;
  target.comboStep = 0;
  target.chargeMs = 0;
  target.charging = false;
  target.bufferedQuick = false;
  target.latestInput = { ...target.latestInput, quick: false, heavy: false, dash: false };
  return [{
    type: 'KNOCKOUT',
    ...eventMetadata(state),
    attackerId: credited,
    targetId,
    scoreAwardedTo: credited,
    scores: { ...state.scores }
  }];
}

function resolveBoundaries(state: MatchState, previousPositions: Readonly<Record<string, Vec2>>): readonly GameEvent[] {
  const events: GameEvent[] = [];
  const platform = platformAt(state.contraction);
  const knockedOutPlayerIds = new Set<string>();
  for (const playerId of Object.keys(state.players).sort(compareStableIds)) {
    const player = state.players[playerId];
    if (player.connected && player.respawnRemainingMs <= 0 &&
      isKnockedOut(player.position, platform, GAME.knockoutDistance)) {
      player.position = platformExitPoint(previousPositions[playerId], player.position, platform.vertices);
      const knockoutEvents = knockoutTransition(state, playerId, undefined, knockedOutPlayerIds);
      if (knockoutEvents.length === 0) continue;
      events.push(...knockoutEvents);
      knockedOutPlayerIds.add(playerId);
    }
  }
  return events;
}

function finishMatch(state: MatchState, winnerPlayerId: string | null, reason: 'TARGET_SCORE' | 'TIME' | 'SUDDEN_DEATH' | 'NO_CONTEST'): GameEvent {
  state.phase = 'FINISHED';
  state.winnerPlayerId = winnerPlayerId;
  state.resultReason = reason;
  clearPulses(state);
  return { type: 'RESULT', ...eventMetadata(state), winnerPlayerId, reason, scores: { ...state.scores } };
}

function spawnActivatedPulses(
  state: MatchState,
  activated: readonly ActiveAttackSlice[],
  events: GameEvent[]
): void {
  for (const slice of [...activated].sort((left, right) =>
    left.attack.attackId - right.attack.attackId || compareStableIds(left.playerId, right.playerId))) {
    const owner = state.players[slice.playerId];
    if (!owner || !owner.connected || owner.respawnRemainingMs > 0) continue;
    const spawned = spawnNeonPulse(state, owner, slice.attack);
    if (spawned) events.push(spawned.event);
  }
}

function uniqueLeader(state: MatchState): string | null {
  const ranked = Object.keys(state.scores).sort((left, right) =>
    state.scores[right] - state.scores[left] || compareStableIds(left, right));
  if (ranked.length === 0 || (ranked[1] && state.scores[ranked[0]] === state.scores[ranked[1]])) return null;
  return ranked[0];
}

function evaluateScoringResult(state: MatchState): readonly GameEvent[] {
  if (state.phase === 'FINISHED') return [];
  const targetWinner = Object.keys(state.scores)
    .filter((playerId) => state.scores[playerId] >= state.settings.knockoutTarget)
    .sort((left, right) => state.scores[right] - state.scores[left] || compareStableIds(left, right))[0];
  if (targetWinner) return [finishMatch(state, targetWinner, 'TARGET_SCORE')];
  if (state.phase === 'SUDDEN_DEATH') {
    const winner = uniqueLeader(state);
    if (winner) return [finishMatch(state, winner, 'SUDDEN_DEATH')];
  }
  return [];
}

function evaluateResult(state: MatchState): readonly GameEvent[] {
  const scoringResult = evaluateScoringResult(state);
  if (scoringResult.length > 0) return scoringResult;
  if (state.phase === 'REGULATION' && state.remainingMs === 0) {
    const winner = uniqueLeader(state);
    if (winner) return [finishMatch(state, winner, 'TIME')];
    state.phase = 'SUDDEN_DEATH';
    state.contraction = 1;
    return [phaseEvent(state, 'SUDDEN_DEATH')];
  }
  return [];
}

export function stepMatch(
  state: MatchState,
  inputs: ReadonlyMap<string, InputFrame>,
  stepMs: number,
  combatHistory?: CombatFrameHistory
): readonly GameEvent[] {
  if (state.phase === 'FINISHED') return [];
  if (state.phase === 'PAUSED') {
    if (state.pauseRemainingMs !== null) {
      state.pauseRemainingMs = Math.max(0, state.pauseRemainingMs - Math.max(0, stepMs));
      if (state.pauseRemainingMs === 0) return [finishMatch(state, null, 'NO_CONTEST')];
    }
    return [];
  }

  const activeAtStart = state.phase === 'REGULATION' || state.phase === 'SUDDEN_DEATH';
  const events: GameEvent[] = [];
  state.tick += 1;
  acceptInputs(state, inputs);
  const combatStep = advanceCombatTimers(state, stepMs);
  advanceMatchClocks(state, stepMs, events);
  updateContraction(state);
  if (!activeAtStart) return events;
  const previousPositions = Object.fromEntries(Object.values(state.players).map((player) => [player.playerId, { ...player.position }]));
  startActions(state, stepMs);
  const pulseBurstActivations = advancePlayers(state, stepMs);
  separateActivePlayers(state);
  events.push(...resolvePulseBurstActivations(state, pulseBurstActivations));
  spawnActivatedPulses(state, combatStep.activated, events);
  advancePulses(state, stepMs);
  const shapes = buildActiveAttackShapes(state, combatStep.activeSlices);
  events.push(...resolveClashesAndPulseBreaks(state, shapes));
  events.push(...resolveSurvivingContacts(state, shapes, combatHistory));
  const knockoutEvents = resolveBoundaries(state, previousPositions);
  events.push(...knockoutEvents);
  advanceRespawns(state, stepMs, events, knockoutEvents);
  events.push(...evaluateResult(state));
  return events;
}

function snapshotPlayer(player: MutableMatchPlayer): MatchPlayer {
  const action = player.respawnRemainingMs > 0
    ? { kind: 'RESPAWNING' as const, phase: 'IDLE' as const }
    : player.hitstunRemainingMs > 0
      ? { kind: 'HITSTUN' as const, phase: 'IDLE' as const }
      : player.dashRemainingMs > 0
        ? { kind: 'DASH' as const, phase: 'IDLE' as const }
        : player.attack
          ? { kind: player.attack.kind, phase: player.attack.phase }
          : { kind: null, phase: 'IDLE' as const };
  const serializedAttack = player.attack && action.kind === player.attack.kind ? player.attack : null;
  return {
    playerId: player.playerId,
    name: player.name,
    chassis: player.chassis,
    accent: player.accent,
    position: { ...player.position },
    velocity: { ...player.velocity },
    facing: { ...player.facing },
    overload: player.overload,
    lastProcessedInputSeq: player.lastProcessedInputSeq,
    action: {
      ...action,
      comboStep: player.comboStep,
      chargeMs: serializedAttack?.kind === 'HEAVY' ? serializedAttack.chargeMs : player.chargeMs,
      charging: action.kind === null && player.charging,
      attackId: serializedAttack?.attackId ?? null,
      profileId: serializedAttack?.profileId ?? null,
      lockedFacing: serializedAttack ? { ...serializedAttack.lockedFacing } : null,
      activeProgress: serializedAttack?.phase === 'ACTIVE'
        ? clamp(serializedAttack.phaseElapsedMs / profileForAttack(serializedAttack.kind).activeMs, 0, 1)
        : serializedAttack?.phase === 'RECOVERY' ? 1 : 0,
      hitTargetIds: serializedAttack ? [...serializedAttack.hitPlayerIds].sort(compareStableIds) : []
    },
    dashRemainingMs: player.dashRemainingMs,
    dashCooldownRemainingMs: player.dashCooldownRemainingMs,
    hitstunRemainingMs: player.hitstunRemainingMs,
    respawnRemainingMs: player.respawnRemainingMs,
    protectionRemainingMs: player.protectionRemainingMs,
    stats: { ...player.stats }
  };
}

function emptyNetworkFor(state: MatchState): Record<string, PlayerNetworkStatus> {
  return Object.fromEntries(
    Object.keys(state.players)
      .sort(compareStableIds)
      .map((playerId) => [playerId, { currentMs: null, medianMs: null, jitterMs: null, transport: 'polling' as const }])
  );
}

export function snapshotMatch(
  state: MatchState,
  network: Readonly<Record<string, PlayerNetworkStatus>> = emptyNetworkFor(state)
): MatchSnapshot {
  return {
    tick: state.tick,
    phase: state.phase,
    remainingMs: phaseRemaining(state),
    platformProgress: state.contraction,
    settings: { ...state.settings },
    scores: { ...state.scores },
    network: { ...network },
    players: Object.keys(state.players)
      .filter((playerId) => state.players[playerId].connected)
      .sort(compareStableIds)
      .map((playerId) => snapshotPlayer(state.players[playerId])),
    pulses: Object.keys(state.pulses)
      .map(Number)
      .sort((left, right) => left - right)
      .map((projectileId) => {
        const pulse = state.pulses[projectileId];
        return {
          projectileId: pulse.projectileId,
          ownerPlayerId: pulse.ownerPlayerId,
          originatingAttackId: pulse.originatingAttackId,
          position: { ...pulse.position },
          velocity: { ...pulse.velocity },
          radius: pulse.radius,
          remainingMs: pulse.remainingMs,
          hitTargetIds: [...pulse.hitPlayerIds].sort(compareStableIds)
        };
      }),
    winnerPlayerId: state.winnerPlayerId,
    resultReason: state.resultReason
  };
}

export function setPlayerConnected(state: MatchState, playerId: string, connected: boolean): readonly GameEvent[] {
  const player = state.players[playerId];
  if (!player || player.connected === connected) return [];
  player.connected = connected;
  player.latestInput = createEmptyInput();
  player.previousQuick = false;
  player.previousHeavy = false;
  player.previousDash = false;
  player.attack = null;
  player.comboStep = 0;
  player.chargeMs = 0;
  player.charging = false;
  player.perfectDodgeConsumed = false;
  player.bufferedQuick = false;
  player.velocity = { x: 0, y: 0 };
  player.hitstunRemainingMs = 0;
  player.dashRemainingMs = 0;
  player.dashInvulnerabilityRemainingMs = 0;
  player.protectionRemainingMs = 0;
  player.resetOverloadOnRespawn = false;
  player.respawnRemainingMs = connected ? GAME.reconnectWarpMs : 0;
  if (connected) player.position = chooseSafestSpawn(state, playerId);
  return [];
}

export function forceKnockout(state: MatchState, attackerId: string, targetId: string): readonly GameEvent[] {
  const events = [...knockoutTransition(state, targetId, attackerId)];
  if (events.length > 0) events.push(...evaluateResult(state));
  return events;
}

export function setMatchPaused(state: MatchState, remainingMs: number): readonly GameEvent[] {
  if (state.phase === 'PAUSED' || state.phase === 'FINISHED') return [];
  state.pausedPhase = state.phase;
  state.phase = 'PAUSED';
  state.pauseRemainingMs = Math.max(0, remainingMs);
  return [phaseEvent(state, 'PAUSED')];
}

export function resumePausedMatch(state: MatchState): readonly GameEvent[] {
  if (state.phase !== 'PAUSED' || !state.pausedPhase) return [];
  state.phase = state.pausedPhase;
  state.pausedPhase = null;
  state.pauseRemainingMs = null;
  return [phaseEvent(state, state.phase)];
}
