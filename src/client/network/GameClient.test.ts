import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  MatchEventPublication,
  MatchSnapshotPublication,
  MatchStartedPublication,
  TransportModeNotice
} from '../../shared/gameplayTransport.js';
import type { GameEvent, InputFrame, MatchSnapshot, RoomState, SessionWelcome } from '../../shared/model.js';
import { DEFAULT_ROOM_SETTINGS } from '../../shared/roomSettings.js';

const socketHarness = vi.hoisted(() => {
  type Handler = (...args: never[]) => void;
  const handlers = new Map<string, Set<Handler>>();
  const managerHandlers = new Map<string, Set<Handler>>();
  const addHandler = (target: Map<string, Set<Handler>>, event: string, handler: Handler): void => {
    const listeners = target.get(event) ?? new Set<Handler>();
    listeners.add(handler);
    target.set(event, listeners);
  };
  const socket = {
    connected: false,
    active: false,
    on: vi.fn((event: string, handler: Handler) => addHandler(handlers, event, handler)),
    emit: vi.fn(),
    connect: vi.fn(),
    disconnect: vi.fn(),
    io: { on: vi.fn((event: string, handler: Handler) => addHandler(managerHandlers, event, handler)) }
  };
  return {
    socket,
    io: vi.fn(() => socket),
    trigger(event: string, ...args: unknown[]): void {
      for (const listener of handlers.get(event) ?? []) listener(...(args as never[]));
    },
    reset(): void {
      handlers.clear();
      managerHandlers.clear();
      socket.connected = false;
      socket.active = false;
      socket.on.mockClear();
      socket.emit.mockReset();
      socket.connect.mockClear();
      socket.disconnect.mockClear();
      socket.io.on.mockClear();
      this.io.mockClear();
    }
  };
});

vi.mock('socket.io-client', () => ({ io: socketHarness.io }));

const gameplayHarness = vi.hoisted(() => {
  type SignalingResult = Readonly<{ ok: boolean }>;
  type TransportOptions = Readonly<{
    negotiate: (request: unknown) => Promise<SignalingResult>;
    activate: (request: unknown) => Promise<SignalingResult>;
    sendFallbackInput: (input: InputFrame) => void;
  }>;
  let automaticSignaling = false;
  const optionSets: TransportOptions[] = [];
  const transports: Array<{
    start: ReturnType<typeof vi.fn>;
    acceptMode: ReturnType<typeof vi.fn>;
    acceptSocketStarted: ReturnType<typeof vi.fn>;
    acceptSocketSnapshot: ReturnType<typeof vi.fn>;
    acceptSocketEvent: ReturnType<typeof vi.fn>;
    acceptAuthoritativeSnapshot: ReturnType<typeof vi.fn>;
    sendInput: ReturnType<typeof vi.fn>;
    fallback: ReturnType<typeof vi.fn>;
    dispose: ReturnType<typeof vi.fn>;
  }> = [];
  const createTransport = () => ({
    start: vi.fn(async () => undefined),
    acceptMode: vi.fn(),
    acceptSocketStarted: vi.fn(),
    acceptSocketSnapshot: vi.fn(),
    acceptSocketEvent: vi.fn(),
    acceptAuthoritativeSnapshot: vi.fn(),
    sendInput: vi.fn(() => false),
    fallback: vi.fn(),
    dispose: vi.fn()
  });
  const createGameplayTransport = vi.fn((options: TransportOptions) => {
    const transport = createTransport();
    const generationId = `00000000-0000-4000-8000-${String(transports.length + 1).padStart(12, '0')}`;
    if (automaticSignaling) {
      transport.start.mockImplementation(async () => {
        const negotiation = await options.negotiate({
          generationId,
          offer: { type: 'offer', sdp: `client-offer:${generationId}` }
        });
        if (!negotiation.ok) return;
        await options.activate({ generationId });
      });
    }
    optionSets.push(options);
    transports.push(transport);
    return transport;
  });
  return {
    transports,
    createGameplayTransport,
    get transport() {
      return transports.at(-1)!;
    },
    get firstTransport() {
      return transports[0]!;
    },
    get options() {
      return optionSets.at(-1)!;
    },
    enableAutomaticSignaling(): void {
      automaticSignaling = true;
    },
    reset(): void {
      transports.splice(0);
      optionSets.splice(0);
      automaticSignaling = false;
      createGameplayTransport.mockClear();
    }
  };
});

const sequencerHarness = vi.hoisted(() => {
  type Options = Readonly<{
    onStarted: (value: unknown) => void;
    onSnapshot: (value: unknown) => void;
    onEvent: (value: unknown) => void;
    onTransportGap: () => void;
  }>;
  const sequencers: Array<{
    options: Options;
    acceptStarted: ReturnType<typeof vi.fn>;
    acceptSnapshot: ReturnType<typeof vi.fn>;
    acceptEvent: ReturnType<typeof vi.fn>;
    dispose: ReturnType<typeof vi.fn>;
  }> = [];
  const createMatchPublicationSequencer = vi.fn((options: Options) => {
    const sequencer = {
      options,
      acceptStarted: vi.fn(),
      acceptSnapshot: vi.fn(),
      acceptEvent: vi.fn(),
      dispose: vi.fn()
    };
    sequencers.push(sequencer);
    return sequencer;
  });
  return {
    sequencers,
    createMatchPublicationSequencer,
    get sequencer() {
      return sequencers.at(-1)!;
    },
    get firstSequencer() {
      return sequencers[0]!;
    },
    reset(): void {
      sequencers.splice(0);
      createMatchPublicationSequencer.mockClear();
    }
  };
});

vi.mock('./GameplayTransport.js', () => ({
  createGameplayTransport: gameplayHarness.createGameplayTransport
}));

vi.mock('./MatchPublicationSequencer.js', () => ({
  createMatchPublicationSequencer: sequencerHarness.createMatchPublicationSequencer
}));

import { createSocketGameClient } from './GameClient.js';

function roomState(): RoomState {
  return {
    roomCode: 'AB2Z', phase: 'LOBBY', hostPlayerId: 'player-1', pauseRemainingMs: null, chatMessages: [],
    result: null, settings: DEFAULT_ROOM_SETTINGS, players: []
  };
}

function welcome(overrides: Partial<SessionWelcome> = {}): SessionWelcome {
  return {
    playerId: 'player-1',
    roomCode: 'AB2Z',
    resumeToken: 'resume-1',
    resumed: false,
    ...overrides
  };
}

function matchSnapshot(tick = 1): MatchSnapshot {
  return {
    tick,
    phase: 'REGULATION',
    remainingMs: 10_000,
    platformProgress: 0,
    settings: { durationMs: 120_000, knockoutTarget: 5 },
    scores: {},
    network: {},
    players: [],
    pulses: [],
    winnerPlayerId: null,
    resultReason: null
  };
}

function matchEvent(eventId = 1): GameEvent {
  return {
    eventId,
    tick: eventId,
    type: 'PHASE',
    phase: 'REGULATION',
    remainingMs: 9_000
  };
}

describe('createSocketGameClient', () => {
  beforeEach(() => {
    socketHarness.reset();
    gameplayHarness.reset();
    sequencerHarness.reset();
  });
  afterEach(() => vi.useRealTimers());

  it('creates one same-origin client with WebSocket-first polling fallback and cleans external subscriptions', () => {
    const client = createSocketGameClient();
    const listener = vi.fn();
    const unsubscribe = client.subscribe('room:state', listener);
    expect(socketHarness.io).toHaveBeenCalledOnce();
    expect(socketHarness.io).toHaveBeenCalledWith(window.location.origin, expect.objectContaining({
      autoConnect: false,
      reconnection: true,
      reconnectionAttempts: Infinity,
      transports: ['websocket', 'polling'],
      tryAllTransports: true
    }));
    socketHarness.trigger('room:state', roomState());
    expect(listener).toHaveBeenCalledOnce();
    unsubscribe();
    unsubscribe();
    socketHarness.trigger('room:state', roomState());
    expect(listener).toHaveBeenCalledOnce();
  });

  it('returns a typed recoverable failure when an acknowledgement times out', async () => {
    vi.useFakeTimers();
    const client = createSocketGameClient({ acknowledgementTimeoutMs: 25 });
    const acknowledgement = client.createRoom('Ada');
    await vi.advanceTimersByTimeAsync(25);
    await expect(acknowledgement).resolves.toEqual({
      ok: false,
      error: { code: 'ACK_TIMEOUT', message: 'Sunucu yanıt vermedi.', recoverable: true }
    });
  });

  it('emits the complete room settings pair through one acknowledged event', async () => {
    socketHarness.socket.emit.mockImplementation((_event, _payload, acknowledge?: (value: unknown) => void) => {
      acknowledge?.({ ok: true, data: null });
    });
    const client = createSocketGameClient();

    await client.setRoomSettings({ durationMs: 90_000, knockoutTarget: 3 });

    expect(socketHarness.socket.emit.mock.calls).toEqual([
      ['lobby:settings', { durationMs: 90_000, knockoutTarget: 3 }, expect.any(Function)]
    ]);
  });

  it('emits one acknowledged empty leave-room request', async () => {
    socketHarness.socket.emit.mockImplementation((_event, _payload, acknowledge?: (value: unknown) => void) => {
      acknowledge?.({ ok: true, data: null });
    });
    const client = createSocketGameClient();

    await client.leaveRoom();

    expect(socketHarness.socket.emit.mock.calls).toEqual([
      ['room:leave', {}, expect.any(Function)]
    ]);
    expect(gameplayHarness.transport.dispose).toHaveBeenCalledOnce();
    expect(sequencerHarness.sequencer.dispose).toHaveBeenCalledOnce();
  });

  it('keeps the gameplay transport when leave-room is rejected', async () => {
    socketHarness.socket.emit.mockImplementation((_event, _payload, acknowledge?: (value: unknown) => void) => {
      acknowledge?.({
        ok: false,
        error: { code: 'NOT_IN_ROOM', message: 'Not in a room.', recoverable: true }
      });
    });
    const client = createSocketGameClient();

    await client.leaveRoom();

    expect(gameplayHarness.transport.dispose).not.toHaveBeenCalled();
  });

  it('emits the revised chassis, ready, start, result-ready, and lobby contracts', async () => {
    socketHarness.socket.emit.mockImplementation((_event, _payload, acknowledge?: (value: unknown) => void) => {
      acknowledge?.({ ok: true, data: null });
    });
    const client = createSocketGameClient();
    const formerTransport = gameplayHarness.transport;
    const formerSequencer = sequencerHarness.sequencer;
    await client.setChassis('WRAITH');
    await client.setReady(true);
    await client.startMatch();
    await client.setResultReady(false);
    await client.returnToLobby();
    expect(socketHarness.socket.emit.mock.calls).toEqual([
      ['lobby:chassis', { chassis: 'WRAITH' }, expect.any(Function)],
      ['lobby:ready', { ready: true }, expect.any(Function)],
      ['match:start', {}, expect.any(Function)],
      ['result:ready', { ready: false }, expect.any(Function)],
      ['result:lobby', {}, expect.any(Function)]
    ]);
    expect(formerTransport.dispose).not.toHaveBeenCalled();
    expect(formerSequencer.dispose).not.toHaveBeenCalled();
  });

  it('automatically negotiates a fresh transport from result return before the epoch-two countdown starts', async () => {
    gameplayHarness.enableAutomaticSignaling();
    socketHarness.socket.emit.mockImplementation((event, payload, acknowledge?: (value: unknown) => void) => {
      if (event === 'transport:negotiate') {
        const request = payload as { generationId: string };
        acknowledge?.({
          ok: true,
          data: {
            generationId: request.generationId,
            answer: { type: 'answer', sdp: 'server-answer' }
          }
        });
        return;
      }
      if (event === 'transport:activate') {
        const request = payload as { generationId: string };
        acknowledge?.({ ok: true, data: { generationId: request.generationId, mode: 'webrtc' } });
        return;
      }
      acknowledge?.({ ok: true, data: null });
    });
    const client = createSocketGameClient();
    const observedRoomStates: RoomState[] = [];
    client.subscribe('room:state', (state) => observedRoomStates.push(state));
    socketHarness.trigger('session:welcome', welcome());
    await Promise.resolve();
    await Promise.resolve();
    const firstTransport = gameplayHarness.transport;
    const firstGeneration = (socketHarness.socket.emit.mock.calls.find(
      ([event]) => event === 'transport:negotiate'
    )?.[1] as { generationId?: string } | undefined)?.generationId;
    expect(firstGeneration).toEqual(expect.any(String));
    socketHarness.trigger('room:state', {
      ...roomState(),
      phase: 'RESULT',
      result: { winnerPlayerId: 'player-1', reason: 'TARGET_SCORE', players: [] }
    });
    expect(observedRoomStates.at(-1)?.phase).toBe('RESULT');
    socketHarness.socket.emit.mockClear();

    const lobbyReturn = client.returnToLobby();
    socketHarness.trigger('room:state', roomState());
    socketHarness.trigger('room:state', roomState());
    await expect(lobbyReturn).resolves.toEqual({ ok: true, data: null });
    await Promise.resolve();
    await Promise.resolve();

    const rematchTransport = gameplayHarness.transport;
    expect(rematchTransport).not.toBe(firstTransport);
    expect(firstTransport.dispose).toHaveBeenCalledOnce();
    const rematchNegotiate = socketHarness.socket.emit.mock.calls.find(([event]) => event === 'transport:negotiate');
    const rematchActivate = socketHarness.socket.emit.mock.calls.find(([event]) => event === 'transport:activate');
    expect(rematchNegotiate).toEqual([
      'transport:negotiate',
      expect.objectContaining({ generationId: expect.any(String) }),
      expect.any(Function)
    ]);
    expect(rematchActivate).toEqual([
      'transport:activate',
      expect.objectContaining({ generationId: rematchNegotiate?.[1].generationId }),
      expect.any(Function)
    ]);
    expect(rematchNegotiate?.[1].generationId).not.toBe(firstGeneration);

    const epochTwoStart: MatchStartedPublication = {
      matchEpoch: 2,
      eventCursor: 0,
      snapshot: { ...matchSnapshot(0), phase: 'COUNTDOWN' }
    };
    socketHarness.trigger('match:started', epochTwoStart);
    expect(rematchTransport.acceptSocketStarted).toHaveBeenCalledWith(epochTwoStart);
    expect(firstTransport.acceptSocketStarted).not.toHaveBeenCalled();
  });

  it('renegotiates once for a guest when the authoritative room phase returns from result to lobby', async () => {
    const client = createSocketGameClient();
    socketHarness.trigger('session:welcome', welcome({ playerId: 'guest-1' }));
    const firstTransport = gameplayHarness.transport;
    socketHarness.trigger('room:state', {
      ...roomState(),
      phase: 'RESULT',
      result: { winnerPlayerId: 'player-1', reason: 'TARGET_SCORE', players: [] }
    });

    socketHarness.trigger('room:state', roomState());
    socketHarness.trigger('room:state', roomState());

    expect(gameplayHarness.transports).toHaveLength(2);
    expect(firstTransport.dispose).toHaveBeenCalledOnce();
    expect(gameplayHarness.transport.start).toHaveBeenCalledOnce();
    expect(socketHarness.socket.emit).not.toHaveBeenCalledWith('result:lobby', expect.anything(), expect.anything());
    client.disconnect();
  });

  it('acknowledges an input latch only from a sequencer-accepted snapshot for the welcomed local player', () => {
    createSocketGameClient();
    socketHarness.trigger('session:welcome', welcome({ playerId: 'player-1' }));
    const accepted = {
      ...matchSnapshot(7),
      players: [{ playerId: 'player-1', lastProcessedInputSeq: 41 }]
    } as unknown as MatchSnapshot;

    sequencerHarness.sequencer.options.onSnapshot(accepted);

    expect(gameplayHarness.transport.acceptAuthoritativeSnapshot).toHaveBeenCalledWith(accepted, 'player-1');
  });

  it('sends match input fire-and-forget without an acknowledgement callback', () => {
    const client = createSocketGameClient();
    const input: InputFrame = {
      seq: 4, viewTick: 3, moveX: 1, moveY: 0, aimX: 0.8, aimY: -0.2, quick: true, heavy: false, dash: true
    };
    client.sendInput(input);
    expect(gameplayHarness.transport.sendInput).toHaveBeenCalledWith(input);
    expect(socketHarness.socket.emit).toHaveBeenCalledWith('match:input', input);
    expect(socketHarness.socket.emit.mock.calls.at(-1)).toHaveLength(2);
  });

  it('does not duplicate input on Socket.IO when the gameplay channel accepts it', () => {
    const client = createSocketGameClient();
    gameplayHarness.transport.sendInput.mockReturnValue(true);
    const value: InputFrame = {
      seq: 5, viewTick: 4, moveX: 0, moveY: 1, aimX: -1, aimY: 0, quick: false, heavy: true, dash: false
    };

    client.sendInput(value);

    expect(gameplayHarness.transport.sendInput).toHaveBeenCalledWith(value);
    expect(socketHarness.socket.emit).not.toHaveBeenCalledWith('match:input', expect.anything());
  });

  it('routes an attack edge replay requested by the gameplay fallback through Socket.IO', () => {
    createSocketGameClient();
    const attackEdge: InputFrame = {
      seq: 6, viewTick: 5, moveX: 0, moveY: 0, aimX: 1, aimY: 0, quick: true, heavy: false, dash: false
    };

    gameplayHarness.options.sendFallbackInput(attackEdge);

    expect(socketHarness.socket.emit).toHaveBeenCalledWith('match:input', attackEdge);
    expect(socketHarness.socket.emit.mock.calls.at(-1)).toHaveLength(2);
  });

  it('starts a fresh generation for welcome and disposes the replaced session before restarting', () => {
    createSocketGameClient();

    socketHarness.trigger('session:welcome', welcome());
    const firstTransport = gameplayHarness.firstTransport;
    const firstSequencer = sequencerHarness.firstSequencer;
    socketHarness.trigger('session:welcome', welcome({ resumed: true, resumeToken: 'resume-2' }));

    expect(gameplayHarness.transports).toHaveLength(2);
    expect(firstTransport.start).toHaveBeenCalledOnce();
    expect(firstTransport.dispose).toHaveBeenCalledOnce();
    expect(firstSequencer.dispose).toHaveBeenCalledOnce();
    expect(gameplayHarness.transport.start).toHaveBeenCalledOnce();
    expect(firstTransport.dispose.mock.invocationCallOrder[0]).toBeLessThan(
      gameplayHarness.transport.start.mock.invocationCallOrder[0]!
    );
  });

  it('routes matching transport mode notices into gameplay arbitration', () => {
    createSocketGameClient();
    const notice: TransportModeNotice = {
      generationId: '11111111-1111-4111-8111-111111111111',
      mode: 'webrtc'
    };

    socketHarness.trigger('transport:mode', notice);

    expect(gameplayHarness.transport.acceptMode).toHaveBeenCalledWith(notice);
  });

  it('routes epoch-bearing Socket.IO safety publications through the owning gameplay controller and acknowledges snapshots', () => {
    const client = createSocketGameClient();
    const startedListener = vi.fn();
    const snapshotListener = vi.fn();
    const eventListener = vi.fn();
    const startValue: MatchStartedPublication = {
      matchEpoch: 1,
      eventCursor: 0,
      snapshot: matchSnapshot(1)
    };
    const snapshotValue: MatchSnapshotPublication = {
      matchEpoch: 1,
      eventCursor: 1,
      snapshot: matchSnapshot(2)
    };
    const eventValue: MatchEventPublication = { matchEpoch: 1, event: matchEvent() };
    client.subscribe('match:started', startedListener);
    client.subscribe('match:snapshot', snapshotListener);
    client.subscribe('match:event', eventListener);

    socketHarness.trigger('match:started', startValue);
    const acknowledgeSnapshot = vi.fn();
    socketHarness.trigger('match:snapshot', snapshotValue, acknowledgeSnapshot);
    socketHarness.trigger('match:event', eventValue);

    expect(startedListener).not.toHaveBeenCalled();
    expect(snapshotListener).not.toHaveBeenCalled();
    expect(eventListener).not.toHaveBeenCalled();
    expect(gameplayHarness.transport.acceptSocketStarted).toHaveBeenCalledWith(startValue);
    expect(gameplayHarness.transport.acceptSocketSnapshot).toHaveBeenCalledWith(snapshotValue);
    expect(acknowledgeSnapshot).toHaveBeenCalledOnce();
    expect(gameplayHarness.transport.acceptSocketEvent).toHaveBeenCalledWith(eventValue);
  });

  it('acknowledges a Socket.IO snapshot even after the active gameplay bundle is disposed', () => {
    const client = createSocketGameClient();
    const acknowledgeSnapshot = vi.fn();

    client.disconnect();
    socketHarness.trigger('match:snapshot', {
      matchEpoch: 1,
      eventCursor: 1,
      snapshot: matchSnapshot(2)
    }, acknowledgeSnapshot);

    expect(acknowledgeSnapshot).toHaveBeenCalledOnce();
    expect(gameplayHarness.firstTransport.acceptSocketSnapshot).not.toHaveBeenCalled();
  });

  it('acknowledges a Socket.IO snapshot even when a snapshot subscriber throws', () => {
    const client = createSocketGameClient();
    gameplayHarness.transport.acceptSocketSnapshot.mockImplementation((publication: MatchSnapshotPublication) => {
      sequencerHarness.sequencer.options.onSnapshot(publication.snapshot);
    });
    client.subscribe('match:snapshot', () => {
      throw new Error('snapshot subscriber failed');
    });
    const acknowledgeSnapshot = vi.fn();

    expect(() => socketHarness.trigger('match:snapshot', {
      matchEpoch: 1,
      eventCursor: 1,
      snapshot: matchSnapshot(2)
    }, acknowledgeSnapshot)).toThrow('snapshot subscriber failed');

    expect(acknowledgeSnapshot).toHaveBeenCalledOnce();
  });

  it('disposes on explicit and non-resumable disconnects but waits through recoverable reconnects', () => {
    const explicitClient = createSocketGameClient();
    const explicitSequencer = sequencerHarness.sequencer;
    explicitClient.disconnect();
    expect(gameplayHarness.transport.dispose).toHaveBeenCalledOnce();
    expect(explicitSequencer.dispose).toHaveBeenCalledOnce();

    createSocketGameClient();
    const nonResumableTransport = gameplayHarness.transport;
    const nonResumableSequencer = sequencerHarness.sequencer;
    socketHarness.socket.active = false;
    socketHarness.trigger('disconnect', 'io server disconnect');
    expect(nonResumableTransport.dispose).toHaveBeenCalledOnce();
    expect(nonResumableSequencer.dispose).toHaveBeenCalledOnce();

    createSocketGameClient();
    const recoverableTransport = gameplayHarness.transport;
    const recoverableSequencer = sequencerHarness.sequencer;
    socketHarness.socket.active = true;
    socketHarness.trigger('disconnect', 'transport close');
    expect(recoverableTransport.dispose).not.toHaveBeenCalled();
    expect(recoverableSequencer.dispose).not.toHaveBeenCalled();
  });

  it('negotiates a fresh generation after a recoverable resume welcome', () => {
    createSocketGameClient();
    socketHarness.trigger('session:welcome', welcome());
    const formerTransport = gameplayHarness.transport;
    const formerSequencer = sequencerHarness.sequencer;
    socketHarness.socket.active = true;

    socketHarness.trigger('disconnect', 'transport close');
    socketHarness.trigger('session:welcome', welcome({ resumed: true, resumeToken: 'resume-2' }));

    expect(formerTransport.dispose).toHaveBeenCalledOnce();
    expect(formerSequencer.dispose).toHaveBeenCalledOnce();
    expect(gameplayHarness.transport.start).toHaveBeenCalledOnce();
  });

  it('ignores a stale publication gap after a replacement session', () => {
    createSocketGameClient();
    socketHarness.trigger('session:welcome', welcome());
    const formerTransport = gameplayHarness.transport;
    const formerSequencer = sequencerHarness.sequencer;
    socketHarness.trigger('session:welcome', welcome({ resumed: true, resumeToken: 'resume-2' }));
    const currentTransport = gameplayHarness.transport;

    formerSequencer.options.onTransportGap();

    expect(formerTransport.fallback).not.toHaveBeenCalled();
    expect(currentTransport.fallback).not.toHaveBeenCalled();
    expect(socketHarness.socket.emit).not.toHaveBeenCalledWith('transport:fallback', {});
  });

  it('cancels and ignores a publication gap after explicit disconnect', () => {
    const client = createSocketGameClient();
    const formerTransport = gameplayHarness.transport;
    const formerSequencer = sequencerHarness.sequencer;

    client.disconnect();
    formerSequencer.options.onTransportGap();

    expect(formerSequencer.dispose).toHaveBeenCalledOnce();
    expect(formerTransport.fallback).not.toHaveBeenCalled();
    expect(socketHarness.socket.emit).not.toHaveBeenCalledWith('transport:fallback', {});
  });

  it('routes a current publication gap through the owning controller fallback method', () => {
    createSocketGameClient();
    const currentTransport = gameplayHarness.transport;

    sequencerHarness.sequencer.options.onTransportGap();

    expect(currentTransport.fallback).toHaveBeenCalledOnce();
    expect(socketHarness.socket.emit).not.toHaveBeenCalledWith('transport:fallback', {});
  });

  it('echoes only the server nonce when acknowledging a Socket.IO RTT probe', () => {
    createSocketGameClient();
    const acknowledge = vi.fn();

    socketHarness.trigger('network:probe', { nonce: 17 }, acknowledge);

    expect(acknowledge).toHaveBeenCalledOnce();
    expect(acknowledge).toHaveBeenCalledWith({ nonce: 17 });
    expect(socketHarness.socket.emit).not.toHaveBeenCalled();
  });

});
