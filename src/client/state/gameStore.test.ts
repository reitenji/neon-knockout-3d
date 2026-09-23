import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  Ack, Chassis, GameEvent, InputFrame, MatchSnapshot, RoomPlayer, RoomState, ServerError, SessionWelcome
} from '../../shared/model.js';
import { DEFAULT_ROOM_SETTINGS } from '../../shared/roomSettings.js';
import type { RoomSettings } from '../../shared/roomSettings.js';
import type { GameClient, GameClientConnectionState, GameClientEvents } from '../network/GameClient.js';
import { createArenaBridge, createGameStore } from './gameStore.js';

class MemoryStorage implements Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> {
  readonly values = new Map<string, string>();
  readonly writes: Array<readonly [string, string]> = [];
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  setItem(key: string, value: string): void { this.values.set(key, value); this.writes.push([key, value]); }
  removeItem(key: string): void { this.values.delete(key); }
}

class FakeGameClient implements GameClient {
  private readonly listeners: { [K in keyof GameClientEvents]: Set<GameClientEvents[K]> } = {
    'room:kicked': new Set(), connection: new Set(), 'session:welcome': new Set(), 'room:state': new Set(), 'match:started': new Set(),
    'match:snapshot': new Set(), 'match:event': new Set(), 'server:error': new Set()
  };
  readonly unsubscribeCalls = vi.fn();
  connectionState: GameClientConnectionState = 'idle';
  readonly connect = vi.fn(() => undefined);
  readonly disconnect = vi.fn(() => undefined);
  readonly createRoom = vi.fn<(name: string) => Promise<Ack<SessionWelcome>>>();
  readonly joinRoom = vi.fn<(name: string, roomCode: string) => Promise<Ack<SessionWelcome>>>();
  readonly resumeSession = vi.fn<(roomCode: string, resumeToken: string) => Promise<Ack<SessionWelcome>>>();
  readonly setRole = vi.fn<GameClient['setRole']>(async () => ({ ok: true, data: null }));
  readonly addBot = vi.fn<GameClient['addBot']>(async () => ({ ok: true, data: null }));
  readonly updateBot = vi.fn<GameClient['updateBot']>(async () => ({ ok: true, data: null }));
  readonly sendChat = vi.fn<GameClient['sendChat']>(async () => ({ ok: true, data: null }));
  readonly kickPlayer = vi.fn<GameClient['kickPlayer']>(async () => ({ ok: true, data: null }));
  readonly removeBot = vi.fn<GameClient['removeBot']>(async () => ({ ok: true, data: null }));
  readonly setChassis = vi.fn<(chassis: Chassis) => Promise<Ack<null>>>(async () => ({ ok: true, data: null }));
  readonly setReady = vi.fn<(ready: boolean) => Promise<Ack<null>>>(async () => ({ ok: true, data: null }));
  readonly setRoomSettings = vi.fn<(settings: RoomSettings) => Promise<Ack<null>>>(async () => ({ ok: true, data: null }));
  readonly startMatch = vi.fn<() => Promise<Ack<null>>>(async () => ({ ok: true, data: null }));
  readonly sendInput = vi.fn<(input: InputFrame) => void>(() => undefined);
  readonly setResultReady = vi.fn<(ready: boolean) => Promise<Ack<null>>>(async () => ({ ok: true, data: null }));
  readonly returnToLobby = vi.fn<() => Promise<Ack<null>>>(async () => ({ ok: true, data: null }));
  readonly leaveRoom = vi.fn<() => Promise<Ack<null>>>(async () => ({ ok: true, data: null }));
  getConnectionState(): GameClientConnectionState { return this.connectionState; }
  subscribe<E extends keyof GameClientEvents>(event: E, listener: GameClientEvents[E]): () => void {
    this.listeners[event].add(listener);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      this.listeners[event].delete(listener);
      this.unsubscribeCalls(event);
    };
  }
  emit<E extends keyof GameClientEvents>(event: E, ...args: Parameters<GameClientEvents[E]>): void {
    for (const listener of this.listeners[event]) {
      (listener as (...eventArgs: Parameters<GameClientEvents[E]>) => void)(...args);
    }
  }
}

const stats = (overrides: Partial<RoomPlayer['stats']> = {}): RoomPlayer['stats'] => ({
  knockouts: 0, falls: 0, landedHits: 0, completedAttacks: 0, ...overrides
});
function successWelcome(overrides: Partial<SessionWelcome> = {}): SessionWelcome {
  return { playerId: 'player-1', roomCode: 'AB2Z', resumeToken: 'a'.repeat(64), resumed: false, ...overrides };
}
function player(overrides: Partial<RoomPlayer> = {}): RoomPlayer {
  return {
    role: 'FIGHTER', botDifficulty: null,
    playerId: 'player-1', name: 'Ada', chassis: 'RIFT', accent: 0, ready: false, connected: true,
    reconnectRemainingMs: null, stats: stats(), ...overrides
  };
}
function roomState(overrides: Partial<RoomState> = {}): RoomState {
  return {
    roomCode: 'AB2Z', phase: 'LOBBY', hostPlayerId: 'player-1', pauseRemainingMs: null, chatMessages: [], result: null,
    settings: DEFAULT_ROOM_SETTINGS,
    players: [player()], ...overrides
  };
}
function matchSnapshot(overrides: Partial<MatchSnapshot> = {}): MatchSnapshot {
  return {
    tick: 12, phase: 'REGULATION', remainingMs: 115_000, platformProgress: 0,
    settings: DEFAULT_ROOM_SETTINGS,
    scores: { 'player-1': 0 },
    network: { 'player-1': { currentMs: null, medianMs: null, jitterMs: null, transport: 'websocket' } },
    players: [], pulses: [], winnerPlayerId: null, resultReason: null, ...overrides
  };
}
function phaseEvent(overrides: Partial<Extract<GameEvent, { type: 'PHASE' }>> = {}): Extract<GameEvent, { type: 'PHASE' }> {
  return { eventId: 1, tick: 12, type: 'PHASE', phase: 'REGULATION', remainingMs: 115_000, ...overrides };
}
function createFixture(client = new FakeGameClient(), storage = new MemoryStorage()) {
  const clipboard = { writeText: vi.fn(async () => undefined) };
  const store = createGameStore({ client, storage, clipboard });
  return { client, storage, clipboard, store };
}

describe('createGameStore', () => {
  afterEach(() => vi.useRealTimers());

  it('normalizes valid requests and exposes typed adjacent validation for raw invalid values', async () => {
    const { client, storage, store } = createFixture();
    client.joinRoom.mockResolvedValue({ ok: true, data: successWelcome() });
    await store.actions.createRoom('');
    expect(store.getSnapshot()).toMatchObject({ errorAction: 'create-room', lastError: { code: 'INVALID_NAME' } });
    expect(client.createRoom).not.toHaveBeenCalled();
    await store.actions.joinRoom('  A\u0301da  ', 'bad');
    expect(store.getSnapshot()).toMatchObject({ errorAction: 'join-room', lastError: { code: 'INVALID_ROOM_CODE' } });
    await store.actions.joinRoom('  A\u0301da  ', ' ab2z ');
    expect(client.joinRoom).toHaveBeenCalledWith('Áda', 'AB2Z');
    expect(storage.values.get('neon-relay:AB2Z:resume')).toBe('a'.repeat(64));
  });

  it('does not resume a stored room when the current invite targets a different room', async () => {
    const client = new FakeGameClient();
    const storage = new MemoryStorage();
    const clipboard = { writeText: vi.fn(async () => undefined) };
    storage.setItem('neon-relay:last-room', 'AB2Z');
    storage.setItem('neon-relay:AB2Z:resume', 'a'.repeat(64));
    client.resumeSession.mockResolvedValue({ ok: true, data: successWelcome({ resumed: true }) });
    client.joinRoom.mockResolvedValue({
      ok: true,
      data: successWelcome({ roomCode: 'CD3X', resumeToken: 'b'.repeat(64) })
    });
    const store = createGameStore({
      client,
      storage,
      clipboard,
      getPreferredResumeRoomCode: () => 'CD3X'
    });

    client.connectionState = 'connected';
    client.emit('connection', 'connected');
    await Promise.resolve();

    expect(client.resumeSession).not.toHaveBeenCalled();
    expect(storage.getItem('neon-relay:AB2Z:resume')).toBe('a'.repeat(64));

    await store.actions.joinRoom('Ece', 'CD3X');
    expect(client.joinRoom).toHaveBeenCalledWith('Ece', 'CD3X');
    expect(store.getSnapshot().session).toMatchObject({ roomCode: 'CD3X' });
  });

  it('resumes normally when the current invite targets the stored room', async () => {
    const client = new FakeGameClient();
    const storage = new MemoryStorage();
    storage.setItem('neon-relay:last-room', 'AB2Z');
    storage.setItem('neon-relay:AB2Z:resume', 'a'.repeat(64));
    client.resumeSession.mockResolvedValue({ ok: true, data: successWelcome({ resumed: true }) });
    const store = createGameStore({
      client,
      storage,
      clipboard: { writeText: vi.fn(async () => undefined) },
      getPreferredResumeRoomCode: () => 'AB2Z'
    });

    client.connectionState = 'connected';
    client.emit('connection', 'connected');

    await vi.waitFor(() => expect(client.resumeSession).toHaveBeenCalledWith('AB2Z', 'a'.repeat(64)));
    expect(store.getSnapshot().session).toMatchObject({ roomCode: 'AB2Z', playerId: 'player-1' });
  });

  it('keeps auto-resume suppressed when an invite is dismissed before connection and across reconnects', async () => {
    const client = new FakeGameClient();
    const storage = new MemoryStorage();
    let resumePreference: string | null | undefined = 'CD3X';
    storage.setItem('neon-relay:last-room', 'AB2Z');
    storage.setItem('neon-relay:AB2Z:resume', 'a'.repeat(64));
    client.resumeSession.mockResolvedValue({ ok: true, data: successWelcome({ resumed: true }) });
    createGameStore({
      client,
      storage,
      clipboard: { writeText: vi.fn(async () => undefined) },
      getPreferredResumeRoomCode: () => resumePreference
    });

    resumePreference = null;
    client.connectionState = 'connected';
    client.emit('connection', 'connected');
    await Promise.resolve();
    expect(client.resumeSession).not.toHaveBeenCalled();

    client.connectionState = 'reconnecting';
    client.emit('connection', 'reconnecting');
    client.connectionState = 'connected';
    client.emit('connection', 'connected');
    await Promise.resolve();
    expect(client.resumeSession).not.toHaveBeenCalled();
  });

  it('keeps chassis and ready state canonical until one authoritative room replacement arrives', async () => {
    const { client, store } = createFixture();
    client.emit('session:welcome', successWelcome());
    const canonical = roomState({ players: [player({ chassis: 'RIFT', ready: true })] });
    client.emit('room:state', canonical);
    let settleChassis!: (acknowledgement: Ack<null>) => void;
    client.setChassis.mockImplementation(() => new Promise((resolve) => { settleChassis = resolve; }));
    const pendingChassis = store.actions.setChassis('PULSE');
    expect(client.setChassis).toHaveBeenCalledWith('PULSE');
    expect(store.getSnapshot().room).toBe(canonical);
    expect(store.getSnapshot().room?.players[0]).toMatchObject({ chassis: 'RIFT', ready: true });
    expect(store.getSnapshot().pendingAction).toBe('chassis');
    const replacement = roomState({ players: [player({ chassis: 'PULSE', ready: false })] });
    client.emit('room:state', replacement);
    expect(store.getSnapshot().room).toBe(replacement);
    expect(store.getSnapshot().pendingAction).toBe('chassis');
    settleChassis({ ok: true, data: null });
    await pendingChassis;
    expect(store.getSnapshot().pendingAction).toBeNull();
  });

  it('keeps settings pending and canonical until acknowledgement and authoritative room publication arrive independently', async () => {
    const { client, store } = createFixture();
    client.emit('session:welcome', successWelcome());
    const canonical = roomState();
    client.emit('room:state', canonical);
    let settleSettings!: (acknowledgement: Ack<null>) => void;
    client.setRoomSettings.mockImplementation(() => new Promise((resolve) => { settleSettings = resolve; }));

    const pendingSettings = store.actions.setRoomSettings({ durationMs: 90_000, knockoutTarget: 3 });

    expect(client.setRoomSettings).toHaveBeenCalledWith({ durationMs: 90_000, knockoutTarget: 3 });
    expect(store.getSnapshot()).toMatchObject({ pendingAction: 'settings', room: canonical });
    settleSettings({ ok: true, data: null });
    await pendingSettings;
    expect(store.getSnapshot()).toMatchObject({ pendingAction: null, room: canonical });

    const authoritative = roomState({ settings: { durationMs: 90_000, knockoutTarget: 3 } });
    client.emit('room:state', authoritative);
    expect(store.getSnapshot().room).toBe(authoritative);
  });

  it('preserves authoritative settings and exposes the settings action when the server rejects the update', async () => {
    const { client, store } = createFixture();
    client.emit('session:welcome', successWelcome());
    const canonical = roomState();
    client.emit('room:state', canonical);
    client.setRoomSettings.mockResolvedValue({
      ok: false,
      error: { code: 'NOT_HOST', message: 'Bu işlemi yalnızca oda sahibi yapabilir.', recoverable: true }
    });

    await store.actions.setRoomSettings({ durationMs: 180_000, knockoutTarget: 10 });

    expect(store.getSnapshot()).toMatchObject({
      pendingAction: null,
      room: canonical,
      errorAction: 'settings',
      lastError: { code: 'NOT_HOST' }
    });
  });

  it('clears only room lifecycle state after acknowledged leave while preserving transport and sound', async () => {
    const client = new FakeGameClient();
    client.connectionState = 'connected';
    const storage = new MemoryStorage();
    storage.setItem('neon-relay:muted', 'true');
    const { store } = createFixture(client, storage);
    const welcome = successWelcome();
    const room = roomState({ phase: 'MATCH', pauseRemainingMs: 9_000 });
    const match = matchSnapshot();
    client.emit('session:welcome', welcome);
    client.emit('room:state', room);
    client.emit('match:started', match);
    client.emit('server:error', { code: 'SERVER_BUSY', message: 'Birazdan tekrar deneyin.', recoverable: true });
    const session = store.getSnapshot().session;
    let settleLeave!: (acknowledgement: Ack<null>) => void;
    client.leaveRoom.mockImplementation(() => new Promise((resolve) => { settleLeave = resolve; }));

    const pendingLeave = store.actions.leaveRoom();

    expect(store.getSnapshot()).toMatchObject({
      screen: 'MATCH', connectionState: 'connected', room, match,
      pendingAction: 'leave-room', soundMuted: true, reconnectRemainingMs: 9_000
    });
    expect(store.getSnapshot().session).toBe(session);
    expect(storage.getItem('neon-relay:last-room')).toBe('AB2Z');
    expect(storage.getItem('neon-relay:AB2Z:resume')).toBe('a'.repeat(64));
    client.connectionState = 'reconnecting';
    client.emit('connection', 'reconnecting');
    client.connectionState = 'connected';
    client.emit('connection', 'connected');
    settleLeave({ ok: true, data: null });
    await pendingLeave;

    expect(store.getSnapshot()).toMatchObject({
      screen: 'LANDING', connectionState: 'connected', room: null, match: null, session: null,
      pendingAction: null, lastError: null, errorAction: null, soundMuted: true, reconnectRemainingMs: null
    });
    expect(storage.getItem('neon-relay:last-room')).toBeNull();
    expect(storage.getItem('neon-relay:AB2Z:resume')).toBeNull();
    expect(client.resumeSession).not.toHaveBeenCalled();
  });

  it('ignores delayed publications from the departed session after acknowledged leave', async () => {
    const client = new FakeGameClient();
    client.connectionState = 'connected';
    const { storage, store } = createFixture(client);
    const welcome = successWelcome();
    client.emit('session:welcome', welcome);
    client.emit('room:state', roomState({ phase: 'MATCH' }));
    client.emit('match:started', matchSnapshot());

    await store.actions.leaveRoom();
    client.emit('session:welcome', welcome);
    client.emit('room:state', roomState({ phase: 'MATCH' }));
    client.emit('match:snapshot', matchSnapshot({ tick: 13 }));
    client.emit('match:event', phaseEvent({ tick: 13 }));
    client.emit('connection', 'reconnecting');
    client.emit('connection', 'connected');
    await Promise.resolve();

    expect(store.getSnapshot()).toMatchObject({ screen: 'LANDING', room: null, match: null, session: null });
    expect(storage.getItem('neon-relay:last-room')).toBeNull();
    expect(storage.getItem('neon-relay:AB2Z:resume')).toBeNull();
    expect(client.resumeSession).not.toHaveBeenCalled();
  });

  it('isolates a rejoined session from delayed room and match publications for the former membership', async () => {
    const client = new FakeGameClient();
    client.connectionState = 'connected';
    const { storage, store } = createFixture(client);
    const formerWelcome = successWelcome();
    const formerRoom = roomState({ phase: 'MATCH' });
    client.emit('session:welcome', formerWelcome);
    client.emit('room:state', formerRoom);
    client.emit('match:started', matchSnapshot({ tick: 10 }));
    await store.actions.leaveRoom();

    const rejoinedWelcome = successWelcome({
      playerId: 'player-2',
      resumeToken: 'b'.repeat(64)
    });
    client.joinRoom.mockResolvedValue({ ok: true, data: rejoinedWelcome });
    await store.actions.joinRoom('Ece', 'AB2Z');
    client.emit('session:welcome', rejoinedWelcome);

    client.emit('room:state', formerRoom);
    client.emit('match:started', matchSnapshot({ tick: 11 }));
    client.emit('match:snapshot', matchSnapshot({ tick: 12 }));
    client.emit('match:event', phaseEvent({ tick: 12 }));

    expect(store.getSnapshot()).toMatchObject({
      screen: 'LANDING', room: null, match: null,
      session: { playerId: 'player-2', roomCode: 'AB2Z', resumeToken: 'b'.repeat(64) }
    });
    expect(storage.getItem('neon-relay:last-room')).toBe('AB2Z');
    expect(storage.getItem('neon-relay:AB2Z:resume')).toBe('b'.repeat(64));

    const rejoinedRoom = roomState({
      players: [player(), player({ playerId: 'player-2', name: 'Ece', accent: 1 })]
    });
    const rejoinedMatch = matchSnapshot({ tick: 20, scores: { 'player-1': 0, 'player-2': 0 } });
    client.emit('room:state', rejoinedRoom);
    client.emit('match:started', rejoinedMatch);

    expect(store.getSnapshot()).toMatchObject({ screen: 'MATCH', room: rejoinedRoom, match: rejoinedMatch });
  });

  it.each([
    ['server rejection', { code: 'INVALID_PHASE', message: 'Bu işlem şu anda kullanılamaz.', recoverable: true }],
    ['acknowledgement timeout', { code: 'ACK_TIMEOUT', message: 'Sunucu yanıt vermedi.', recoverable: true }]
  ] as const)('preserves the complete room session after a leave %s', async (_label, error) => {
    const { client, storage, store } = createFixture();
    const welcome = successWelcome();
    const room = roomState({ phase: 'MATCH', pauseRemainingMs: 7_000 });
    const match = matchSnapshot();
    client.emit('session:welcome', welcome);
    client.emit('room:state', room);
    client.emit('match:started', match);
    const session = store.getSnapshot().session;
    client.leaveRoom.mockResolvedValue({ ok: false, error });

    await store.actions.leaveRoom();

    expect(store.getSnapshot()).toMatchObject({
      screen: 'MATCH', room, match, pendingAction: null,
      errorAction: 'leave-room', lastError: error, reconnectRemainingMs: 7_000
    });
    expect(store.getSnapshot().session).toBe(session);
    expect(storage.getItem('neon-relay:last-room')).toBe('AB2Z');
    expect(storage.getItem('neon-relay:AB2Z:resume')).toBe('a'.repeat(64));
  });

  it('queues exactly one resume when the transport reconnects during a pending acknowledgement', async () => {
    const client = new FakeGameClient();
    const storage = new MemoryStorage();
    storage.setItem('neon-relay:last-room', 'AB2Z');
    storage.setItem('neon-relay:AB2Z:resume', 'b'.repeat(64));
    let settleReady!: (acknowledgement: Ack<null>) => void;
    client.setReady.mockImplementation(() => new Promise((resolve) => { settleReady = resolve; }));
    client.resumeSession.mockResolvedValue({ ok: true, data: successWelcome({ resumeToken: 'b'.repeat(64), resumed: true }) });
    const { store } = createFixture(client, storage);
    const pendingReady = store.actions.setReady(true);
    client.connectionState = 'connected';
    client.emit('connection', 'connected');
    client.emit('connection', 'connected');
    expect(client.resumeSession).not.toHaveBeenCalled();
    client.emit('room:state', roomState());
    await Promise.resolve();
    expect(client.resumeSession).not.toHaveBeenCalled();
    expect(store.getSnapshot().pendingAction).toBe('ready');
    client.emit('room:state', roomState());
    client.emit('connection', 'connected');
    expect(client.resumeSession).not.toHaveBeenCalled();
    settleReady({ ok: true, data: null });
    await pendingReady;
    await vi.waitFor(() => expect(client.resumeSession).toHaveBeenCalledOnce());
    client.emit('room:state', roomState());
    client.emit('connection', 'connected');
    await Promise.resolve();
    expect(client.resumeSession).toHaveBeenCalledOnce();
  });

  it('deduplicates acknowledgement and event delivery of the same welcome', async () => {
    const { client, storage, store } = createFixture();
    const welcome = successWelcome();
    client.createRoom.mockImplementation(async () => {
      client.emit('session:welcome', welcome);
      return { ok: true, data: welcome };
    });
    let previousSession = store.getSnapshot().session;
    const sessionTransitions: Array<typeof previousSession> = [];
    store.subscribe(() => {
      const currentSession = store.getSnapshot().session;
      if (currentSession === previousSession) return;
      previousSession = currentSession;
      sessionTransitions.push(currentSession);
    });
    await store.actions.createRoom('Ada');
    expect(store.getSnapshot().session?.playerId).toBe('player-1');
    expect(sessionTransitions).toHaveLength(1);
    expect(storage.writes.filter(([key]) => key === 'neon-relay:AB2Z:resume')).toHaveLength(1);
  });

  it('counts down from the published pause duration without mutating the canonical room', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-28T12:00:00Z'));
    const { client, store } = createFixture();
    const canonical = roomState({ phase: 'MATCH', pauseRemainingMs: 12_400 });
    client.emit('session:welcome', successWelcome());
    client.emit('room:state', canonical);
    expect(store.getSnapshot().reconnectRemainingMs).toBe(12_400);
    vi.advanceTimersByTime(1_400);
    expect(store.getSnapshot().reconnectRemainingMs).toBe(11_000);
    expect(store.getSnapshot().room).toBe(canonical);
    expect(canonical.pauseRemainingMs).toBe(12_400);
  });

  it('maps NO_CONTEST to a Turkish toast and then accepts the lobby room state', () => {
    const { client, store } = createFixture();
    client.emit('session:welcome', successWelcome());
    client.emit('room:state', roomState({ phase: 'MATCH' }));
    client.emit('match:event', {
      eventId: 9, tick: 600, type: 'RESULT', winnerPlayerId: null, reason: 'NO_CONTEST', scores: { 'player-1': 2 }
    });
    client.emit('room:state', roomState());
    expect(store.getSnapshot().screen).toBe('LOBBY');
    expect(store.getSnapshot().toasts.at(-1)).toMatchObject({
      tone: 'warning', message: 'Rakip yeniden bağlanamadığı için maç geçersiz sayıldı.'
    });
  });

  it('keeps real-time input shaping silent during a match', () => {
    const { client, store } = createFixture();
    const rateLimited: ServerError = {
      code: 'RATE_LIMITED', message: 'Çok hızlı istek gönderiyorsunuz.', recoverable: true
    };
    client.emit('session:welcome', successWelcome());
    client.emit('room:state', roomState({ phase: 'MATCH' }));

    client.emit('server:error', rateLimited);

    expect(store.getSnapshot()).toMatchObject({ lastError: null, errorAction: null, toasts: [] });
    client.emit('room:state', roomState({ phase: 'LOBBY' }));
    client.emit('server:error', rateLimited);
    expect(store.getSnapshot().toasts.at(-1)).toMatchObject({
      tone: 'warning', message: 'Çok hızlı istek gönderiyorsunuz.'
    });
  });

  it('streams authoritative snapshots/events and creates a Phaser-free arena bridge', () => {
    const { client, store } = createFixture();
    const bridge = createArenaBridge(store);
    const snapshotListener = vi.fn();
    const eventListener = vi.fn();
    bridge.subscribeSnapshot(snapshotListener);
    bridge.subscribeEvent(eventListener);
    const snapshot = matchSnapshot();
    const event = phaseEvent();
    client.emit('session:welcome', successWelcome());
    client.emit('room:state', roomState({ phase: 'MATCH' }));
    client.emit('match:started', snapshot);
    client.emit('match:event', event);
    bridge.sendInput({ seq: 1, viewTick: 0, moveX: 0, moveY: 0, aimX: 1, aimY: 0, quick: false, heavy: false, dash: false });
    expect(bridge.getSnapshot()).toBe(snapshot);
    expect(snapshotListener).toHaveBeenCalledWith(snapshot);
    expect(eventListener).toHaveBeenCalledWith(event);
    expect(client.sendInput).toHaveBeenCalledOnce();
  });

  it('allocates input sequences monotonically across arena remounts and snapshot catch-up', () => {
    const { store } = createFixture();
    const bridge = createArenaBridge(store);

    expect(bridge.reserveInputSequence(0)).toBe(0);
    expect(bridge.reserveInputSequence(0)).toBe(1);
    expect(bridge.reserveInputSequence(12)).toBe(12);
    expect(bridge.reserveInputSequence(2)).toBe(13);
  });

  it('persists mute and notifies bridge listeners only when that setting changes', () => {
    const { storage, store } = createFixture();
    const bridge = createArenaBridge(store);
    const listener = vi.fn();
    const unsubscribe = bridge.subscribeMuted(listener);
    expect(listener).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenLastCalledWith(false);
    store.actions.toggleSound();
    store.actions.dismissToast(999);
    expect(storage.getItem('neon-relay:muted')).toBe('true');
    expect(listener).toHaveBeenCalledTimes(2);
    expect(listener).toHaveBeenLastCalledWith(true);
    unsubscribe();
    store.actions.toggleSound();
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('exposes current connection and notifies bridge listeners once per connection change until disposal', () => {
    const { client, store } = createFixture();
    const bridge = createArenaBridge(store);
    const listener = vi.fn();

    expect(bridge.isConnected()).toBe(false);
    const unsubscribe = bridge.subscribeConnected(listener);
    expect(listener).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenLastCalledWith(false);

    client.emit('connection', 'connected');
    client.emit('connection', 'connected');
    expect(bridge.isConnected()).toBe(true);
    expect(listener).toHaveBeenCalledTimes(2);
    expect(listener).toHaveBeenLastCalledWith(true);

    client.emit('connection', 'disconnected');
    expect(listener).toHaveBeenCalledTimes(3);
    expect(listener).toHaveBeenLastCalledWith(false);

    unsubscribe();
    unsubscribe();
    client.emit('connection', 'connected');
    expect(listener).toHaveBeenCalledTimes(3);
  });

  it('delivers persisted mute immediately and disposes that subscription idempotently', () => {
    const storage = new MemoryStorage();
    storage.setItem('neon-relay:muted', 'true');
    const { store } = createFixture(new FakeGameClient(), storage);
    const bridge = createArenaBridge(store);
    const listener = vi.fn();

    const unsubscribe = bridge.subscribeMuted(listener);

    expect(listener).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledWith(true);
    unsubscribe();
    unsubscribe();
    store.actions.toggleSound();
    expect(listener).toHaveBeenCalledOnce();
  });

  it('sends result-ready, rematch, and host lobby-return actions without optimistic state', async () => {
    const { client, store } = createFixture();
    const canonical = roomState({
      phase: 'RESULT',
      result: { winnerPlayerId: 'player-1', reason: 'TARGET_SCORE', players: [] }
    });
    client.emit('session:welcome', successWelcome());
    client.emit('room:state', canonical);
    await store.actions.setResultReady(true);
    expect(client.setResultReady).toHaveBeenCalledWith(true);
    expect(store.getSnapshot().room).toBe(canonical);
    client.emit('room:state', canonical);
    await store.actions.startMatch();
    expect(client.startMatch).toHaveBeenCalledOnce();
    client.emit('room:state', canonical);
    await store.actions.returnToLobby();
    expect(client.returnToLobby).toHaveBeenCalledOnce();
  });

  it('disposes every client and public subscription exactly once', () => {
    const { client, store } = createFixture();
    const stateUnsubscribe = store.subscribe(vi.fn());
    const matchUnsubscribe = store.subscribeMatch(vi.fn());
    const eventUnsubscribe = store.subscribeGameEvent(vi.fn());
    stateUnsubscribe(); stateUnsubscribe();
    matchUnsubscribe(); matchUnsubscribe();
    eventUnsubscribe(); eventUnsubscribe();
    store.dispose(); store.dispose();
    expect(client.unsubscribeCalls).toHaveBeenCalledTimes(8);
    expect(client.disconnect).toHaveBeenCalledOnce();
    const before = store.getSnapshot();
    client.emit('server:error', { code: 'ROOM_FULL', message: 'Oda dolu.', recoverable: true } satisfies ServerError);
    expect(store.getSnapshot()).toBe(before);
  });
});

it('forgets a kicked session and suppresses late publications and failed acknowledgements', async () => {
  const { client, store, storage } = createFixture();
  client.emit('session:welcome', successWelcome()); client.emit('room:state', roomState());
  let resolve!: (ack: Ack<null>) => void;
  client.setReady.mockImplementation(() => new Promise(done => { resolve = done; }));
  const pending = store.actions.setReady(true);
  client.emit('room:kicked', { roomCode: 'AB2Z' });
  resolve({ ok: false, error: { code: 'OLD', message: 'old error', recoverable: true } }); await pending;
  client.emit('room:state', roomState()); client.emit('session:welcome', successWelcome());
  client.emit('connection', 'disconnected'); client.emit('connection', 'connected');
  expect(store.getSnapshot()).toMatchObject({ screen: 'LANDING', session: null, room: null, lastError: null });
  expect(storage.getItem('neon-relay:AB2Z:resume')).toBeNull();
  expect(client.resumeSession).not.toHaveBeenCalled();
  expect(store.getSnapshot().toasts.at(-1)?.message).toContain('çıkardı'); store.dispose();
});
