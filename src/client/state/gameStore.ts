import type {
  Ack, BotDifficulty, PlayerRole, Chassis, GameEvent, InputFrame, MatchSnapshot, RoomPlayer, RoomState, ServerError, SessionWelcome
} from '../../shared/model.js';
import type { RoomSettings } from '../../shared/roomSettings.js';
import { normalizePlayerName, normalizeRoomCode } from '../../shared/names.js';
import type { GameClient, GameClientConnectionState } from '../network/GameClient.js';

export type GameScreen = 'LANDING' | 'LOBBY' | 'MATCH' | 'RESULT';
export type PendingAction =
  | 'create-room' | 'join-room' | 'resume' | 'chassis' | 'ready' | 'settings' | 'leave-room'
  | 'role' | 'bot-add' | 'bot-update' | 'bot-remove' | 'start' | 'result-ready' | 'return-lobby' | null;
export type ErrorAction = Exclude<PendingAction, null> | 'server' | null;
export type CopyFeedback = 'idle' | 'copied' | 'failed';

export type Toast = Readonly<{ id: number; message: string; tone: 'info' | 'warning' | 'error' }>;
export type ClientSession = Readonly<{ playerId: string; roomCode: string; resumeToken: string }>;
export type ClientState = Readonly<{
  screen: GameScreen;
  connectionState: GameClientConnectionState;
  room: RoomState | null;
  match: MatchSnapshot | null;
  session: ClientSession | null;
  pendingAction: PendingAction;
  lastError: ServerError | null;
  errorAction: ErrorAction;
  copyFeedback: CopyFeedback;
  toasts: readonly Toast[];
  soundMuted: boolean;
  reconnectRemainingMs: number | null;
}>;

export interface GameStore {
  getSnapshot(): ClientState;
  getLatestMatch(): MatchSnapshot | null;
  subscribe(listener: () => void): () => void;
  subscribeMatch(listener: (snapshot: MatchSnapshot) => void): () => void;
  subscribeGameEvent(listener: (event: GameEvent) => void): () => void;
  sendInput(frame: InputFrame): void;
  dispose(): void;
  actions: {
    connect(): void;
    createRoom(name: string): Promise<void>;
    joinRoom(name: string, code: string, role?: PlayerRole): Promise<void>;
    setRole(role: PlayerRole): Promise<void>;
    addBot(chassis: Chassis, difficulty: BotDifficulty): Promise<void>;
    updateBot(playerId: string, chassis: Chassis, difficulty: BotDifficulty): Promise<void>;
    removeBot(playerId: string): Promise<void>;
    setChassis(chassis: Chassis): Promise<void>;
    setReady(ready: boolean): Promise<void>;
    setRoomSettings(settings: RoomSettings): Promise<void>;
    leaveRoom(): Promise<void>;
    startMatch(): Promise<void>;
    setResultReady(ready: boolean): Promise<void>;
    returnToLobby(): Promise<void>;
    copyRoomCode(): Promise<void>;
    toggleSound(): void;
    dismissToast(id: number): void;
  };
}

export interface ArenaBridge {
  getSnapshot(): MatchSnapshot | null;
  isConnected(): boolean;
  subscribeSnapshot(listener: (snapshot: MatchSnapshot) => void): () => void;
  subscribeConnected(listener: (connected: boolean) => void): () => void;
  subscribeEvent(listener: (event: GameEvent) => void): () => void;
  subscribeMuted(listener: (muted: boolean) => void): () => void;
  reserveInputSequence(minimum: number): number;
  sendInput(frame: InputFrame): void;
}

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
type ClipboardLike = Pick<Clipboard, 'writeText'>;
type GameStoreOptions = Readonly<{
  client: GameClient;
  storage: StorageLike;
  clipboard: ClipboardLike;
  getPreferredResumeRoomCode?: () => string | null | undefined;
}>;

const LAST_ROOM_KEY = 'neon-relay:last-room';
const SOUND_KEY = 'neon-relay:muted';
const RECONNECT_TICK_MS = 200;
const NO_CONTEST_MESSAGE = 'Rakip yeniden bağlanamadığı için maç geçersiz sayıldı.';

function resumeKey(roomCode: string): string { return `neon-relay:${roomCode}:resume`; }
function screenForRoom(room: RoomState | null): GameScreen {
  if (!room) return 'LANDING';
  if (room.phase === 'LOBBY') return 'LOBBY';
  if (room.phase === 'RESULT') return 'RESULT';
  return 'MATCH';
}
function invalidNameError(): ServerError {
  return { code: 'INVALID_NAME', message: 'Oyuncu adı 2–16 görünür karakter olmalıdır.', recoverable: true };
}
function invalidRoomCodeError(): ServerError {
  return { code: 'INVALID_ROOM_CODE', message: 'Oda kodu geçersiz.', recoverable: true };
}
function normalizeNameOrNull(name: string): string | null {
  try { return normalizePlayerName(name); } catch { return null; }
}
function normalizeCodeOrNull(code: string): string | null {
  try { return normalizeRoomCode(code); } catch { return null; }
}
function sameSession(left: ClientSession | null, right: ClientSession): boolean {
  return left?.playerId === right.playerId && left.roomCode === right.roomCode && left.resumeToken === right.resumeToken;
}
function scoresChanged(previous: MatchSnapshot | null, next: MatchSnapshot): boolean {
  if (!previous) return true;
  const keys = new Set([...Object.keys(previous.scores), ...Object.keys(next.scores)]);
  for (const key of keys) if (previous.scores[key] !== next.scores[key]) return true;
  return false;
}
function coarseMatchChanged(previous: MatchSnapshot | null, next: MatchSnapshot): boolean {
  return !previous || previous.phase !== next.phase || previous.winnerPlayerId !== next.winnerPlayerId ||
    previous.resultReason !== next.resultReason || scoresChanged(previous, next);
}
function once(remove: () => void): () => void {
  let active = true;
  return () => { if (!active) return; active = false; remove(); };
}

export function createGameStore({ client, storage, clipboard, getPreferredResumeRoomCode }: GameStoreOptions): GameStore {
  const listeners = new Set<() => void>();
  const matchListeners = new Set<(snapshot: MatchSnapshot) => void>();
  const gameEventListeners = new Set<(event: GameEvent) => void>();
  const unsubscribeClient: Array<() => void> = [];
  let disposed = false;
  let resumeAttemptedForConnection = false;
  let resumeQueued = false;
  let departedSessionEventsSuppressed = false;
  let awaitingAuthoritativeRoom = false;
  let acknowledgementsInFlight = 0;
  let toastId = 0;
  let pausePublishedAt = 0;
  let pausePublishedDuration: number | null = null;
  let reconnectTimer: number | null = null;
  let state: ClientState = {
    screen: 'LANDING', connectionState: client.getConnectionState(), room: null, match: null, session: null,
    pendingAction: null, lastError: null, errorAction: null, copyFeedback: 'idle', toasts: [],
    soundMuted: storage.getItem(SOUND_KEY) === 'true', reconnectRemainingMs: null
  };

  const emit = (): void => { if (!disposed) for (const listener of listeners) listener(); };
  const replace = (next: ClientState, notify = true): void => {
    if (disposed || Object.is(next, state)) return;
    state = next;
    if (notify) emit();
  };
  const patch = (recipe: (current: ClientState) => ClientState, notify = true): void => replace(recipe(state), notify);
  const clearReconnectTimer = (): void => {
    if (reconnectTimer !== null) window.clearInterval(reconnectTimer);
    reconnectTimer = null;
  };
  const updateReconnectCountdown = (): void => {
    if (pausePublishedDuration === null) return;
    const remaining = Math.max(0, pausePublishedDuration - (Date.now() - pausePublishedAt));
    if (remaining !== state.reconnectRemainingMs) patch((current) => ({ ...current, reconnectRemainingMs: remaining }));
    if (remaining === 0) clearReconnectTimer();
  };
  const acceptReconnectDuration = (duration: number | null): void => {
    clearReconnectTimer();
    pausePublishedDuration = duration;
    pausePublishedAt = Date.now();
    if (duration === null) {
      if (state.reconnectRemainingMs !== null) patch((current) => ({ ...current, reconnectRemainingMs: null }));
      return;
    }
    if (state.reconnectRemainingMs !== duration) patch((current) => ({ ...current, reconnectRemainingMs: duration }));
    if (duration > 0) reconnectTimer = window.setInterval(updateReconnectCountdown, RECONNECT_TICK_MS);
  };
  const publishMatch = (match: MatchSnapshot): void => {
    if (disposed) return;
    for (const listener of matchListeners) listener(match);
  };
  const publishGameEvent = (event: GameEvent): void => {
    if (disposed) return;
    for (const listener of gameEventListeners) listener(event);
  };
  const roomBelongsToCurrentSession = (room: RoomState): boolean => {
    const session = state.session;
    return Boolean(session && room.roomCode === session.roomCode &&
      room.players.some((player) => player.playerId === session.playerId));
  };
  const acceptsMatchPublications = (): boolean =>
    !departedSessionEventsSuppressed && !awaitingAuthoritativeRoom && state.room !== null &&
    roomBelongsToCurrentSession(state.room);
  const persistWelcome = (welcome: SessionWelcome): void => {
    departedSessionEventsSuppressed = false;
    const session = { playerId: welcome.playerId, roomCode: welcome.roomCode, resumeToken: welcome.resumeToken };
    if (sameSession(state.session, session)) return;
    awaitingAuthoritativeRoom = true;
    storage.setItem(resumeKey(welcome.roomCode), welcome.resumeToken);
    storage.setItem(LAST_ROOM_KEY, welcome.roomCode);
    resumeQueued = false;
    resumeAttemptedForConnection = true;
    patch((current) => ({ ...current, session, lastError: null, errorAction: null }));
  };
  const forgetRoom = (roomCode: string): void => {
    storage.removeItem(resumeKey(roomCode));
    if (storage.getItem(LAST_ROOM_KEY) === roomCode) storage.removeItem(LAST_ROOM_KEY);
  };
  const setFailure = (action: ErrorAction, error: ServerError): void => {
    patch((current) => ({ ...current, pendingAction: null, lastError: error, errorAction: action }));
    void flushResume();
  };
  const setUnexpectedFailure = (action: ErrorAction): void => {
    setFailure(action, { code: 'CLIENT_ERROR', message: 'Beklenmeyen bir istemci hatası oluştu.', recoverable: true });
  };
  const beginAction = (action: Exclude<PendingAction, null>): boolean => {
    if (state.pendingAction !== null) return false;
    patch((current) => ({
      ...current, pendingAction: action, lastError: null, errorAction: null,
      copyFeedback: action === 'create-room' || action === 'join-room' ? 'idle' : current.copyFeedback
    }));
    return true;
  };
  const beginAcknowledgement = (action: Exclude<PendingAction, null>): boolean => {
    if (!beginAction(action)) return false;
    acknowledgementsInFlight += 1;
    return true;
  };
  const finishAcknowledgement = (action: Exclude<PendingAction, null>): void => {
    acknowledgementsInFlight -= 1;
    if (!disposed && state.pendingAction === action) {
      patch((current) => ({ ...current, pendingAction: null }));
    }
    void flushResume();
  };
  const attemptResume = async (): Promise<void> => {
    if (disposed || resumeAttemptedForConnection) return;
    if (acknowledgementsInFlight > 0 || state.pendingAction !== null) { resumeQueued = true; return; }
    const roomCode = storage.getItem(LAST_ROOM_KEY);
    const resumeToken = roomCode ? storage.getItem(resumeKey(roomCode)) : null;
    if (!roomCode || !resumeToken) return;
    const preferredRoomCode = getPreferredResumeRoomCode?.();
    if (preferredRoomCode === null || (preferredRoomCode !== undefined && preferredRoomCode !== roomCode)) {
      resumeAttemptedForConnection = true;
      return;
    }
    resumeAttemptedForConnection = true;
    patch((current) => ({ ...current, pendingAction: 'resume', lastError: null, errorAction: null }));
    acknowledgementsInFlight += 1;
    try {
      const acknowledgement = await client.resumeSession(roomCode, resumeToken);
      if (disposed) return;
      if (!acknowledgement.ok) {
        forgetRoom(roomCode);
        replace({
          ...state, screen: 'LANDING', room: null, match: null, session: null, pendingAction: null,
          lastError: acknowledgement.error, errorAction: 'resume', reconnectRemainingMs: null
        });
        return;
      }
      persistWelcome(acknowledgement.data);
    } catch { if (!disposed) setUnexpectedFailure('resume'); }
    finally { finishAcknowledgement('resume'); }
  };
  async function flushResume(): Promise<void> {
    if (!resumeQueued || acknowledgementsInFlight > 0 || state.pendingAction !== null || state.connectionState !== 'connected') return;
    resumeQueued = false;
    await attemptResume();
  }
  unsubscribeClient.push(
    client.subscribe('connection', (connectionState) => {
      if (connectionState !== 'connected') {
        resumeAttemptedForConnection = false;
        resumeQueued = false;
      }
      patch((current) => ({ ...current, connectionState }));
      if (connectionState === 'connected') {
        if (acknowledgementsInFlight > 0 || state.pendingAction !== null) resumeQueued = true;
        else void attemptResume();
      }
    }),
    client.subscribe('session:welcome', (welcome) => {
      if (!departedSessionEventsSuppressed) persistWelcome(welcome);
    }),
    client.subscribe('room:state', (room) => {
      if (departedSessionEventsSuppressed || !roomBelongsToCurrentSession(room)) return;
      awaitingAuthoritativeRoom = false;
      acceptReconnectDuration(room.pauseRemainingMs);
      const screen = screenForRoom(room);
      patch((current) => ({
        ...current, room, screen, match: screen === 'LOBBY' ? null : current.match,
        lastError: null, errorAction: null
      }));
    }),
    client.subscribe('match:started', (match) => {
      if (!acceptsMatchPublications()) return;
      publishMatch(match);
      patch((current) => ({
        ...current, match, screen: 'MATCH', lastError: null, errorAction: null
      }));
    }),
    client.subscribe('match:snapshot', (match) => {
      if (!acceptsMatchPublications()) return;
      const shouldNotify = coarseMatchChanged(state.match, match);
      publishMatch(match);
      patch((current) => ({ ...current, match }), shouldNotify);
    }),
    client.subscribe('match:event', (event) => {
      if (!acceptsMatchPublications()) return;
      publishGameEvent(event);
      if (event.type === 'RESULT' && event.reason === 'NO_CONTEST') {
        patch((current) => ({
          ...current,
          toasts: [...current.toasts, { id: ++toastId, message: NO_CONTEST_MESSAGE, tone: 'warning' }]
        }));
      }
    }),
    client.subscribe('server:error', (error) => {
      if (state.screen === 'MATCH' && state.pendingAction === null && error.code === 'RATE_LIMITED') return;
      const action = state.pendingAction ?? 'server';
      patch((current) => ({
        ...current, pendingAction: null, lastError: error, errorAction: action,
        toasts: action === 'server'
          ? [...current.toasts, { id: ++toastId, message: error.message, tone: error.recoverable ? 'warning' : 'error' }]
          : current.toasts
      }));
      void flushResume();
    })
  );

  const runAcknowledgedAction = async (
    action: Exclude<PendingAction, null>, invoke: () => Promise<Ack<null>>
  ): Promise<void> => {
    if (!beginAcknowledgement(action)) return;
    try {
      const acknowledgement = await invoke();
      if (!disposed && !acknowledgement.ok) setFailure(action, acknowledgement.error);
    } catch { if (!disposed) setUnexpectedFailure(action); }
    finally { finishAcknowledgement(action); }
  };

  const actions: GameStore['actions'] = {
    connect(): void { client.connect(); },
    async createRoom(name: string): Promise<void> {
      if (state.pendingAction !== null) return;
      const normalizedName = normalizeNameOrNull(name);
      if (!normalizedName) { setFailure('create-room', invalidNameError()); return; }
      if (!beginAcknowledgement('create-room')) return;
      try {
        const acknowledgement = await client.createRoom(normalizedName);
        if (disposed) return;
        if (!acknowledgement.ok) { setFailure('create-room', acknowledgement.error); return; }
        persistWelcome(acknowledgement.data);
      } catch { if (!disposed) setUnexpectedFailure('create-room'); }
      finally { finishAcknowledgement('create-room'); }
    },
    async joinRoom(name: string, code: string, role?: PlayerRole): Promise<void> {
      if (state.pendingAction !== null) return;
      const normalizedName = normalizeNameOrNull(name);
      if (!normalizedName) { setFailure('join-room', invalidNameError()); return; }
      const normalizedCode = normalizeCodeOrNull(code);
      if (!normalizedCode) { setFailure('join-room', invalidRoomCodeError()); return; }
      if (!beginAcknowledgement('join-room')) return;
      try {
        const acknowledgement = await (role ? client.joinRoom(normalizedName, normalizedCode, role) : client.joinRoom(normalizedName, normalizedCode));
        if (disposed) return;
        if (!acknowledgement.ok) { setFailure('join-room', acknowledgement.error); return; }
        persistWelcome(acknowledgement.data);
      } catch { if (!disposed) setUnexpectedFailure('join-room'); }
      finally { finishAcknowledgement('join-room'); }
    },
    setRole(role): Promise<void> { return runAcknowledgedAction('role', () => client.setRole(role)); },
    addBot(chassis, difficulty): Promise<void> { return runAcknowledgedAction('bot-add', () => client.addBot(chassis, difficulty)); },
    updateBot(playerId, chassis, difficulty): Promise<void> { return runAcknowledgedAction('bot-update', () => client.updateBot(playerId, chassis, difficulty)); },
    removeBot(playerId): Promise<void> { return runAcknowledgedAction('bot-remove', () => client.removeBot(playerId)); },
    setChassis(chassis): Promise<void> { return runAcknowledgedAction('chassis', () => client.setChassis(chassis)); },
    setReady(ready): Promise<void> { return runAcknowledgedAction('ready', () => client.setReady(ready)); },
    setRoomSettings(settings): Promise<void> { return runAcknowledgedAction('settings', () => client.setRoomSettings(settings)); },
    async leaveRoom(): Promise<void> {
      const roomCode = state.session?.roomCode ?? state.room?.roomCode;
      if (!roomCode) return;
      if (!beginAcknowledgement('leave-room')) return;
      try {
        const acknowledgement = await client.leaveRoom();
        if (disposed) return;
        if (!acknowledgement.ok) { setFailure('leave-room', acknowledgement.error); return; }
        forgetRoom(roomCode);
        clearReconnectTimer();
        departedSessionEventsSuppressed = true;
        awaitingAuthoritativeRoom = true;
        resumeAttemptedForConnection = true;
        resumeQueued = false;
        replace({
          ...state,
          screen: 'LANDING',
          room: null,
          match: null,
          session: null,
          pendingAction: null,
          lastError: null,
          errorAction: null,
          reconnectRemainingMs: null
        });
      } catch { if (!disposed) setUnexpectedFailure('leave-room'); }
      finally { finishAcknowledgement('leave-room'); }
    },
    startMatch(): Promise<void> { return runAcknowledgedAction('start', () => client.startMatch()); },
    setResultReady(ready): Promise<void> { return runAcknowledgedAction('result-ready', () => client.setResultReady(ready)); },
    returnToLobby(): Promise<void> { return runAcknowledgedAction('return-lobby', () => client.returnToLobby()); },
    async copyRoomCode(): Promise<void> {
      const roomCode = state.room?.roomCode;
      if (!roomCode) return;
      try { await clipboard.writeText(roomCode); patch((current) => ({ ...current, copyFeedback: 'copied' })); }
      catch { patch((current) => ({ ...current, copyFeedback: 'failed' })); }
    },
    toggleSound(): void {
      patch((current) => {
        const soundMuted = !current.soundMuted;
        storage.setItem(SOUND_KEY, String(soundMuted));
        return { ...current, soundMuted };
      });
    },
    dismissToast(id): void { patch((current) => ({ ...current, toasts: current.toasts.filter((toast) => toast.id !== id) })); }
  };

  return {
    getSnapshot: () => state,
    getLatestMatch: () => state.match,
    subscribe(listener) { if (disposed) return () => undefined; listeners.add(listener); return once(() => listeners.delete(listener)); },
    subscribeMatch(listener) { if (disposed) return () => undefined; matchListeners.add(listener); return once(() => matchListeners.delete(listener)); },
    subscribeGameEvent(listener) { if (disposed) return () => undefined; gameEventListeners.add(listener); return once(() => gameEventListeners.delete(listener)); },
    sendInput(frame) { if (!disposed && selectSelfPlayer(state)?.role !== 'SPECTATOR') client.sendInput(frame); },
    dispose() {
      if (disposed) return;
      disposed = true;
      clearReconnectTimer();
      for (const unsubscribe of unsubscribeClient) unsubscribe();
      listeners.clear(); matchListeners.clear(); gameEventListeners.clear();
      client.disconnect();
    },
    actions
  };
}

export function createArenaBridge(store: GameStore): ArenaBridge {
  let nextInputSequence = 0;
  return {
    getSnapshot: store.getLatestMatch,
    isConnected: () => store.getSnapshot().connectionState === 'connected',
    subscribeSnapshot: store.subscribeMatch,
    subscribeConnected(listener) {
      let previous = store.getSnapshot().connectionState === 'connected';
      listener(previous);
      return store.subscribe(() => {
        const next = store.getSnapshot().connectionState === 'connected';
        if (next === previous) return;
        previous = next;
        listener(next);
      });
    },
    subscribeEvent: store.subscribeGameEvent,
    subscribeMuted(listener) {
      let previous = store.getSnapshot().soundMuted;
      listener(previous);
      return store.subscribe(() => {
        const next = store.getSnapshot().soundMuted;
        if (next === previous) return;
        previous = next;
        listener(next);
      });
    },
    reserveInputSequence(minimum) {
      const sequence = Math.max(nextInputSequence, minimum);
      nextInputSequence = sequence + 1;
      return sequence;
    },
    sendInput: store.sendInput
  };
}

export function selectSelfPlayer(state: ClientState): RoomPlayer | null {
  const playerId = state.session?.playerId;
  if (!playerId || !state.room) return null;
  return state.room.players.find((candidate) => candidate.playerId === playerId) ?? null;
}

export function selectCanStart(state: ClientState): boolean {
  if (!state.room || (state.room.phase !== 'LOBBY' && state.room.phase !== 'RESULT')) return false;
  const connected = state.room.players.filter((player) => player.connected && player.role === 'FIGHTER');
  return connected.length >= 2 && connected.every((player) => player.botDifficulty !== null || player.ready);
}
