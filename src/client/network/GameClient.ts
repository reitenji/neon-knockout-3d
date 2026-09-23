import { io, type Socket } from 'socket.io-client';
import type { Ack, BotDifficulty, PlayerRole, Chassis, GameEvent, InputFrame, MatchSnapshot, RoomState, ServerError, SessionWelcome } from '../../shared/model.js';
import type { RoomSettings } from '../../shared/roomSettings.js';
import type { ClientToServerEvents, ServerToClientEvents } from '../../shared/protocol.js';
import { createGameplayTransport } from './GameplayTransport.js';
import { createMatchPublicationSequencer } from './MatchPublicationSequencer.js';

export type GameClientConnectionState = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'disconnected';

export type GameClientEvents = {
  'room:kicked': (notice: Readonly<{ roomCode: string }>) => void;
  connection: (state: GameClientConnectionState) => void;
  'session:welcome': (welcome: SessionWelcome) => void;
  'room:state': (state: RoomState) => void;
  'match:started': (snapshot: MatchSnapshot) => void;
  'match:snapshot': (snapshot: MatchSnapshot) => void;
  'match:event': (event: GameEvent) => void;
  'server:error': (error: ServerError) => void;
};

export interface GameClient {
  connect(): void;
  disconnect(): void;
  getConnectionState(): GameClientConnectionState;
  subscribe<E extends keyof GameClientEvents>(event: E, listener: GameClientEvents[E]): () => void;
  createRoom(name: string): Promise<Ack<SessionWelcome>>;
  joinRoom(name: string, roomCode: string, role?: PlayerRole): Promise<Ack<SessionWelcome>>;
  resumeSession(roomCode: string, resumeToken: string): Promise<Ack<SessionWelcome>>;
  sendChat(text: string): Promise<Ack<null>>;
  kickPlayer(playerId: string): Promise<Ack<null>>;
  setRole(role: PlayerRole): Promise<Ack<null>>;
  addBot(chassis: Chassis, difficulty: BotDifficulty): Promise<Ack<null>>;
  updateBot(playerId: string, chassis: Chassis, difficulty: BotDifficulty): Promise<Ack<null>>;
  removeBot(playerId: string): Promise<Ack<null>>;
  setChassis(chassis: Chassis): Promise<Ack<null>>;
  setReady(ready: boolean): Promise<Ack<null>>;
  setRoomSettings(settings: RoomSettings): Promise<Ack<null>>;
  leaveRoom(): Promise<Ack<null>>;
  startMatch(): Promise<Ack<null>>;
  sendInput(input: InputFrame): void;
  setResultReady(ready: boolean): Promise<Ack<null>>;
  returnToLobby(): Promise<Ack<null>>;
}

type ListenerSets = { [K in keyof GameClientEvents]: Set<GameClientEvents[K]> };
type GameSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

type SocketGameClientOptions = Readonly<{
  origin?: string;
  acknowledgementTimeoutMs?: number;
}>;

const ACKNOWLEDGEMENT_TIMEOUT_MS = 5_000;

const ACK_TIMEOUT_ERROR: ServerError = {
  code: 'ACK_TIMEOUT',
  message: 'Sunucu yanıt vermedi.',
  recoverable: true
};

function createListenerSets(): ListenerSets {
  return {
    connection: new Set(),
    'session:welcome': new Set(),
    'room:state': new Set(),
    'room:kicked': new Set(),
    'match:started': new Set(),
    'match:snapshot': new Set(),
    'match:event': new Set(),
    'server:error': new Set()
  };
}

export function createSocketGameClient(options: SocketGameClientOptions = {}): GameClient {
  const origin = options.origin ?? window.location.origin;
  const timeoutMs = options.acknowledgementTimeoutMs ?? ACKNOWLEDGEMENT_TIMEOUT_MS;
  const socket: GameSocket = io(origin, {
    autoConnect: false,
    reconnection: true,
    reconnectionAttempts: Infinity,
    transports: ['websocket', 'polling'],
    tryAllTransports: true
  });
  const listeners = createListenerSets();
  let connectionState: GameClientConnectionState = 'idle';
  let hasConnected = false;
  let hasSession = false;
  let localPlayerId: string | null = null;
  let roomPhase: RoomState['phase'] | null = null;

  const publish = <E extends keyof GameClientEvents>(event: E, ...args: Parameters<GameClientEvents[E]>): void => {
    for (const listener of listeners[event]) {
      (listener as (...eventArgs: Parameters<GameClientEvents[E]>) => void)(...args);
    }
  };

  const setConnectionState = (next: GameClientConnectionState): void => {
    if (next === connectionState) return;
    connectionState = next;
    publish('connection', next);
  };

  const withAckTimeout = <T>(send: (acknowledge: (acknowledgement: Ack<T>) => void) => void): Promise<Ack<T>> =>
    new Promise((resolve) => {
      let settled = false;
      const finish = (acknowledgement: Ack<T>): void => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        resolve(acknowledgement);
      };
      const timer = window.setTimeout(() => finish({ ok: false, error: ACK_TIMEOUT_ERROR }), timeoutMs);
      send(finish);
    });

  type GameplayTransportBundle = {
    readonly transport: ReturnType<typeof createGameplayTransport>;
    readonly sequencer: ReturnType<typeof createMatchPublicationSequencer>;
    disposed: boolean;
  };
  let activeBundle: GameplayTransportBundle | null = null;

  const createBundle = (): GameplayTransportBundle => {
    let owner: GameplayTransportBundle | null = null;
    const sequencer = createMatchPublicationSequencer({
      onStarted: (snapshot) => publish('match:started', snapshot),
      onSnapshot: (snapshot) => {
        if (owner !== null && activeBundle === owner && !owner.disposed && localPlayerId !== null) {
          owner.transport.acceptAuthoritativeSnapshot(snapshot, localPlayerId);
        }
        publish('match:snapshot', snapshot);
      },
      onEvent: (event) => publish('match:event', event),
      onTransportGap: () => {
        if (owner !== null && activeBundle === owner && !owner.disposed) owner.transport.fallback();
      }
    });
    const transport = createGameplayTransport({
      negotiate: (request) => withAckTimeout((acknowledge) => {
        socket.emit('transport:negotiate', request, acknowledge);
      }),
      activate: (request) => withAckTimeout((acknowledge) => {
        socket.emit('transport:activate', request, acknowledge);
      }),
      notifyFallback: () => socket.emit('transport:fallback', {}),
      sendFallbackInput: (input) => socket.emit('match:input', input),
      sequencer
    });
    owner = { transport, sequencer, disposed: false };
    return owner;
  };

  const ensureBundle = (): GameplayTransportBundle => {
    activeBundle ??= createBundle();
    return activeBundle;
  };

  const disposeActiveBundle = (): void => {
    const bundle = activeBundle;
    if (bundle === null) return;
    activeBundle = null;
    bundle.disposed = true;
    bundle.sequencer.dispose();
    bundle.transport.dispose();
  };

  const replaceBundleAndStart = (): void => {
    disposeActiveBundle();
    const bundle = createBundle();
    activeBundle = bundle;
    void bundle.transport.start();
  };

  activeBundle = createBundle();

  socket.on('connect', () => {
    hasConnected = true;
    setConnectionState('connected');
  });
  socket.io.on('reconnect_attempt', () => setConnectionState(hasConnected ? 'reconnecting' : 'connecting'));
  socket.on('connect_error', () => setConnectionState(hasConnected ? 'reconnecting' : 'disconnected'));
  socket.on('disconnect', () => {
    if (!socket.active) {
      disposeActiveBundle();
      hasSession = false;
      localPlayerId = null;
      roomPhase = null;
    }
    setConnectionState(socket.active ? 'reconnecting' : 'disconnected');
  });
  socket.on('session:welcome', (welcome) => {
    if (hasSession) replaceBundleAndStart();
    else void ensureBundle().transport.start();
    hasSession = true;
    localPlayerId = welcome.playerId;
    roomPhase = null;
    publish('session:welcome', welcome);
  });
  let spectator = false;
  socket.on('room:kicked', (notice) => {
    disposeActiveBundle(); hasSession = false; localPlayerId = null; roomPhase = null;
    publish('room:kicked', notice);
  });
  socket.on('room:state', (state) => {
    spectator = state.players.find((player) => player.playerId === localPlayerId)?.role === 'SPECTATOR';
    const startsFreshGeneration = hasSession && roomPhase === 'RESULT' && state.phase === 'LOBBY';
    roomPhase = state.phase;
    if (startsFreshGeneration) replaceBundleAndStart();
    publish('room:state', state);
  });
  socket.on('transport:mode', (notice) => activeBundle?.transport.acceptMode(notice));
  socket.on('match:started', (publication) => activeBundle?.transport.acceptSocketStarted(publication));
  socket.on('match:snapshot', (publication, acknowledge) => {
    try {
      activeBundle?.transport.acceptSocketSnapshot(publication);
    } finally {
      acknowledge();
    }
  });
  socket.on('match:event', (publication) => activeBundle?.transport.acceptSocketEvent(publication));
  socket.on('network:probe', (probe, acknowledge) => acknowledge({ nonce: probe.nonce }));
  socket.on('server:error', (error) => publish('server:error', error));

  return {
    connect(): void {
      if (socket.connected || socket.active) return;
      setConnectionState(hasConnected ? 'reconnecting' : 'connecting');
      socket.connect();
    },
    disconnect(): void {
      disposeActiveBundle();
      hasSession = false;
      localPlayerId = null;
      roomPhase = null;
      socket.disconnect();
      setConnectionState('disconnected');
    },
    getConnectionState(): GameClientConnectionState {
      return connectionState;
    },
    subscribe<E extends keyof GameClientEvents>(event: E, listener: GameClientEvents[E]): () => void {
      listeners[event].add(listener);
      return () => listeners[event].delete(listener);
    },
    createRoom(name: string): Promise<Ack<SessionWelcome>> {
      return withAckTimeout((acknowledge) => socket.emit('room:create', { name }, acknowledge));
    },
    joinRoom(name: string, roomCode: string, role?: PlayerRole): Promise<Ack<SessionWelcome>> {
      return withAckTimeout((acknowledge) => socket.emit('room:join', { name, roomCode, ...(role ? { role } : {}) }, acknowledge));
    },
    resumeSession(roomCode: string, resumeToken: string): Promise<Ack<SessionWelcome>> {
      return withAckTimeout((acknowledge) => socket.emit('session:resume', { roomCode, resumeToken }, acknowledge));
    },
    sendChat(text) { return withAckTimeout((acknowledge) => socket.emit('lobby:chat', { text }, acknowledge)); },
    kickPlayer(playerId) { return withAckTimeout((acknowledge) => socket.emit('room:kick', { playerId }, acknowledge)); },
    setRole(role): Promise<Ack<null>> {
      return withAckTimeout((acknowledge) => socket.emit('lobby:role', { role }, acknowledge));
    },
    addBot(chassis, difficulty): Promise<Ack<null>> {
      return withAckTimeout((acknowledge) => socket.emit('lobby:bot:add', { chassis, difficulty }, acknowledge));
    },
    updateBot(playerId, chassis, difficulty): Promise<Ack<null>> {
      return withAckTimeout((acknowledge) => socket.emit('lobby:bot:update', { playerId, chassis, difficulty }, acknowledge));
    },
    removeBot(playerId): Promise<Ack<null>> {
      return withAckTimeout((acknowledge) => socket.emit('lobby:bot:remove', { playerId }, acknowledge));
    },
    setChassis(chassis: Chassis): Promise<Ack<null>> {
      return withAckTimeout((acknowledge) => socket.emit('lobby:chassis', { chassis }, acknowledge));
    },
    setReady(ready: boolean): Promise<Ack<null>> {
      return withAckTimeout((acknowledge) => socket.emit('lobby:ready', { ready }, acknowledge));
    },
    setRoomSettings(settings: RoomSettings): Promise<Ack<null>> {
      return withAckTimeout((acknowledge) => socket.emit('lobby:settings', settings, acknowledge));
    },
    async leaveRoom(): Promise<Ack<null>> {
      const acknowledgement = await withAckTimeout<null>((acknowledge) => {
        socket.emit('room:leave', {}, acknowledge);
      });
      if (acknowledgement.ok) {
        disposeActiveBundle();
        hasSession = false;
        localPlayerId = null;
        roomPhase = null;
      }
      return acknowledgement;
    },
    startMatch(): Promise<Ack<null>> {
      return withAckTimeout((acknowledge) => socket.emit('match:start', {}, acknowledge));
    },
    sendInput(input: InputFrame): void {
      if (spectator) return;
      if (!activeBundle?.transport.sendInput(input)) socket.emit('match:input', input);
    },
    setResultReady(ready: boolean): Promise<Ack<null>> {
      return withAckTimeout((acknowledge) => socket.emit('result:ready', { ready }, acknowledge));
    },
    returnToLobby(): Promise<Ack<null>> {
      return withAckTimeout<null>((acknowledge) => {
        socket.emit('result:lobby', {}, acknowledge);
      });
    }
  };
}
