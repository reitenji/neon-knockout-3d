// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CLIENT_MESSAGE_LIMIT_BYTES,
  GAMEPLAY_PROTOCOL_VERSION,
  type MatchEventPublication,
  type MatchSnapshotPublication,
  type MatchStartedPublication,
  type RtcAnswer,
  type RtcOffer
} from '../../../shared/gameplayTransport.js';
import type { GameEvent, InputFrame, MatchSnapshot, ServerError } from '../../../shared/model.js';
import type { MatchInputIngress, MatchInputIngressResult } from '../matchInputIngress.js';
import type { PeerSendResult, ServerPeer, ServerPeerFactory } from './ServerPeer.js';
import {
  GameplayTransportHub,
  GameplayTransportNegotiationCancelledError,
  GameplayTransportSessionUnavailableError,
  type TransportPublication,
  type TransportSession
} from './GameplayTransportHub.js';

const FIRST_GENERATION = '2f8ca1f2-7e6e-4ea7-90e2-e6a955892574';
const SECOND_GENERATION = '4cf2e59c-3dd7-4a54-8e5d-95eb40efca5c';
const UDP_PORT_RANGE = [53100, 53131] as const;

const input: InputFrame = {
  seq: 9,
  viewTick: 8,
  moveX: 1,
  moveY: 0,
  aimX: 0.6,
  aimY: -0.8,
  quick: true,
  heavy: false,
  dash: false
};

const snapshot: MatchSnapshot = {
  tick: 42,
  phase: 'REGULATION',
  remainingMs: 80_000,
  platformProgress: 0.25,
  settings: { durationMs: 120_000, knockoutTarget: 5 },
  scores: { p1: 1 },
  network: {},
  players: [],
  pulses: [],
  winnerPlayerId: null,
  resultReason: null
};

const event: GameEvent = {
  type: 'PHASE',
  eventId: 7,
  tick: 42,
  phase: 'REGULATION',
  remainingMs: 80_000
};

type MessageListener = (serialized: string) => void;
type ListenerRegistrationFailure = 'reliable' | 'closed' | null;

type Deferred<T> = Readonly<{
  promise: Promise<T>;
  resolve(value: T): void;
}>;

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => { resolve = complete; });
  return { promise, resolve };
}

class FakePeer implements ServerPeer {
  readonly offers: RtcOffer[] = [];
  readonly fastSent: string[] = [];
  readonly reliableSent: string[] = [];
  readonly fastListeners = new Set<MessageListener>();
  readonly reliableListeners = new Set<MessageListener>();
  readonly closedListeners = new Set<() => void>();
  ready = false;
  fastResult: PeerSendResult = 'sent';
  reliableResult: PeerSendResult = 'sent';
  negotiationDeferred: Deferred<RtcAnswer> | null = null;
  listenerRegistrationFailure: ListenerRegistrationFailure = null;
  closeCalls = 0;

  constructor(readonly generationId: string) {}

  async negotiate(offer: RtcOffer) {
    this.offers.push(offer);
    if (this.negotiationDeferred) return this.negotiationDeferred.promise;
    return { type: 'answer' as const, sdp: `answer:${offer.sdp}` };
  }

  isReady(): boolean {
    return this.ready;
  }

  sendFast(serialized: string): PeerSendResult {
    if (this.fastResult === 'sent') this.fastSent.push(serialized);
    return this.fastResult;
  }

  sendReliable(serialized: string): PeerSendResult {
    if (this.reliableResult === 'sent') {
      this.reliableSent.push(serialized);
    }
    return this.reliableResult;
  }

  onFastMessage(listener: MessageListener): () => void {
    this.fastListeners.add(listener);
    return () => this.fastListeners.delete(listener);
  }

  onReliableMessage(listener: MessageListener): () => void {
    if (this.listenerRegistrationFailure === 'reliable') {
      throw new Error('reliable listener registration failed');
    }
    this.reliableListeners.add(listener);
    return () => this.reliableListeners.delete(listener);
  }

  onClosed(listener: () => void): () => void {
    if (this.listenerRegistrationFailure === 'closed') {
      throw new Error('closed listener registration failed');
    }
    this.closedListeners.add(listener);
    return () => this.closedListeners.delete(listener);
  }

  async close(): Promise<void> {
    this.closeCalls += 1;
    this.ready = false;
  }

  openBothChannels(): void {
    this.ready = true;
  }

  receiveFast(message: unknown): void {
    const serialized = typeof message === 'string' ? message : JSON.stringify(message);
    for (const listener of [...this.fastListeners]) listener(serialized);
  }

  receiveReliable(message: unknown): void {
    const serialized = typeof message === 'string' ? message : JSON.stringify(message);
    for (const listener of [...this.reliableListeners]) listener(serialized);
  }

  disconnect(): void {
    for (const listener of [...this.closedListeners]) listener();
  }
}

class FakePeerFactory {
  readonly peers: FakePeer[] = [];
  readonly calls: Parameters<ServerPeerFactory>[0][] = [];
  nextListenerRegistrationFailure: ListenerRegistrationFailure = null;
  nextNegotiationDeferred: Deferred<RtcAnswer> | null = null;

  deferNextNegotiation(): Deferred<RtcAnswer> {
    const pending = deferred<RtcAnswer>();
    this.nextNegotiationDeferred = pending;
    return pending;
  }

  readonly create: ServerPeerFactory = (options) => {
    this.calls.push(options);
    const peer = new FakePeer(options.generationId);
    peer.listenerRegistrationFailure = this.nextListenerRegistrationFailure;
    peer.negotiationDeferred = this.nextNegotiationDeferred;
    this.nextListenerRegistrationFailure = null;
    this.nextNegotiationDeferred = null;
    this.peers.push(peer);
    return peer;
  };
}

type SessionHarness = Readonly<{
  session: TransportSession;
  acceptedInputs: InputFrame[];
  emittedErrors: ServerError[];
  emittedModes: Parameters<TransportSession['emitMode']>[0][];
  emittedStarted: MatchStartedPublication[];
  emittedSnapshots: MatchSnapshotPublication[];
  emittedEvents: MatchEventPublication[];
  networkModes: Parameters<TransportSession['setNetworkMode']>[0][];
  networkSamples: Array<Readonly<{ medianMs: number; jitterMs: number; sampledAt: number }>>;
  networkClearTimes: number[];
}>;

function session(
  overrides: Partial<Pick<TransportSession, 'socketId' | 'sourceId' | 'playerId' | 'roomCode'>> = {}
): SessionHarness {
  const acceptedInputs: InputFrame[] = [];
  const emittedErrors: ServerError[] = [];
  const emittedModes: Parameters<TransportSession['emitMode']>[0][] = [];
  const emittedStarted: MatchStartedPublication[] = [];
  const emittedSnapshots: MatchSnapshotPublication[] = [];
  const emittedEvents: MatchEventPublication[] = [];
  const networkModes: Parameters<TransportSession['setNetworkMode']>[0][] = [];
  const networkSamples: Array<Readonly<{ medianMs: number; jitterMs: number; sampledAt: number }>> = [];
  const networkClearTimes: number[] = [];
  const ingress: MatchInputIngress = {
    accept: (payload: unknown): MatchInputIngressResult => {
      acceptedInputs.push(payload as InputFrame);
      return { status: 'accepted' };
    },
    reset: () => undefined
  };
  const transportSession: TransportSession = {
    socketId: overrides.socketId ?? 's1',
    sourceId: overrides.sourceId ?? overrides.socketId ?? 's1',
    playerId: overrides.playerId ?? 'p1',
    roomCode: overrides.roomCode ?? 'AB2Z',
    inputIngress: ingress,
    socketMode: () => 'websocket',
    emitMode: (notice) => emittedModes.push(notice),
    emitStarted: (value) => emittedStarted.push(value),
    emitSnapshot: (value) => emittedSnapshots.push(value),
    emitEvent: (value) => emittedEvents.push(value),
    emitError: (value) => emittedErrors.push(value),
    setNetworkMode: (mode) => networkModes.push(mode),
    setNetworkSample: (medianMs, jitterMs, sampledAt) => networkSamples.push({ medianMs, jitterMs, sampledAt }),
    clearNetworkSample: () => networkClearTimes.push(Date.now())
  };
  return {
    session: transportSession,
    acceptedInputs,
    emittedErrors,
    emittedModes,
    emittedStarted,
    emittedSnapshots,
    emittedEvents,
    networkModes,
    networkSamples,
    networkClearTimes
  };
}

function fastInput(generationId = FIRST_GENERATION, matchEpoch = 2, payload = input) {
  return { version: GAMEPLAY_PROTOCOL_VERSION, generationId, matchEpoch, kind: 'input', payload } as const;
}

function started(roomCode = 'AB2Z', matchEpoch = 2): TransportPublication {
  return { type: 'MATCH_STARTED', roomCode, matchEpoch, eventCursor: 7, snapshot };
}

function startedSafety(matchEpoch = 2): MatchStartedPublication {
  return { matchEpoch, eventCursor: 7, snapshot };
}

function snapshotPublication(
  roomCode = 'AB2Z',
  matchEpoch = 2,
  publishedSnapshot: MatchSnapshot = snapshot
): TransportPublication {
  return { type: 'MATCH_SNAPSHOT', roomCode, matchEpoch, eventCursor: 7, snapshot: publishedSnapshot };
}

function snapshotSafety(
  matchEpoch = 2,
  publishedSnapshot: MatchSnapshot = snapshot
): MatchSnapshotPublication {
  return { matchEpoch, eventCursor: 7, snapshot: publishedSnapshot };
}

function eventPublication(
  roomCode = 'AB2Z',
  matchEpoch = 2,
  publishedEvent: GameEvent = event
): TransportPublication {
  return { type: 'MATCH_EVENT', roomCode, matchEpoch, event: publishedEvent };
}

function eventSafety(matchEpoch = 2, publishedEvent: GameEvent = event): MatchEventPublication {
  return { matchEpoch, event: publishedEvent };
}

const hubs: GameplayTransportHub[] = [];

function createSubject(now: () => number = Date.now) {
  const factory = new FakePeerFactory();
  const hub = new GameplayTransportHub({ peerFactory: factory.create, udpPortRange: UDP_PORT_RANGE, now });
  hubs.push(hub);
  return { hub, factory };
}

async function negotiateAndActivate(hub: GameplayTransportHub, factory: FakePeerFactory, socketId = 's1') {
  await hub.negotiate(socketId, {
    generationId: FIRST_GENERATION,
    offer: { type: 'offer', sdp: 'browser-offer' }
  });
  const peer = factory.peers.at(-1);
  if (!peer) throw new Error('Expected a peer to be created.');
  peer.openBothChannels();
  expect(hub.activate(socketId, { generationId: FIRST_GENERATION })).toBe(true);
  return peer;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
});

afterEach(async () => {
  await Promise.all(hubs.splice(0).map((hub) => hub.stop()));
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('GameplayTransportHub', () => {
  it('classifies an unattached or stopped-session request separately from in-flight cancellation', async () => {
    const { hub } = createSubject();
    const request = {
      generationId: FIRST_GENERATION,
      offer: { type: 'offer' as const, sdp: 'unattached-offer' }
    };

    const unattachedError = await hub.negotiate('unknown-socket', request).catch((error: unknown) => error);
    expect(unattachedError).toBeInstanceOf(GameplayTransportSessionUnavailableError);
    expect(unattachedError).not.toBeInstanceOf(GameplayTransportNegotiationCancelledError);

    await hub.stop();
    const stoppedError = await hub.negotiate('unknown-socket', request).catch((error: unknown) => error);
    expect(stoppedError).toBeInstanceOf(GameplayTransportSessionUnavailableError);
    expect(stoppedError).not.toBeInstanceOf(GameplayTransportNegotiationCancelledError);
  });

  it('classifies superseded and detached pending negotiations as expected lifecycle cancellation', async () => {
    const { hub, factory } = createSubject();
    hub.attachSession(session().session);
    const firstDeferred = factory.deferNextNegotiation();
    const firstNegotiation = hub.negotiate('s1', {
      generationId: FIRST_GENERATION,
      offer: { type: 'offer', sdp: 'delayed-first-offer' }
    });
    await Promise.resolve();

    const replacement = await hub.negotiate('s1', {
      generationId: SECOND_GENERATION,
      offer: { type: 'offer', sdp: 'replacement-offer' }
    });
    firstDeferred.resolve({ type: 'answer', sdp: 'late-first-answer' });

    await expect(firstNegotiation).rejects.toBeInstanceOf(GameplayTransportNegotiationCancelledError);
    expect(replacement.generationId).toBe(SECOND_GENERATION);
    expect(hub.activate('s1', { generationId: FIRST_GENERATION })).toBe(false);

    const detached = createSubject();
    detached.hub.attachSession(session({ socketId: 's2', playerId: 'p2' }).session);
    const detachedDeferred = detached.factory.deferNextNegotiation();
    const detachedNegotiation = detached.hub.negotiate('s2', {
      generationId: FIRST_GENERATION,
      offer: { type: 'offer', sdp: 'detached-offer' }
    });
    await Promise.resolve();
    await detached.hub.detachSession('s2');
    detachedDeferred.resolve({ type: 'answer', sdp: 'detached-answer' });

    await expect(detachedNegotiation).rejects.toBeInstanceOf(GameplayTransportNegotiationCancelledError);
  });

  it('negotiates only inside the registered socket session and activates after both channels are ready', async () => {
    const { hub, factory } = createSubject();
    const first = session();
    hub.attachSession(first.session);

    await expect(hub.negotiate('unknown-socket', {
      generationId: FIRST_GENERATION,
      offer: { type: 'offer', sdp: 'wrong-session' }
    })).rejects.toThrow(/session/i);
    const answer = await hub.negotiate('s1', {
      generationId: FIRST_GENERATION,
      offer: { type: 'offer', sdp: 'browser-offer' }
    });
    const peer = factory.peers[0]!;

    expect(answer).toEqual({
      generationId: FIRST_GENERATION,
      answer: { type: 'answer', sdp: 'answer:browser-offer' }
    });
    expect(factory.calls).toEqual([{ generationId: FIRST_GENERATION, udpPortRange: UDP_PORT_RANGE }]);
    expect(hub.activate('s1', { generationId: FIRST_GENERATION })).toBe(false);
    peer.openBothChannels();
    expect(hub.activate('s1', { generationId: FIRST_GENERATION })).toBe(true);
    expect(hub.modeForPlayer('p1')).toBe('webrtc');
    expect(hub.generationForPlayerForTest('p1')).toEqual({
      generationId: FIRST_GENERATION,
      negotiationCount: 1
    });
    expect(first.networkModes).toEqual(['webrtc']);
  });

  it('reserves UDP capacity and rejects peers beyond the aggregate admission limit', async () => {
    const factory = new FakePeerFactory();
    const hub = new GameplayTransportHub({
      peerFactory: factory.create,
      udpPortRange: [53100, 53101]
    });
    hubs.push(hub);
    hub.attachSession(session().session);
    hub.attachSession(session({ socketId: 's2', sourceId: 's1', playerId: 'p2' }).session);

    await hub.negotiate('s1', {
      generationId: FIRST_GENERATION,
      offer: { type: 'offer', sdp: 'first-offer' }
    });
    await expect(hub.negotiate('s2', {
      generationId: SECOND_GENERATION,
      offer: { type: 'offer', sdp: 'second-offer' }
    })).rejects.toThrow(/capacity/i);

    expect(factory.peers).toHaveLength(1);
  });

  it('limits peer allocation across sockets sharing a network source', async () => {
    const factory = new FakePeerFactory();
    const hub = new GameplayTransportHub({
      peerFactory: factory.create,
      udpPortRange: UDP_PORT_RANGE,
      maxPeersPerSource: 1
    });
    hubs.push(hub);
    hub.attachSession(session().session);
    hub.attachSession(session({ socketId: 's2', sourceId: 's1', playerId: 'p2' }).session);

    await hub.negotiate('s1', {
      generationId: FIRST_GENERATION,
      offer: { type: 'offer', sdp: 'first-offer' }
    });
    await expect(hub.negotiate('s2', {
      generationId: SECOND_GENERATION,
      offer: { type: 'offer', sdp: 'second-offer' }
    })).rejects.toThrow(/capacity/i);

    expect(factory.peers).toHaveLength(1);
  });

  it('retains admission capacity until a detached peer actually closes', async () => {
    const factory = new FakePeerFactory();
    const hub = new GameplayTransportHub({ peerFactory: factory.create, udpPortRange: [53100, 53101] });
    hubs.push(hub);
    hub.attachSession(session().session);
    hub.attachSession(session({ socketId: 's2', playerId: 'p2' }).session);
    await hub.negotiate('s1', { generationId: FIRST_GENERATION, offer: { type: 'offer', sdp: 'first' } });
    const closing = deferred<void>();
    factory.peers[0]!.close = () => closing.promise;
    const detached = hub.detachSession('s1');
    try {
      await expect(hub.negotiate('s2', {
        generationId: SECOND_GENERATION, offer: { type: 'offer', sdp: 'second' }
      })).rejects.toThrow(/capacity/i);
    } finally {
      closing.resolve();
      await detached;
    }
    await expect(hub.negotiate('s2', {
      generationId: SECOND_GENERATION, offer: { type: 'offer', sdp: 'second' }
    })).resolves.toMatchObject({ generationId: SECOND_GENERATION });
  });

  it('keeps repeated activation of the active current generation idempotently active', async () => {
    const { hub, factory } = createSubject();
    const first = session();
    hub.attachSession(first.session);
    const peer = await negotiateAndActivate(hub, factory);

    const repeatedActivation = hub.activate('s1', { generationId: FIRST_GENERATION });
    await Promise.resolve();
    await Promise.resolve();

    expect({
      repeatedActivation,
      mode: hub.modeForPlayer('p1'),
      peerCloseCalls: peer.closeCalls,
      emittedModes: first.emittedModes,
      networkModes: first.networkModes
    }).toEqual({
      repeatedActivation: true,
      mode: 'webrtc',
      peerCloseCalls: 0,
      emittedModes: [{ generationId: FIRST_GENERATION, mode: 'webrtc' }],
      networkModes: ['webrtc']
    });
  });

  it.each(['reliable', 'closed'] as const)(
    'closes and fully unsubscribes a peer when %s listener registration throws',
    async (listenerRegistrationFailure) => {
      const { hub, factory } = createSubject();
      const first = session();
      hub.attachSession(first.session);
      factory.nextListenerRegistrationFailure = listenerRegistrationFailure;

      await expect(hub.negotiate('s1', {
        generationId: FIRST_GENERATION,
        offer: { type: 'offer', sdp: 'browser-offer' }
      })).rejects.toThrow(`${listenerRegistrationFailure} listener registration failed`);
      const peer = factory.peers[0]!;

      expect(peer.closeCalls).toBe(1);
      expect(peer.fastListeners.size).toBe(0);
      expect(peer.reliableListeners.size).toBe(0);
      expect(peer.closedListeners.size).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
      expect(hub.modeForPlayer('p1')).toBe('websocket');
      hub.publish(snapshotPublication());
      expect(first.emittedSnapshots).toEqual([snapshotSafety()]);
    }
  );

  it('routes valid current-generation and current-epoch input through the exact session ingress', async () => {
    const { hub, factory } = createSubject();
    const first = session();
    hub.attachSession(first.session);
    const peer = await negotiateAndActivate(hub, factory);
    hub.publish(started());

    peer.receiveFast(fastInput());

    expect(first.acceptedInputs).toEqual([input]);
  });

  it('synchronizes an active-match boundary to only the resumed session and updates its accepted epoch', async () => {
    const { hub, factory } = createSubject();
    const resumed = session();
    const existing = session({ socketId: 's2', playerId: 'p2' });
    hub.attachSession(resumed.session);
    hub.attachSession(existing.session);
    const peer = await negotiateAndActivate(hub, factory);

    hub.synchronizeSession('s1', startedSafety(4));
    peer.receiveFast(fastInput(FIRST_GENERATION, 4));

    expect(resumed.emittedStarted).toEqual([startedSafety(4)]);
    expect(existing.emittedStarted).toEqual([]);
    expect(resumed.acceptedInputs).toEqual([input]);
  });

  it('rejects malformed, oversized, wrong-schema, wrong-generation, and wrong-epoch fast input before ingress', async () => {
    const { hub, factory } = createSubject();
    const first = session();
    hub.attachSession(first.session);
    const peer = await negotiateAndActivate(hub, factory);
    hub.publish(started());

    peer.receiveFast('{');
    peer.receiveFast('x'.repeat(CLIENT_MESSAGE_LIMIT_BYTES + 1));
    peer.receiveFast({ ...fastInput(), version: 1 });
    peer.receiveFast({ ...fastInput(), extra: true });
    peer.receiveFast(fastInput(SECOND_GENERATION));
    peer.receiveFast(fastInput(FIRST_GENERATION, 3));

    expect(first.acceptedInputs).toEqual([]);
  });

  it('closes a replaced generation once and ignores messages or closure from the old peer', async () => {
    const { hub, factory } = createSubject();
    const first = session();
    hub.attachSession(first.session);
    const oldPeer = await negotiateAndActivate(hub, factory);
    hub.publish(started());

    await vi.advanceTimersByTimeAsync(1_000);
    const heartbeat = JSON.parse(oldPeer.reliableSent.at(-1)!);
    const probe = JSON.parse(oldPeer.fastSent.at(-1)!);
    oldPeer.receiveReliable({
      version: GAMEPLAY_PROTOCOL_VERSION,
      generationId: FIRST_GENERATION,
      kind: 'heartbeat-ack',
      nonce: heartbeat.nonce
    });
    await vi.advanceTimersByTimeAsync(50);
    oldPeer.receiveFast({
      version: GAMEPLAY_PROTOCOL_VERSION,
      generationId: FIRST_GENERATION,
      kind: 'probe-ack',
      nonce: probe.nonce
    });
    expect(first.networkSamples).toEqual([{ medianMs: 50, jitterMs: 0, sampledAt: 1_050 }]);

    await hub.negotiate('s1', {
      generationId: SECOND_GENERATION,
      offer: { type: 'offer', sdp: 'replacement' }
    });
    const replacement = factory.peers[1]!;
    replacement.openBothChannels();
    expect(hub.activate('s1', { generationId: FIRST_GENERATION })).toBe(false);
    expect(hub.activate('s1', { generationId: SECOND_GENERATION })).toBe(true);
    oldPeer.receiveFast(fastInput());
    oldPeer.disconnect();

    expect(oldPeer.closeCalls).toBe(1);
    expect(first.acceptedInputs).toEqual([]);
    expect(first.networkClearTimes).toEqual([1_050]);
    expect(hub.modeForPlayer('p1')).toBe('webrtc');
  });

  it('caps activation at five seconds and performs the fallback transition once', async () => {
    const { hub, factory } = createSubject();
    const first = session();
    hub.attachSession(first.session);
    await hub.negotiate('s1', {
      generationId: FIRST_GENERATION,
      offer: { type: 'offer', sdp: 'browser-offer' }
    });
    const peer = factory.peers[0]!;
    peer.openBothChannels();

    await vi.advanceTimersByTimeAsync(5_000);
    expect(hub.activate('s1', { generationId: FIRST_GENERATION })).toBe(false);
    hub.fallback('s1');
    peer.disconnect();
    await vi.runAllTicks();

    expect(hub.modeForPlayer('p1')).toBe('websocket');
    expect(first.emittedModes).toEqual([{ generationId: FIRST_GENERATION, mode: 'websocket' }]);
    expect(first.networkClearTimes).toEqual([5_000]);
    expect(peer.closeCalls).toBe(1);
  });

  it('sends active snapshots only on fast WebRTC and drops only a backpressured intermediate snapshot', async () => {
    const { hub, factory } = createSubject();
    const first = session();
    hub.attachSession(first.session);
    const peer = await negotiateAndActivate(hub, factory);
    hub.publish(started());
    first.emittedSnapshots.length = 0;

    hub.publish(snapshotPublication());
    peer.fastResult = 'backpressured';
    hub.publish(snapshotPublication('AB2Z', 2, { ...snapshot, tick: 43 }));

    expect(peer.fastSent.map((message) => JSON.parse(message))).toEqual([{
      version: GAMEPLAY_PROTOCOL_VERSION,
      generationId: FIRST_GENERATION,
      kind: 'snapshot',
      payload: { matchEpoch: 2, eventCursor: 7, snapshot }
    }]);
    expect(first.emittedSnapshots).toEqual([]);
    expect(hub.modeForPlayer('p1')).toBe('webrtc');
  });

  it('falls back on a closed fast send and emits that same snapshot through Socket.IO', async () => {
    const { hub, factory } = createSubject();
    const first = session();
    hub.attachSession(first.session);
    const peer = await negotiateAndActivate(hub, factory);
    hub.publish(started());
    peer.fastResult = 'closed';

    hub.publish(snapshotPublication());
    await vi.runAllTicks();

    expect(first.emittedSnapshots).toEqual([snapshotSafety()]);
    expect(first.emittedModes.at(-1)).toEqual({ generationId: FIRST_GENERATION, mode: 'websocket' });
    expect(hub.modeForPlayer('p1')).toBe('websocket');
    expect(peer.closeCalls).toBe(1);
  });

  it('sends starts and events reliably with Socket.IO safety copies and falls back on reliable backpressure', async () => {
    const { hub, factory } = createSubject();
    const first = session();
    hub.attachSession(first.session);
    const peer = await negotiateAndActivate(hub, factory);

    hub.publish(started());
    hub.publish(eventPublication());
    expect(peer.reliableSent.map((message) => JSON.parse(message))).toEqual([
      {
        version: GAMEPLAY_PROTOCOL_VERSION,
        generationId: FIRST_GENERATION,
        kind: 'started',
        payload: { matchEpoch: 2, eventCursor: 7, snapshot }
      },
      {
        version: GAMEPLAY_PROTOCOL_VERSION,
        generationId: FIRST_GENERATION,
        kind: 'event',
        payload: { matchEpoch: 2, event }
      }
    ]);
    expect(first.emittedStarted).toEqual([startedSafety()]);
    expect(first.emittedEvents).toEqual([eventSafety()]);

    peer.reliableResult = 'backpressured';
    hub.publish(eventPublication('AB2Z', 2, { ...event, eventId: 8 }));
    expect(first.emittedEvents).toEqual([eventSafety(), eventSafety(2, { ...event, eventId: 8 })]);
    expect(hub.modeForPlayer('p1')).toBe('websocket');
  });

  it('falls back once after the third missed heartbeat acknowledgement and accepts only the current nonce', async () => {
    const { hub, factory } = createSubject();
    const first = session();
    hub.attachSession(first.session);
    const peer = await negotiateAndActivate(hub, factory);

    await vi.advanceTimersByTimeAsync(1_000);
    const heartbeat1 = JSON.parse(peer.reliableSent.at(-1)!);
    peer.receiveReliable({
      version: GAMEPLAY_PROTOCOL_VERSION,
      generationId: FIRST_GENERATION,
      kind: 'heartbeat-ack',
      nonce: heartbeat1.nonce + 1
    });
    await vi.advanceTimersByTimeAsync(1_000);
    const heartbeat2 = JSON.parse(peer.reliableSent.at(-1)!);
    peer.receiveReliable({
      version: GAMEPLAY_PROTOCOL_VERSION,
      generationId: FIRST_GENERATION,
      kind: 'heartbeat-ack',
      nonce: heartbeat2.nonce
    });
    await vi.advanceTimersByTimeAsync(4_000);

    expect(first.emittedModes).toEqual([
      { generationId: FIRST_GENERATION, mode: 'webrtc' },
      { generationId: FIRST_GENERATION, mode: 'websocket' }
    ]);
    expect(hub.modeForPlayer('p1')).toBe('websocket');
    expect(peer.closeCalls).toBe(1);
  });

  it('falls back when the reliable channel closes while sending a heartbeat', async () => {
    const { hub, factory } = createSubject();
    const first = session();
    hub.attachSession(first.session);
    const peer = await negotiateAndActivate(hub, factory);
    peer.reliableResult = 'closed';

    await vi.advanceTimersByTimeAsync(1_000);

    expect(first.emittedModes.at(-1)).toEqual({ generationId: FIRST_GENERATION, mode: 'websocket' });
    expect(hub.modeForPlayer('p1')).toBe('websocket');
  });

  it('publishes one server-timed RTT and median consecutive-sample jitter per matching fast probe acknowledgement', async () => {
    let serverNow = 50_000;
    let fakeTimerNow = 0;
    const advanceServerClock = async (timerDurationMs: number, serverDurationMs = timerDurationMs): Promise<void> => {
      fakeTimerNow += timerDurationMs;
      serverNow += serverDurationMs;
      await vi.advanceTimersByTimeAsync(timerDurationMs);
    };
    const { hub, factory } = createSubject(() => serverNow);
    const first = session();
    hub.attachSession(first.session);
    const peer = await negotiateAndActivate(hub, factory);

    await advanceServerClock(1_000);
    const firstHeartbeat = JSON.parse(peer.reliableSent.at(-1)!);
    const firstProbe = JSON.parse(peer.fastSent.at(-1)!);
    await advanceServerClock(50);
    peer.receiveFast({
      version: GAMEPLAY_PROTOCOL_VERSION,
      generationId: SECOND_GENERATION,
      kind: 'probe-ack',
      nonce: firstProbe.nonce
    });
    expect(first.networkSamples).toEqual([]);
    peer.receiveReliable({
      version: GAMEPLAY_PROTOCOL_VERSION,
      generationId: FIRST_GENERATION,
      kind: 'heartbeat-ack',
      nonce: firstHeartbeat.nonce
    });
    expect(first.networkSamples).toEqual([]);
    peer.receiveFast({
      version: GAMEPLAY_PROTOCOL_VERSION,
      generationId: FIRST_GENERATION,
      kind: 'probe-ack',
      nonce: firstProbe.nonce
    });
    expect(first.networkSamples).toEqual([{ medianMs: 50, jitterMs: 0, sampledAt: 51_050 }]);

    peer.receiveFast({
      version: GAMEPLAY_PROTOCOL_VERSION,
      generationId: FIRST_GENERATION,
      kind: 'probe-ack',
      nonce: firstProbe.nonce
    });
    peer.receiveFast({
      version: GAMEPLAY_PROTOCOL_VERSION,
      generationId: FIRST_GENERATION,
      kind: 'probe-ack',
      nonce: firstProbe.nonce + 1
    });
    expect(first.networkSamples).toEqual([{ medianMs: 50, jitterMs: 0, sampledAt: 51_050 }]);

    let nextHeartbeatTimerAt = 2_000;
    for (const [delayMs, expectedMedianMs] of [[10, 30], [30, 30], [100, 40], [20, 30], [0, 20]] as const) {
      await advanceServerClock(nextHeartbeatTimerAt - fakeTimerNow);
      const heartbeat = JSON.parse(peer.reliableSent.at(-1)!);
      const probe = JSON.parse(peer.fastSent.at(-1)!);
      peer.receiveReliable({
        version: GAMEPLAY_PROTOCOL_VERSION,
        generationId: FIRST_GENERATION,
        kind: 'heartbeat-ack',
        nonce: heartbeat.nonce
      });
      await advanceServerClock(delayMs);
      peer.receiveFast({
        version: GAMEPLAY_PROTOCOL_VERSION,
        generationId: FIRST_GENERATION,
        kind: 'probe-ack',
        nonce: probe.nonce
      });
      expect(first.networkSamples.at(-1)?.medianMs).toBe(expectedMedianMs);
      nextHeartbeatTimerAt += 1_000;
    }

    expect(first.networkSamples).toEqual([
      { medianMs: 50, jitterMs: 0, sampledAt: 51_050 },
      { medianMs: 30, jitterMs: 40, sampledAt: 52_010 },
      { medianMs: 30, jitterMs: 30, sampledAt: 53_030 },
      { medianMs: 40, jitterMs: 40, sampledAt: 54_100 },
      { medianMs: 30, jitterMs: 55, sampledAt: 55_020 },
      { medianMs: 20, jitterMs: 45, sampledAt: 56_000 }
    ]);
  });

  it('does not fall back or publish RTT when fast probes are lost or backpressured', async () => {
    const { hub, factory } = createSubject();
    const first = session();
    hub.attachSession(first.session);
    const peer = await negotiateAndActivate(hub, factory);

    for (let heartbeatIndex = 0; heartbeatIndex < 4; heartbeatIndex += 1) {
      if (heartbeatIndex === 2) peer.fastResult = 'backpressured';
      await vi.advanceTimersByTimeAsync(1_000);
      const heartbeat = JSON.parse(peer.reliableSent.at(-1)!);
      peer.receiveReliable({
        version: GAMEPLAY_PROTOCOL_VERSION,
        generationId: FIRST_GENERATION,
        kind: 'heartbeat-ack',
        nonce: heartbeat.nonce
      });
    }

    expect(first.networkSamples).toEqual([]);
    expect(first.emittedModes).toEqual([{ generationId: FIRST_GENERATION, mode: 'webrtc' }]);
    expect(hub.modeForPlayer('p1')).toBe('webrtc');
  });

  it('resets expired WebRTC RTT history before recording the first post-gap acknowledgement', async () => {
    let serverNow = 0;
    let heartbeat: (() => void) | null = null;
    const heartbeatInterval = vi.spyOn(globalThis, 'setInterval').mockImplementation((callback) => {
      heartbeat = callback;
      return 0 as unknown as ReturnType<typeof setInterval>;
    });
    const { hub, factory } = createSubject(() => serverNow);
    const first = session();
    hub.attachSession(first.session);
    const peer = await negotiateAndActivate(hub, factory);

    const acknowledgeFastProbe = (elapsedMs: number): void => {
      if (!heartbeat) throw new Error('Expected the WebRTC heartbeat to be scheduled.');
      heartbeat();
      const heartbeatMessage = JSON.parse(peer.reliableSent.at(-1)!);
      const probeMessage = JSON.parse(peer.fastSent.at(-1)!);
      peer.receiveReliable({
        version: GAMEPLAY_PROTOCOL_VERSION,
        generationId: FIRST_GENERATION,
        kind: 'heartbeat-ack',
        nonce: heartbeatMessage.nonce
      });
      serverNow += elapsedMs;
      peer.receiveFast({
        version: GAMEPLAY_PROTOCOL_VERSION,
        generationId: FIRST_GENERATION,
        kind: 'probe-ack',
        nonce: probeMessage.nonce
      });
    };

    try {
      acknowledgeFastProbe(100);
      acknowledgeFastProbe(300);
      expect(first.networkSamples).toEqual([
        { medianMs: 100, jitterMs: 0, sampledAt: 100 },
        { medianMs: 200, jitterMs: 200, sampledAt: 400 }
      ]);

      serverNow += 6_000;
      await vi.advanceTimersByTimeAsync(6_000);
      expect(first.networkClearTimes).toHaveLength(1);

      acknowledgeFastProbe(50);
      expect(first.networkSamples.at(-1)).toEqual({ medianMs: 50, jitterMs: 0, sampledAt: 6_450 });
    } finally {
      heartbeatInterval.mockRestore();
    }
  });

  it('discards overdue WebRTC RTT history before its freshness timer callback runs', async () => {
    let serverNow = 0;
    let heartbeat: (() => void) | null = null;
    const heartbeatInterval = vi.spyOn(globalThis, 'setInterval').mockImplementation((callback) => {
      heartbeat = callback;
      return 0 as unknown as ReturnType<typeof setInterval>;
    });
    const { hub, factory } = createSubject(() => serverNow);
    const first = session();
    hub.attachSession(first.session);
    const peer = await negotiateAndActivate(hub, factory);

    const acknowledgeFastProbe = (elapsedMs: number): void => {
      if (!heartbeat) throw new Error('Expected the WebRTC heartbeat to be scheduled.');
      heartbeat();
      const heartbeatMessage = JSON.parse(peer.reliableSent.at(-1)!);
      const probeMessage = JSON.parse(peer.fastSent.at(-1)!);
      peer.receiveReliable({
        version: GAMEPLAY_PROTOCOL_VERSION,
        generationId: FIRST_GENERATION,
        kind: 'heartbeat-ack',
        nonce: heartbeatMessage.nonce
      });
      serverNow += elapsedMs;
      peer.receiveFast({
        version: GAMEPLAY_PROTOCOL_VERSION,
        generationId: FIRST_GENERATION,
        kind: 'probe-ack',
        nonce: probeMessage.nonce
      });
    };

    try {
      acknowledgeFastProbe(100);
      acknowledgeFastProbe(300);
      expect(first.networkSamples).toEqual([
        { medianMs: 100, jitterMs: 0, sampledAt: 100 },
        { medianMs: 200, jitterMs: 200, sampledAt: 400 }
      ]);

      serverNow += 6_000;
      expect(first.networkClearTimes).toEqual([]);

      acknowledgeFastProbe(50);
      expect(first.networkSamples.at(-1)).toEqual({ medianMs: 50, jitterMs: 0, sampledAt: 6_450 });
      expect(first.networkClearTimes).toEqual([]);
    } finally {
      heartbeatInterval.mockRestore();
    }
  });

  it('isolates room publications and peer failure to their server-owned sessions', async () => {
    const { hub, factory } = createSubject();
    const first = session();
    const second = session({ socketId: 's2', playerId: 'p2', roomCode: 'CD3Y' });
    hub.attachSession(first.session);
    hub.attachSession(second.session);
    const firstPeer = await negotiateAndActivate(hub, factory, 's1');
    await hub.negotiate('s2', {
      generationId: SECOND_GENERATION,
      offer: { type: 'offer', sdp: 'second-browser' }
    });
    const secondPeer = factory.peers[1]!;
    secondPeer.openBothChannels();
    expect(hub.activate('s2', { generationId: SECOND_GENERATION })).toBe(true);

    hub.publish(started('AB2Z'));
    firstPeer.disconnect();
    hub.publish(eventPublication('CD3Y'));

    expect(first.emittedStarted).toEqual([startedSafety()]);
    expect(first.emittedEvents).toEqual([]);
    expect(second.emittedStarted).toEqual([]);
    expect(second.emittedEvents).toEqual([eventSafety()]);
    expect(hub.modeForPlayer('p1')).toBe('websocket');
    expect(hub.modeForPlayer('p2')).toBe('webrtc');
    expect(second.emittedModes).toEqual([{ generationId: SECOND_GENERATION, mode: 'webrtc' }]);
  });

  it('cycles active and pending peers without leaking timers or closing any peer twice', async () => {
    const { hub, factory } = createSubject();
    for (let index = 0; index < 12; index += 1) {
      const socketId = `s${index}`;
      const generationId = index % 2 === 0 ? FIRST_GENERATION : SECOND_GENERATION;
      hub.attachSession(session({ socketId, playerId: `p${index}` }).session);
      await hub.negotiate(socketId, {
        generationId,
        offer: { type: 'offer', sdp: `browser-${index}` }
      });
      if (index % 2 === 0) {
        factory.peers[index]!.openBothChannels();
        expect(hub.activate(socketId, { generationId })).toBe(true);
      }
    }

    await hub.detachSession('s0');
    await hub.detachSession('s0');
    await hub.stop();
    await hub.stop();

    expect(factory.peers).toHaveLength(12);
    expect(factory.peers.map((peer) => peer.closeCalls)).toEqual(Array.from({ length: 12 }, () => 1));
    expect(hub.modeForPlayer('p0')).toBeNull();
    expect(hub.modeForPlayer('p11')).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('drops a peer by authenticated player identity without penalizing or removing the session', async () => {
    const { hub, factory } = createSubject();
    const first = session();
    hub.attachSession(first.session);
    const peer = await negotiateAndActivate(hub, factory);

    await hub.dropPeerForTest('p1');
    await hub.dropPeerForTest('p1');

    expect(peer.closeCalls).toBe(1);
    expect(hub.modeForPlayer('p1')).toBe('websocket');
    hub.publish(snapshotPublication());
    expect(first.emittedSnapshots).toEqual([snapshotSafety()]);
  });

  it('can restart after an awaited stop without retaining peers or UDP-range ownership', async () => {
    const { hub, factory } = createSubject();
    hub.attachSession(session().session);
    const firstPeer = await negotiateAndActivate(hub, factory);

    await hub.stop();
    hub.start();
    hub.attachSession(session({ socketId: 's2', playerId: 'p2' }).session);
    await hub.negotiate('s2', {
      generationId: SECOND_GENERATION,
      offer: { type: 'offer', sdp: 'restart-offer' }
    });

    expect(firstPeer.closeCalls).toBe(1);
    expect(factory.calls.map((call) => call.udpPortRange)).toEqual([UDP_PORT_RANGE, UDP_PORT_RANGE]);
  });
});
