import type { AttackProfileId } from './combat/profiles.js';
import type { RoomSettings } from './roomSettings.js';

export const CHASSIS = ['RIFT', 'BASTION', 'PULSE', 'WRAITH', 'EMBER', 'VOLT', 'TITAN', 'NOVA'] as const;

export type Chassis = (typeof CHASSIS)[number];

export const BOT_DIFFICULTIES = ['EASY', 'NORMAL', 'HARD'] as const;
export type BotDifficulty = (typeof BOT_DIFFICULTIES)[number];
export type PlayerRole = 'FIGHTER' | 'SPECTATOR';

export type PlayerAccent = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;

export type RoomPhase = 'LOBBY' | 'COUNTDOWN' | 'MATCH' | 'RESULT';

export type MatchPhase = 'COUNTDOWN' | 'REGULATION' | 'PAUSED' | 'SUDDEN_DEATH' | 'FINISHED';

export type MatchResultReason = 'TARGET_SCORE' | 'TIME' | 'SUDDEN_DEATH' | 'NO_CONTEST';

export type AttackKind = 'QUICK_1' | 'QUICK_2' | 'QUICK_3' | 'HEAVY';

export type HitSource = AttackKind | 'NEON_PULSE';

export type AttackPhase = 'IDLE' | 'WINDUP' | 'ACTIVE' | 'RECOVERY';

export type Vec2 = Readonly<{ x: number; y: number }>;

export type Polygon = readonly Vec2[];

export type InputFrame = Readonly<{
  seq: number;
  viewTick: number;
  moveX: number;
  moveY: number;
  aimX: number;
  aimY: number;
  quick: boolean;
  heavy: boolean;
  dash: boolean;
}>;

export type PlayerStats = Readonly<{
  knockouts: number;
  falls: number;
  landedHits: number;
  completedAttacks: number;
}>;

export type RoomPlayer = Readonly<{
  role: PlayerRole;
  botDifficulty: BotDifficulty | null;
  playerId: string;
  name: string;
  chassis: Chassis;
  accent: PlayerAccent;
  ready: boolean;
  connected: boolean;
  reconnectRemainingMs: number | null;
  stats: PlayerStats;
}>;

export type ResultPlayerStatus = 'WAITING' | 'READY' | 'LEFT';

export type ResultPlayer = Readonly<RoomPlayer & {
  resultStatus: ResultPlayerStatus;
}>;

export type LobbyChatMessage = Readonly<{ id: number; playerId: string; name: string; text: string; sentAt: number }>;

export type RoomState = Readonly<{
  roomCode: string;
  phase: RoomPhase;
  hostPlayerId: string;
  pauseRemainingMs: number | null;
  result: Readonly<{
    winnerPlayerId: string | null;
    reason: MatchResultReason;
    players: readonly ResultPlayer[];
  }> | null;
  settings: RoomSettings;
  players: readonly RoomPlayer[];
  chatMessages: readonly LobbyChatMessage[];
}>;

export type MatchAction = Readonly<{
  kind: AttackKind | 'DASH' | 'HITSTUN' | 'RESPAWNING' | null;
  phase: AttackPhase;
  comboStep: 0 | 1 | 2 | 3;
  chargeMs: number;
  charging: boolean;
  attackId: number | null;
  profileId: AttackProfileId | null;
  lockedFacing: Vec2 | null;
  activeProgress: number;
  hitTargetIds: readonly string[];
}>;

export type MatchPulse = Readonly<{
  projectileId: number;
  ownerPlayerId: string;
  originatingAttackId: number;
  position: Vec2;
  velocity: Vec2;
  radius: number;
  remainingMs: number;
  hitTargetIds: readonly string[];
}>;

export type MatchPlayer = Readonly<{
  playerId: string;
  name: string;
  chassis: Chassis;
  accent: PlayerAccent;
  position: Vec2;
  velocity: Vec2;
  facing: Vec2;
  overload: number;
  lastProcessedInputSeq: number;
  action: MatchAction;
  dashRemainingMs: number;
  dashCooldownRemainingMs: number;
  hitstunRemainingMs: number;
  respawnRemainingMs: number;
  protectionRemainingMs: number;
  stats: PlayerStats;
}>;

export type PlayerNetworkTransport = 'webrtc' | 'websocket' | 'polling';

export type PlayerNetworkStatus = Readonly<{
  currentMs: number | null;
  medianMs: number | null;
  jitterMs: number | null;
  transport: PlayerNetworkTransport;
}>;

export type MatchSnapshot = Readonly<{
  tick: number;
  phase: MatchPhase;
  remainingMs: number;
  platformProgress: number;
  settings: RoomSettings;
  scores: Readonly<Record<string, number>>;
  network: Readonly<Record<string, PlayerNetworkStatus>>;
  players: readonly MatchPlayer[];
  pulses: readonly MatchPulse[];
  winnerPlayerId: string | null;
  resultReason: MatchResultReason | null;
}>;

type EventMetadata = Readonly<{ eventId: number; tick: number }>;

export type GameEvent = EventMetadata &
  (
    | Readonly<{
        type: 'HIT';
        attackerId: string;
        targetId: string;
        attack: HitSource;
        impactPosition: Vec2;
        impulse: number;
        resultingOverload: number;
      }>
    | Readonly<{
        type: 'CLASH';
        playerIds: readonly [string, string];
        attackIds: readonly [number, number];
        impactPosition: Vec2;
        strength: 'QUICK' | 'HEAVY';
      }>
    | Readonly<{
        type: 'PERFECT_DODGE';
        playerId: string;
        attackerId: string;
        attackId: number;
        source: HitSource;
        projectileId: number | null;
        impactPosition: Vec2;
        refundedMs: number;
      }>
    | Readonly<{
        type: 'PULSE_SPAWN';
        projectileId: number;
        ownerPlayerId: string;
        originatingAttackId: number;
        position: Vec2;
      }>
    | Readonly<{
        type: 'PULSE_BREAK';
        projectileId: number;
        breakerPlayerId: string;
        breakerAttackId: number;
        impactPosition: Vec2;
      }>
    | Readonly<{
        type: 'KNOCKOUT';
        attackerId: string | null;
        targetId: string;
        scoreAwardedTo: string | null;
        scores: Readonly<Record<string, number>>;
      }>
    | Readonly<{
        type: 'RESPAWN';
        playerId: string;
        position: Vec2;
      }>
    | Readonly<{
        type: 'PHASE';
        phase: MatchPhase;
        remainingMs: number;
      }>
    | Readonly<{
        type: 'RESULT';
        winnerPlayerId: string | null;
        reason: MatchResultReason;
        scores: Readonly<Record<string, number>>;
      }>
  );

export type SessionWelcome = Readonly<{
  playerId: string;
  roomCode: string;
  resumeToken: string;
  resumed: boolean;
}>;

export type ServerError = Readonly<{
  code: string;
  message: string;
  recoverable: boolean;
}>;

export type Ack<T> = Readonly<{ ok: true; data: T }> | Readonly<{ ok: false; error: ServerError }>;
