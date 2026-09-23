import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Ack, SessionWelcome } from '../../shared/model.js';
import type { GameplayTransportMode } from '../../shared/gameplayTransport.js';
import { RoomManager } from '../rooms/roomManager.js';
import type { GameplayTransportHub, TransportSession } from './gameplayTransport/GameplayTransportHub.js';
import { registerSocketHandlers, type GameIo, type GameSocket } from './socketHandlers.js';

type ProbeDelivery = Readonly<{
  nonce: number;
  acknowledge: (payload: { nonce: number }) => void;
}>;

function harness() {
  let now = 0;
  let randomByte = 0;
  let transportMode: GameplayTransportMode = 'websocket';
  let transportSession: TransportSession | null = null;
  const rooms = new RoomManager({
    now: () => now,
    randomBytes: (size) => new Uint8Array(size).fill(randomByte++),
    publish: () => undefined
  });
  const transportHub = {
    attachSession: (session: TransportSession): void => { transportSession = session; },
    modeForPlayer: (): GameplayTransportMode => transportMode,
    synchronizeSession: (): void => undefined
  } as unknown as GameplayTransportHub;
  let onConnection: ((socket: GameSocket) => void) | null = null;
  const io = {
    on: (_event: string, listener: (socket: GameSocket) => void): void => { onConnection = listener; }
  } as unknown as GameIo;
  const listeners = new Map<string, (...args: unknown[]) => void>();
  const probes: ProbeDelivery[] = [];
  const probeTimeouts: number[] = [];
  const socket = {
    id: 'host-socket',
    conn: { transport: { name: 'websocket' }, on: () => undefined },
    emit: (event: string, ...args: unknown[]): boolean => {
      if (event === 'network:probe') {
        const acknowledgeWithTimeout = args[1] as (error: Error | null, payload: { nonce: number }) => void;
        probes.push({
          nonce: (args[0] as { nonce: number }).nonce,
          acknowledge: (payload) => acknowledgeWithTimeout(null, payload)
        });
      }
      return true;
    },
    timeout: (milliseconds: number) => {
      probeTimeouts.push(milliseconds);
      return socket;
    },
    join: async () => undefined,
    leave: async () => undefined,
    on: (event: string, listener: (...args: unknown[]) => void): void => { listeners.set(event, listener); }
  } as unknown as GameSocket;
  registerSocketHandlers({
    io,
    rooms,
    now: () => now,
    logger: { error: vi.fn() },
    transportHub,
    onSession: () => undefined,
    onLeave: () => undefined,
    onDisconnect: () => undefined
  });
  const connectionHandler = onConnection as ((socket: GameSocket) => void) | null;
  if (connectionHandler === null) throw new Error('Socket connection handler was not registered.');
  connectionHandler(socket);
  const createRoom = listeners.get('room:create') as (
    payload: { name: string },
    acknowledge: (acknowledgement: Ack<SessionWelcome>) => void
  ) => void;
  let host: SessionWelcome | null = null;
  createRoom({ name: 'Ada' }, (acknowledgement) => {
    if (!acknowledgement.ok) throw new Error(acknowledgement.error.code);
    host = acknowledgement.data;
  });
  const establishedHost = host as SessionWelcome | null;
  if (establishedHost === null) throw new Error('Host session was not established.');

  return {
    rooms,
    listeners,
    probes,
    probeTimeouts,
    host: establishedHost,
    setNow(value: number): void { now = value; },
    setTransportMode(mode: GameplayTransportMode): void {
      transportMode = mode;
      if (transportSession === null) throw new Error('Transport session was not attached.');
      transportSession.setNetworkMode(mode);
    },
    publishStarted(): void {
      if (transportSession === null) throw new Error('Transport session was not attached.');
      const publication = rooms.currentMatchPublication('host-socket');
      if (publication === null) throw new Error('Match publication was not available.');
      transportSession.emitStarted(publication);
    }
  };
}

function prepareMatch(subject: ReturnType<typeof harness>): SessionWelcome {
  const guest = subject.rooms.joinRoom('guest-socket', subject.host.roomCode, 'Linus');
  subject.rooms.setReady('host-socket', true);
  subject.rooms.setReady('guest-socket', true);
  return guest;
}

function startMatch(subject: ReturnType<typeof harness>): Ack<null> | null {
  let acknowledgement: Ack<null> | null = null;
  const handler = subject.listeners.get('match:start') as (
    payload: Record<string, never>,
    acknowledge: (value: Ack<null>) => void
  ) => void;
  handler({}, (value) => { acknowledgement = value; });
  return acknowledgement;
}

describe('Socket fallback RTT at match start', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('restarts immediately when a fallback session receives the match-start publication', () => {
    vi.useFakeTimers();
    const subject = harness();
    expect(subject.probes.map(({ nonce }) => nonce)).toEqual([1]);
    expect(subject.probeTimeouts).toEqual([2_000]);
    subject.setNow(5);
    subject.probes[0]!.acknowledge({ nonce: 1 });
    const guest = prepareMatch(subject);

    subject.setNow(10);
    expect(startMatch(subject)).toEqual({ ok: true, data: null });
    expect(subject.probes.map(({ nonce }) => nonce)).toEqual([1]);
    subject.publishStarted();
    expect(subject.probes.map(({ nonce }) => nonce)).toEqual([1, 2]);
    subject.setNow(17);
    subject.probes[1]!.acknowledge({ nonce: 2 });

    expect(subject.rooms.currentMatchPublication('host-socket')?.snapshot.network).toMatchObject({
      [subject.host.playerId]: { currentMs: 7, medianMs: 7, transport: 'websocket' },
      [guest.playerId]: { currentMs: null }
    });
  });

  it('does not restart the Socket sampler when WebRTC is active at match start', () => {
    vi.useFakeTimers();
    const subject = harness();
    subject.setNow(5);
    subject.probes[0]!.acknowledge({ nonce: 1 });
    subject.setTransportMode('webrtc');
    prepareMatch(subject);

    subject.setNow(10);
    expect(startMatch(subject)).toEqual({ ok: true, data: null });
    subject.publishStarted();
    expect(subject.probes.map(({ nonce }) => nonce)).toEqual([1]);
    expect(subject.rooms.currentMatchPublication('host-socket')?.snapshot.network[subject.host.playerId]).toEqual({
      currentMs: null,
      medianMs: null,
      jitterMs: null,
      transport: 'webrtc'
    });
  });
});
