import {
  ACTIVATION_TIMEOUT_MS,
  GAMEPLAY_PROTOCOL_VERSION,
  HEARTBEAT_INTERVAL_MS,
  MISSED_HEARTBEATS_BEFORE_FALLBACK,
  RTT_FRESHNESS_MS,
  RTT_SAMPLE_LIMIT,
  clientFastMessageSchema,
  clientReliableMessageSchema,
  rtcActivationRequestSchema,
  rtcNegotiationRequestSchema,
  type GameplayTransportMode,
  type MatchEventPublication,
  type MatchSnapshotPublication,
  type MatchStartedPublication,
  type RtcActivationRequest,
  type RtcNegotiationAnswer,
  type RtcNegotiationRequest,
  type ServerFastMessage,
  type ServerReliableMessage,
  type TransportModeNotice
} from '../../../shared/gameplayTransport.js';
import type { ServerError } from '../../../shared/model.js';
import type { MatchInputIngress } from '../matchInputIngress.js';
import type { ServerPeer, ServerPeerFactory } from './ServerPeer.js';

type SocketGameplayTransportMode = Exclude<GameplayTransportMode, 'webrtc'>;

export type TransportSession = Readonly<{
  socketId: string;
  sourceId: string;
  playerId: string;
  roomCode: string;
  inputIngress: MatchInputIngress;
  socketMode(): SocketGameplayTransportMode;
  emitMode(notice: TransportModeNotice): void;
  emitStarted(publication: MatchStartedPublication): void;
  emitSnapshot(publication: MatchSnapshotPublication): void;
  emitEvent(publication: MatchEventPublication): void;
  emitError(error: ServerError): void;
  setNetworkMode(mode: GameplayTransportMode): void;
  setNetworkSample(medianMs: number, jitterMs: number, sampledAt: number): void;
  clearNetworkSample(): void;
}>;

export type TransportPublication =
  | Readonly<{ type: 'MATCH_STARTED'; roomCode: string } & MatchStartedPublication>
  | Readonly<{ type: 'MATCH_SNAPSHOT'; roomCode: string } & MatchSnapshotPublication>
  | Readonly<{ type: 'MATCH_EVENT'; roomCode: string } & MatchEventPublication>;

export type GameplayTransportHubOptions = Readonly<{
  peerFactory: ServerPeerFactory;
  udpPortRange: readonly [number, number];
  now?: () => number;
  maxPeersPerSource?: number;
}>;

type RttSample = Readonly<{ value: number; sampledAt: number }>;
type PeerClosureResult = Readonly<{ ok: true }> | Readonly<{ ok: false; error: unknown }>;

type SessionRecord = {
  readonly session: TransportSession;
  mode: GameplayTransportMode;
  matchEpoch: number | null;
  generationId: string | null;
  peer: ServerPeer | null;
  activationExpiresAt: number | null;
  activationTimer: ReturnType<typeof setTimeout> | null;
  heartbeatTimer: ReturnType<typeof setInterval> | null;
  rttFreshnessTimer: ReturnType<typeof setTimeout> | null;
  heartbeatNonce: number;
  pendingHeartbeatNonce: number | null;
  fastProbeNonce: number;
  pendingFastProbeNonce: number | null;
  pendingFastProbeSentAtMs: number | null;
  missedHeartbeats: number;
  rttSamples: RttSample[];
  rttFresh: boolean;
  fallbackTriggered: boolean;
  negotiationSequence: number;
  pendingPeerClosures: Set<Promise<PeerClosureResult>>;
  peerCloseFailure: Readonly<{ error: unknown }> | null;
  unsubscribers: Array<() => void>;
  disposed: boolean;
};

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return Math.round(sorted[middle]!);
  return Math.round((sorted[middle - 1]! + sorted[middle]!) / 2);
}

function safeInvoke(callback: () => void): void {
  try {
    callback();
  } catch {
    // A detached Socket.IO or room callback must not affect another session.
  }
}

export abstract class GameplayTransportExpectedLifecycleError extends Error {}

export class GameplayTransportSessionUnavailableError extends GameplayTransportExpectedLifecycleError {
  constructor() {
    super('Gameplay transport session is not attached.');
    this.name = 'GameplayTransportSessionUnavailableError';
  }
}

export class GameplayTransportNegotiationCancelledError extends GameplayTransportExpectedLifecycleError {
  constructor(message: string) {
    super(message);
    this.name = 'GameplayTransportNegotiationCancelledError';
  }
}

export class GameplayTransportCapacityError extends GameplayTransportExpectedLifecycleError {
  constructor() {
    super('WebRTC transport capacity is currently unavailable.');
    this.name = 'GameplayTransportCapacityError';
  }
}

export class GameplayTransportHub {
  private readonly sessionsBySocket = new Map<string, SessionRecord>();
  private readonly sessionsByPlayer = new Map<string, SessionRecord>();
  private readonly detachmentsBySocket = new Map<string, Readonly<{
    record: SessionRecord;
    promise: Promise<void>;
  }>>();
  private readonly peerClosures = new WeakMap<ServerPeer, Promise<PeerClosureResult>>();
  private readonly pendingPeerClosures = new Set<Promise<PeerClosureResult>>();
  private readonly now: () => number;
  private readonly maxPeers: number;
  private readonly maxPeersPerSource: number;
  private stopped = false;

  constructor(private readonly options: GameplayTransportHubOptions) {
    this.now = options.now ?? Date.now;
    const udpPortCount = options.udpPortRange[1] - options.udpPortRange[0] + 1;
    // Keep one UDP port in reserve so admitted unauthenticated sessions cannot
    // consume the entire configured range and starve an unrelated session.
    this.maxPeers = Math.max(1, udpPortCount - 1);
    this.maxPeersPerSource = Math.max(1, Math.min(options.maxPeersPerSource ?? 8, this.maxPeers));
  }

  attachSession(session: TransportSession): void {
    if (this.stopped) throw new Error('Gameplay transport hub is stopped.');

    const socketRecord = this.sessionsBySocket.get(session.socketId);
    if (socketRecord) this.removeRecord(socketRecord);
    const playerRecord = this.sessionsByPlayer.get(session.playerId);
    if (playerRecord && playerRecord !== socketRecord) this.removeRecord(playerRecord);

    const record: SessionRecord = {
      session,
      mode: this.fallbackMode(session),
      matchEpoch: null,
      generationId: null,
      peer: null,
      activationExpiresAt: null,
      activationTimer: null,
      heartbeatTimer: null,
      rttFreshnessTimer: null,
      heartbeatNonce: 0,
      pendingHeartbeatNonce: null,
      fastProbeNonce: 0,
      pendingFastProbeNonce: null,
      pendingFastProbeSentAtMs: null,
      missedHeartbeats: 0,
      rttSamples: [],
      rttFresh: false,
      fallbackTriggered: false,
      negotiationSequence: 0,
      pendingPeerClosures: new Set(),
      peerCloseFailure: null,
      unsubscribers: [],
      disposed: false
    };
    this.sessionsBySocket.set(session.socketId, record);
    this.sessionsByPlayer.set(session.playerId, record);
  }

  start(): void {
    this.stopped = false;
  }

  async negotiate(socketId: string, request: RtcNegotiationRequest): Promise<RtcNegotiationAnswer> {
    const record = this.requireSession(socketId);
    const parsed = rtcNegotiationRequestSchema.safeParse(request);
    if (!parsed.success) throw new Error('Invalid WebRTC negotiation request.');
    const sequence = ++record.negotiationSequence;

    const existingPeer = record.peer;
    if (existingPeer) {
      if (record.mode === 'webrtc') {
        await this.transitionToFallback(record, record.generationId, existingPeer);
      } else {
        await this.disposePeer(record, existingPeer);
      }
    }
    if (!this.isCurrentRecord(record) || record.negotiationSequence !== sequence) {
      throw new GameplayTransportNegotiationCancelledError('WebRTC negotiation was superseded.');
    }

    const recordsWithPeers = [...this.sessionsBySocket.values()].filter((candidate) => candidate.peer !== null);
    const sourcePeerCount = recordsWithPeers.filter(
      (candidate) => candidate.session.sourceId === record.session.sourceId
    ).length;
    if (recordsWithPeers.length >= this.maxPeers || sourcePeerCount >= this.maxPeersPerSource) {
      throw new GameplayTransportCapacityError();
    }

    const generationId = parsed.data.generationId;
    const peer = this.options.peerFactory({ generationId, udpPortRange: this.options.udpPortRange });
    record.generationId = generationId;
    record.peer = peer;
    record.mode = this.fallbackMode(record.session);
    record.fallbackTriggered = false;
    record.heartbeatNonce = 0;
    record.pendingHeartbeatNonce = null;
    record.fastProbeNonce = 0;
    record.pendingFastProbeNonce = null;
    record.pendingFastProbeSentAtMs = null;
    record.missedHeartbeats = 0;
    record.rttSamples = [];
    try {
      this.bindPeer(record, peer, generationId);
      record.activationExpiresAt = this.now() + ACTIVATION_TIMEOUT_MS;
      record.activationTimer = setTimeout(() => {
        if (!this.isCurrentPeer(record, peer, generationId) || record.mode === 'webrtc') return;
        void this.transitionToFallback(record, generationId, peer);
      }, ACTIVATION_TIMEOUT_MS);
      const answer = await peer.negotiate(parsed.data.offer);
      if (
        !this.isCurrentPeer(record, peer, generationId)
        || record.negotiationSequence !== sequence
      ) {
        await this.closePeer(record, peer);
        throw new GameplayTransportNegotiationCancelledError('WebRTC negotiation was superseded.');
      }
      return { generationId, answer };
    } catch (error) {
      const stillCurrent = this.isCurrentPeer(record, peer, generationId)
        && record.negotiationSequence === sequence;
      if (stillCurrent) {
        await this.transitionToFallback(record, generationId, peer);
      }
      if (!stillCurrent && !(error instanceof GameplayTransportExpectedLifecycleError)) {
        throw new GameplayTransportNegotiationCancelledError('WebRTC negotiation was cancelled with its stale session.');
      }
      throw error;
    }
  }

  activate(socketId: string, request: RtcActivationRequest): boolean {
    const record = this.sessionsBySocket.get(socketId);
    const parsed = rtcActivationRequestSchema.safeParse(request);
    if (!record || record.disposed || !parsed.success) return false;
    const { peer, generationId, activationExpiresAt } = record;
    if (
      peer
      && generationId === parsed.data.generationId
      && record.mode === 'webrtc'
      && !record.fallbackTriggered
    ) return true;
    if (
      !peer
      || generationId !== parsed.data.generationId
      || record.mode === 'webrtc'
      || record.fallbackTriggered
      || activationExpiresAt === null
      || this.now() >= activationExpiresAt
    ) {
      if (peer && generationId === parsed.data.generationId && this.now() >= (activationExpiresAt ?? 0)) {
        void this.transitionToFallback(record, generationId, peer);
      }
      return false;
    }

    try {
      if (!peer.isReady()) return false;
    } catch {
      void this.transitionToFallback(record, generationId, peer);
      return false;
    }

    if (record.activationTimer) clearTimeout(record.activationTimer);
    record.activationTimer = null;
    record.activationExpiresAt = null;
    record.mode = 'webrtc';
    safeInvoke(() => record.session.setNetworkMode('webrtc'));
    safeInvoke(() => record.session.emitMode({ generationId, mode: 'webrtc' }));
    this.startHeartbeat(record, peer, generationId);
    return true;
  }

  fallback(socketId: string): void {
    const record = this.sessionsBySocket.get(socketId);
    if (!record || record.disposed || !record.peer) return;
    void this.transitionToFallback(record, record.generationId, record.peer);
  }

  publish(publication: TransportPublication): void {
    for (const record of [...this.sessionsBySocket.values()]) {
      if (record.disposed || record.session.roomCode !== publication.roomCode) continue;
      try {
        this.publishToSession(record, publication);
      } catch {
        if (record.peer) void this.transitionToFallback(record, record.generationId, record.peer);
      }
    }
  }

  synchronizeSession(socketId: string, publication: MatchStartedPublication): void {
    const record = this.sessionsBySocket.get(socketId);
    if (!record || record.disposed) return;
    this.publishToSession(record, {
      type: 'MATCH_STARTED',
      roomCode: record.session.roomCode,
      ...publication
    });
  }

  detachSession(socketId: string): Promise<void> {
    const record = this.sessionsBySocket.get(socketId);
    if (!record) return this.detachmentsBySocket.get(socketId)?.promise ?? Promise.resolve();
    this.sessionsBySocket.delete(socketId);
    if (this.sessionsByPlayer.get(record.session.playerId) === record) {
      this.sessionsByPlayer.delete(record.session.playerId);
    }
    const detachment = {
      record,
      promise: this.disposeRecord(record, true)
    };
    this.detachmentsBySocket.set(socketId, detachment);
    const clearDetachment = (): void => {
      if (this.detachmentsBySocket.get(socketId) === detachment) {
        this.detachmentsBySocket.delete(socketId);
      }
    };
    void detachment.promise.then(clearDetachment, clearDetachment);
    return detachment.promise;
  }

  modeForPlayer(playerId: string): GameplayTransportMode | null {
    return this.sessionsByPlayer.get(playerId)?.mode ?? null;
  }

  generationForPlayerForTest(playerId: string): Readonly<{
    generationId: string | null;
    negotiationCount: number;
  }> | null {
    const record = this.sessionsByPlayer.get(playerId);
    return record
      ? { generationId: record.generationId, negotiationCount: record.negotiationSequence }
      : null;
  }

  async dropPeerForTest(playerId: string): Promise<void> {
    const record = this.sessionsByPlayer.get(playerId);
    if (!record?.peer || record.disposed) return;
    await this.transitionToFallback(record, record.generationId, record.peer);
  }

  async stop(): Promise<void> {
    if (!this.stopped) {
      this.stopped = true;
      const records = [...this.sessionsBySocket.values()];
      this.sessionsBySocket.clear();
      this.sessionsByPlayer.clear();
      await Promise.all(records.map((record) => this.disposeRecord(record)));
    }
    await Promise.all([...this.pendingPeerClosures]);
  }

  private requireSession(socketId: string): SessionRecord {
    const record = this.sessionsBySocket.get(socketId);
    if (!record || record.disposed || this.stopped) {
      throw new GameplayTransportSessionUnavailableError();
    }
    return record;
  }

  private fallbackMode(session: TransportSession): SocketGameplayTransportMode {
    try {
      return session.socketMode() === 'polling' ? 'polling' : 'websocket';
    } catch {
      return 'websocket';
    }
  }

  private bindPeer(record: SessionRecord, peer: ServerPeer, generationId: string): void {
    record.unsubscribers.push(
      peer.onFastMessage((serialized) => this.acceptFastMessage(record, peer, generationId, serialized))
    );
    record.unsubscribers.push(
      peer.onReliableMessage((serialized) => this.acceptReliableMessage(record, peer, generationId, serialized))
    );
    record.unsubscribers.push(peer.onClosed(() => {
      if (this.isCurrentPeer(record, peer, generationId)) {
        void this.transitionToFallback(record, generationId, peer);
      }
    }));
  }

  private acceptFastMessage(
    record: SessionRecord,
    peer: ServerPeer,
    generationId: string,
    serialized: string
  ): void {
    if (!this.isCurrentPeer(record, peer, generationId) || record.mode !== 'webrtc') return;
    const parsed = clientFastMessageSchema.safeParse(serialized);
    if (!parsed.success || parsed.data.generationId !== generationId) return;
    if (parsed.data.kind === 'probe-ack') {
      if (
        parsed.data.nonce !== record.pendingFastProbeNonce
        || record.pendingFastProbeSentAtMs === null
      ) return;
      const sentAt = record.pendingFastProbeSentAtMs;
      record.pendingFastProbeNonce = null;
      record.pendingFastProbeSentAtMs = null;
      this.recordRttSample(record, this.now() - sentAt);
      return;
    }
    if (record.matchEpoch === null || parsed.data.matchEpoch !== record.matchEpoch) return;

    const result = record.session.inputIngress.accept(parsed.data.payload, 'webrtc');
    if (result.status === 'error') safeInvoke(() => record.session.emitError(result.error));
  }

  private acceptReliableMessage(
    record: SessionRecord,
    peer: ServerPeer,
    generationId: string,
    serialized: string
  ): void {
    if (!this.isCurrentPeer(record, peer, generationId) || record.mode !== 'webrtc') return;
    const parsed = clientReliableMessageSchema.safeParse(serialized);
    if (
      !parsed.success
      || parsed.data.generationId !== generationId
      || parsed.data.nonce !== record.pendingHeartbeatNonce
    ) return;
    record.pendingHeartbeatNonce = null;
    record.missedHeartbeats = 0;
  }

  private publishToSession(record: SessionRecord, publication: TransportPublication): void {
    if (publication.type === 'MATCH_STARTED') {
      record.matchEpoch = publication.matchEpoch;
      const payload: MatchStartedPublication = {
        matchEpoch: publication.matchEpoch,
        eventCursor: publication.eventCursor,
        snapshot: publication.snapshot
      };
      safeInvoke(() => record.session.emitStarted(payload));
      if (record.mode !== 'webrtc' || !record.peer || !record.generationId) return;
      const message: ServerReliableMessage = {
        version: GAMEPLAY_PROTOCOL_VERSION,
        generationId: record.generationId,
        kind: 'started',
        payload
      };
      this.sendReliable(record, message);
      return;
    }

    if (publication.type === 'MATCH_EVENT') {
      const payload: MatchEventPublication = {
        matchEpoch: publication.matchEpoch,
        event: publication.event
      };
      safeInvoke(() => record.session.emitEvent(payload));
      if (record.mode !== 'webrtc' || !record.peer || !record.generationId) return;
      const message: ServerReliableMessage = {
        version: GAMEPLAY_PROTOCOL_VERSION,
        generationId: record.generationId,
        kind: 'event',
        payload
      };
      this.sendReliable(record, message);
      return;
    }

    if (record.mode !== 'webrtc' || !record.peer || !record.generationId) {
      safeInvoke(() => record.session.emitSnapshot({
        matchEpoch: publication.matchEpoch,
        eventCursor: publication.eventCursor,
        snapshot: publication.snapshot
      }));
      return;
    }

    const peer = record.peer;
    const message: ServerFastMessage = {
      version: GAMEPLAY_PROTOCOL_VERSION,
      generationId: record.generationId,
      kind: 'snapshot',
      payload: {
        matchEpoch: publication.matchEpoch,
        eventCursor: publication.eventCursor,
        snapshot: publication.snapshot
      }
    };
    let result: ReturnType<ServerPeer['sendFast']>;
    try {
      result = peer.sendFast(JSON.stringify(message));
    } catch {
      result = 'closed';
    }
    if (result === 'sent' || result === 'backpressured') return;
    void this.transitionToFallback(record, record.generationId, peer);
    safeInvoke(() => record.session.emitSnapshot({
      matchEpoch: publication.matchEpoch,
      eventCursor: publication.eventCursor,
      snapshot: publication.snapshot
    }));
  }

  private sendReliable(record: SessionRecord, message: ServerReliableMessage): void {
    const peer = record.peer;
    if (!peer) return;
    let result: ReturnType<ServerPeer['sendReliable']>;
    try {
      result = peer.sendReliable(JSON.stringify(message));
    } catch {
      result = 'closed';
    }
    if (result !== 'sent') void this.transitionToFallback(record, record.generationId, peer);
  }

  private startHeartbeat(record: SessionRecord, peer: ServerPeer, generationId: string): void {
    record.heartbeatTimer = setInterval(() => {
      if (!this.isCurrentPeer(record, peer, generationId) || record.mode !== 'webrtc') return;
      if (record.pendingHeartbeatNonce !== null) {
        record.missedHeartbeats += 1;
        if (record.missedHeartbeats >= MISSED_HEARTBEATS_BEFORE_FALLBACK) {
          void this.transitionToFallback(record, generationId, peer);
          return;
        }
      }

      const nonce = ++record.heartbeatNonce;
      const message: ServerReliableMessage = {
        version: GAMEPLAY_PROTOCOL_VERSION,
        generationId,
        kind: 'heartbeat',
        nonce
      };
      let result: ReturnType<ServerPeer['sendReliable']>;
      try {
        result = peer.sendReliable(JSON.stringify(message));
      } catch {
        result = 'closed';
      }
      if (result !== 'sent') {
        void this.transitionToFallback(record, generationId, peer);
        return;
      }
      record.pendingHeartbeatNonce = nonce;
      this.sendFastProbe(record, peer, generationId);
    }, HEARTBEAT_INTERVAL_MS);
  }

  private sendFastProbe(record: SessionRecord, peer: ServerPeer, generationId: string): void {
    const nonce = ++record.fastProbeNonce;
    const message: ServerFastMessage = {
      version: GAMEPLAY_PROTOCOL_VERSION,
      generationId,
      kind: 'probe',
      nonce
    };
    record.pendingFastProbeNonce = nonce;
    record.pendingFastProbeSentAtMs = this.now();
    let result: ReturnType<ServerPeer['sendFast']>;
    try {
      result = peer.sendFast(JSON.stringify(message));
    } catch {
      result = 'closed';
    }
    if (result === 'sent') return;
    if (record.pendingFastProbeNonce === nonce) {
      record.pendingFastProbeNonce = null;
      record.pendingFastProbeSentAtMs = null;
    }
    if (result === 'closed') void this.transitionToFallback(record, generationId, peer);
  }

  private recordRttSample(record: SessionRecord, elapsedMs: number): void {
    const sampledAt = this.now();
    const latest = record.rttSamples.at(-1);
    if (latest && sampledAt - latest.sampledAt >= RTT_FRESHNESS_MS) {
      record.rttSamples = [];
    }
    record.rttSamples.push({ value: Math.round(Math.max(0, elapsedMs)), sampledAt });
    if (record.rttSamples.length > RTT_SAMPLE_LIMIT) {
      record.rttSamples.splice(0, record.rttSamples.length - RTT_SAMPLE_LIMIT);
    }
    record.rttFresh = true;
    const rttValues = record.rttSamples.map((sample) => sample.value);
    const differences = rttValues.slice(1).map((value, index) => Math.abs(value - rttValues[index]!));
    safeInvoke(() => record.session.setNetworkSample(
      median(rttValues),
      differences.length === 0 ? 0 : median(differences),
      sampledAt
    ));
    if (record.rttFreshnessTimer) clearTimeout(record.rttFreshnessTimer);
    record.rttFreshnessTimer = setTimeout(() => {
      if (
        !record.rttFresh
        || record.mode !== 'webrtc'
      ) return;
      const latest = record.rttSamples.at(-1);
      if (!latest || this.now() - latest.sampledAt < RTT_FRESHNESS_MS) return;
      record.rttFresh = false;
      record.rttSamples = [];
      safeInvoke(() => record.session.clearNetworkSample());
    }, RTT_FRESHNESS_MS);
  }

  private async transitionToFallback(
    record: SessionRecord,
    generationId: string | null,
    peer: ServerPeer
  ): Promise<void> {
    if (
      record.disposed
      || record.generationId !== generationId
      || (record.peer !== peer && !record.fallbackTriggered)
    ) return;
    if (record.fallbackTriggered) return this.closePeer(record, peer);

    record.fallbackTriggered = true;
    const mode = this.fallbackMode(record.session);
    record.mode = mode;
    const closure = this.disposePeer(record, peer);
    safeInvoke(() => record.session.setNetworkMode(mode));
    safeInvoke(() => record.session.emitMode({ generationId, mode }));
    safeInvoke(() => record.session.clearNetworkSample());
    await closure;
  }

  private disposePeer(record: SessionRecord, peer: ServerPeer): Promise<void> {
    if (record.peer === peer) record.peer = null;
    this.clearPeerTimers(record);
    for (const unsubscribe of record.unsubscribers.splice(0)) safeInvoke(unsubscribe);
    record.activationExpiresAt = null;
    record.pendingHeartbeatNonce = null;
    record.pendingFastProbeNonce = null;
    record.pendingFastProbeSentAtMs = null;
    record.missedHeartbeats = 0;
    record.rttFresh = false;
    record.rttSamples = [];
    return this.closePeer(record, peer);
  }

  private async closePeer(record: SessionRecord, peer: ServerPeer): Promise<void> {
    await this.trackPeerClosure(record, peer);
  }

  private trackPeerClosure(record: SessionRecord, peer: ServerPeer): Promise<PeerClosureResult> {
    const existing = this.peerClosures.get(peer);
    if (existing) return existing;
    const closure: Promise<PeerClosureResult> = Promise.resolve()
      .then(() => peer.close())
      .then(
        (): PeerClosureResult => ({ ok: true }),
        (error: unknown): PeerClosureResult => ({ ok: false, error })
      );
    this.peerClosures.set(peer, closure);
    this.pendingPeerClosures.add(closure);
    record.pendingPeerClosures.add(closure);
    void closure.then((result) => {
      this.pendingPeerClosures.delete(closure);
      record.pendingPeerClosures.delete(closure);
      if (!result.ok && record.peerCloseFailure === null) {
        record.peerCloseFailure = { error: result.error };
      }
    });
    return closure;
  }

  private clearPeerTimers(record: SessionRecord): void {
    if (record.activationTimer) clearTimeout(record.activationTimer);
    if (record.heartbeatTimer) clearInterval(record.heartbeatTimer);
    if (record.rttFreshnessTimer) clearTimeout(record.rttFreshnessTimer);
    record.activationTimer = null;
    record.heartbeatTimer = null;
    record.rttFreshnessTimer = null;
  }

  private removeRecord(record: SessionRecord): void {
    this.sessionsBySocket.delete(record.session.socketId);
    if (this.sessionsByPlayer.get(record.session.playerId) === record) {
      this.sessionsByPlayer.delete(record.session.playerId);
    }
    void this.disposeRecord(record);
  }

  private async disposeRecord(record: SessionRecord, surfaceCloseFailure = false): Promise<void> {
    if (!record.disposed) {
      record.disposed = true;
      record.negotiationSequence += 1;
      const peer = record.peer;
      this.clearPeerTimers(record);
      for (const unsubscribe of record.unsubscribers.splice(0)) safeInvoke(unsubscribe);
      record.peer = null;
      record.pendingHeartbeatNonce = null;
      record.pendingFastProbeNonce = null;
      record.pendingFastProbeSentAtMs = null;
      record.rttSamples = [];
      if (record.mode === 'webrtc' || record.rttFresh) {
        safeInvoke(() => record.session.clearNetworkSample());
      }
      record.rttFresh = false;
      if (peer) this.trackPeerClosure(record, peer);
    }
    await Promise.all([...record.pendingPeerClosures]);
    if (surfaceCloseFailure && record.peerCloseFailure) throw record.peerCloseFailure.error;
  }

  private isCurrentRecord(record: SessionRecord): boolean {
    return !record.disposed && this.sessionsBySocket.get(record.session.socketId) === record;
  }

  private isCurrentPeer(record: SessionRecord, peer: ServerPeer, generationId: string): boolean {
    return this.isCurrentRecord(record)
      && record.peer === peer
      && record.generationId === generationId;
  }
}
