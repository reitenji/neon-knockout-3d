import { randomBytes } from 'node:crypto';
import { createServer, type Server as HttpServer } from 'node:http';
import { networkInterfaces as getNetworkInterfaces } from 'node:os';
import { resolve } from 'node:path';
import express from 'express';
import { Server } from 'socket.io';
import { GAME } from '../../shared/constants.js';
import type { GameplayTransportMode } from '../../shared/gameplayTransport.js';
import type { GameEvent, InputFrame, MatchSnapshot, SessionWelcome, Vec2 } from '../../shared/model.js';
import type { ClientToServerEvents, ServerToClientEvents } from '../../shared/protocol.js';
import {
  RoomManager,
  type RoomManagerTestHarness,
  type RoomManagerResourceLimits,
  type RoomPublication,
  type TestCombatScript
} from '../rooms/roomManager.js';
import { discoverRuntimeNetworkInfo, type NetworkInterfaces } from '../runtime/lanAddresses.js';
import { registerSocketHandlers, type GameSocket } from './socketHandlers.js';
import {
  DEFAULT_NETWORK_RESOURCE_LIMITS,
  NetworkAdmission,
  type NetworkResourceLimits
} from './NetworkAdmission.js';
import { GameplayTransportHub } from './gameplayTransport/GameplayTransportHub.js';
import type {
  ServerPeerFactory,
  TransportImpairment,
  TransportImpairmentResolver
} from './gameplayTransport/ServerPeer.js';
import { createTestImpairedPeerFactory } from './gameplayTransport/TestImpairedServerPeer.js';
import {
  createWeriftServerPeer,
  readWebRtcUdpPortRange
} from './gameplayTransport/WeriftServerPeer.js';

export interface GameServer {
  start(): Promise<{ port: number; origin: string }>;
  stop(): Promise<void>;
  rooms: RoomManager;
  testHarness: {
    forceKnockout(roomCode: string, attackerId: string, targetId: string): void;
    disconnectPlayer(roomCode: string, playerId: string): void;
    placePlayer(roomCode: string, playerId: string, position: Vec2, facing: Vec2): void;
    runCombatScript(roomCode: string, script: TestCombatScript): void;
    recentEvents(roomCode: string): readonly GameEvent[];
    matchSnapshot(roomCode: string): MatchSnapshot | null;
    transportMode(playerId: string): GameplayTransportMode | null;
    transportGeneration(playerId: string): Readonly<{ generationId: string | null; negotiationCount: number }> | null;
    acceptedInputs(playerId: string): readonly AcceptedInputRecord[];
    dropWebRtc(playerId: string): Promise<void>;
  } | null;
}

export type AcceptedInputRecord = Readonly<{
  sequence: number;
  source: GameplayTransportMode;
}>;

export type CreateGameServerOptions = Readonly<{
  host?: string;
  port?: number;
  enableTestHarness?: boolean;
  clientDirectory?: string | false;
  logger?: Pick<Console, 'error'>;
  networkInterfaces?: () => NetworkInterfaces;
  resourceLimits?: Partial<NetworkResourceLimits & RoomManagerResourceLimits>;
  testGameplayTransport?: Readonly<{
    peerFactory: ServerPeerFactory;
    udpPortRange: readonly [number, number];
    impairment?: TransportImpairment | TransportImpairmentResolver;
  }>;
}>;

type PlayerConnection = Readonly<{ roomCode: string; socketId: string }>;

const TEST_EVENT_HISTORY_LIMIT = 256;
const TEST_INPUT_HISTORY_LIMIT = 256;

function updateSnapshot(snapshot: MatchSnapshot, publication: Extract<RoomPublication, { type: 'MATCH_EVENT' }>): MatchSnapshot {
  const event = publication.event;
  if (event.type === 'KNOCKOUT') return { ...snapshot, scores: { ...event.scores } };
  if (event.type === 'PHASE') return { ...snapshot, phase: event.phase };
  if (event.type === 'RESULT') {
    return {
      ...snapshot,
      phase: 'FINISHED',
      scores: { ...event.scores },
      winnerPlayerId: event.winnerPlayerId,
      resultReason: event.reason
    };
  }
  return snapshot;
}

export function createGameServer(options: CreateGameServerOptions = {}): GameServer {
  const host = options.host ?? '0.0.0.0';
  const requestedPort = options.port ?? 4174;
  const logger = options.logger ?? console;
  const networkInterfaces = options.networkInterfaces ?? getNetworkInterfaces;
  const now = (): number => performance.now();
  const app = express();
  const httpServer: HttpServer = createServer(app);
  const io = new Server<ClientToServerEvents, ServerToClientEvents>(httpServer);
  const roomCodes = new Set<string>();
  const resourceLimits = { ...DEFAULT_NETWORK_RESOURCE_LIMITS, ...options.resourceLimits };
  const admission = new NetworkAdmission(resourceLimits, now, () => roomCodes.size);
  const snapshots = new Map<string, MatchSnapshot>();
  const testEventHistory = options.enableTestHarness ? new Map<string, GameEvent[]>() : null;
  const testInputHistory = options.enableTestHarness ? new Map<string, AcceptedInputRecord[]>() : null;
  const playerConnections = new Map<string, PlayerConnection>();
  const testTransport = options.enableTestHarness ? options.testGameplayTransport : undefined;
  const transportPeerFactory = testTransport?.impairment
    ? createTestImpairedPeerFactory(testTransport.peerFactory, testTransport.impairment, now)
    : testTransport?.peerFactory ?? createWeriftServerPeer;
  const transportHub = new GameplayTransportHub({
    peerFactory: transportPeerFactory,
    udpPortRange: testTransport?.udpPortRange ?? readWebRtcUdpPortRange(process.env),
    now
  });
  const pendingRoomPublications = new Map<
    NodeJS.Immediate,
    Extract<RoomPublication, { type: 'ROOM_STATE' }>
  >();
  let startedAt = now();
  let scheduler: NodeJS.Timeout | null = null;
  let schedulerActive = false;
  let lastAdvanceAt = startedAt;
  let nextAdvanceAt = startedAt;
  let activeAddress: { port: number; origin: string } | null = null;
  let starting: Promise<{ port: number; origin: string }> | null = null;
  let restartAfterStop: Promise<{ port: number; origin: string }> | null = null;
  let stopping: Promise<void> | null = null;

  io.use((socket, next) => {
    const source = socket.handshake.address;
    if (!admission.admitConnection(source)) {
      next(new Error('SERVER_CAPACITY_REACHED'));
      return;
    }
    socket.once('disconnect', () => admission.releaseConnection(source));
    next();
  });

  const dispatch = (publication: RoomPublication): void => {
    if (publication.type === 'ROOM_STATE') io.to(publication.roomCode).emit('room:state', publication.state);
    if (publication.type === 'ROOM_CLOSED' && publication.reason === 'IDLE') {
      io.to(publication.roomCode).emit('server:error', {
        code: 'ROOM_NOT_FOUND', message: 'Oda kapandı.', recoverable: true
      });
      // Disconnect handlers release admission, timers and Socket.IO membership.
      io.in(publication.roomCode).disconnectSockets(true);
    }
    if (
      publication.type === 'MATCH_STARTED'
      || publication.type === 'MATCH_SNAPSHOT'
      || publication.type === 'MATCH_EVENT'
    ) transportHub.publish(publication);
  };

  const flushPendingRoomPublications = (roomCode: string): void => {
    for (const [immediate, publication] of pendingRoomPublications) {
      if (publication.roomCode !== roomCode) continue;
      clearImmediate(immediate);
      pendingRoomPublications.delete(immediate);
      dispatch(publication);
    }
  };

  const publish = (publication: RoomPublication): void => {
    if (publication.type === 'ROOM_STATE') roomCodes.add(publication.roomCode);
    if (publication.type === 'ROOM_CLOSED') {
      roomCodes.delete(publication.roomCode);
      snapshots.delete(publication.roomCode);
      testEventHistory?.delete(publication.roomCode);
      for (const [playerId, connection] of playerConnections) {
        if (connection.roomCode !== publication.roomCode) continue;
        playerConnections.delete(playerId);
        testInputHistory?.delete(playerId);
        void transportHub.detachSession(connection.socketId);
      }
    }
    if (publication.type === 'MATCH_STARTED' || publication.type === 'MATCH_SNAPSHOT') {
      if (publication.type === 'MATCH_STARTED') testEventHistory?.delete(publication.roomCode);
      snapshots.set(publication.roomCode, publication.snapshot);
    }
    if (publication.type === 'MATCH_EVENT') {
      if (testEventHistory) {
        const history = testEventHistory.get(publication.roomCode) ?? [];
        history.push(structuredClone(publication.event));
        if (history.length > TEST_EVENT_HISTORY_LIMIT) {
          history.splice(0, history.length - TEST_EVENT_HISTORY_LIMIT);
        }
        testEventHistory.set(publication.roomCode, history);
      }
      const snapshot = snapshots.get(publication.roomCode);
      if (snapshot) snapshots.set(publication.roomCode, updateSnapshot(snapshot, publication));
    }
    if (publication.type === 'ROOM_STATE') {
      const immediate = setImmediate(() => {
        pendingRoomPublications.delete(immediate);
        dispatch(publication);
      });
      pendingRoomPublications.set(immediate, publication);
      return;
    }
    flushPendingRoomPublications(publication.roomCode);
    dispatch(publication);
  };

  let roomTestHarness: RoomManagerTestHarness | null = null;
  const rooms = new RoomManager({
    now,
    randomBytes,
    publish,
    resourceLimits,
    ...(options.enableTestHarness
      ? { bindTestHarness: (harness: RoomManagerTestHarness): void => { roomTestHarness = harness; } }
      : {})
  });

  app.get('/health', (_request, response) => {
    response.json({
      status: 'ok',
      rooms: roomCodes.size,
      uptimeSeconds: Math.max(0, (now() - startedAt) / 1_000)
    });
  });

  app.get('/api/runtime/network', (_request, response) => {
    const address = httpServer.address();
    if (!address || typeof address === 'string') {
      response.status(503).json({ error: 'SERVER_NOT_LISTENING' });
      return;
    }
    response.json(discoverRuntimeNetworkInfo(address.port, networkInterfaces()));
  });

  const clientDirectory = options.clientDirectory === undefined ? resolve(process.cwd(), 'dist/client') : options.clientDirectory;
  if (clientDirectory !== false) {
    app.use(express.static(clientDirectory));
    app.use((request, response, next) => {
      if (request.path === '/health' || request.path.startsWith('/socket.io')) {
        next();
        return;
      }
      response.sendFile('index.html', { root: clientDirectory }, (error) => {
        if (error) next(error);
      });
    });
  }

  registerSocketHandlers({
    io,
    rooms,
    now,
    logger,
    transportHub,
    admitRoomCreation: (socket) => admission.admitRoomCreation(socket.handshake.address),
    onSession: (socket: GameSocket, welcome: SessionWelcome) => {
      playerConnections.set(welcome.playerId, { roomCode: welcome.roomCode, socketId: socket.id });
    },
    onAcceptedInput: (playerId: string, input: InputFrame, source: GameplayTransportMode) => {
      if (!testInputHistory) return;
      const history = testInputHistory.get(playerId) ?? [];
      history.push({ sequence: input.seq, source });
      if (history.length > TEST_INPUT_HISTORY_LIMIT) {
        history.splice(0, history.length - TEST_INPUT_HISTORY_LIMIT);
      }
      testInputHistory.set(playerId, history);
    },
    onLeave: (socket: GameSocket, roomCode: string) => {
      for (const [playerId, connection] of playerConnections) {
        if (connection.socketId === socket.id && connection.roomCode === roomCode) playerConnections.delete(playerId);
      }
    },
    onDisconnect: (socket: GameSocket) => {
      for (const [playerId, connection] of playerConnections) {
        if (connection.socketId === socket.id) playerConnections.delete(playerId);
      }
    }
  });

  const advanceIntervalMs = 1_000 / GAME.tickRate;
  const advanceRooms = (): void => {
    scheduler = null;
    if (!schedulerActive) return;
    const current = now();
    rooms.advance(current - lastAdvanceAt);
    lastAdvanceAt = current;
    if (!schedulerActive) return;

    const afterAdvance = now();
    nextAdvanceAt += advanceIntervalMs;
    if (nextAdvanceAt <= afterAdvance) {
      const missedDeadlines = Math.floor((afterAdvance - nextAdvanceAt) / advanceIntervalMs) + 1;
      nextAdvanceAt += missedDeadlines * advanceIntervalMs;
    }
    scheduler = setTimeout(advanceRooms, Math.max(0, nextAdvanceAt - afterAdvance));
  };

  const listen = async (): Promise<{ port: number; origin: string }> => {
    transportHub.start();
    await new Promise<void>((resolveStart, rejectStart) => {
      const onError = (error: Error): void => {
        httpServer.off('listening', onListening);
        rejectStart(error);
      };
      const onListening = (): void => {
        httpServer.off('error', onError);
        resolveStart();
      };
      httpServer.once('error', onError);
      httpServer.once('listening', onListening);
      httpServer.listen(requestedPort, host);
    });
    const address = httpServer.address();
    if (!address || typeof address === 'string') throw new Error('Game server did not bind a TCP port.');
    const originHost = host === '0.0.0.0' ? '127.0.0.1' : host;
    activeAddress = { port: address.port, origin: `http://${originHost}:${address.port}` };
    startedAt = now();
    lastAdvanceAt = startedAt;
    nextAdvanceAt = startedAt + advanceIntervalMs;
    schedulerActive = true;
    scheduler = setTimeout(advanceRooms, advanceIntervalMs);
    return activeAddress;
  };

  const start = (): Promise<{ port: number; origin: string }> => {
    if (stopping) {
      if (restartAfterStop) return restartAfterStop;
      const stopToJoin = stopping;
      const sharedStart = stopToJoin.then(listen).finally(() => {
        if (starting === sharedStart) starting = null;
        if (restartAfterStop === sharedStart) restartAfterStop = null;
      });
      restartAfterStop = sharedStart;
      starting = sharedStart;
      return sharedStart;
    }
    if (starting) return starting;
    if (activeAddress) return Promise.resolve(activeAddress);
    const sharedStart = listen().finally(() => {
      if (starting === sharedStart) starting = null;
    });
    starting = sharedStart;
    return sharedStart;
  };

  const stop = (): Promise<void> => {
    if (stopping) return stopping;
    stopping = (async () => {
      try {
        const startToJoin = starting;
        if (startToJoin) {
          try {
            await startToJoin;
          } catch {
            // A failed start still needs the same resource and state cleanup.
          }
        }
        schedulerActive = false;
        if (scheduler) {
          clearTimeout(scheduler);
          scheduler = null;
        }
        if (activeAddress || httpServer.listening) {
          await new Promise<void>((resolveClose) => io.close(() => resolveClose()));
          if (httpServer.listening) {
            await new Promise<void>((resolveClose, rejectClose) => {
              httpServer.close((error) => error ? rejectClose(error) : resolveClose());
            });
          }
        }
        await transportHub.stop();
        for (const immediate of pendingRoomPublications.keys()) clearImmediate(immediate);
        pendingRoomPublications.clear();
        rooms.reset();
        roomCodes.clear();
        snapshots.clear();
        testEventHistory?.clear();
        testInputHistory?.clear();
        playerConnections.clear();
        activeAddress = null;
      } finally {
        stopping = null;
      }
    })();
    return stopping;
  };

  const testHarness = options.enableTestHarness
    ? {
        forceKnockout: (roomCode: string, attackerId: string, targetId: string): void =>
          rooms.forceKnockout(roomCode, attackerId, targetId),
        disconnectPlayer: (roomCode: string, playerId: string): void => {
          const connection = playerConnections.get(playerId);
          if (!connection || connection.roomCode !== roomCode) return;
          io.sockets.sockets.get(connection.socketId)?.disconnect(true);
        },
        placePlayer: (roomCode: string, playerId: string, position: Vec2, facing: Vec2): void => {
          if (!roomTestHarness) throw new Error('Test harness was not bound.');
          roomTestHarness.placePlayer(roomCode, playerId, position, facing);
        },
        runCombatScript: (roomCode: string, script: TestCombatScript): void => {
          if (!roomTestHarness) throw new Error('Test harness was not bound.');
          roomTestHarness.runCombatScript(roomCode, script);
        },
        recentEvents: (roomCode: string): readonly GameEvent[] =>
          structuredClone(testEventHistory?.get(roomCode) ?? []),
        matchSnapshot: (roomCode: string): MatchSnapshot | null => {
          const snapshot = snapshots.get(roomCode);
          return snapshot ? structuredClone(snapshot) : null;
        },
        transportMode: (playerId: string): GameplayTransportMode | null => transportHub.modeForPlayer(playerId),
        transportGeneration: (playerId: string) => transportHub.generationForPlayerForTest(playerId),
        acceptedInputs: (playerId: string): readonly AcceptedInputRecord[] =>
          structuredClone(testInputHistory?.get(playerId) ?? []),
        dropWebRtc: (playerId: string): Promise<void> => transportHub.dropPeerForTest(playerId)
      }
    : null;

  return { start, stop, rooms, testHarness };
}
