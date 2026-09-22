import { randomUUID } from 'node:crypto';
import type { Server, Socket } from 'socket.io';
import type { z } from 'zod';
import type { Ack, InputFrame, ServerError, SessionWelcome } from '../../shared/model.js';
import {
  rtcActivationRequestSchema,
  rtcNegotiationRequestSchema
} from '../../shared/gameplayTransport.js';
import type { GameplayTransportMode } from '../../shared/gameplayTransport.js';
import {
  lobbyChassisSchema,
  lobbyRoleSchema,
  lobbyBotAddSchema,
  lobbyBotUpdateSchema,
  lobbyBotRemoveSchema,
  lobbyReadySchema,
  lobbySettingsSchema,
  matchStartSchema,
  resultLobbySchema,
  resultReadySchema,
  roomCreateSchema,
  roomJoinSchema,
  roomLeaveSchema,
  sessionResumeSchema,
  transportFallbackSchema,
  type ClientToServerEvents,
  type ServerToClientEvents
} from '../../shared/protocol.js';
import { DomainError } from '../rooms/domainError.js';
import type { RoomManager } from '../rooms/roomManager.js';
import { createMatchInputIngress, type MatchInputIngress } from './matchInputIngress.js';
import { PROBE_TIMEOUT_MS, SocketRttSampler } from './SocketRttSampler.js';
import { SocketSnapshotPacer } from './SocketSnapshotPacer.js';
import {
  GameplayTransportExpectedLifecycleError,
  type GameplayTransportHub
} from './gameplayTransport/GameplayTransportHub.js';

export type GameIo = Server<ClientToServerEvents, ServerToClientEvents>;
export type GameSocket = Socket<ClientToServerEvents, ServerToClientEvents>;

type ErrorLogger = Pick<Console, 'error'>;

type SocketHandlerOptions = Readonly<{
  io: GameIo;
  rooms: RoomManager;
  now: () => number;
  logger: ErrorLogger;
  transportHub: GameplayTransportHub;
  onSession: (socket: GameSocket, welcome: SessionWelcome, inputIngress: MatchInputIngress) => void;
  onAcceptedInput?: (playerId: string, input: InputFrame, source: GameplayTransportMode) => void;
  onLeave: (socket: GameSocket, roomCode: string) => void;
  onDisconnect: (socket: GameSocket) => void;
}>;

type Bucket = {
  tokens: number;
  updatedAt: number;
};

const INVALID_PAYLOAD: ServerError = {
  code: 'INVALID_PAYLOAD',
  message: 'İstek verisi geçersiz.',
  recoverable: true
};

const RATE_LIMITED: ServerError = {
  code: 'RATE_LIMITED',
  message: 'Çok hızlı istek gönderiyorsunuz.',
  recoverable: true
};

const INTERNAL_ERROR: ServerError = {
  code: 'INTERNAL_ERROR',
  message: 'Beklenmeyen bir sunucu hatası oluştu.',
  recoverable: true
};

const TRANSPORT_UNAVAILABLE: ServerError = {
  code: 'TRANSPORT_UNAVAILABLE',
  message: 'WebRTC oyun taşıması şu anda kullanılamıyor.',
  recoverable: true
};

class SafeSocketActionError {
  constructor(readonly error: ServerError) {}
}

function currentTransport(socket: GameSocket): 'websocket' | 'polling' {
  return socket.conn.transport.name === 'websocket' ? 'websocket' : 'polling';
}

function domainError(error: DomainError): ServerError {
  return {
    code: error.code,
    message: error.safeMessage,
    recoverable: error.recoverable
  };
}

class SocketRateLimiter {
  private readonly actions: Bucket;
  private errorSuppressedUntil = 0;

  constructor(private readonly now: () => number) {
    const timestamp = now();
    this.actions = { tokens: 10, updatedAt: timestamp };
  }

  consumeAction(): boolean {
    return this.consume(this.actions, 10);
  }

  shouldEmitError(): boolean {
    const timestamp = this.now();
    if (timestamp < this.errorSuppressedUntil) return false;
    this.errorSuppressedUntil = timestamp + 1_000;
    return true;
  }

  private consume(bucket: Bucket, ratePerSecond: number): boolean {
    const timestamp = this.now();
    const elapsedMs = Math.max(0, timestamp - bucket.updatedAt);
    bucket.tokens = Math.min(ratePerSecond, bucket.tokens + (elapsedMs / 1_000) * ratePerSecond);
    bucket.updatedAt = timestamp;
    if (bucket.tokens < 1) return false;
    bucket.tokens -= 1;
    return true;
  }
}

export function registerSocketHandlers(options: SocketHandlerOptions): void {
  const { io, rooms, now, logger, transportHub, onSession, onAcceptedInput, onLeave, onDisconnect } = options;

  io.on('connection', (socket) => {
    const limiter = new SocketRateLimiter(now);
    const inputIngress = createMatchInputIngress({
      connectionId: socket.id,
      rooms,
      now,
      logger,
      onAccepted: (input, source) => {
        if (activePlayerId !== null) onAcceptedInput?.(activePlayerId, input, source);
      }
    });
    let activePlayerId: string | null = null;
    let rttSampler: SocketRttSampler | null = null;
    let snapshotPacer: SocketSnapshotPacer | null = null;

    const disposeRttSampler = (): void => {
      rttSampler?.stop();
      rttSampler = null;
    };

    const disposeSnapshotPacer = (): void => {
      snapshotPacer?.dispose();
      snapshotPacer = null;
    };

    const emitRateLimit = (): void => {
      if (limiter.shouldEmitError()) socket.emit('server:error', RATE_LIMITED);
    };
    const acknowledge = <TPayload, TData>(
      schema: z.ZodType<TPayload>,
      payload: unknown,
      callback: ((acknowledgement: Ack<TData>) => void) | undefined,
      action: (validated: TPayload) => TData,
      success?: (data: TData) => void
    ): void => {
      if (typeof callback !== 'function') {
        socket.emit('server:error', INVALID_PAYLOAD);
        return;
      }
      if (!limiter.consumeAction()) {
        emitRateLimit();
        callback({ ok: false, error: RATE_LIMITED });
        return;
      }
      const parsed = schema.safeParse(payload);
      if (!parsed.success) {
        callback({ ok: false, error: INVALID_PAYLOAD });
        return;
      }
      try {
        const data = action(parsed.data);
        callback({ ok: true, data });
        success?.(data);
      } catch (error) {
        if (error instanceof DomainError) {
          callback({ ok: false, error: domainError(error) });
          return;
        }
        if (error instanceof SafeSocketActionError) {
          callback({ ok: false, error: error.error });
          return;
        }
        const correlationId = randomUUID();
        logger.error(`[${correlationId}] Unexpected Socket.IO action failure`, error);
        callback({ ok: false, error: INTERNAL_ERROR });
      }
    };

    const acknowledgeAsync = <TPayload, TData>(
      schema: z.ZodType<TPayload>,
      payload: unknown,
      callback: ((acknowledgement: Ack<TData>) => void) | undefined,
      action: (validated: TPayload) => Promise<TData>
    ): void => {
      if (typeof callback !== 'function') {
        socket.emit('server:error', INVALID_PAYLOAD);
        return;
      }
      if (!limiter.consumeAction()) {
        emitRateLimit();
        callback({ ok: false, error: RATE_LIMITED });
        return;
      }
      const parsed = schema.safeParse(payload);
      if (!parsed.success) {
        callback({ ok: false, error: INVALID_PAYLOAD });
        return;
      }
      void action(parsed.data).then(
        (data) => callback({ ok: true, data }),
        (error: unknown) => {
          if (error instanceof DomainError) {
            callback({ ok: false, error: domainError(error) });
            return;
          }
          if (error instanceof SafeSocketActionError) {
            callback({ ok: false, error: error.error });
            return;
          }
          if (error instanceof GameplayTransportExpectedLifecycleError) {
            callback({ ok: false, error: TRANSPORT_UNAVAILABLE });
            return;
          }
          const correlationId = randomUUID();
          logger.error(`[${correlationId}] Unexpected Socket.IO async action failure`, error);
          callback({ ok: false, error: INTERNAL_ERROR });
        }
      );
    };

    const establishSession = (welcome: SessionWelcome): void => {
      disposeRttSampler();
      disposeSnapshotPacer();
      const sessionSnapshotPacer = new SocketSnapshotPacer(
        (publication, acknowledgeSnapshot) => {
          socket.emit('match:snapshot', structuredClone(publication), acknowledgeSnapshot);
        }
      );
      const sessionRttSampler = new SocketRttSampler({
        now,
        send: (probe, acknowledgeProbe) => {
          socket.timeout(PROBE_TIMEOUT_MS).emit(
            'network:probe',
            structuredClone(probe),
            (error, acknowledgement) => {
              if (!error && acknowledgement) acknowledgeProbe(acknowledgement);
            }
          );
        },
        onSample: ({ rttMs, sampledAtMs }) => {
          if (rttSampler !== sessionRttSampler || activePlayerId !== welcome.playerId) return;
          const mode = transportHub.modeForPlayer(welcome.playerId);
          if (mode !== 'websocket' && mode !== 'polling') return;
          rooms.setPing(socket.id, rttMs, currentTransport(socket), sampledAtMs);
        },
        onUnavailable: () => {
          if (rttSampler !== sessionRttSampler || activePlayerId !== welcome.playerId) return;
          const mode = transportHub.modeForPlayer(welcome.playerId);
          if (mode !== 'websocket' && mode !== 'polling') return;
          rooms.clearPing(socket.id);
        }
      });
      rttSampler = sessionRttSampler;
      snapshotPacer = sessionSnapshotPacer;
      void socket.join(welcome.roomCode);
      inputIngress.reset();
      activePlayerId = welcome.playerId;
      transportHub.attachSession({
        socketId: socket.id,
        playerId: welcome.playerId,
        roomCode: welcome.roomCode,
        inputIngress,
        socketMode: () => currentTransport(socket),
        emitMode: (notice) => socket.emit('transport:mode', structuredClone(notice)),
        emitStarted: (publication) => {
          socket.emit('match:started', structuredClone(publication));
          if (rttSampler !== sessionRttSampler) return;
          const mode = transportHub.modeForPlayer(welcome.playerId);
          if (mode !== 'websocket' && mode !== 'polling') return;
          sessionRttSampler.stop();
          sessionRttSampler.start();
        },
        emitSnapshot: (publication) => sessionSnapshotPacer.publish(publication),
        emitEvent: (publication) => socket.emit('match:event', structuredClone(publication)),
        emitError: (error) => socket.emit('server:error', structuredClone(error)),
        setNetworkMode: (mode) => {
          rooms.setTransport(socket.id, mode);
          if (mode === 'webrtc') sessionRttSampler.stop();
          else sessionRttSampler.start();
        },
        setNetworkSample: (medianMs, jitterMs, sampledAt) =>
          rooms.setWebRtcNetworkSample(socket.id, medianMs, jitterMs, sampledAt),
        clearNetworkSample: () => rooms.clearWebRtcNetworkSample(socket.id)
      });
      onSession(socket, welcome, inputIngress);
      rooms.setTransport(socket.id, currentTransport(socket));
      sessionRttSampler.start();
      queueMicrotask(() => {
        socket.emit('session:welcome', welcome);
        const publication = rooms.currentMatchPublication(socket.id);
        if (publication) transportHub.synchronizeSession(socket.id, publication);
      });
    };

    socket.conn.on('upgrade', () => {
      try {
        if (activePlayerId && transportHub.modeForPlayer(activePlayerId) === 'webrtc') return;
        rooms.setTransport(socket.id, currentTransport(socket));
        rttSampler?.stop();
        rttSampler?.start();
      } catch {
        // Ignore upgrades before a room session exists or after it was torn down.
      }
    });

    socket.on('room:create', (payload, callback) => {
      acknowledge(roomCreateSchema, payload, callback, (validated) => rooms.createRoom(socket.id, validated.name), establishSession);
    });
    socket.on('room:join', (payload, callback) => {
      acknowledge(
        roomJoinSchema,
        payload,
        callback,
        (validated) => rooms.joinRoom(socket.id, validated.roomCode, validated.name, validated.role),
        establishSession
      );
    });
    socket.on('session:resume', (payload, callback) => {
      acknowledge(
        sessionResumeSchema,
        payload,
        callback,
        (validated) => rooms.resume(
          socket.id,
          validated.roomCode,
          validated.resumeToken,
          currentTransport(socket)
        ),
        establishSession
      );
    });
    socket.on('transport:negotiate', (payload, callback) => {
      acknowledgeAsync(
        rtcNegotiationRequestSchema,
        payload,
        callback,
        (validated) => transportHub.negotiate(socket.id, validated)
      );
    });
    socket.on('transport:activate', (payload, callback) => {
      acknowledge(rtcActivationRequestSchema, payload, callback, (validated) => {
        if (!transportHub.activate(socket.id, validated)) {
          throw new SafeSocketActionError(TRANSPORT_UNAVAILABLE);
        }
        return { generationId: validated.generationId, mode: 'webrtc' } as const;
      });
    });
    socket.on('transport:fallback', (payload) => {
      if (!transportFallbackSchema.safeParse(payload).success) {
        socket.emit('server:error', INVALID_PAYLOAD);
        return;
      }
      transportHub.fallback(socket.id);
    });
    socket.on('lobby:chassis', (payload, callback) => {
      acknowledge(lobbyChassisSchema, payload, callback, (validated) => {
        rooms.setChassis(socket.id, validated.chassis);
        return null;
      });
    });
    socket.on('lobby:role', (payload, callback) => {
      acknowledge(lobbyRoleSchema, payload, callback, (validated) => {
        rooms.setRole(socket.id, validated.role);
        return null;
      });
    });
    socket.on('lobby:bot:add', (payload, callback) => {
      acknowledge(lobbyBotAddSchema, payload, callback, (validated) => {
        rooms.addBot(socket.id, validated.chassis, validated.difficulty);
        return null;
      });
    });
    socket.on('lobby:bot:update', (payload, callback) => {
      acknowledge(lobbyBotUpdateSchema, payload, callback, (validated) => {
        rooms.updateBot(socket.id, validated.playerId, validated.chassis, validated.difficulty);
        return null;
      });
    });
    socket.on('lobby:bot:remove', (payload, callback) => {
      acknowledge(lobbyBotRemoveSchema, payload, callback, (validated) => {
        rooms.removeBot(socket.id, validated.playerId);
        return null;
      });
    });
    socket.on('lobby:ready', (payload, callback) => {
      acknowledge(lobbyReadySchema, payload, callback, (validated) => {
        rooms.setReady(socket.id, validated.ready);
        return null;
      });
    });
    socket.on('lobby:settings', (payload, callback) => {
      acknowledge(lobbySettingsSchema, payload, callback, (validated) => {
        rooms.setRoomSettings(socket.id, validated);
        return null;
      });
    });
    socket.on('room:leave', (payload, callback) => {
      acknowledgeAsync(roomLeaveSchema, payload, callback, async () => {
        const roomCode = rooms.leaveRoom(socket.id);
        disposeRttSampler();
        disposeSnapshotPacer();
        activePlayerId = null;
        const cleanupResults = await Promise.allSettled([
          transportHub.detachSession(socket.id),
          socket.leave(roomCode)
        ]);
        onLeave(socket, roomCode);
        const cleanupFailures = cleanupResults.flatMap((result) =>
          result.status === 'rejected' ? [result.reason] : []);
        if (cleanupFailures.length > 0) {
          const correlationId = randomUUID();
          logger.error(
            `[${correlationId}] Socket.IO room leave cleanup failure`,
            cleanupFailures.length === 1 ? cleanupFailures[0] : cleanupFailures
          );
        }
        return null;
      });
    });
    socket.on('match:start', (payload, callback) => {
      acknowledge(matchStartSchema, payload, callback, () => {
        rooms.startMatch(socket.id);
        return null;
      });
    });
    socket.on('result:ready', (payload, callback) => {
      acknowledge(resultReadySchema, payload, callback, (validated) => {
        rooms.setResultReady(socket.id, validated.ready);
        return null;
      });
    });
    socket.on('result:lobby', (payload, callback) => {
      acknowledge(resultLobbySchema, payload, callback, () => {
        rooms.returnToLobby(socket.id);
        return null;
      });
    });
    socket.on('match:input', (payload) => {
      const result = inputIngress.accept(payload, currentTransport(socket));
      if (result.status === 'error') socket.emit('server:error', result.error);
    });
    socket.on('disconnect', () => {
      disposeRttSampler();
      disposeSnapshotPacer();
      rooms.disconnect(socket.id);
      activePlayerId = null;
      void transportHub.detachSession(socket.id);
      onDisconnect(socket);
    });
  });
}
