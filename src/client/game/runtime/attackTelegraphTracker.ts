import { profileForAttack, type AttackProfileId } from '../../../shared/combat/profiles.js';
import type { MatchAction, MatchPlayer, Vec2 } from '../../../shared/model.js';
export type AttackTelegraph = Readonly<{ profileId: AttackProfileId; facing: Vec2; previousProgress: number; currentProgress: number; active: boolean }>;

const MIN_SWEEP_MS = 1_000 / 60;
const EPSILON = 0.000001;

type PredictableAction = Extract<MatchAction['kind'], 'QUICK_1' | 'QUICK_2' | 'QUICK_3' | 'HEAVY'>;

type ProvisionalAttack = Readonly<{
  kind: PredictableAction;
  profileId: AttackProfileId;
  facing: Vec2;
  startedAtMs: number;
  lastProgress: number;
  acknowledged: boolean;
}>;

type AuthoritativeAttack = Readonly<{
  profileId: AttackProfileId;
  facing: Vec2;
  previousProgress: number;
  currentProgress: number;
  active: boolean;
}>;

function profileIdForKind(kind: PredictableAction): AttackProfileId {
  switch (kind) {
    case 'QUICK_1': return 'quick-1';
    case 'QUICK_2': return 'quick-2';
    case 'QUICK_3': return 'quick-3';
    case 'HEAVY': return 'heavy-melee';
  }
}

function predictiveFacing(action: MatchAction, presentationFacing: Vec2): Vec2 {
  return action.lockedFacing ?? presentationFacing;
}

function predictiveKind(action: MatchAction | null): PredictableAction | null {
  if (!action || action.charging || action.attackId !== null) return null;
  return action.kind === 'QUICK_1' || action.kind === 'QUICK_2' ||
    action.kind === 'QUICK_3' || action.kind === 'HEAVY'
    ? action.kind
    : null;
}

function ensureMeaningfulSweep(
  profileId: AttackProfileId,
  previousProgress: number,
  currentProgress: number
): Readonly<{ previousProgress: number; currentProgress: number }> {
  if (currentProgress > previousProgress + EPSILON) return { previousProgress, currentProgress };
  const profile = profileForAttack(profileId === 'heavy-melee'
    ? 'HEAVY'
    : profileId === 'quick-1'
      ? 'QUICK_1'
      : profileId === 'quick-2'
        ? 'QUICK_2'
        : 'QUICK_3');
  const minimumWindow = Math.min(1, MIN_SWEEP_MS / profile.activeMs);
  if (currentProgress <= EPSILON) return { previousProgress: 0, currentProgress: minimumWindow };
  return { previousProgress: Math.max(0, currentProgress - minimumWindow), currentProgress };
}

export class AttackTelegraphTracker {
  private readonly provisionalByPlayerId = new Map<string, ProvisionalAttack>();

  telegraph(
    playerId: string,
    previousPlayer: MatchPlayer,
    currentPlayer: MatchPlayer,
    predictedAction: MatchAction | null,
    presentationFacing: Vec2,
    nowMs: number,
    isLocal: boolean
  ): AttackTelegraph | null {
    if (isLocal) this.capturePrediction(playerId, predictedAction, presentationFacing, nowMs);
    const authoritative = this.authoritativeTelegraph(previousPlayer, currentPlayer);
    const provisional = isLocal ? this.provisionalTelegraph(playerId, currentPlayer, nowMs) : null;
    const tracked = this.provisionalByPlayerId.get(playerId) ?? null;

    if (!authoritative) {
      if (!isLocal) this.provisionalByPlayerId.delete(playerId);
      return provisional;
    }
    if (authoritative.active) {
      this.provisionalByPlayerId.delete(playerId);
      return authoritative;
    }
    if (tracked && this.matchesAcknowledgedAttack(tracked, authoritative)) {
      this.provisionalByPlayerId.set(playerId, { ...tracked, acknowledged: true });
      return provisional;
    }
    this.provisionalByPlayerId.delete(playerId);
    return authoritative;
  }

  prune(activePlayerIds: ReadonlySet<string>): void {
    for (const playerId of this.provisionalByPlayerId.keys()) {
      if (!activePlayerIds.has(playerId)) this.provisionalByPlayerId.delete(playerId);
    }
  }

  reset(): void {
    this.provisionalByPlayerId.clear();
  }

  private authoritativeTelegraph(previousPlayer: MatchPlayer, currentPlayer: MatchPlayer): AuthoritativeAttack | null {
    const action = currentPlayer.action;
    if (action.profileId === null || action.attackId === null) return null;
    if (action.phase !== 'ACTIVE') {
      return {
        profileId: action.profileId,
        facing: action.lockedFacing ?? currentPlayer.facing,
        previousProgress: 0,
        currentProgress: action.activeProgress,
        active: false
      };
    }
    const continuesAttack = previousPlayer.action.attackId === action.attackId &&
      previousPlayer.action.profileId === action.profileId;
    const sweep = ensureMeaningfulSweep(
      action.profileId,
      continuesAttack ? previousPlayer.action.activeProgress : 0,
      action.activeProgress
    );
    return {
      profileId: action.profileId,
      facing: action.lockedFacing ?? currentPlayer.facing,
      previousProgress: sweep.previousProgress,
      currentProgress: sweep.currentProgress,
      active: true
    };
  }

  private capturePrediction(
    playerId: string,
    predictedAction: MatchAction | null,
    presentationFacing: Vec2,
    nowMs: number
  ): void {
    const kind = predictiveKind(predictedAction);
    if (kind === null || !predictedAction) return;
    const profileId = profileIdForKind(kind);
    const facing = predictiveFacing(predictedAction, presentationFacing);
    const current = this.provisionalByPlayerId.get(playerId);
    if (current && current.kind === kind &&
      current.facing.x === facing.x && current.facing.y === facing.y) {
      return;
    }
    this.provisionalByPlayerId.set(playerId, {
      kind,
      profileId,
      facing,
      startedAtMs: nowMs,
      lastProgress: 0,
      acknowledged: false
    });
  }

  private provisionalTelegraph(playerId: string, currentPlayer: MatchPlayer, nowMs: number): AttackTelegraph | null {
    const provisional = this.provisionalByPlayerId.get(playerId);
    if (!provisional) return null;
    if (this.predictionInvalidated(provisional, currentPlayer.action)) {
      this.provisionalByPlayerId.delete(playerId);
      return null;
    }
    const profile = profileForAttack(provisional.kind === 'HEAVY' ? 'HEAVY' : provisional.kind);
    const elapsedMs = Math.max(0, nowMs - provisional.startedAtMs);
    if (elapsedMs < profile.windupMs) return null;
    if (elapsedMs >= profile.windupMs + profile.activeMs + profile.recoveryMs) {
      this.provisionalByPlayerId.delete(playerId);
      return null;
    }
    if (elapsedMs >= profile.windupMs + profile.activeMs) return null;
    const currentProgress = Math.max(0, Math.min(1, (elapsedMs - profile.windupMs) / profile.activeMs));
    const sweep = ensureMeaningfulSweep(provisional.profileId, provisional.lastProgress, currentProgress);
    this.provisionalByPlayerId.set(playerId, { ...provisional, lastProgress: sweep.currentProgress });
    return {
      profileId: provisional.profileId,
      facing: provisional.facing,
      previousProgress: sweep.previousProgress,
      currentProgress: sweep.currentProgress,
      active: true
    };
  }

  private matchesAcknowledgedAttack(
    provisional: ProvisionalAttack,
    authoritative: AuthoritativeAttack
  ): boolean {
    return authoritative.profileId === provisional.profileId &&
      authoritative.facing.x === provisional.facing.x &&
      authoritative.facing.y === provisional.facing.y;
  }

  private predictionInvalidated(provisional: ProvisionalAttack, action: MatchAction): boolean {
    if (action.kind === null || action.charging) return provisional.acknowledged;
    if (action.kind === provisional.kind) return false;
    return true;
  }
}
