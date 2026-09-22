import { afterEach, describe, expect, it, vi } from 'vitest';
import { GAME } from '../../shared/constants.js';
import type { Ack, SessionWelcome } from '../../shared/model.js';
import { RoomManager } from '../rooms/roomManager.js';
import { createGameServer } from './createGameServer.js';
import { GameplayTransportHub } from './gameplayTransport/GameplayTransportHub.js';
import type { TransportSession } from './gameplayTransport/GameplayTransportHub.js';
import type { MatchInputIngress } from './matchInputIngress.js';
import { registerSocketHandlers, type GameIo, type GameSocket } from './socketHandlers.js';

function inertTransportHub(): GameplayTransportHub {
  return new GameplayTransportHub({
    peerFactory: () => { throw new Error('No peer expected in this unit test.'); },
    udpPortRange: [54100, 54131]
  });
}

function controllableTransportHub() {
  let session: TransportSession | null = null;
  let mode: 'webrtc' | 'websocket' | 'polling' = 'websocket';
  const hub = {
    attachSession: (next: TransportSession): void => { session = next; },
    modeForPlayer: (): typeof mode => mode,
    synchronizeSession: (): void => undefined
  } as unknown as GameplayTransportHub;
  return {
    hub,
    setMode(next: typeof mode): void {
      mode = next;
      if (session === null) throw new Error('Transport session was not attached.');
      session.setNetworkMode(next);
    }
  };
}

describe('createGameServer scheduler', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('schedules authoritative room advancement at the shared tick rate', async () => {
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    const server = createGameServer({ host: '127.0.0.1', port: 0, clientDirectory: false });

    try {
      await server.start();
      expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 1_000 / GAME.tickRate);
    } finally {
      await server.stop();
    }
  });

  it('keeps the combat scripting surface absent unless the in-process test harness is explicitly enabled', () => {
    const productionServer = createGameServer({ clientDirectory: false });
    const testServer = createGameServer({ clientDirectory: false, enableTestHarness: true });

    expect(productionServer.testHarness).toBeNull();
    expect(testServer.testHarness?.runCombatScript).toBeTypeOf('function');
    expect(testServer.testHarness?.transportMode).toBeTypeOf('function');
    expect(testServer.testHarness?.dropWebRtc).toBeTypeOf('function');
    expect(testServer.testHarness?.acceptedInputs).toBeTypeOf('function');
    expect(testServer.testHarness?.transportGeneration).toBeTypeOf('function');
  });

  it('accepts transport impairment only through the existing test gameplay-transport path', () => {
    const server = createGameServer({
      clientDirectory: false,
      enableTestHarness: true,
      testGameplayTransport: {
        peerFactory: () => { throw new Error('No peer expected in this unit test.'); },
        udpPortRange: [54100, 54131],
        impairment: {
          oneWayDelayMs: 25,
          jitterSequenceMs: [0, 5],
          dropEveryNthPacket: 3,
          reorderWindow: 1
        }
      }
    });

    expect(server.testHarness).not.toBeNull();
  });

  it('accepts peer- and direction-aware impairment only through the test gameplay-transport path', () => {
    const server = createGameServer({
      clientDirectory: false,
      enableTestHarness: true,
      testGameplayTransport: {
        peerFactory: () => { throw new Error('No peer expected in this unit test.'); },
        udpPortRange: [54100, 54131],
        impairment: ({ generationId, direction }) => generationId === 'unimpaired-peer' || direction === 'inbound'
          ? null
          : {
              oneWayDelayMs: 25,
              jitterSequenceMs: [],
              dropEveryNthPacket: null,
              reorderWindow: 0
            }
      }
    });

    expect(server.testHarness).not.toBeNull();
  });
});

describe('Socket.IO RTT sampling', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('starts an immediate nonce probe for an established fallback session and measures only server elapsed time', () => {
    vi.useFakeTimers();
    let now = 100;
    let randomByte = 0;
    const rooms = new RoomManager({
      now: () => now,
      randomBytes: (size) => new Uint8Array(size).fill(randomByte++),
      publish: () => undefined
    });
    let onConnection: ((socket: GameSocket) => void) | undefined;
    const io = {
      on: (_event: string, listener: (socket: GameSocket) => void): void => {
        onConnection = listener;
      }
    } as unknown as GameIo;
    const socketListeners = new Map<string, (...args: unknown[]) => void>();
    const probes: Array<{
      payload: { nonce: number };
      acknowledge: (payload: { nonce: number }) => void;
    }> = [];
    const socket = {
      id: 'host-socket',
      conn: { transport: { name: 'websocket' }, on: () => undefined },
      emit: (event: string, ...args: unknown[]): boolean => {
        if (event === 'network:probe') {
          const acknowledgeWithTimeout = args[1] as (error: Error | null, payload: { nonce: number }) => void;
          probes.push({
            payload: args[0] as { nonce: number },
            acknowledge: (payload) => acknowledgeWithTimeout(null, payload)
          });
        }
        return true;
      },
      timeout: () => socket,
      join: async () => undefined,
      leave: async () => undefined,
      on: (event: string, listener: (...args: unknown[]) => void): void => {
        socketListeners.set(event, listener);
      }
    } as unknown as GameSocket;

    registerSocketHandlers({
      io,
      rooms,
      now: () => now,
      logger: { error: vi.fn() },
      transportHub: inertTransportHub(),
      onSession: () => undefined,
      onLeave: () => undefined,
      onDisconnect: () => undefined
    });
    if (!onConnection) throw new Error('Socket connection handler was not registered.');
    onConnection(socket);

    const createRoom = socketListeners.get('room:create') as (
      payload: { name: string },
      acknowledge: (acknowledgement: Ack<SessionWelcome>) => void
    ) => void;
    let welcome: SessionWelcome | undefined;
    createRoom({ name: 'Ada' }, (acknowledgement) => {
      if (!acknowledgement.ok) throw new Error(acknowledgement.error.code);
      welcome = acknowledgement.data;
    });

    expect(probes).toHaveLength(1);
    expect(probes[0]?.payload).toEqual({ nonce: 1 });
    if (!welcome) throw new Error('Host session was not established.');
    const guest = rooms.joinRoom('guest-socket', welcome.roomCode, 'Linus');
    rooms.setReady('host-socket', true);
    rooms.setReady('guest-socket', true);
    rooms.startMatch('host-socket');
    now = 112;
    probes[0]!.acknowledge({ nonce: probes[0]!.payload.nonce });
    rooms.advance(20);

    expect(rooms.currentMatchPublication('host-socket')?.snapshot.network).toMatchObject({
      [welcome.playerId]: { currentMs: 12, medianMs: 12, transport: 'websocket' },
      [guest.playerId]: { currentMs: null }
    });

    rooms.disconnect('guest-socket');
    expect(rooms.currentMatchPublication('host-socket')?.snapshot.phase).toBe('PAUSED');
    now = 1_100;
    vi.advanceTimersByTime(988);
    expect(probes.map(({ payload }) => payload)).toEqual([{ nonce: 1 }, { nonce: 2 }]);
    now = 1_108;
    probes[1]!.acknowledge({ nonce: 2 });
    expect(rooms.currentMatchPublication('host-socket')?.snapshot.network[welcome.playerId]).toMatchObject({
      currentMs: 8,
      medianMs: 10,
      transport: 'websocket'
    });

    now = 2_100;
    vi.advanceTimersByTime(992);
    expect(probes.map(({ payload }) => payload)).toEqual([{ nonce: 1 }, { nonce: 2 }, { nonce: 3 }]);
    now = 4_099;
    vi.advanceTimersByTime(1_999);
    expect(rooms.currentMatchPublication('host-socket')?.snapshot.network[welcome.playerId]?.currentMs).toBe(8);
    now = 4_100;
    vi.advanceTimersByTime(1);
    expect(rooms.currentMatchPublication('host-socket')?.snapshot.network[welcome.playerId]).toEqual({
      currentMs: null,
      medianMs: null,
      jitterMs: null,
      transport: 'websocket'
    });
    expect(probes.map(({ payload }) => payload)).toEqual([
      { nonce: 1 }, { nonce: 2 }, { nonce: 3 }, { nonce: 4 }
    ]);
    now = 4_106;
    probes[3]!.acknowledge({ nonce: 4 });
    expect(rooms.currentMatchPublication('host-socket')?.snapshot.network[welcome.playerId]).toMatchObject({
      currentMs: 6,
      medianMs: 6,
      transport: 'websocket'
    });
  });

  it('invalidates an in-flight polling probe and samples immediately after a Socket.IO transport upgrade', () => {
    vi.useFakeTimers();
    let randomByte = 0;
    let now = 50;
    const rooms = new RoomManager({
      now: () => now,
      randomBytes: (size) => new Uint8Array(size).fill(randomByte++),
      publish: () => undefined
    });
    let onConnection: ((socket: GameSocket) => void) | undefined;
    const io = {
      on: (_event: string, listener: (socket: GameSocket) => void): void => {
        onConnection = listener;
      }
    } as unknown as GameIo;
    const socketListeners = new Map<string, (...args: unknown[]) => void>();
    let onUpgrade: (() => void) | undefined;
    const socketTransport = { name: 'polling' };
    const probes: Array<{
      payload: { nonce: number };
      acknowledge: (payload: { nonce: number }) => void;
    }> = [];
    const socket = {
      id: 'host-socket',
      conn: {
        transport: socketTransport,
        on: (event: string, listener: () => void): void => {
          if (event === 'upgrade') onUpgrade = listener;
        }
      },
      emit: (event: string, ...args: unknown[]): boolean => {
        if (event === 'network:probe') {
          const acknowledgeWithTimeout = args[1] as (error: Error | null, payload: { nonce: number }) => void;
          probes.push({
            payload: args[0] as { nonce: number },
            acknowledge: (payload) => acknowledgeWithTimeout(null, payload)
          });
        }
        return true;
      },
      timeout: () => socket,
      join: async () => undefined,
      leave: async () => undefined,
      on: (event: string, listener: (...args: unknown[]) => void): void => {
        socketListeners.set(event, listener);
      }
    } as unknown as GameSocket;

    registerSocketHandlers({
      io,
      rooms,
      now: () => now,
      logger: { error: vi.fn() },
      transportHub: inertTransportHub(),
      onSession: () => undefined,
      onLeave: () => undefined,
      onDisconnect: () => undefined
    });
    if (!onConnection) throw new Error('Socket connection handler was not registered.');
    onConnection(socket);
    const createRoom = socketListeners.get('room:create') as (
      payload: { name: string },
      acknowledge: (acknowledgement: Ack<SessionWelcome>) => void
    ) => void;
    let welcome: SessionWelcome | undefined;
    createRoom({ name: 'Ada' }, (acknowledgement) => {
      if (!acknowledgement.ok) throw new Error(acknowledgement.error.code);
      welcome = acknowledgement.data;
    });
    expect(probes.map(({ payload }) => payload)).toEqual([{ nonce: 1 }]);

    socketTransport.name = 'websocket';
    onUpgrade?.();

    expect(probes.map(({ payload }) => payload)).toEqual([{ nonce: 1 }, { nonce: 2 }]);
    if (!welcome) throw new Error('Host session was not established.');
    const guest = rooms.joinRoom('guest-socket', welcome.roomCode, 'Linus');
    rooms.setReady('host-socket', true);
    rooms.setReady('guest-socket', true);
    rooms.startMatch('host-socket');
    now = 57;
    probes[0]!.acknowledge({ nonce: 1 });
    probes[1]!.acknowledge({ nonce: 2 });
    rooms.advance(20);

    expect(rooms.currentMatchPublication('host-socket')?.snapshot.network).toMatchObject({
      [welcome.playerId]: { currentMs: 7, medianMs: 7, transport: 'websocket' },
      [guest.playerId]: { currentMs: null }
    });
  });

  it('stops Socket probes in WebRTC mode and restarts one immediately for idempotent fallback mode', () => {
    vi.useFakeTimers();
    let randomByte = 0;
    let now = 0;
    const rooms = new RoomManager({
      now: () => now,
      randomBytes: (size) => new Uint8Array(size).fill(randomByte++),
      publish: () => undefined
    });
    const controlledTransport = controllableTransportHub();
    let onConnection: ((socket: GameSocket) => void) | undefined;
    const io = {
      on: (_event: string, listener: (socket: GameSocket) => void): void => {
        onConnection = listener;
      }
    } as unknown as GameIo;
    const socketListeners = new Map<string, (...args: unknown[]) => void>();
    const probes: Array<{
      payload: { nonce: number };
      acknowledge: (payload: { nonce: number }) => void;
    }> = [];
    const socket = {
      id: 'host-socket',
      conn: { transport: { name: 'websocket' }, on: () => undefined },
      emit: (event: string, ...args: unknown[]): boolean => {
        if (event === 'network:probe') {
          const acknowledgeWithTimeout = args[1] as (error: Error | null, payload: { nonce: number }) => void;
          probes.push({
            payload: args[0] as { nonce: number },
            acknowledge: (payload) => acknowledgeWithTimeout(null, payload)
          });
        }
        return true;
      },
      timeout: () => socket,
      join: async () => undefined,
      leave: async () => undefined,
      on: (event: string, listener: (...args: unknown[]) => void): void => {
        socketListeners.set(event, listener);
      }
    } as unknown as GameSocket;

    registerSocketHandlers({
      io,
      rooms,
      now: () => now,
      logger: { error: vi.fn() },
      transportHub: controlledTransport.hub,
      onSession: () => undefined,
      onLeave: () => undefined,
      onDisconnect: () => undefined
    });
    if (!onConnection) throw new Error('Socket connection handler was not registered.');
    onConnection(socket);
    const createRoom = socketListeners.get('room:create') as (
      payload: { name: string },
      acknowledge: (acknowledgement: Ack<SessionWelcome>) => void
    ) => void;
    let welcome: SessionWelcome | undefined;
    createRoom({ name: 'Ada' }, (acknowledgement) => {
      if (!acknowledgement.ok) throw new Error(acknowledgement.error.code);
      welcome = acknowledgement.data;
    });
    if (!welcome) throw new Error('Host session was not established.');
    rooms.joinRoom('guest-socket', welcome.roomCode, 'Linus');
    rooms.setReady('host-socket', true);
    rooms.setReady('guest-socket', true);
    rooms.startMatch('host-socket');

    controlledTransport.setMode('webrtc');
    now = 25;
    probes[0]!.acknowledge({ nonce: 1 });
    vi.advanceTimersByTime(3_000);
    expect(probes.map(({ payload }) => payload)).toEqual([{ nonce: 1 }]);
    expect(rooms.currentMatchPublication('host-socket')?.snapshot.network[welcome.playerId]).toEqual({
      currentMs: null,
      medianMs: null,
      jitterMs: null,
      transport: 'webrtc'
    });

    controlledTransport.setMode('websocket');
    controlledTransport.setMode('websocket');
    expect(probes.map(({ payload }) => payload)).toEqual([{ nonce: 1 }, { nonce: 2 }]);
    now = 34;
    probes[1]!.acknowledge({ nonce: 2 });
    rooms.advance(20);
    expect(rooms.currentMatchPublication('host-socket')?.snapshot.network[welcome.playerId]).toMatchObject({
      currentMs: 9,
      medianMs: 9,
      transport: 'websocket'
    });
  });
});

describe('socket session ingress', () => {
  it('passes each established session its authoritative input ingress', () => {
    const rooms = new RoomManager({
      now: () => 0,
      randomBytes: (size) => new Uint8Array(size).fill(size),
      publish: () => undefined
    });
    let onConnection: ((socket: GameSocket) => void) | undefined;
    const io = {
      on: (_event: string, listener: (socket: GameSocket) => void): void => {
        onConnection = listener;
      }
    } as unknown as GameIo;
    const socketListeners = new Map<string, (...args: unknown[]) => void>();
    const socket = {
      id: 'host-socket',
      conn: { transport: { name: 'websocket' }, on: () => undefined },
      emit: () => true,
      join: async () => undefined,
      leave: async () => undefined,
      on: (event: string, listener: (...args: unknown[]) => void): void => {
        socketListeners.set(event, listener);
      }
    } as unknown as GameSocket;
    let sessionIngress: MatchInputIngress | undefined;

    registerSocketHandlers({
      io,
      rooms,
      now: () => 0,
      logger: { error: vi.fn() },
      transportHub: inertTransportHub(),
      onSession: (_socket, _welcome, inputIngress) => { sessionIngress = inputIngress; },
      onLeave: () => undefined,
      onDisconnect: () => undefined
    });
    if (!onConnection) throw new Error('Socket connection handler was not registered.');
    onConnection(socket);
    const createRoom = socketListeners.get('room:create') as (
      payload: { name: string },
      acknowledge: (acknowledgement: Ack<SessionWelcome>) => void
    ) => void;
    createRoom({ name: 'Ada' }, () => undefined);

    expect(sessionIngress).toMatchObject({ accept: expect.any(Function), reset: expect.any(Function) });
  });
});
