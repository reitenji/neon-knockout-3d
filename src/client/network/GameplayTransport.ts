import { z } from 'zod';
import { GAME } from '../../shared/constants.js';
import {
  ACTIVATION_TIMEOUT_MS,
  CLIENT_MESSAGE_LIMIT_BYTES,
  FAST_CHANNEL_LABEL,
  FAST_CHANNEL_MAX_BUFFERED_BYTES,
  GAMEPLAY_PROTOCOL_VERSION,
  HEARTBEAT_INTERVAL_MS,
  ICE_GATHER_TIMEOUT_MS,
  MISSED_HEARTBEATS_BEFORE_FALLBACK,
  RELIABLE_CHANNEL_LABEL,
  type ClientFastMessage,
  type ClientReliableMessage,
  type MatchEventPublication,
  type MatchSnapshotPublication,
  type MatchStartedPublication,
  type RtcActivationRequest,
  type RtcNegotiationAnswer,
  type RtcNegotiationRequest,
  type TransportModeNotice
} from '../../shared/gameplayTransport.js';
import { CHASSIS, type Ack, type InputFrame } from '../../shared/model.js';
import type { createMatchPublicationSequencer } from './MatchPublicationSequencer.js';

type MatchPublicationSequencer = ReturnType<typeof createMatchPublicationSequencer>;
type SocketMode = 'websocket' | 'polling';
type GameplayFallbackReason =
  | 'edgeAckTimeout'
  | 'heartbeatGap'
  | 'channelClose'
  | 'sendFailure'
  | 'modeNotice'
  | 'activationTimeout'
  | 'activationFailure'
  | 'transportGap';

type GameplayTransportOptions = Readonly<{
  createPeer?: () => RTCPeerConnection;
  negotiate: (request: RtcNegotiationRequest) => Promise<Ack<RtcNegotiationAnswer>>;
  activate: (request: RtcActivationRequest) => Promise<Ack<TransportModeNotice>>;
  notifyFallback: () => void;
  sendFallbackInput: (input: InputFrame) => void;
  sequencer: MatchPublicationSequencer;
  now?: () => number;
}>;

type ChannelReadyState = Readonly<{
  promise: Promise<boolean>;
  resolve: (ready: boolean) => void;
}>;

type CancellationState = Readonly<{
  promise: Promise<void>;
  cancel: () => void;
}>;

type Generation = {
  readonly generationId: string;
  readonly peer: RTCPeerConnection;
  readonly fast: RTCDataChannel;
  readonly reliable: RTCDataChannel;
  readonly channelsReady: ChannelReadyState;
  readonly cancellation: CancellationState;
  readonly pendingCancellations: Set<() => void>;
  socketMode: SocketMode;
  mode: 'webrtc' | SocketMode;
  matchEpoch: number | null;
  heartbeatDeadline: number | null;
  heartbeatTimer: ReturnType<typeof setTimeout> | null;
  activationDeadline: number;
  activationTimer: ReturnType<typeof setTimeout> | null;
  failed: boolean;
  fallbackNotified: boolean;
  lastSentInput: InputFrame | null;
  pendingQuickSeq: number | null;
  pendingDashSeq: number | null;
  edgeAckTimer: ReturnType<typeof setTimeout> | null;
  edgeAckTimeoutMs: number;
  edgeInputReplayed: boolean;
};

const encoder = new TextEncoder();
const HEARTBEAT_GAP_MS = HEARTBEAT_INTERVAL_MS * MISSED_HEARTBEATS_BEFORE_FALLBACK;
const DEFAULT_INPUT_EDGE_ACK_TIMEOUT_MS = 250;
const MAX_INPUT_EDGE_ACK_TIMEOUT_MS = 1_000;
const TICK_MS = 1_000 / GAME.tickRate;
const CANCELLED = Symbol('cancelled');
const finiteNumberSchema = z.number().finite();
const nonNegativeIntegerSchema = z.number().int().nonnegative();
const nullableFiniteNumberSchema = finiteNumberSchema.nullable();
const vec2Schema = z.object({ x: finiteNumberSchema, y: finiteNumberSchema }).strict();
const scoresSchema = z.record(z.string(), nonNegativeIntegerSchema);
const roomSettingsSchema = z.object({
  durationMs: z.union([z.literal(90_000), z.literal(120_000), z.literal(180_000)]),
  knockoutTarget: z.union([z.literal(3), z.literal(5), z.literal(7), z.literal(10)])
}).strict();
const playerStatsSchema = z.object({
  knockouts: nonNegativeIntegerSchema,
  falls: nonNegativeIntegerSchema,
  landedHits: nonNegativeIntegerSchema,
  completedAttacks: nonNegativeIntegerSchema
}).strict();
const matchActionSchema = z.object({
  kind: z.enum(['QUICK_1', 'QUICK_2', 'QUICK_3', 'HEAVY', 'DASH', 'HITSTUN', 'RESPAWNING']).nullable(),
  phase: z.enum(['IDLE', 'WINDUP', 'ACTIVE', 'RECOVERY']),
  comboStep: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]),
  chargeMs: finiteNumberSchema,
  charging: z.boolean(),
  attackId: nonNegativeIntegerSchema.nullable(),
  profileId: z.enum(['quick-1', 'quick-2', 'quick-3', 'heavy-melee']).nullable(),
  lockedFacing: vec2Schema.nullable(),
  activeProgress: finiteNumberSchema,
  hitTargetIds: z.array(z.string())
}).strict();
const matchPlayerSchema = z.object({
  playerId: z.string(),
  name: z.string(),
  chassis: z.enum(CHASSIS),
  accent: z.union([
    z.literal(0), z.literal(1), z.literal(2), z.literal(3),
    z.literal(4), z.literal(5), z.literal(6), z.literal(7)
  ]),
  position: vec2Schema,
  velocity: vec2Schema,
  facing: vec2Schema,
  overload: finiteNumberSchema,
  lastProcessedInputSeq: z.number().int().finite(),
  action: matchActionSchema,
  dashRemainingMs: finiteNumberSchema,
  dashCooldownRemainingMs: finiteNumberSchema,
  hitstunRemainingMs: finiteNumberSchema,
  respawnRemainingMs: finiteNumberSchema,
  protectionRemainingMs: finiteNumberSchema,
  stats: playerStatsSchema
}).strict();
const matchPulseSchema = z.object({
  projectileId: nonNegativeIntegerSchema,
  ownerPlayerId: z.string(),
  originatingAttackId: nonNegativeIntegerSchema,
  position: vec2Schema,
  velocity: vec2Schema,
  radius: finiteNumberSchema,
  remainingMs: finiteNumberSchema,
  hitTargetIds: z.array(z.string())
}).strict();
const networkStatusSchema = z.object({
  currentMs: nullableFiniteNumberSchema,
  medianMs: nullableFiniteNumberSchema,
  jitterMs: nullableFiniteNumberSchema,
  transport: z.enum(['webrtc', 'websocket', 'polling'])
}).strict();
const matchSnapshotSchema = z.object({
  tick: nonNegativeIntegerSchema,
  phase: z.enum(['COUNTDOWN', 'REGULATION', 'PAUSED', 'SUDDEN_DEATH', 'FINISHED']),
  remainingMs: finiteNumberSchema,
  platformProgress: finiteNumberSchema,
  settings: roomSettingsSchema,
  scores: scoresSchema,
  network: z.record(z.string(), networkStatusSchema),
  players: z.array(matchPlayerSchema),
  pulses: z.array(matchPulseSchema),
  winnerPlayerId: z.string().nullable(),
  resultReason: z.enum(['TARGET_SCORE', 'TIME', 'SUDDEN_DEATH', 'NO_CONTEST']).nullable()
}).strict();
const eventMetadataShape = {
  eventId: nonNegativeIntegerSchema,
  tick: nonNegativeIntegerSchema
} as const;
const hitSourceSchema = z.enum(['QUICK_1', 'QUICK_2', 'QUICK_3', 'HEAVY', 'NEON_PULSE']);
const gameEventSchema = z.discriminatedUnion('type', [
  z.object({
    ...eventMetadataShape,
    type: z.literal('HIT'),
    attackerId: z.string(),
    targetId: z.string(),
    attack: hitSourceSchema,
    impactPosition: vec2Schema,
    impulse: finiteNumberSchema,
    resultingOverload: finiteNumberSchema
  }).strict(),
  z.object({
    ...eventMetadataShape,
    type: z.literal('CLASH'),
    playerIds: z.tuple([z.string(), z.string()]),
    attackIds: z.tuple([nonNegativeIntegerSchema, nonNegativeIntegerSchema]),
    impactPosition: vec2Schema,
    strength: z.enum(['QUICK', 'HEAVY'])
  }).strict(),
  z.object({
    ...eventMetadataShape,
    type: z.literal('PERFECT_DODGE'),
    playerId: z.string(),
    attackerId: z.string(),
    attackId: nonNegativeIntegerSchema,
    source: hitSourceSchema,
    projectileId: nonNegativeIntegerSchema.nullable(),
    impactPosition: vec2Schema,
    refundedMs: finiteNumberSchema
  }).strict(),
  z.object({
    ...eventMetadataShape,
    type: z.literal('PULSE_SPAWN'),
    projectileId: nonNegativeIntegerSchema,
    ownerPlayerId: z.string(),
    originatingAttackId: nonNegativeIntegerSchema,
    position: vec2Schema
  }).strict(),
  z.object({
    ...eventMetadataShape,
    type: z.literal('PULSE_BREAK'),
    projectileId: nonNegativeIntegerSchema,
    breakerPlayerId: z.string(),
    breakerAttackId: nonNegativeIntegerSchema,
    impactPosition: vec2Schema
  }).strict(),
  z.object({
    ...eventMetadataShape,
    type: z.literal('KNOCKOUT'),
    attackerId: z.string().nullable(),
    targetId: z.string(),
    scoreAwardedTo: z.string().nullable(),
    scores: scoresSchema
  }).strict(),
  z.object({
    ...eventMetadataShape,
    type: z.literal('RESPAWN'),
    playerId: z.string(),
    position: vec2Schema
  }).strict(),
  z.object({
    ...eventMetadataShape,
    type: z.literal('PHASE'),
    phase: z.enum(['COUNTDOWN', 'REGULATION', 'PAUSED', 'SUDDEN_DEATH', 'FINISHED']),
    remainingMs: finiteNumberSchema
  }).strict(),
  z.object({
    ...eventMetadataShape,
    type: z.literal('RESULT'),
    winnerPlayerId: z.string().nullable(),
    reason: z.enum(['TARGET_SCORE', 'TIME', 'SUDDEN_DEATH', 'NO_CONTEST']),
    scores: scoresSchema
  }).strict()
]);
const matchStartedPublicationSchema = z.object({
  matchEpoch: nonNegativeIntegerSchema,
  eventCursor: nonNegativeIntegerSchema,
  snapshot: matchSnapshotSchema
}).strict();
const matchEventPublicationSchema = z.object({
  matchEpoch: nonNegativeIntegerSchema,
  event: gameEventSchema
}).strict();
const serverFastMessageSchema = z.discriminatedUnion('kind', [
  z.object({
    version: z.literal(GAMEPLAY_PROTOCOL_VERSION),
    generationId: z.string().uuid(),
    kind: z.literal('snapshot'),
    payload: matchStartedPublicationSchema
  }).strict(),
  z.object({
    version: z.literal(GAMEPLAY_PROTOCOL_VERSION),
    generationId: z.string().uuid(),
    kind: z.literal('probe'),
    nonce: nonNegativeIntegerSchema
  }).strict()
]);
const serverReliableMessageSchema = z.discriminatedUnion('kind', [
  z.object({
    version: z.literal(GAMEPLAY_PROTOCOL_VERSION),
    generationId: z.string().uuid(),
    kind: z.literal('started'),
    payload: matchStartedPublicationSchema
  }).strict(),
  z.object({
    version: z.literal(GAMEPLAY_PROTOCOL_VERSION),
    generationId: z.string().uuid(),
    kind: z.literal('event'),
    payload: matchEventPublicationSchema
  }).strict(),
  z.object({
    version: z.literal(GAMEPLAY_PROTOCOL_VERSION),
    generationId: z.string().uuid(),
    kind: z.literal('heartbeat'),
    nonce: nonNegativeIntegerSchema
  }).strict()
]);

function deferredChannelReady(): ChannelReadyState {
  let settled = false;
  let settle: (ready: boolean) => void = () => undefined;
  const promise = new Promise<boolean>((resolve) => {
    settle = resolve;
  });
  return {
    promise,
    resolve: (ready) => {
      if (settled) return;
      settled = true;
      settle(ready);
    }
  };
}

function deferredCancellation(): CancellationState {
  let cancelled = false;
  let cancelPromise: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    cancelPromise = resolve;
  });
  return {
    promise,
    cancel: () => {
      if (cancelled) return;
      cancelled = true;
      cancelPromise();
    }
  };
}

function parseJson(value: unknown): unknown {
  if (typeof value !== 'string') return null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function createGenerationId(): string | null {
  const cryptoApi: Partial<Crypto> | undefined = globalThis.crypto;
  if (cryptoApi === undefined) return null;
  if (typeof cryptoApi.randomUUID === 'function') {
    try {
      const generationId = cryptoApi.randomUUID();
      if (z.string().uuid().safeParse(generationId).success) return generationId;
    } catch {
      // Private HTTP may expose crypto without randomUUID.
    }
  }
  if (typeof cryptoApi.getRandomValues !== 'function') return null;
  try {
    const bytes = new Uint8Array(16);
    cryptoApi.getRandomValues(bytes);
    bytes[6] = (bytes[6]! & 0x0f) | 0x40;
    bytes[8] = (bytes[8]! & 0x3f) | 0x80;
    const hex = Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  } catch {
    return null;
  }
}

export function createGameplayTransport(options: GameplayTransportOptions): Readonly<{
  start(): Promise<void>;
  acceptMode(notice: TransportModeNotice): void;
  acceptSocketStarted(value: MatchStartedPublication): void;
  acceptSocketSnapshot(value: MatchSnapshotPublication): void;
  acceptSocketEvent(value: MatchEventPublication): void;
  acceptAuthoritativeSnapshot(snapshot: MatchSnapshotPublication['snapshot'], localPlayerId: string): void;
  sendInput(input: InputFrame): boolean;
  fallback(): void;
  dispose(): void;
}> {
  const now = options.now ?? Date.now;
  let current: Generation | null = null;

  function isCurrent(generation: Generation): boolean {
    return current === generation && !generation.failed;
  }

  function clearHeartbeat(generation: Generation): void {
    generation.heartbeatDeadline = null;
    if (generation.heartbeatTimer !== null) {
      clearTimeout(generation.heartbeatTimer);
      generation.heartbeatTimer = null;
    }
  }

  function clearActivationDeadline(generation: Generation): void {
    if (generation.activationTimer === null) return;
    clearTimeout(generation.activationTimer);
    generation.activationTimer = null;
  }

  function hasPendingEdge(generation: Generation): boolean {
    return generation.pendingQuickSeq !== null || generation.pendingDashSeq !== null;
  }

  function clearEdgeAckDeadline(generation: Generation): void {
    if (generation.edgeAckTimer === null) return;
    clearTimeout(generation.edgeAckTimer);
    generation.edgeAckTimer = null;
  }

  function latchedInput(generation: Generation, input: InputFrame): InputFrame {
    if (!hasPendingEdge(generation)) return input;
    return {
      ...input,
      quick: input.quick || generation.pendingQuickSeq !== null,
      dash: input.dash || generation.pendingDashSeq !== null
    };
  }

  function detachAndClose(generation: Generation, clearCurrent: boolean): void {
    generation.failed = true;
    clearHeartbeat(generation);
    clearActivationDeadline(generation);
    generation.cancellation.cancel();
    for (const cancel of [...generation.pendingCancellations]) cancel();
    generation.pendingCancellations.clear();
    generation.channelsReady.resolve(false);
    generation.fast.onopen = null;
    generation.fast.onmessage = null;
    generation.fast.onclose = null;
    generation.fast.onerror = null;
    generation.reliable.onopen = null;
    generation.reliable.onmessage = null;
    generation.reliable.onclose = null;
    generation.reliable.onerror = null;
    generation.peer.onicegatheringstatechange = null;
    generation.peer.onconnectionstatechange = null;
    try {
      if (generation.fast.readyState !== 'closed') generation.fast.close();
    } catch {
      // The peer close below remains the authoritative cleanup path.
    }
    try {
      if (generation.reliable.readyState !== 'closed') generation.reliable.close();
    } catch {
      // The peer close below remains the authoritative cleanup path.
    }
    try {
      generation.peer.close();
    } catch {
      // A failed browser peer is already unusable.
    }
    if (clearCurrent) {
      clearEdgeAckDeadline(generation);
      generation.pendingQuickSeq = null;
      generation.pendingDashSeq = null;
      if (current === generation) current = null;
    }
  }

  function sendLatchedFallbackInput(generation: Generation, input: InputFrame): boolean {
    try {
      options.sendFallbackInput(latchedInput(generation, input));
      generation.lastSentInput = input;
      return true;
    } catch {
      return false;
    }
  }

  function recordFallbackReason(generation: Generation, reason: GameplayFallbackReason): void {
    const candidate = (globalThis as typeof globalThis & {
      __NEON_E2E_INPUT_OBSERVER__?: unknown;
    }).__NEON_E2E_INPUT_OBSERVER__;
    if (typeof candidate !== 'object' || candidate === null) return;
    const reasons = (candidate as {
      fallbackReasons?: Array<Readonly<{
        reason: GameplayFallbackReason;
        atMs: number;
        pendingQuickSeq: number | null;
        pendingDashSeq: number | null;
        edgeAckTimeoutMs: number;
        lastSentInputSeq: number | null;
      }>>;
    }).fallbackReasons;
    if (!Array.isArray(reasons)) return;
    reasons.push({
      reason,
      atMs: now(),
      pendingQuickSeq: generation.pendingQuickSeq,
      pendingDashSeq: generation.pendingDashSeq,
      edgeAckTimeoutMs: generation.edgeAckTimeoutMs,
      lastSentInputSeq: generation.lastSentInput?.seq ?? null
    });
    if (reasons.length > 20) reasons.splice(0, reasons.length - 20);
  }

  function localFallback(
    generation: Generation,
    reason: GameplayFallbackReason,
    input?: InputFrame
  ): boolean {
    if (current !== generation || generation.fallbackNotified) return false;
    generation.mode = generation.socketMode;
    generation.fallbackNotified = true;
    recordFallbackReason(generation, reason);
    clearEdgeAckDeadline(generation);
    const replayed = replayEdgeInput(generation, input);
    detachAndClose(generation, false);
    try {
      options.notifyFallback();
    } catch {
      // Input arbitration is already on Socket.IO even if the notice cannot be emitted.
    }
    return replayed;
  }

  function replayEdgeInput(generation: Generation, input?: InputFrame): boolean {
    if (!hasPendingEdge(generation)) return false;
    if (generation.edgeInputReplayed && input === undefined) return true;
    generation.edgeInputReplayed = true;
    const candidate = input ?? generation.lastSentInput;
    return candidate === null ? false : sendLatchedFallbackInput(generation, candidate);
  }

  function scheduleEdgeAckDeadline(generation: Generation): void {
    if (generation.edgeAckTimer !== null || !hasPendingEdge(generation)) return;
    generation.edgeAckTimer = setTimeout(() => {
      generation.edgeAckTimer = null;
      if (current === generation && hasPendingEdge(generation)) localFallback(generation, 'edgeAckTimeout');
    }, generation.edgeAckTimeoutMs);
  }

  function edgeAckTimeoutMs(snapshot: MatchSnapshotPublication['snapshot'], localPlayerId: string): number {
    const sample = snapshot.network[localPlayerId];
    if (
      sample?.transport !== 'webrtc'
      || sample.medianMs === null
      || sample.jitterMs === null
    ) return DEFAULT_INPUT_EDGE_ACK_TIMEOUT_MS;
    const adaptiveTimeoutMs = 2 * Math.max(0, sample.medianMs)
      + 2 * Math.max(0, sample.jitterMs)
      + 2 * TICK_MS;
    return Math.min(
      MAX_INPUT_EDGE_ACK_TIMEOUT_MS,
      Math.max(DEFAULT_INPUT_EDGE_ACK_TIMEOUT_MS, Math.ceil(adaptiveTimeoutMs))
    );
  }

  function scheduleActivationDeadline(generation: Generation): void {
    const remaining = Math.max(0, generation.activationDeadline - now());
    generation.activationTimer = setTimeout(() => localFallback(generation, 'activationTimeout'), remaining);
  }

  async function waitForGeneration<T>(generation: Generation, operation: () => Promise<T>): Promise<T | typeof CANCELLED> {
    if (!isCurrent(generation)) return CANCELLED;
    const cancelled = generation.cancellation.promise.then((): typeof CANCELLED => CANCELLED);
    return await Promise.race<T | typeof CANCELLED>([
      operation(),
      cancelled
    ]);
  }

  function scheduleHeartbeatGap(generation: Generation): void {
    if (!isCurrent(generation) || generation.mode !== 'webrtc') return;
    clearHeartbeat(generation);
    generation.heartbeatDeadline = now() + HEARTBEAT_GAP_MS;

    const check = (): void => {
      if (!isCurrent(generation) || generation.mode !== 'webrtc' || generation.heartbeatDeadline === null) return;
      const remaining = generation.heartbeatDeadline - now();
      if (remaining <= 0) {
        localFallback(generation, 'heartbeatGap');
        return;
      }
      generation.heartbeatTimer = setTimeout(check, remaining);
    };
    generation.heartbeatTimer = setTimeout(check, HEARTBEAT_GAP_MS);
  }

  function acceptModeFor(generation: Generation, notice: TransportModeNotice): void {
    if (current !== generation || notice.generationId !== generation.generationId) return;
    if (notice.mode === 'webrtc') {
      if (
        generation.failed
        || generation.fast.readyState !== 'open'
        || generation.reliable.readyState !== 'open'
      ) return;
      generation.mode = 'webrtc';
      clearActivationDeadline(generation);
      scheduleHeartbeatGap(generation);
      return;
    }

    generation.socketMode = notice.mode;
    generation.mode = notice.mode;
    generation.fallbackNotified = true;
    recordFallbackReason(generation, 'modeNotice');
    clearEdgeAckDeadline(generation);
    replayEdgeInput(generation);
    if (!generation.failed) detachAndClose(generation, false);
  }

  function acceptFastMessage(generation: Generation, event: MessageEvent): void {
    if (!isCurrent(generation) || generation.mode !== 'webrtc') return;
    const parsed = serverFastMessageSchema.safeParse(parseJson(event.data));
    if (!parsed.success || parsed.data.generationId !== generation.generationId) return;
    if (parsed.data.kind === 'probe') {
      sendFastProbeAck(generation, parsed.data.nonce);
      return;
    }
    options.sequencer.acceptSnapshot(parsed.data.payload);
  }

  function sendFastProbeAck(generation: Generation, nonce: number): void {
    if (generation.fast.readyState !== 'open') return;
    if (generation.fast.bufferedAmount > FAST_CHANNEL_MAX_BUFFERED_BYTES) return;
    const acknowledgement: ClientFastMessage = {
      version: GAMEPLAY_PROTOCOL_VERSION,
      generationId: generation.generationId,
      kind: 'probe-ack',
      nonce
    };
    try {
      generation.fast.send(JSON.stringify(acknowledgement));
    } catch {
      // Lost probe acks are non-fatal; the reliable heartbeat still owns liveness.
    }
  }

  function sendHeartbeatAck(generation: Generation, nonce: number): void {
    if (generation.reliable.readyState !== 'open') {
      localFallback(generation, 'sendFailure');
      return;
    }
    const acknowledgement: ClientReliableMessage = {
      version: GAMEPLAY_PROTOCOL_VERSION,
      generationId: generation.generationId,
      kind: 'heartbeat-ack',
      nonce
    };
    try {
      generation.reliable.send(JSON.stringify(acknowledgement));
    } catch {
      localFallback(generation, 'sendFailure');
    }
  }

  function acceptReliableMessage(generation: Generation, event: MessageEvent): void {
    if (!isCurrent(generation) || generation.mode !== 'webrtc') return;
    const parsed = serverReliableMessageSchema.safeParse(parseJson(event.data));
    if (!parsed.success || parsed.data.generationId !== generation.generationId) return;
    const message = parsed.data;

    if (message.kind === 'heartbeat') {
      scheduleHeartbeatGap(generation);
      sendHeartbeatAck(generation, message.nonce);
      return;
    }
    if (message.kind === 'started') {
      generation.matchEpoch = message.payload.matchEpoch;
      options.sequencer.acceptStarted(message.payload);
      return;
    }
    options.sequencer.acceptEvent(message.payload);
  }

  function bindGeneration(generation: Generation): void {
    const checkChannels = (): void => {
      if (
        isCurrent(generation)
        && generation.fast.readyState === 'open'
        && generation.reliable.readyState === 'open'
      ) generation.channelsReady.resolve(true);
    };
    generation.fast.onopen = checkChannels;
    generation.reliable.onopen = checkChannels;
    generation.fast.onmessage = (event) => acceptFastMessage(generation, event);
    generation.reliable.onmessage = (event) => acceptReliableMessage(generation, event);
    generation.fast.onclose = () => localFallback(generation, 'channelClose');
    generation.fast.onerror = () => localFallback(generation, 'channelClose');
    generation.reliable.onclose = () => localFallback(generation, 'channelClose');
    generation.reliable.onerror = () => localFallback(generation, 'channelClose');
    generation.peer.onconnectionstatechange = () => {
      if (
        generation.peer.connectionState === 'closed'
        || generation.peer.connectionState === 'failed'
        || generation.peer.connectionState === 'disconnected'
      ) localFallback(generation, 'channelClose');
    };
    checkChannels();
  }

  function waitForIceGathering(generation: Generation): Promise<void> {
    if (generation.peer.iceGatheringState === 'complete') return Promise.resolve();
    return new Promise((resolve) => {
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        generation.pendingCancellations.delete(finish);
        if (generation.peer.onicegatheringstatechange === onStateChange) {
          generation.peer.onicegatheringstatechange = null;
        }
        resolve();
      };
      const onStateChange = (): void => {
        if (generation.peer.iceGatheringState === 'complete') finish();
      };
      const timer = setTimeout(finish, ICE_GATHER_TIMEOUT_MS);
      generation.pendingCancellations.add(finish);
      generation.peer.onicegatheringstatechange = onStateChange;
    });
  }

  async function activateGeneration(generation: Generation): Promise<void> {
    const ready = await waitForGeneration(generation, () => generation.channelsReady.promise);
    if (ready === CANCELLED || !ready || !isCurrent(generation)) return;
    const acknowledgement = await waitForGeneration(generation, () => options.activate({
      generationId: generation.generationId
    }));
    if (acknowledgement === CANCELLED || !isCurrent(generation)) return;
    if (
      !acknowledgement.ok
      || acknowledgement.data.generationId !== generation.generationId
    ) {
      localFallback(generation, 'activationFailure');
      return;
    }
    acceptModeFor(generation, acknowledgement.data);
    if (acknowledgement.data.mode !== 'webrtc') localFallback(generation, 'modeNotice');
  }

  async function start(): Promise<void> {
    let ownedGeneration: Generation | null = null;
    try {
      if (current !== null) detachAndClose(current, true);
      const createPeer = options.createPeer ?? (
        typeof RTCPeerConnection === 'undefined'
          ? null
          : () => new RTCPeerConnection({ iceServers: [] })
      );
      if (createPeer === null) return;
      const generationId = createGenerationId();
      if (generationId === null) return;
      const activationDeadline = now() + ACTIVATION_TIMEOUT_MS;

      let peer: RTCPeerConnection | null = null;
      let fast: RTCDataChannel | null = null;
      let reliable: RTCDataChannel | null = null;
      try {
        peer = createPeer();
        fast = peer.createDataChannel(FAST_CHANNEL_LABEL, { ordered: false, maxRetransmits: 0 });
        reliable = peer.createDataChannel(RELIABLE_CHANNEL_LABEL, { ordered: true });
      } catch {
        try {
          fast?.close();
        } catch {
          // A partially created channel has no remaining owner.
        }
        try {
          reliable?.close();
        } catch {
          // A partially created channel has no remaining owner.
        }
        try {
          peer?.close();
        } catch {
          // A partially created peer has no remaining owner.
        }
        return;
      }

      const generation: Generation = {
        generationId,
        peer,
        fast,
        reliable,
        channelsReady: deferredChannelReady(),
        cancellation: deferredCancellation(),
        pendingCancellations: new Set(),
        socketMode: 'websocket',
        mode: 'websocket',
        matchEpoch: null,
        heartbeatDeadline: null,
        heartbeatTimer: null,
        activationDeadline,
        activationTimer: null,
        failed: false,
        fallbackNotified: false,
        lastSentInput: null,
        pendingQuickSeq: null,
        pendingDashSeq: null,
        edgeAckTimer: null,
        edgeAckTimeoutMs: DEFAULT_INPUT_EDGE_ACK_TIMEOUT_MS,
        edgeInputReplayed: false,
      };
      ownedGeneration = generation;
      current = generation;
      scheduleActivationDeadline(generation);
      bindGeneration(generation);

      const offer = await waitForGeneration(generation, () => peer.createOffer());
      if (offer === CANCELLED || !isCurrent(generation)) return;
      const localDescriptionSet = await waitForGeneration(generation, () => peer.setLocalDescription(offer));
      if (localDescriptionSet === CANCELLED || !isCurrent(generation)) return;
      const iceGathered = await waitForGeneration(generation, () => waitForIceGathering(generation));
      if (iceGathered === CANCELLED || !isCurrent(generation)) return;
      const localDescription = peer.localDescription;
      if (localDescription?.type !== 'offer' || typeof localDescription.sdp !== 'string') {
        localFallback(generation, 'activationFailure');
        return;
      }
      const acknowledgement = await waitForGeneration(generation, () => options.negotiate({
        generationId: generation.generationId,
        offer: { type: 'offer', sdp: localDescription.sdp }
      }));
      if (acknowledgement === CANCELLED || !isCurrent(generation)) return;
      if (!acknowledgement.ok || acknowledgement.data.generationId !== generation.generationId) {
        localFallback(generation, 'activationFailure');
        return;
      }
      const remoteDescriptionSet = await waitForGeneration(generation, () => peer.setRemoteDescription(
        acknowledgement.data.answer
      ));
      if (remoteDescriptionSet === CANCELLED || !isCurrent(generation)) return;
      await activateGeneration(generation);
    } catch {
      if (ownedGeneration !== null && current === ownedGeneration) localFallback(ownedGeneration, 'activationFailure');
    }
  }

  function acceptMode(notice: TransportModeNotice): void {
    if (current !== null) acceptModeFor(current, notice);
  }

  function acceptSocketStarted(value: MatchStartedPublication): void {
    if (current !== null && !current.failed) current.matchEpoch = value.matchEpoch;
    options.sequencer.acceptStarted(value);
  }

  function acceptSocketSnapshot(value: MatchSnapshotPublication): void {
    options.sequencer.acceptSnapshot(value);
  }

  function acceptSocketEvent(value: MatchEventPublication): void {
    options.sequencer.acceptEvent(value);
  }

  function acceptAuthoritativeSnapshot(snapshot: MatchSnapshotPublication['snapshot'], localPlayerId: string): void {
    const generation = current;
    if (generation === null) return;
    generation.edgeAckTimeoutMs = edgeAckTimeoutMs(snapshot, localPlayerId);
    if (!hasPendingEdge(generation)) return;
    const localPlayer = snapshot.players.find((player) => player.playerId === localPlayerId);
    if (!localPlayer) return;
    if (generation.pendingQuickSeq !== null && localPlayer.lastProcessedInputSeq >= generation.pendingQuickSeq) {
      generation.pendingQuickSeq = null;
    }
    if (generation.pendingDashSeq !== null && localPlayer.lastProcessedInputSeq >= generation.pendingDashSeq) {
      generation.pendingDashSeq = null;
    }
    if (!hasPendingEdge(generation)) clearEdgeAckDeadline(generation);
  }

  function sendInput(input: InputFrame): boolean {
    const generation = current;
    if (generation === null) return false;
    if (generation.failed || generation.mode !== 'webrtc') {
      return hasPendingEdge(generation) ? sendLatchedFallbackInput(generation, input) : false;
    }
    if (!isCurrent(generation)) return false;
    if (
      generation.matchEpoch === null
      || generation.fast.readyState !== 'open'
    ) return hasPendingEdge(generation) ? localFallback(generation, 'sendFailure', input) : false;

    const payload = latchedInput(generation, input);

    if (generation.fast.bufferedAmount > FAST_CHANNEL_MAX_BUFFERED_BYTES) {
      return hasPendingEdge(generation) ? localFallback(generation, 'sendFailure', input) : false;
    }

    const message: ClientFastMessage = {
      version: GAMEPLAY_PROTOCOL_VERSION,
      generationId: generation.generationId,
      matchEpoch: generation.matchEpoch,
      kind: 'input',
      payload
    };
    let serialized: string;
    try {
      serialized = JSON.stringify(message);
    } catch {
      return hasPendingEdge(generation) ? localFallback(generation, 'sendFailure', input) : false;
    }
    if (encoder.encode(serialized).byteLength > CLIENT_MESSAGE_LIMIT_BYTES) {
      return hasPendingEdge(generation) ? localFallback(generation, 'sendFailure', input) : false;
    }
    try {
      generation.fast.send(serialized);
      if (input.quick && generation.pendingQuickSeq === null) generation.pendingQuickSeq = input.seq;
      if (input.dash && generation.pendingDashSeq === null) generation.pendingDashSeq = input.seq;
      generation.lastSentInput = input;
      scheduleEdgeAckDeadline(generation);
      return true;
    } catch {
      localFallback(generation, 'sendFailure');
      return false;
    }
  }

  function dispose(): void {
    if (current === null) return;
    detachAndClose(current, true);
  }

  function fallback(): void {
    if (current !== null) localFallback(current, 'transportGap');
  }

  return {
    start,
    acceptMode,
    acceptSocketStarted,
    acceptSocketSnapshot,
    acceptSocketEvent,
    acceptAuthoritativeSnapshot,
    sendInput,
    fallback,
    dispose
  };
}
