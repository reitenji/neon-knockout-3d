import { ARENA, CHASSIS, GAME } from '../../shared/constants.js';
import {
  RTT_FRESHNESS_MS,
  RTT_SAMPLE_LIMIT,
  type MatchEventPublication,
  type MatchSnapshotPublication,
  type MatchStartedPublication
} from '../../shared/gameplayTransport.js';
import { DEFAULT_ROOM_SETTINGS, type RoomSettings } from '../../shared/roomSettings.js';
import type {
  BotDifficulty,
  PlayerRole,
  Chassis,
  GameEvent,
  InputFrame,
  MatchSnapshot,
  PlayerNetworkStatus,
  PlayerNetworkTransport,
  PlayerAccent,
  PlayerStats,
  ResultPlayer,
  RoomPhase,
  RoomState,
  SessionWelcome,
  Vec2
} from '../../shared/model.js';
import { normalizePlayerName, normalizeRoomCode } from '../../shared/names.js';
import {
  forceKnockout as forceMatchKnockout,
  resumePausedMatch,
  setMatchPaused,
  setPlayerConnected,
  snapshotMatch,
  stepMatch
} from '../game/simulation.js';
import { CombatFrameHistory } from '../game/CombatFrameHistory.js';
import { clampClaimedViewTick } from '../game/netcodeCompensation.js';
import { createEmptyInput, createMatchState, createPlayerStats, type MatchState } from '../game/state.js';
import { clearPulses, removePulsesOwnedBy } from '../game/projectiles.js';
import { BotController } from '../game/botController.js';
import { BOT_DIFFICULTIES } from '../../shared/model.js';
import { DomainError } from './domainError.js';

const ROOM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const SIMULATION_STEP_MS = 1_000 / GAME.tickRate;
const SNAPSHOT_INTERVAL_MS = 1_000 / GAME.snapshotRate;
const MAX_ELAPSED_MS = 250;
const MAX_STEPS_PER_ADVANCE = 5;
const TIMER_EPSILON_MS = 1e-7;
const MAX_TEST_COMBAT_STEPS = 240;
const DEFAULT_RESOURCE_LIMITS = {
  maxRooms: 256,
  maxConnections: 4_096,
  roomCreationsPerWindow: 32,
  roomCreationWindowMs: 10_000,
  roomIdleTimeoutMs: 30 * 60_000,
  roomCodeAttempts: 32
} as const;

export type RoomManagerResourceLimits = Readonly<{
  maxRooms: number;
  maxConnections: number;
  roomCreationsPerWindow: number;
  roomCreationWindowMs: number;
  roomIdleTimeoutMs: number;
  roomCodeAttempts: number;
}>;

export type RoomPublication =
  | { type: 'ROOM_STATE'; roomCode: string; state: RoomState }
  | ({ type: 'MATCH_STARTED'; roomCode: string } & MatchStartedPublication)
  | ({ type: 'MATCH_SNAPSHOT'; roomCode: string } & MatchSnapshotPublication)
  | ({ type: 'MATCH_EVENT'; roomCode: string } & MatchEventPublication)
  | { type: 'ROOM_CLOSED'; roomCode: string };

type RoomPlayer = {
  role: PlayerRole;
  botDifficulty: BotDifficulty | null;
  playerId: string;
  name: string;
  chassis: Chassis;
  accent: PlayerAccent;
  ready: boolean;
  connected: boolean;
  stats: PlayerStats;
  resumeToken: Uint8Array;
  order: number;
  expiresAt: number | null;
  reconnectAnchor: Vec2 | null;
};

type ResultPlayerRecord = {
  role: PlayerRole;
  botDifficulty: BotDifficulty | null;
  playerId: string;
  name: string;
  chassis: Chassis;
  accent: PlayerAccent;
  stats: PlayerStats;
  order: number;
  left: boolean;
};

type Room = {
  roomCode: string;
  phase: RoomPhase;
  hostPlayerId: string;
  settings: RoomSettings;
  players: Map<string, RoomPlayer>;
  nextPlayerOrder: number;
  matchEpoch: number;
  match: MatchState | null;
  resultPlayers: Map<string, ResultPlayerRecord> | null;
  network: Map<string, PlayerNetworkRuntime>;
  combatHistory: CombatFrameHistory | null;
  inputs: Map<string, InputFrame>;
  bots: Map<string, BotController>;
  accumulatorMs: number;
  snapshotAccumulatorMs: number;
  lastActivityAt: number;
};

type PlayerNetworkRuntime = {
  currentMs: number | null;
  medianMs: number | null;
  jitterMs: number | null;
  transport: PlayerNetworkTransport;
  samples: number[];
  sampledAtMs: number | null;
};

type ConnectionSession = Readonly<{ roomCode: string; playerId: string }>;

type RoomManagerDependencies = Readonly<{
  now: () => number;
  randomBytes: (size: number) => Uint8Array;
  publish: (event: RoomPublication) => void;
  bindTestHarness?: (harness: RoomManagerTestHarness) => void;
  resourceLimits?: Partial<RoomManagerResourceLimits>;
}>;

export type TestCombatPlayerStage = Readonly<{
  playerId: string;
  position: Vec2;
  facing: Vec2;
  overload: number;
}>;

export type TestCombatStep = Readonly<{
  elapsedMs: number;
  inputs?: readonly Readonly<{ playerId: string; input: InputFrame }>[];
}>;

export type TestCombatScript = Readonly<{
  preservePulses?: boolean;
  players: readonly TestCombatPlayerStage[];
  steps: readonly TestCombatStep[];
}>;

export type RoomManagerTestHarness = Readonly<{
  placePlayer(roomCode: string, playerId: string, position: Vec2, facing: Vec2): void;
  runCombatScript(roomCode: string, script: TestCombatScript): void;
}>;

export type DebugRoom = Readonly<{
  phase: RoomPhase;
  connectedCount: number;
  reservedCount: number;
  playerIds: readonly string[];
  tick: number | null;
  scores: Readonly<Record<string, number>> | null;
  historyOldestTick: number | null;
  historyLatestTick: number | null;
  playerViewTicks: Readonly<Record<string, number>> | null;
}>;

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('');
}

function equalTokenBytes(left: Uint8Array, right: Uint8Array): boolean {
  let difference = left.length ^ right.length;
  for (let index = 0; index < left.length; index++) difference |= left[index] ^ right[index];
  return difference === 0;
}

function emptyStats(): PlayerStats {
  return { ...createPlayerStats() };
}

function createNetworkRuntime(transport: PlayerNetworkTransport = 'polling'): PlayerNetworkRuntime {
  return { currentMs: null, medianMs: null, jitterMs: null, transport, samples: [], sampledAtMs: null };
}

function roundMedian(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return Math.round(sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle]);
}

function pushBounded(values: number[], next: number): void {
  values.push(next);
  if (values.length > RTT_SAMPLE_LIMIT) values.splice(0, values.length - RTT_SAMPLE_LIMIT);
}

function clearNetworkSamples(runtime: PlayerNetworkRuntime): void {
  runtime.currentMs = null;
  runtime.medianMs = null;
  runtime.jitterMs = null;
  runtime.samples = [];
  runtime.sampledAtMs = null;
}

function networkStatus(runtime: PlayerNetworkRuntime, now: number): PlayerNetworkStatus {
  const fresh = runtime.sampledAtMs !== null && now - runtime.sampledAtMs < RTT_FRESHNESS_MS;
  return {
    currentMs: fresh ? runtime.currentMs : null,
    medianMs: fresh ? runtime.medianMs : null,
    jitterMs: fresh ? runtime.jitterMs : null,
    transport: runtime.transport
  };
}

export class RoomManager {
  private readonly rooms = new Map<string, Room>();
  private readonly connections = new Map<string, ConnectionSession>();
  private readonly roomCreationTimes: number[] = [];
  private readonly resourceLimits: RoomManagerResourceLimits;

  constructor(private readonly deps: RoomManagerDependencies) {
    this.resourceLimits = { ...DEFAULT_RESOURCE_LIMITS, ...deps.resourceLimits };
    deps.bindTestHarness?.({
      placePlayer: (roomCode, playerId, position, facing) =>
        this.placePlayerForTesting(roomCode, playerId, position, facing),
      runCombatScript: (roomCode, script) => this.runCombatScriptForTesting(roomCode, script)
    });
  }

  reset(): void {
    for (const room of this.rooms.values()) {
      if (room.match) clearPulses(room.match);
      room.combatHistory?.clear();
    }
    this.rooms.clear();
    this.connections.clear();
    this.roomCreationTimes.length = 0;
  }

  createRoom(connectionId: string, name: string): SessionWelcome {
    this.assertConnectionAvailable(connectionId);
    const normalizedName = this.normalizeName(name);
    this.assertRoomCreationAvailable();
    const roomCode = this.createRoomCode();
    const playerId = bytesToHex(this.deps.randomBytes(16));
    const resumeToken = this.deps.randomBytes(32);
    const player: RoomPlayer = {
      playerId,
      role: 'FIGHTER',
      botDifficulty: null,
      name: normalizedName,
      chassis: CHASSIS[0],
      accent: 0,
      ready: false,
      connected: true,
      stats: emptyStats(),
      resumeToken,
      order: 0,
      expiresAt: null,
      reconnectAnchor: null
    };
    const room: Room = {
      roomCode,
      phase: 'LOBBY',
      hostPlayerId: playerId,
      settings: { ...DEFAULT_ROOM_SETTINGS },
      players: new Map([[playerId, player]]),
      nextPlayerOrder: 1,
      matchEpoch: 0,
      match: null,
      resultPlayers: null,
      network: new Map([[playerId, createNetworkRuntime()]]),
      combatHistory: null,
      inputs: new Map(),
      bots: new Map(),
      accumulatorMs: 0,
      snapshotAccumulatorMs: 0,
      lastActivityAt: this.deps.now()
    };
    this.rooms.set(roomCode, room);
    this.connections.set(connectionId, { roomCode, playerId });
    this.roomCreationTimes.push(this.deps.now());
    this.publishRoom(room);
    return { playerId, roomCode, resumeToken: bytesToHex(resumeToken), resumed: false };
  }

  joinRoom(connectionId: string, roomCode: string, name: string, role: PlayerRole = 'FIGHTER'): SessionWelcome {
    this.assertConnectionAvailable(connectionId);
    const room = this.requireRoom(roomCode);
    room.lastActivityAt = this.deps.now();
    this.assertRole(role);
    if (role === 'FIGHTER' && (room.phase === 'COUNTDOWN' || room.phase === 'MATCH')) {
      throw new DomainError('MATCH_IN_PROGRESS', 'Maç devam ederken yeni oyuncu katılamaz.', true);
    }
    this.assertRoleCapacity(room, role);
    const normalizedName = this.normalizeName(name);
    const playerId = bytesToHex(this.deps.randomBytes(16));
    const resumeToken = this.deps.randomBytes(32);
    const order = room.nextPlayerOrder++;
    room.players.set(playerId, {
      playerId,
      role,
      botDifficulty: null,
      name: normalizedName,
      chassis: CHASSIS[order % CHASSIS.length],
      accent: role === 'FIGHTER' ? this.lowestUnusedAccent(room) : 0,
      ready: false,
      connected: true,
      stats: emptyStats(),
      resumeToken,
      order,
      expiresAt: null,
      reconnectAnchor: null
    });
    room.network.set(playerId, createNetworkRuntime());
    this.connections.set(connectionId, { roomCode: room.roomCode, playerId });
    this.publishRoom(room);
    return { playerId, roomCode: room.roomCode, resumeToken: bytesToHex(resumeToken), resumed: false };
  }

  resume(
    connectionId: string,
    roomCode: string,
    resumeToken: string,
    transport: PlayerNetworkTransport = 'polling'
  ): SessionWelcome {
    this.assertConnectionAvailable(connectionId);
    const room = this.requireRoom(roomCode);
    room.lastActivityAt = this.deps.now();
    const token = this.parseResumeToken(resumeToken);
    const now = this.deps.now();
    const player = [...room.players.values()].find((candidate) =>
      !candidate.connected && candidate.expiresAt !== null && candidate.expiresAt > now &&
      candidate.resumeToken.byteLength === token.byteLength && equalTokenBytes(candidate.resumeToken, token));
    if (!player) {
      throw new DomainError('INVALID_RESUME_TOKEN', 'Yeniden bağlanma anahtarı geçersiz veya süresi dolmuş.', true);
    }
    const network = room.network.get(player.playerId) ?? createNetworkRuntime(transport);
    clearNetworkSamples(network);
    network.transport = transport;
    room.network.set(player.playerId, network);
    player.connected = true;
    player.expiresAt = null;
    this.connections.set(connectionId, { roomCode: room.roomCode, playerId: player.playerId });
    if (!room.players.get(room.hostPlayerId)?.connected) this.migrateHost(room);
    if (room.match?.players[player.playerId] && (room.phase === 'COUNTDOWN' || room.phase === 'MATCH')) {
      this.publishMatchEvents(room, setPlayerConnected(room.match, player.playerId, true));
      player.reconnectAnchor = { ...room.match.players[player.playerId].position };
      this.reconcilePopulation(room);
      this.publishSnapshot(room);
    }
    this.publishRoom(room);
    return { playerId: player.playerId, roomCode: room.roomCode, resumeToken, resumed: true };
  }

  setChassis(connectionId: string, chassis: Chassis): void {
    const { room, player } = this.requireConnectedPlayer(connectionId);
    this.assertFighter(player);
    if (room.phase !== 'LOBBY') throw new DomainError('INVALID_PHASE', 'Bu işlem şu anda kullanılamaz.', true);
    if (!(CHASSIS as readonly string[]).includes(chassis)) {
      throw new DomainError('INVALID_CHASSIS', 'Gövde seçimi geçersiz.', true);
    }
    if (player.chassis === chassis) return;
    player.chassis = chassis;
    player.ready = false;
    this.publishRoom(room);
  }

  setRole(connectionId: string, role: PlayerRole): void {
    const { room, player } = this.requireConnectedPlayer(connectionId);
    if (room.phase !== 'LOBBY') throw new DomainError('INVALID_PHASE', 'Bu işlem şu anda kullanılamaz.', true);
    this.assertRole(role);
    if (player.role === role) return;
    this.assertRoleCapacity(room, role);
    if (role === 'FIGHTER') player.accent = this.lowestUnusedAccent(room);
    player.role = role;
    player.ready = false;
    this.publishRoom(room);
  }

  addBot(connectionId: string, chassis: Chassis, difficulty: BotDifficulty): void {
    const room = this.requireBotHost(connectionId);
    this.assertBotSelection(chassis, difficulty);
    this.assertRoleCapacity(room, 'FIGHTER');
    const order = room.nextPlayerOrder++;
    const playerId = `bot-${bytesToHex(this.deps.randomBytes(16))}`;
    room.players.set(playerId, {
      playerId, name: `Bot ${order + 1}`, chassis, botDifficulty: difficulty, role: 'FIGHTER',
      accent: this.lowestUnusedAccent(room), ready: true, connected: true, stats: emptyStats(),
      resumeToken: new Uint8Array(), order, expiresAt: null, reconnectAnchor: null
    });
    this.publishRoom(room);
  }

  updateBot(connectionId: string, playerId: string, chassis: Chassis, difficulty: BotDifficulty): void {
    const room = this.requireBotHost(connectionId);
    this.assertBotSelection(chassis, difficulty);
    const bot = room.players.get(playerId);
    if (!bot?.botDifficulty) throw new DomainError('BOT_NOT_FOUND', 'Bot bulunamadı.', true);
    bot.chassis = chassis;
    bot.botDifficulty = difficulty;
    bot.ready = true;
    this.publishRoom(room);
  }

  removeBot(connectionId: string, playerId: string): void {
    const room = this.requireBotHost(connectionId);
    if (!room.players.get(playerId)?.botDifficulty) throw new DomainError('BOT_NOT_FOUND', 'Bot bulunamadı.', true);
    room.players.delete(playerId);
    this.publishRoom(room);
  }

  private requireBotHost(connectionId: string): Room {
    const { room, player } = this.requireConnectedPlayer(connectionId);
    if (room.hostPlayerId !== player.playerId) throw new DomainError('NOT_HOST', 'Bu işlemi yalnızca oda sahibi yapabilir.', true);
    if (room.phase !== 'LOBBY') throw new DomainError('INVALID_PHASE', 'Bu işlem şu anda kullanılamaz.', true);
    return room;
  }

  private assertBotSelection(chassis: Chassis, difficulty: BotDifficulty): void {
    if (!(CHASSIS as readonly string[]).includes(chassis)) throw new DomainError('INVALID_CHASSIS', 'Gövde seçimi geçersiz.', true);
    if (!(BOT_DIFFICULTIES as readonly string[]).includes(difficulty)) throw new DomainError('INVALID_DIFFICULTY', 'Bot zorluğu geçersiz.', true);
  }

  private assertRole(role: PlayerRole): void {
    if (role !== 'FIGHTER' && role !== 'SPECTATOR') throw new DomainError('INVALID_ROLE', 'Katılım türü geçersiz.', true);
  }

  private assertRoleCapacity(room: Room, role: PlayerRole): void {
    const capacity = role === 'FIGHTER' ? GAME.maxPlayers : 8;
    if ([...room.players.values()].filter((player) => player.role === role).length >= capacity) {
      throw new DomainError('ROOM_FULL', role === 'FIGHTER' ? 'Oyuncu kontenjanı dolu.' : 'Seyirci kontenjanı dolu.', true);
    }
  }

  private assertFighter(player: RoomPlayer): void {
    if (player.role !== 'FIGHTER') throw new DomainError('SPECTATOR_ACTION', 'Seyirciler oyuncu eylemlerini kullanamaz.', true);
  }

  setReady(connectionId: string, ready: boolean): void {
    const { room, player } = this.requireConnectedPlayer(connectionId);
    this.assertFighter(player);
    if (room.phase !== 'LOBBY') throw new DomainError('INVALID_PHASE', 'Bu işlem şu anda kullanılamaz.', true);
    player.ready = ready;
    this.publishRoom(room);
  }

  setRoomSettings(connectionId: string, settings: RoomSettings): void {
    const { room, player } = this.requireConnectedPlayer(connectionId);
    if (room.phase !== 'LOBBY') throw new DomainError('INVALID_PHASE', 'Bu işlem şu anda kullanılamaz.', true);
    if (room.hostPlayerId !== player.playerId) {
      throw new DomainError('NOT_HOST', 'Bu işlemi yalnızca oda sahibi yapabilir.', true);
    }
    if (room.settings.durationMs === settings.durationMs && room.settings.knockoutTarget === settings.knockoutTarget) return;
    room.settings = { ...settings };
    for (const candidate of room.players.values()) candidate.ready = candidate.botDifficulty !== null;
    this.publishRoom(room);
  }

  leaveRoom(connectionId: string): string {
    const { room, player } = this.requireConnectedPlayer(connectionId);
    const leavingHost = room.hostPlayerId === player.playerId;
    if (room.phase === 'RESULT') this.markResultPlayerLeft(room, player);
    this.connections.delete(connectionId);
    room.inputs.delete(player.playerId);
    room.players.delete(player.playerId);
    if (room.match) {
      removePulsesOwnedBy(room.match, player.playerId);
      delete room.match.players[player.playerId];
      delete room.match.scores[player.playerId];
    }
    room.network.delete(player.playerId);
    if (leavingHost) this.reassignHost(room);
    if (![...room.players.values()].some((member) => member.botDifficulty === null)) {
      if (room.match) clearPulses(room.match);
      room.combatHistory?.clear();
      this.rooms.delete(room.roomCode);
      this.deps.publish({ type: 'ROOM_CLOSED', roomCode: room.roomCode });
      return room.roomCode;
    }
    if (room.match && (room.phase === 'COUNTDOWN' || room.phase === 'MATCH')) {
      if (!this.reconcilePopulation(room)) return room.roomCode;
      this.publishSnapshot(room);
    }
    this.publishRoom(room);
    return room.roomCode;
  }

  startMatch(connectionId: string): void {
    const { room, player } = this.requireConnectedPlayer(connectionId);
    if (room.phase !== 'LOBBY' && room.phase !== 'RESULT') {
      throw new DomainError('INVALID_PHASE', 'Bu işlem şu anda kullanılamaz.', true);
    }
    if (room.hostPlayerId !== player.playerId) {
      throw new DomainError('NOT_HOST', 'Bu işlemi yalnızca oda sahibi yapabilir.', true);
    }
    const connected = [...room.players.values()].filter((candidate) => candidate.role === 'FIGHTER' && candidate.connected);
    if (connected.length < GAME.minPlayers) {
      throw new DomainError('NOT_ENOUGH_PLAYERS', 'Maçı başlatmak için en az iki bağlı oyuncu gerekir.', true);
    }
    if (connected.some((candidate) => !candidate.ready)) {
      throw new DomainError('NOT_READY', 'Tüm bağlı oyuncular hazır olmalıdır.', true);
    }
    for (const candidate of room.players.values()) {
      candidate.ready = candidate.botDifficulty !== null;
      candidate.stats = emptyStats();
      candidate.reconnectAnchor = null;
    }
    if (room.match) clearPulses(room.match);
    room.combatHistory?.clear();
    room.matchEpoch += 1;
    room.match = createMatchState([...room.players.values()].filter((candidate) => candidate.role === 'FIGHTER').map((candidate) => ({
      playerId: candidate.playerId,
      name: candidate.name,
      chassis: candidate.chassis,
      accent: candidate.accent,
      connected: candidate.connected
    })), this.deps.now(), room.settings);
    room.bots.clear();
    for (const candidate of room.players.values()) {
      if (candidate.botDifficulty) {
        room.bots.set(candidate.playerId, new BotController(candidate.playerId, candidate.botDifficulty, room.matchEpoch));
        continue;
      }
      const runtime = room.network.get(candidate.playerId) ?? createNetworkRuntime();
      clearNetworkSamples(runtime);
      room.network.set(candidate.playerId, runtime);
    }
    room.resultPlayers = null;
    room.phase = 'COUNTDOWN';
    room.combatHistory = new CombatFrameHistory();
    room.combatHistory.capture(room.match);
    room.inputs.clear();
    room.accumulatorMs = 0;
    room.snapshotAccumulatorMs = 0;
    this.publishRoom(room);
    this.deps.publish({
      type: 'MATCH_STARTED',
      roomCode: room.roomCode,
      matchEpoch: room.matchEpoch,
      eventCursor: room.match.nextEventId - 1,
      snapshot: this.snapshotForRoom(room)
    });
  }

  applyInput(connectionId: string, input: InputFrame): void {
    const { room, player } = this.requireConnectedPlayer(connectionId);
    this.assertFighter(player);
    if (!room.match || (room.phase !== 'COUNTDOWN' && room.phase !== 'MATCH')) {
      throw new DomainError('INVALID_PHASE', 'Bu işlem şu anda kullanılamaz.', true);
    }
    const queued = room.inputs.get(player.playerId);
    const processed = room.match.players[player.playerId]?.lastProcessedInputSeq ?? -1;
    if (input.seq <= Math.max(queued?.seq ?? -1, processed)) return;
    const boundedInput = {
      ...input,
      viewTick: clampClaimedViewTick({
        currentTick: room.match.tick,
        claimedViewTick: input.viewTick,
        historyOldestTick: room.combatHistory?.oldestTick() ?? null
      })
    };
    const unprocessed = queued && queued.seq > processed ? queued : null;
    room.inputs.set(player.playerId, unprocessed
      ? {
        ...boundedInput,
        viewTick: unprocessed.quick ? unprocessed.viewTick : boundedInput.viewTick,
        quick: unprocessed.quick || boundedInput.quick,
        dash: unprocessed.dash || boundedInput.dash
      }
      : boundedInput);
  }

  setPing(
    connectionId: string,
    pingMs: number,
    source: Exclude<PlayerNetworkTransport, 'webrtc'>,
    sampledAtMs: number
  ): void {
    const { room, player } = this.requireConnectedPlayer(connectionId);
    if (!room.match || (room.phase !== 'COUNTDOWN' && room.phase !== 'MATCH')) return;
    const runtime = room.network.get(player.playerId) ?? createNetworkRuntime();
    if (runtime.transport !== source || !Number.isFinite(sampledAtMs)) return;
    const normalized = Math.round(Math.max(0, Math.min(GAME.maxPingMs, pingMs)));
    runtime.currentMs = normalized;
    pushBounded(runtime.samples, normalized);
    runtime.medianMs = roundMedian(runtime.samples);
    runtime.jitterMs = roundMedian(runtime.samples.slice(1).map((sample, index) =>
      Math.abs(sample - runtime.samples[index]!)
    )) ?? 0;
    runtime.sampledAtMs = sampledAtMs;
    room.network.set(player.playerId, runtime);
  }

  setWebRtcNetworkSample(connectionId: string, medianMs: number, jitterMs: number, sampledAtMs: number): void {
    const { room, player } = this.requireConnectedPlayer(connectionId);
    if (!room.match || (room.phase !== 'COUNTDOWN' && room.phase !== 'MATCH')) return;
    const runtime = room.network.get(player.playerId) ?? createNetworkRuntime();
    if (runtime.transport !== 'webrtc' || !Number.isFinite(sampledAtMs)) return;
    const normalized = Math.round(Math.max(0, Math.min(GAME.maxPingMs, medianMs)));
    const normalizedJitter = Math.round(Math.max(0, Math.min(GAME.maxPingMs, jitterMs)));
    runtime.currentMs = normalized;
    runtime.medianMs = normalized;
    runtime.jitterMs = normalizedJitter;
    runtime.samples = [];
    runtime.sampledAtMs = sampledAtMs;
    room.network.set(player.playerId, runtime);
  }

  clearWebRtcNetworkSample(connectionId: string): void {
    const { room, player } = this.requireConnectedPlayer(connectionId);
    const runtime = room.network.get(player.playerId) ?? createNetworkRuntime();
    if (runtime.transport !== 'webrtc') return;
    clearNetworkSamples(runtime);
    room.network.set(player.playerId, runtime);
  }

  setTransport(connectionId: string, transport: PlayerNetworkTransport): void {
    const { room, player } = this.requireConnectedPlayer(connectionId);
    const runtime = room.network.get(player.playerId) ?? createNetworkRuntime(transport);
    if (runtime.transport !== transport) clearNetworkSamples(runtime);
    runtime.transport = transport;
    room.network.set(player.playerId, runtime);
  }

  clearPing(connectionId: string): void {
    const { room, player } = this.requireConnectedPlayer(connectionId);
    const runtime = room.network.get(player.playerId) ?? createNetworkRuntime();
    clearNetworkSamples(runtime);
    room.network.set(player.playerId, runtime);
  }

  currentMatchPublication(connectionId: string): MatchStartedPublication | null {
    const session = this.connections.get(connectionId);
    const room = session ? this.rooms.get(session.roomCode) : undefined;
    const player = session ? room?.players.get(session.playerId) : undefined;
    if (
      !room
      || !player?.connected
      || !room.match
      || (room.phase !== 'COUNTDOWN' && room.phase !== 'MATCH')
    ) return null;
    return {
      matchEpoch: room.matchEpoch,
      eventCursor: room.match.nextEventId - 1,
      snapshot: this.snapshotForRoom(room)
    };
  }

  isInActiveMatch(connectionId: string): boolean {
    const session = this.connections.get(connectionId);
    const room = session ? this.rooms.get(session.roomCode) : null;
    const player = session ? room?.players.get(session.playerId) : null;
    return Boolean(room && player?.connected && room.match &&
      (room.phase === 'COUNTDOWN' || room.phase === 'MATCH'));
  }

  isInResult(connectionId: string): boolean {
    const session = this.connections.get(connectionId);
    const room = session ? this.rooms.get(session.roomCode) : null;
    const player = session ? room?.players.get(session.playerId) : null;
    return Boolean(room && player?.connected && room.phase === 'RESULT');
  }

  forceKnockout(roomCode: string, attackerId: string, targetId: string): void {
    const room = this.requireRoom(roomCode);
    if (!room.match || room.phase !== 'MATCH') {
      throw new DomainError('INVALID_PHASE', 'Bu işlem şu anda kullanılamaz.', true);
    }
    this.publishMatchEvents(room, forceMatchKnockout(room.match, attackerId, targetId));
  }

  debugRoom(roomCode: string): DebugRoom | null {
    let normalized: string;
    try {
      normalized = normalizeRoomCode(roomCode);
    } catch {
      return null;
    }
    const room = this.rooms.get(normalized);
    if (!room) return null;
    const ordered = this.orderedPlayers(room);
    return {
      phase: room.phase,
      connectedCount: ordered.filter((player) => player.connected).length,
      reservedCount: ordered.filter((player) => !player.connected).length,
      playerIds: ordered.map((player) => player.playerId),
      tick: room.match?.tick ?? null,
      scores: room.match ? { ...room.match.scores } : null,
      historyOldestTick: room.combatHistory?.oldestTick() ?? null,
      historyLatestTick: room.combatHistory?.latestTick() ?? null,
      playerViewTicks: room.match
        ? Object.fromEntries(Object.keys(room.match.players).sort().map((playerId) => [
          playerId,
          room.match!.players[playerId].latestInput.viewTick
        ]))
        : null
    };
  }

  setResultReady(connectionId: string, ready: boolean): void {
    const { room, player } = this.requireConnectedPlayer(connectionId);
    this.assertFighter(player);
    if (room.phase !== 'RESULT') throw new DomainError('INVALID_PHASE', 'Bu işlem şu anda kullanılamaz.', true);
    player.ready = ready;
    this.publishRoom(room);
  }

  returnToLobby(connectionId: string): void {
    const { room, player } = this.requireConnectedPlayer(connectionId);
    if (room.phase !== 'RESULT') throw new DomainError('INVALID_PHASE', 'Bu işlem şu anda kullanılamaz.', true);
    if (room.hostPlayerId !== player.playerId) {
      throw new DomainError('NOT_HOST', 'Bu işlemi yalnızca oda sahibi yapabilir.', true);
    }
    this.resetMatchToLobby(room);
    this.publishRoom(room);
  }

  disconnect(connectionId: string): void {
    const session = this.connections.get(connectionId);
    if (!session) return;
    const room = this.rooms.get(session.roomCode);
    const player = room?.players.get(session.playerId);
    if (!room || !player) return;
    if (player.role === 'SPECTATOR') {
      this.leaveRoom(connectionId);
      return;
    }
    this.connections.delete(connectionId);
    player.connected = false;
    player.ready = false;
    player.expiresAt = this.deps.now() + GAME.reconnectGraceMs;
    player.reconnectAnchor = null;
    room.inputs.delete(player.playerId);
    if (room.match?.players[player.playerId]) {
      this.publishMatchEvents(room, setPlayerConnected(room.match, player.playerId, false));
      room.combatHistory?.capture(room.match);
      this.reconcilePopulation(room);
    }
    if (room.hostPlayerId === player.playerId) this.migrateHost(room);
    this.publishRoom(room);
  }

  advance(elapsedMs: number): void {
    const now = this.deps.now();
    for (const room of [...this.rooms.values()]) {
      if (now - room.lastActivityAt >= this.resourceLimits.roomIdleTimeoutMs) {
        this.closeRoom(room);
        continue;
      }
      let membershipChanged = false;
      for (const player of [...room.players.values()]) {
        if (!player.connected && player.expiresAt !== null && player.expiresAt <= now) {
          const expiredHost = room.hostPlayerId === player.playerId;
          if (room.phase === 'RESULT') this.markResultPlayerLeft(room, player);
          if (room.match) removePulsesOwnedBy(room.match, player.playerId);
          room.players.delete(player.playerId);
          if (room.match) {
            delete room.match.players[player.playerId];
            delete room.match.scores[player.playerId];
          }
          room.network.delete(player.playerId);
          if (expiredHost) this.reassignHost(room);
          membershipChanged = true;
        }
      }
      if (![...room.players.values()].some((member) => member.botDifficulty === null)) {
        if (room.match) clearPulses(room.match);
        room.combatHistory?.clear();
        this.rooms.delete(room.roomCode);
        this.deps.publish({ type: 'ROOM_CLOSED', roomCode: room.roomCode });
        continue;
      }
      if (room.match && (room.phase === 'COUNTDOWN' || room.phase === 'MATCH')) {
        if (!this.reconcilePopulation(room)) continue;
      }
      if (membershipChanged) this.publishRoom(room);
      if (!room.match || (room.phase !== 'COUNTDOWN' && room.phase !== 'MATCH') || room.match.phase === 'PAUSED') continue;

      const elapsed = Number.isFinite(elapsedMs) ? Math.max(0, Math.min(elapsedMs, MAX_ELAPSED_MS)) : 0;
      room.accumulatorMs += elapsed;
      let steps = 0;
      while (room.accumulatorMs + TIMER_EPSILON_MS >= SIMULATION_STEP_MS && steps < MAX_STEPS_PER_ADVANCE) {
        for (const matchPlayer of Object.values(room.match.players)) {
          if (matchPlayer.respawnRemainingMs > 0 &&
            matchPlayer.respawnRemainingMs <= SIMULATION_STEP_MS + TIMER_EPSILON_MS) {
            matchPlayer.respawnRemainingMs = SIMULATION_STEP_MS;
          }
        }
        const stepDuration = room.match.phase === 'COUNTDOWN' &&
          room.match.countdownRemainingMs <= SIMULATION_STEP_MS + TIMER_EPSILON_MS
          ? room.match.countdownRemainingMs
          : SIMULATION_STEP_MS;
        if (room.bots.size > 0) {
          const observation = snapshotMatch(room.match);
          for (const [playerId, bot] of room.bots) room.inputs.set(playerId, bot.nextInput(observation));
        }
        let events = [...stepMatch(room.match, room.inputs, stepDuration, room.combatHistory ?? undefined)];
        events = this.finalizeReconnectAnchors(room, events);
        room.combatHistory?.capture(room.match);
        room.accumulatorMs -= SIMULATION_STEP_MS;
        room.snapshotAccumulatorMs += SIMULATION_STEP_MS;
        steps += 1;
        this.publishMatchEvents(room, events);
        if (room.match.phase === 'FINISHED') break;
        if (room.phase === 'COUNTDOWN' && room.match.phase === 'REGULATION') {
          room.phase = 'MATCH';
          this.publishRoom(room);
        }
        while (room.snapshotAccumulatorMs + TIMER_EPSILON_MS >= SNAPSHOT_INTERVAL_MS) {
          room.snapshotAccumulatorMs -= SNAPSHOT_INTERVAL_MS;
          this.publishSnapshot(room);
        }
      }
      if (Math.abs(room.accumulatorMs) < TIMER_EPSILON_MS) room.accumulatorMs = 0;
      if (Math.abs(room.snapshotAccumulatorMs) < TIMER_EPSILON_MS) room.snapshotAccumulatorMs = 0;
    }
  }

  private createRoomCode(): string {
    for (let attempt = 0; attempt < this.resourceLimits.roomCodeAttempts; attempt += 1) {
      const roomCode = [...this.deps.randomBytes(4)]
        .map((value) => ROOM_CODE_ALPHABET[value % ROOM_CODE_ALPHABET.length]).join('');
      if (!this.rooms.has(roomCode)) return roomCode;
    }
    throw new DomainError('SERVER_CAPACITY', 'Sunucu şu anda yeni oda oluşturamıyor.', true);
  }

  private assertRoomCreationAvailable(): void {
    if (this.rooms.size >= this.resourceLimits.maxRooms) {
      throw new DomainError('SERVER_CAPACITY', 'Sunucu oda kapasitesine ulaştı.', true);
    }
    const cutoff = this.deps.now() - this.resourceLimits.roomCreationWindowMs;
    while (this.roomCreationTimes[0] !== undefined && this.roomCreationTimes[0] <= cutoff) {
      this.roomCreationTimes.shift();
    }
    if (this.roomCreationTimes.length >= this.resourceLimits.roomCreationsPerWindow) {
      throw new DomainError('RATE_LIMITED', 'Çok hızlı oda oluşturuluyor.', true);
    }
  }

  private closeRoom(room: Room): void {
    if (room.match) clearPulses(room.match);
    room.combatHistory?.clear();
    this.rooms.delete(room.roomCode);
    for (const [connectionId, session] of this.connections) {
      if (session.roomCode === room.roomCode) this.connections.delete(connectionId);
    }
    this.deps.publish({ type: 'ROOM_CLOSED', roomCode: room.roomCode });
  }

  private lowestUnusedAccent(room: Room): PlayerAccent {
    const used = new Set([...room.players.values()].filter((player) => player.role === 'FIGHTER').map((player) => player.accent));
    for (let accent = 0; accent < GAME.maxPlayers; accent += 1) {
      if (!used.has(accent as PlayerAccent)) return accent as PlayerAccent;
    }
    throw new DomainError('ROOM_FULL', 'Oda dolu.', true);
  }

  private orderedPlayers(room: Room): RoomPlayer[] {
    return [...room.players.values()].sort((left, right) => left.order - right.order);
  }

  private migrateHost(room: Room): void {
    const successor = this.orderedPlayers(room).find((player) => player.botDifficulty === null && player.connected);
    if (successor) room.hostPlayerId = successor.playerId;
  }

  private reassignHost(room: Room): void {
    const successor = this.orderedPlayers(room).find((player) => player.botDifficulty === null && player.connected) ?? this.orderedPlayers(room).find((player) => player.botDifficulty === null);
    if (successor) room.hostPlayerId = successor.playerId;
  }

  private reconcilePopulation(room: Room): boolean {
    if (!room.match || (room.phase !== 'COUNTDOWN' && room.phase !== 'MATCH')) return true;
    const connectedCount = [...room.players.values()].filter((player) => player.role === 'FIGHTER' && player.connected).length;
    if (connectedCount >= GAME.minPlayers) {
      if (room.match.phase === 'PAUSED') this.publishMatchEvents(room, resumePausedMatch(room.match));
      return true;
    }
    const now = this.deps.now();
    const validReservations = [...room.players.values()].filter(
      (player) => player.role === 'FIGHTER' && !player.connected && player.expiresAt !== null && player.expiresAt > now
    );
    if (connectedCount + validReservations.length >= GAME.minPlayers) {
      const reconnectRemainingMs = Math.max(...validReservations.map((player) => player.expiresAt! - now));
      if (room.match.phase !== 'PAUSED') {
        this.publishMatchEvents(room, setMatchPaused(room.match, reconnectRemainingMs));
      } else {
        room.match.pauseRemainingMs = reconnectRemainingMs;
      }
      return true;
    }
    this.publishNoContest(room);
    return false;
  }

  private publishNoContest(room: Room): void {
    if (!room.match) return;
    if (room.match.phase !== 'PAUSED') setMatchPaused(room.match, 0);
    room.match.pauseRemainingMs = 0;
    const result = stepMatch(room.match, room.inputs, 0).find(
      (event): event is Extract<GameEvent, { type: 'RESULT' }> => event.type === 'RESULT' && event.reason === 'NO_CONTEST'
    );
    if (result) {
      this.deps.publish({
        type: 'MATCH_EVENT',
        roomCode: room.roomCode,
        matchEpoch: room.matchEpoch,
        event: result
      });
    }
    this.resetMatchToLobby(room);
    this.publishRoom(room);
  }

  private finalizeReconnectAnchors(room: Room, events: GameEvent[]): GameEvent[] {
    if (!room.match) return events;
    const replacements = new Map<string, Vec2>();
    for (const player of room.players.values()) {
      const matchPlayer = room.match.players[player.playerId];
      if (!player.reconnectAnchor || !matchPlayer || matchPlayer.respawnRemainingMs > 0) continue;
      matchPlayer.position = { ...player.reconnectAnchor };
      replacements.set(player.playerId, { ...player.reconnectAnchor });
      player.reconnectAnchor = null;
    }
    if (replacements.size === 0) return events;
    return events.map((event) => event.type === 'RESPAWN' && replacements.has(event.playerId)
      ? { ...event, position: { ...replacements.get(event.playerId)! } }
      : event);
  }

  private publishMatchEvents(room: Room, events: readonly GameEvent[]): void {
    for (const event of events) {
      this.deps.publish({ type: 'MATCH_EVENT', roomCode: room.roomCode, matchEpoch: room.matchEpoch, event });
    }
    if (room.match?.phase === 'FINISHED' && room.phase !== 'RESULT') this.enterResult(room);
  }

  private publishSnapshot(room: Room): void {
    if (!room.match) return;
    room.combatHistory?.capture(room.match!);
    this.deps.publish({
      type: 'MATCH_SNAPSHOT',
      roomCode: room.roomCode,
      matchEpoch: room.matchEpoch,
      eventCursor: room.match.nextEventId - 1,
      snapshot: this.snapshotForRoom(room)
    });
  }

  private enterResult(room: Room): void {
    if (!room.match) return;
    clearPulses(room.match);
    room.combatHistory?.clear();
    room.combatHistory = null;
    room.phase = 'RESULT';
    room.accumulatorMs = 0;
    room.snapshotAccumulatorMs = 0;
    room.resultPlayers = new Map();
    for (const player of room.players.values()) {
      const matchPlayer = room.match.players[player.playerId];
      if (matchPlayer) player.stats = { ...matchPlayer.stats };
      player.ready = player.botDifficulty !== null;
      player.reconnectAnchor = null;
      this.rememberResultPlayer(room, player);
    }
    this.publishRoom(room);
  }

  private resetMatchToLobby(room: Room): void {
    if (room.match) clearPulses(room.match);
    room.combatHistory?.clear();
    room.match = null;
    room.combatHistory = null;
    room.resultPlayers = null;
    room.phase = 'LOBBY';
    room.inputs.clear();
    room.bots.clear();
    room.accumulatorMs = 0;
    room.snapshotAccumulatorMs = 0;
    for (const player of room.players.values()) {
      player.ready = player.botDifficulty !== null;
      player.stats = emptyStats();
      player.reconnectAnchor = null;
    }
  }

  private pauseRemainingMs(room: Room): number | null {
    const now = this.deps.now();
    const deadlines = [...room.players.values()]
      .filter((player) => player.role === 'FIGHTER' && !player.connected && player.expiresAt !== null && player.expiresAt > now)
      .map((player) => player.expiresAt! - now);
    return deadlines.length > 0 ? Math.max(...deadlines) : null;
  }

  private runCombatScriptForTesting(roomCode: string, script: TestCombatScript): void {
    const room = this.requireRoom(roomCode);
    if (!room.match || room.phase !== 'MATCH' ||
      (room.match.phase !== 'REGULATION' && room.match.phase !== 'SUDDEN_DEATH')) {
      throw new Error('Test combat script requires an active match.');
    }
    const matchPlayerIds = Object.keys(room.match.players).sort();
    const stagedPlayerIds = script.players.map((player) => player.playerId).sort();
    if (matchPlayerIds.length !== stagedPlayerIds.length ||
      matchPlayerIds.some((playerId, index) => playerId !== stagedPlayerIds[index])) {
      throw new Error('Test combat script must stage every active match player exactly once.');
    }
    if (script.steps.length === 0 || script.steps.length > MAX_TEST_COMBAT_STEPS) {
      throw new RangeError(`Test combat script requires 1-${MAX_TEST_COMBAT_STEPS} steps.`);
    }

    const normalizedStages = script.players.map((stage) => {
      const withinBounds = stage.position.x >= 0 && stage.position.x <= ARENA.width &&
        stage.position.y >= 0 && stage.position.y <= ARENA.height;
      const facingLength = Math.hypot(stage.facing.x, stage.facing.y);
      if (!Number.isFinite(stage.position.x) || !Number.isFinite(stage.position.y) || !withinBounds ||
        !Number.isFinite(facingLength) || facingLength === 0 || !Number.isFinite(stage.overload) ||
        stage.overload < 0 || stage.overload > GAME.maxOverload) {
        throw new RangeError('Test combat script requires bounded position, facing, and overload values.');
      }
      return {
        ...stage,
        facing: { x: stage.facing.x / facingLength, y: stage.facing.y / facingLength }
      };
    });

    const inputSequences = new Map(matchPlayerIds.map((playerId) => [playerId, -1]));
    for (const step of script.steps) {
      if (!Number.isFinite(step.elapsedMs) || step.elapsedMs < 0 || step.elapsedMs > MAX_ELAPSED_MS) {
        throw new RangeError(`Test combat step duration must be between 0 and ${MAX_ELAPSED_MS} ms.`);
      }
      const stepPlayerIds = new Set<string>();
      for (const entry of step.inputs ?? []) {
        if (!room.match.players[entry.playerId] || stepPlayerIds.has(entry.playerId)) {
          throw new Error('Test combat step inputs require unique active player ids.');
        }
        const input = entry.input;
        if (!Number.isSafeInteger(input.seq) || input.seq <= inputSequences.get(entry.playerId)! ||
          !Number.isFinite(input.moveX) || !Number.isFinite(input.moveY) ||
          !Number.isFinite(input.aimX) || !Number.isFinite(input.aimY) ||
          typeof input.quick !== 'boolean' || typeof input.heavy !== 'boolean' || typeof input.dash !== 'boolean') {
          throw new RangeError('Test combat step inputs must be finite, monotonic input frames.');
        }
        stepPlayerIds.add(entry.playerId);
        inputSequences.set(entry.playerId, input.seq);
      }
    }

    if (!script.preservePulses) clearPulses(room.match);
    room.combatHistory?.clear();
    room.inputs.clear();
    room.accumulatorMs = 0;
    room.snapshotAccumulatorMs = 0;
    for (const stage of normalizedStages) {
      const player = room.match.players[stage.playerId];
      player.position = { ...stage.position };
      player.velocity = { x: 0, y: 0 };
      player.facing = { ...stage.facing };
      player.overload = stage.overload;
      player.comboStep = 0;
      player.attack = null;
      player.chargeMs = 0;
      player.charging = false;
      player.perfectDodgeConsumed = false;
      player.dashRemainingMs = 0;
      player.dashInvulnerabilityRemainingMs = 0;
      player.dashCooldownRemainingMs = 0;
      player.dashDirection = { ...stage.facing };
      player.hitstunRemainingMs = 0;
      player.respawnRemainingMs = 0;
      player.resetOverloadOnRespawn = false;
      player.protectionRemainingMs = 0;
      player.lastProcessedInputSeq = -1;
      player.latestInput = { ...createEmptyInput(), aimX: stage.facing.x, aimY: stage.facing.y };
      player.previousQuick = false;
      player.previousHeavy = false;
      player.previousDash = false;
      player.bufferedQuick = false;
      player.lastAttackerId = null;
      player.lastAttackerAtMs = null;
    }
    room.combatHistory?.capture(room.match);

    for (const step of script.steps) {
      for (const entry of step.inputs ?? []) room.inputs.set(entry.playerId, entry.input);
      let events = [...stepMatch(room.match, room.inputs, step.elapsedMs, room.combatHistory ?? undefined)];
      events = this.finalizeReconnectAnchors(room, events);
      room.combatHistory?.capture(room.match);
      this.publishMatchEvents(room, events);
      this.publishSnapshot(room);
      if (events.some((event) => event.type === 'RESULT')) break;
    }
  }

  private placePlayerForTesting(roomCode: string, playerId: string, position: Vec2, facing: Vec2): void {
    const room = this.requireRoom(roomCode);
    const player = room.match?.players[playerId];
    if (!player || room.phase !== 'MATCH') throw new Error('Test placement requires an active match player.');
    const withinTestBounds = position.x >= 0 && position.x <= ARENA.width && position.y >= 0 && position.y <= ARENA.height;
    const facingLength = Math.hypot(facing.x, facing.y);
    if (!Number.isFinite(position.x) || !Number.isFinite(position.y) || !withinTestBounds ||
      !Number.isFinite(facingLength) || facingLength === 0) {
      throw new RangeError('Test placement requires bounded finite position and facing values.');
    }
    const normalizedFacing = { x: facing.x / facingLength, y: facing.y / facingLength };
    player.position = { x: position.x, y: position.y };
    player.velocity = { x: 0, y: 0 };
    player.facing = normalizedFacing;
    player.latestInput = {
      ...player.latestInput,
      moveX: 0,
      moveY: 0,
      aimX: normalizedFacing.x,
      aimY: normalizedFacing.y,
      quick: false,
      heavy: false,
      dash: false
    };
    player.previousQuick = false;
    player.previousHeavy = false;
    player.previousDash = false;
    room.inputs.delete(playerId);
    const match = room.match;
    if (match) room.combatHistory?.capture(match);
    this.publishSnapshot(room);
  }

  private assertConnectionAvailable(connectionId: string): void {
    if (this.connections.has(connectionId)) {
      throw new DomainError('ALREADY_IN_ROOM', 'Bu bağlantı zaten bir odada.', true);
    }
    if (this.connections.size >= this.resourceLimits.maxConnections) {
      throw new DomainError('SERVER_CAPACITY', 'Sunucu bağlantı kapasitesine ulaştı.', true);
    }
  }

  private normalizeName(name: string): string {
    try {
      return normalizePlayerName(name);
    } catch {
      throw new DomainError('INVALID_NAME', 'Oyuncu adı 2–16 görünür karakter olmalıdır.', true);
    }
  }

  private requireRoom(roomCode: string): Room {
    let normalized: string;
    try {
      normalized = normalizeRoomCode(roomCode);
    } catch {
      throw new DomainError('INVALID_ROOM_CODE', 'Oda kodu geçersiz.', true);
    }
    const room = this.rooms.get(normalized);
    if (!room) throw new DomainError('ROOM_NOT_FOUND', 'Oda bulunamadı.', true);
    return room;
  }

  private parseResumeToken(value: string): Uint8Array {
    if (!/^[0-9a-f]{64}$/iu.test(value)) {
      throw new DomainError('INVALID_RESUME_TOKEN', 'Yeniden bağlanma anahtarı geçersiz veya süresi dolmuş.', true);
    }
    return Uint8Array.from(value.match(/.{2}/g)!, byte => Number.parseInt(byte, 16));
  }

  private requireConnectedPlayer(connectionId: string): { room: Room; player: RoomPlayer } {
    const session = this.connections.get(connectionId);
    const room = session ? this.rooms.get(session.roomCode) : undefined;
    const player = session ? room?.players.get(session.playerId) : undefined;
    if (!room || !player || !player.connected) {
      throw new DomainError('PLAYER_NOT_FOUND', 'Oyuncu oturumu bulunamadı.', true);
    }
    room.lastActivityAt = this.deps.now();
    return { room, player };
  }

  private rememberResultPlayer(room: Room, player: RoomPlayer): void {
    if (player.role !== 'FIGHTER' || !room.resultPlayers || room.resultPlayers.has(player.playerId)) return;
    room.resultPlayers.set(player.playerId, {
      playerId: player.playerId,
      role: player.role,
      botDifficulty: player.botDifficulty,
      name: player.name,
      chassis: player.chassis,
      accent: player.accent,
      stats: { ...(room.match?.players[player.playerId]?.stats ?? player.stats) },
      order: player.order,
      left: false
    });
  }

  private markResultPlayerLeft(room: Room, player: RoomPlayer): void {
    const resultPlayer = room.resultPlayers?.get(player.playerId);
    if (resultPlayer) resultPlayer.left = true;
  }

  private publishedResultPlayers(room: Room): readonly ResultPlayer[] {
    return [...(room.resultPlayers?.values() ?? [])]
      .sort((left, right) => left.order - right.order)
      .map((resultPlayer) => {
        const livePlayer = room.players.get(resultPlayer.playerId);
        if (resultPlayer.left || !livePlayer) {
          return {
            role: resultPlayer.role,
            botDifficulty: resultPlayer.botDifficulty,
            playerId: resultPlayer.playerId,
            name: resultPlayer.name,
            chassis: resultPlayer.chassis,
            accent: resultPlayer.accent,
            ready: false,
            connected: false,
            reconnectRemainingMs: null,
            stats: { ...resultPlayer.stats },
            resultStatus: 'LEFT' as const
          };
        }
        return {
          role: resultPlayer.role,
          botDifficulty: resultPlayer.botDifficulty,
          playerId: resultPlayer.playerId,
          name: resultPlayer.name,
          chassis: resultPlayer.chassis,
          accent: resultPlayer.accent,
          ready: livePlayer.ready,
          connected: livePlayer.connected,
          reconnectRemainingMs: livePlayer.connected || livePlayer.expiresAt === null
            ? null
            : Math.max(0, livePlayer.expiresAt - this.deps.now()),
          stats: { ...resultPlayer.stats },
          resultStatus: livePlayer.ready ? 'READY' as const : 'WAITING' as const
        };
      });
  }

  private publishRoom(room: Room): void {
    const result = room.phase === 'RESULT' && room.match?.resultReason
      ? {
          winnerPlayerId: room.match.winnerPlayerId,
          reason: room.match.resultReason,
          players: this.publishedResultPlayers(room)
        }
      : null;
    this.deps.publish({
      type: 'ROOM_STATE',
      roomCode: room.roomCode,
      state: {
        roomCode: room.roomCode,
        phase: room.phase,
        hostPlayerId: room.hostPlayerId,
        pauseRemainingMs: room.match?.phase === 'PAUSED' ? this.pauseRemainingMs(room) : null,
        result,
        settings: { ...room.settings },
        players: this.orderedPlayers(room).map((player) => ({
          role: player.role,
          botDifficulty: player.botDifficulty,
          playerId: player.playerId,
          name: player.name,
          chassis: player.chassis,
          accent: player.accent,
          ready: player.ready,
          connected: player.connected,
          reconnectRemainingMs: player.connected || player.expiresAt === null
            ? null
            : Math.max(0, player.expiresAt - this.deps.now()),
          stats: { ...(room.match?.players[player.playerId]?.stats ?? player.stats) }
        }))
      }
    });
  }

  private snapshotForRoom(room: Room): MatchSnapshot {
    const now = this.deps.now();
    const network = Object.fromEntries(
      Object.keys(room.match!.players)
        .filter((playerId) => room.players.get(playerId)?.botDifficulty === null)
        .sort()
        .map((playerId) => [playerId, networkStatus(room.network.get(playerId) ?? createNetworkRuntime(), now)])
    );
    const snapshot = snapshotMatch(room.match!, network);
    return {
      ...snapshot,
      network
    };
  }
}
