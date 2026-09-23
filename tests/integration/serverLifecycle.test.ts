import { describe, expect, it } from 'vitest';
import { io, type Socket } from 'socket.io-client';
import type { RtcNegotiationAnswer } from '../../src/shared/gameplayTransport.js';
import type { Ack, RoomState, SessionWelcome } from '../../src/shared/model.js';
import type { ClientToServerEvents, ServerToClientEvents } from '../../src/shared/protocol.js';
import { createGameServer } from '../../src/server/network/createGameServer.js';
import type {
  PeerSendResult,
  ServerPeer,
  ServerPeerFactory
} from '../../src/server/network/gameplayTransport/ServerPeer.js';

type GameClient = Socket<ServerToClientEvents, ClientToServerEvents>;
type SessionEvent = 'room:create' | 'room:join' | 'room:leave' | 'session:resume' | 'transport:negotiate';
const LIFECYCLE_GENERATION = '2f8ca1f2-7e6e-4ea7-90e2-e6a955892574';
const REPLACEMENT_GENERATION = '4cf2e59c-3dd7-4a54-8e5d-95eb40efca5c';
const LIFECYCLE_UDP_RANGE = [54200, 54231] as const;

class LifecyclePeer implements ServerPeer {
  private readonly fastListeners = new Set<(serialized: string) => void>();
  private readonly reliableListeners = new Set<(serialized: string) => void>();
  private readonly closedListeners = new Set<() => void>();
  private releaseClosure: () => void = () => undefined;
  private readonly closureGate = new Promise<void>((resolve) => { this.releaseClosure = resolve; });
  private closeFailure: Error | null = null;
  closeCalls = 0;

  constructor(readonly generationId: string, private readonly releaseRange: () => void) {}

  async negotiate() {
    return { type: 'answer' as const, sdp: 'lifecycle-answer' };
  }

  isReady(): boolean {
    return false;
  }

  sendFast(): PeerSendResult {
    return 'closed';
  }

  sendReliable(): PeerSendResult {
    return 'closed';
  }

  onFastMessage(listener: (serialized: string) => void): () => void {
    this.fastListeners.add(listener);
    return () => this.fastListeners.delete(listener);
  }

  onReliableMessage(listener: (serialized: string) => void): () => void {
    this.reliableListeners.add(listener);
    return () => this.reliableListeners.delete(listener);
  }

  onClosed(listener: () => void): () => void {
    this.closedListeners.add(listener);
    return () => this.closedListeners.delete(listener);
  }

  async close(): Promise<void> {
    this.closeCalls += 1;
    await this.closureGate;
    if (this.closeFailure) throw this.closeFailure;
    this.releaseRange();
  }

  release(error?: Error): void {
    this.closeFailure = error ?? null;
    this.releaseClosure();
  }
}

class LifecyclePeerFactory {
  readonly peers: LifecyclePeer[] = [];
  readonly ranges: Array<readonly [number, number]> = [];
  private occupied = false;

  readonly create: ServerPeerFactory = (options) => {
    if (this.occupied) throw new Error('UDP range is still occupied.');
    this.occupied = true;
    this.ranges.push(options.udpPortRange);
    const peer = new LifecyclePeer(options.generationId, () => { this.occupied = false; });
    this.peers.push(peer);
    return peer;
  };
}

async function healthStatus(origin: string): Promise<number> {
  return fetch(`${origin}/health`, { signal: AbortSignal.timeout(1_000) })
    .then((response) => response.status)
    .catch(() => 0);
}

async function connectClient(origin: string): Promise<GameClient> {
  const socket: GameClient = io(origin, { transports: ['websocket'], forceNew: true, reconnection: false });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out connecting lifecycle client')), 1_500);
    socket.once('connect', () => {
      clearTimeout(timer);
      resolve();
    });
    socket.once('connect_error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
  return socket;
}

function emitAck<T>(socket: GameClient, event: SessionEvent, payload: unknown): Promise<Ack<T>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${event}`)), 1_500);
    const emit = socket.emit.bind(socket) as (
      eventName: string,
      eventPayload: unknown,
      acknowledge: (ack: Ack<T>) => void
    ) => void;
    emit(event, payload, (acknowledgement) => {
      clearTimeout(timer);
      resolve(acknowledgement);
    });
  });
}

function expectWelcome(acknowledgement: Ack<SessionWelcome>): SessionWelcome {
  if (!acknowledgement.ok) throw new Error(acknowledgement.error.code);
  return acknowledgement.data;
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  const deadline = performance.now() + 1_500;
  while (!predicate()) {
    if (performance.now() >= deadline) throw new Error(`Timed out waiting for ${label}.`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function expectRoomState(
  socket: GameClient,
  predicate: (state: RoomState) => boolean
): Promise<RoomState> {
  return new Promise((resolve, reject) => {
    const listener = (state: RoomState): void => {
      if (!predicate(state)) return;
      clearTimeout(timer);
      socket.off('room:state', listener);
      resolve(state);
    };
    const timer = setTimeout(() => {
      socket.off('room:state', listener);
      reject(new Error('Timed out waiting for lifecycle room state'));
    }, 1_500);
    socket.on('room:state', listener);
  });
}

describe('GameServer lifecycle', () => {
  it('awaits peer release before acknowledging leave and reuses the same socket and UDP range', async () => {
    const factory = new LifecyclePeerFactory();
    const serverErrors: unknown[][] = [];
    const server = createGameServer({
      host: '127.0.0.1',
      port: 0,
      clientDirectory: false,
      enableTestHarness: true,
      logger: { error: (...args: unknown[]) => serverErrors.push(args) },
      testGameplayTransport: { peerFactory: factory.create, udpPortRange: LIFECYCLE_UDP_RANGE }
    });
    let client: GameClient | null = null;

    try {
      const address = await server.start();
      client = await connectClient(address.origin);
      const firstRoom = expectWelcome(await emitAck<SessionWelcome>(client, 'room:create', { name: 'Ada' }));
      expect(await emitAck<RtcNegotiationAnswer>(client, 'transport:negotiate', {
        generationId: LIFECYCLE_GENERATION,
        offer: { type: 'offer', sdp: 'first-room-offer' }
      })).toMatchObject({ ok: true });
      const firstPeer = factory.peers[0]!;

      let leaveSettled = false;
      const leaveAcknowledgement = emitAck<null>(client, 'room:leave', {});
      void leaveAcknowledgement.then(() => { leaveSettled = true; });
      await waitFor(() => firstPeer.closeCalls === 1, 'leave peer close request');
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(server.rooms.debugRoom(firstRoom.roomCode)).toBeNull();
      expect(leaveSettled).toBe(false);
      expect(await emitAck<null>(client, 'room:leave', {}))
        .toMatchObject({ ok: false, error: { code: 'PLAYER_NOT_FOUND' } });

      firstPeer.release();
      expect(await leaveAcknowledgement).toEqual({ ok: true, data: null });
      const replacement = expectWelcome(await emitAck<SessionWelcome>(client, 'room:create', { name: 'Ada again' }));
      expect(replacement.roomCode).not.toBe(firstRoom.roomCode);
      expect(await emitAck<RtcNegotiationAnswer>(client, 'transport:negotiate', {
        generationId: REPLACEMENT_GENERATION,
        offer: { type: 'offer', sdp: 'replacement-room-offer' }
      })).toMatchObject({ ok: true });
      expect(factory.ranges).toEqual([LIFECYCLE_UDP_RANGE, LIFECYCLE_UDP_RANGE]);
      expect(factory.peers).toHaveLength(2);
      expect(serverErrors).toEqual([]);
      factory.peers[1]!.release();
    } finally {
      for (const peer of factory.peers) peer.release();
      client?.disconnect();
      await server.stop();
    }
  });

  it('publishes host migration while leave waits for peer closure', async () => {
    const factory = new LifecyclePeerFactory();
    const server = createGameServer({
      host: '127.0.0.1',
      port: 0,
      clientDirectory: false,
      enableTestHarness: true,
      testGameplayTransport: { peerFactory: factory.create, udpPortRange: LIFECYCLE_UDP_RANGE }
    });
    let hostClient: GameClient | null = null;
    let survivorClient: GameClient | null = null;

    try {
      const address = await server.start();
      hostClient = await connectClient(address.origin);
      const room = expectWelcome(await emitAck<SessionWelcome>(hostClient, 'room:create', { name: 'Ada' }));
      survivorClient = await connectClient(address.origin);
      const survivor = expectWelcome(await emitAck<SessionWelcome>(survivorClient, 'room:join', {
        name: 'Linus',
        roomCode: room.roomCode
      }));
      expect(await emitAck<RtcNegotiationAnswer>(hostClient, 'transport:negotiate', {
        generationId: LIFECYCLE_GENERATION,
        offer: { type: 'offer', sdp: 'migration-offer' }
      })).toMatchObject({ ok: true });
      const peer = factory.peers[0]!;
      const migratedRoom = expectRoomState(survivorClient, (state) =>
        state.roomCode === room.roomCode
        && state.hostPlayerId === survivor.playerId
        && state.players.length === 1);

      let leaveSettled = false;
      const leaveAcknowledgement = emitAck<null>(hostClient, 'room:leave', {});
      void leaveAcknowledgement.then(() => { leaveSettled = true; });
      await waitFor(() => peer.closeCalls === 1, 'migrating host peer close request');
      await expect(migratedRoom).resolves.toMatchObject({
        hostPlayerId: survivor.playerId,
        players: [{ playerId: survivor.playerId, connected: true }]
      });
      expect(server.rooms.debugRoom(room.roomCode)?.playerIds).toEqual([survivor.playerId]);
      expect(leaveSettled).toBe(false);

      peer.release();
      expect(await leaveAcknowledgement).toEqual({ ok: true, data: null });
    } finally {
      for (const peer of factory.peers) peer.release();
      hostClient?.disconnect();
      survivorClient?.disconnect();
      await server.stop();
    }
  });

  it('acknowledges the committed leave after logging a peer close cleanup failure', async () => {
    const factory = new LifecyclePeerFactory();
    const serverErrors: unknown[][] = [];
    const server = createGameServer({
      host: '127.0.0.1',
      port: 0,
      clientDirectory: false,
      enableTestHarness: true,
      logger: { error: (...args: unknown[]) => serverErrors.push(args) },
      testGameplayTransport: { peerFactory: factory.create, udpPortRange: LIFECYCLE_UDP_RANGE }
    });
    let client: GameClient | null = null;

    try {
      const address = await server.start();
      client = await connectClient(address.origin);
      const firstRoom = expectWelcome(await emitAck<SessionWelcome>(client, 'room:create', { name: 'Ada' }));
      expect(await emitAck<RtcNegotiationAnswer>(client, 'transport:negotiate', {
        generationId: LIFECYCLE_GENERATION,
        offer: { type: 'offer', sdp: 'close-failure-offer' }
      })).toMatchObject({ ok: true });
      const peer = factory.peers[0]!;

      const leaveAcknowledgement = emitAck<null>(client, 'room:leave', {});
      await waitFor(() => peer.closeCalls === 1, 'failing leave peer close request');
      peer.release(new Error('forced peer close failure'));

      expect(await leaveAcknowledgement).toEqual({ ok: true, data: null });
      expect(server.rooms.debugRoom(firstRoom.roomCode)).toBeNull();
      expect(serverErrors).toHaveLength(1);
      expect(serverErrors[0]?.[0]).toMatch(/Socket.IO room leave cleanup failure/);
      expect(serverErrors[0]?.[1]).toEqual(new Error('forced peer close failure'));
      expect(await emitAck<null>(client, 'room:leave', {}))
        .toMatchObject({ ok: false, error: { code: 'PLAYER_NOT_FOUND' } });
      const replacement = expectWelcome(await emitAck<SessionWelcome>(client, 'room:create', { name: 'Ada again' }));
      expect(replacement.roomCode).not.toBe(firstRoom.roomCode);
      expect(server.rooms.debugRoom(replacement.roomCode)?.playerIds).toEqual([replacement.playerId]);
    } finally {
      for (const peer of factory.peers) peer.release();
      client?.disconnect();
      await server.stop();
    }
  });

  it('accepts a polling-only Socket.IO client when WebSocket is unavailable', async () => {
    const server = createGameServer({ host: '127.0.0.1', port: 0, clientDirectory: false });
    let pollingClient: GameClient | null = null;
    try {
      const address = await server.start();
      pollingClient = io(address.origin, { transports: ['polling'], forceNew: true, reconnection: false });
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Timed out connecting polling-only client')), 1_500);
        pollingClient?.once('connect', () => {
          clearTimeout(timer);
          resolve();
        });
        pollingClient?.once('connect_error', (error) => {
          clearTimeout(timer);
          reject(error);
        });
      });

      const welcome = expectWelcome(await emitAck<SessionWelcome>(pollingClient, 'room:create', { name: 'Ada' }));
      expect(welcome.roomCode).toHaveLength(4);
    } finally {
      pollingClient?.disconnect();
      await server.stop();
    }
  });

  it('discovers the current LAN address on every runtime network request', async () => {
    let currentAddress = '192.168.68.51';
    const server = createGameServer({
      host: '127.0.0.1',
      port: 0,
      clientDirectory: false,
      networkInterfaces: () => ({
        en0: [{ address: currentAddress, family: 'IPv4', internal: false }],
        utun4: [{ address: '10.8.0.2', family: 'IPv4', internal: false }]
      })
    });

    try {
      const address = await server.start();
      const first = await fetch(`${address.origin}/api/runtime/network`).then((response) => response.json());

      expect(first).toEqual({
        port: address.port,
        localUrl: `http://localhost:${address.port}`,
        lanAddresses: [{
          interfaceName: 'en0',
          address: '192.168.68.51',
          url: `http://192.168.68.51:${address.port}`
        }]
      });

      currentAddress = '192.168.68.52';
      const second = await fetch(`${address.origin}/api/runtime/network`).then((response) => response.json());
      expect(second).toEqual({
        port: address.port,
        localUrl: `http://localhost:${address.port}`,
        lanAddresses: [{
          interfaceName: 'en0',
          address: '192.168.68.52',
          url: `http://192.168.68.52:${address.port}`
        }]
      });
    } finally {
      await server.stop();
    }
  });

  it('coalesces concurrent starts onto one listener and one address', async () => {
    const server = createGameServer({ host: '127.0.0.1', port: 0, clientDirectory: false });
    try {
      const firstStart = server.start();
      const secondStart = server.start();
      expect(secondStart).toBe(firstStart);

      const [first, second] = await Promise.all([firstStart, secondStart]);

      expect(second).toEqual(first);
      expect(await healthStatus(first.origin)).toBe(200);
    } finally {
      await server.stop();
    }
  });

  it('lets stop join an in-flight start, closes the listener, and permits a later start', async () => {
    const server = createGameServer({ host: '127.0.0.1', port: 0, clientDirectory: false });
    try {
      const starting = server.start();
      const stopping = server.stop();
      const firstAddress = await starting;
      await stopping;

      expect(await healthStatus(firstAddress.origin)).toBe(0);

      const restarted = await server.start();
      expect(await healthStatus(restarted.origin)).toBe(200);
    } finally {
      await server.stop();
    }
  });

  it('coalesces starts requested during stop onto one post-stop restart', async () => {
    const server = createGameServer({ host: '127.0.0.1', port: 0, clientDirectory: false });
    try {
      const initialStart = server.start();
      const stopping = server.stop();
      const firstRestart = server.start();
      const secondRestart = server.start();

      expect(firstRestart).toBe(secondRestart);
      expect(firstRestart).not.toBe(initialStart);

      await stopping;
      const restarted = await firstRestart;
      expect(await healthStatus(restarted.origin)).toBe(200);
    } finally {
      await server.stop();
    }
  });

  it('restarts with fresh room state and a working Socket.IO boundary', async () => {
    const server = createGameServer({ host: '127.0.0.1', port: 0, clientDirectory: false });
    let firstClient: GameClient | null = null;
    let restartedClient: GameClient | null = null;
    try {
      const firstAddress = await server.start();
      firstClient = await connectClient(firstAddress.origin);
      const oldRoom = expectWelcome(await emitAck<SessionWelcome>(firstClient, 'room:create', { name: 'Ada' }));

      await server.stop();
      const restarted = await server.start();
      expect(await fetch(`${restarted.origin}/health`).then((response) => response.json())).toMatchObject({ rooms: 0 });

      restartedClient = await connectClient(restarted.origin);
      expect(await emitAck<SessionWelcome>(restartedClient, 'room:join', {
        name: 'Linus',
        roomCode: oldRoom.roomCode
      })).toMatchObject({ ok: false, error: { code: 'ROOM_NOT_FOUND' } });
      expect(await emitAck<SessionWelcome>(restartedClient, 'session:resume', {
        roomCode: oldRoom.roomCode,
        resumeToken: oldRoom.resumeToken
      })).toMatchObject({ ok: false, error: { code: 'ROOM_NOT_FOUND' } });

      const newRoom = expectWelcome(await emitAck<SessionWelcome>(restartedClient, 'room:create', { name: 'Grace' }));
      expect(newRoom.roomCode).toHaveLength(4);
      expect(await fetch(`${restarted.origin}/health`).then((response) => response.json())).toMatchObject({ rooms: 1 });
    } finally {
      firstClient?.disconnect();
      restartedClient?.disconnect();
      await server.stop();
    }
  });

  it('awaits peer closure on stop and reuses the same deterministic UDP range after restart', async () => {
    const factory = new LifecyclePeerFactory();
    const server = createGameServer({
      host: '127.0.0.1',
      port: 0,
      clientDirectory: false,
      enableTestHarness: true,
      testGameplayTransport: { peerFactory: factory.create, udpPortRange: LIFECYCLE_UDP_RANGE }
    });
    let firstClient: GameClient | null = null;
    let secondClient: GameClient | null = null;

    try {
      const firstAddress = await server.start();
      firstClient = await connectClient(firstAddress.origin);
      expectWelcome(await emitAck<SessionWelcome>(firstClient, 'room:create', { name: 'Ada' }));
      expect(await emitAck<RtcNegotiationAnswer>(firstClient, 'transport:negotiate', {
        generationId: LIFECYCLE_GENERATION,
        offer: { type: 'offer', sdp: 'first-lifecycle-offer' }
      })).toMatchObject({ ok: true });
      const firstPeer = factory.peers[0]!;

      let stopped = false;
      const stopping = server.stop().then(() => { stopped = true; });
      await waitFor(() => firstPeer.closeCalls === 1, 'the first peer close request');
      expect(stopped).toBe(false);
      firstPeer.release();
      await stopping;
      expect(stopped).toBe(true);

      const restarted = await server.start();
      secondClient = await connectClient(restarted.origin);
      expectWelcome(await emitAck<SessionWelcome>(secondClient, 'room:create', { name: 'Linus' }));
      expect(await emitAck<RtcNegotiationAnswer>(secondClient, 'transport:negotiate', {
        generationId: LIFECYCLE_GENERATION,
        offer: { type: 'offer', sdp: 'second-lifecycle-offer' }
      })).toMatchObject({ ok: true });

      expect(factory.ranges).toEqual([LIFECYCLE_UDP_RANGE, LIFECYCLE_UDP_RANGE]);
      expect(factory.peers).toHaveLength(2);
      factory.peers[1]!.release();
    } finally {
      for (const peer of factory.peers) peer.release();
      firstClient?.disconnect();
      secondClient?.disconnect();
      await server.stop();
    }
  });
});

it('disconnects sockets and releases admission when an idle room expires', async () => {
  const server = createGameServer({
    host: '127.0.0.1', port: 0, clientDirectory: false,
    resourceLimits: { maxConnections: 1, roomIdleTimeoutMs: 300 }
  });
  let client: GameClient | null = null;
  let replacement: GameClient | null = null;
  try {
    const address = await server.start();
    client = await connectClient(address.origin);
    expectWelcome(await emitAck<SessionWelcome>(client, 'room:create', { name: 'Ada' }));
    await expect.poll(() => client?.connected, { timeout: 1_000 }).toBe(false);
    replacement = await connectClient(address.origin);
    expect(replacement.connected).toBe(true);
    expect(await (await fetch(`${address.origin}/health`)).json()).toMatchObject({ rooms: 0 });
  } finally {
    client?.disconnect();
    replacement?.disconnect();
    await server.stop();
  }
});
