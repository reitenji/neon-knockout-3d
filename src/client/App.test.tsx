import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NeonGameFactory } from './game/GamePresentationBridge.js';
import type { ClientState, GameStore } from './state/gameStore.js';
import type { MatchPlayer, MatchSnapshot } from '../shared/model.js';
import { DEFAULT_ROOM_SETTINGS } from '../shared/roomSettings.js';
import { App } from './App.js';
import {
  INVITE_DISMISSED_HISTORY_STATE,
  resumeRoomPreferenceFromLocation
} from './inviteRoute.js';

const gameFactory = vi.fn<NeonGameFactory>(() => ({ destroy() {} }));

function storeFor(state: ClientState): GameStore {
  return {
    getSnapshot: () => state,
    getLatestMatch: () => state.match,
    subscribe: () => () => undefined,
    subscribeMatch: () => () => undefined,
    subscribeGameEvent: () => () => undefined,
    sendInput: vi.fn(),
    dispose: vi.fn(),
    actions: {
      connect: vi.fn(),
      createRoom: vi.fn(async () => undefined),
      joinRoom: vi.fn(async () => undefined),
      setRole: vi.fn(async () => undefined),
      addBot: vi.fn(async () => undefined),
      updateBot: vi.fn(async () => undefined),
      sendChat: vi.fn(async () => true),
      kickPlayer: vi.fn(async () => undefined),
      removeBot: vi.fn(async () => undefined),
      setChassis: vi.fn(async () => undefined),
      setReady: vi.fn(async () => undefined),
      setRoomSettings: vi.fn(async () => undefined),
      leaveRoom: vi.fn(async () => undefined),
      startMatch: vi.fn(async () => undefined),
      setResultReady: vi.fn(async () => undefined),
      returnToLobby: vi.fn(async () => undefined),
      copyRoomCode: vi.fn(async () => undefined),
      toggleSound: vi.fn(),
      dismissToast: vi.fn()
    }
  };
}

const landing: ClientState = {
  screen: 'LANDING',
  connectionState: 'connected',
  room: null,
  match: null,
  session: null,
  pendingAction: null,
  lastError: null,
  errorAction: null,
  copyFeedback: 'idle',
  toasts: [],
  soundMuted: false,
  reconnectRemainingMs: null
};

function matchPlayer(): MatchPlayer {
  return {
    playerId: 'p-local', name: 'Ada', chassis: 'RIFT', accent: 0,
    position: { x: 640, y: 360 }, velocity: { x: 0, y: 0 }, facing: { x: 1, y: 0 },
    overload: 0, lastProcessedInputSeq: 0,
    action: {
      kind: null, phase: 'IDLE', comboStep: 0, chargeMs: 0, charging: false,
      attackId: null, profileId: null, lockedFacing: null, activeProgress: 0, hitTargetIds: []
    },
    dashRemainingMs: 0, dashCooldownRemainingMs: 0, hitstunRemainingMs: 0,
    respawnRemainingMs: 0, protectionRemainingMs: 0,
    stats: { knockouts: 0, falls: 0, landedHits: 0, completedAttacks: 0 }
  };
}

function matchSnapshot(): MatchSnapshot {
  return {
    tick: 180, phase: 'REGULATION', remainingMs: 120_000, platformProgress: 0,
    settings: DEFAULT_ROOM_SETTINGS,
    scores: { 'p-local': 0 },
    network: { 'p-local': { currentMs: null, medianMs: null, jitterMs: null, transport: 'websocket' } },
    players: [matchPlayer()], pulses: [], winnerPlayerId: null, resultReason: null
  };
}

function setViewport(width: number, height: number): void {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: height });
}

function setTouchPoints(count: number): void {
  Object.defineProperty(navigator, 'maxTouchPoints', { configurable: true, value: count });
}

describe('App', () => {
  afterEach(() => {
    cleanup();
    window.history.replaceState(null, '', '/');
    setViewport(1024, 768);
    setTouchPoints(0);
    gameFactory.mockClear();
    vi.restoreAllMocks();
  });

  it('turns a room deep link into a name-only invitation and can return to the home route', () => {
    window.history.replaceState(null, '', '/room/ab2z');
    render(<App store={storeFor(landing)} />);

    expect(screen.getByText(/AB2Z/)).toBeVisible();
    expect(screen.queryByLabelText('Oda kodu')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Oda Kur' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Ana sayfaya dön' }));

    expect(window.location.pathname).toBe('/');
    expect(resumeRoomPreferenceFromLocation(window.location.pathname, window.history.state)).toBeNull();
    expect(screen.getByRole('button', { name: 'Oda Kur' })).toBeVisible();
  });

  it('clears invite-dismissal suppression after a fresh room session is accepted', () => {
    window.history.replaceState(INVITE_DISMISSED_HISTORY_STATE, '', '/');
    render(<App store={storeFor({
      ...landing,
      session: { playerId: 'p-new', roomCode: 'CD3X', resumeToken: 'token' }
    })} />);

    expect(window.history.state).toBeNull();
    expect(resumeRoomPreferenceFromLocation(window.location.pathname, window.history.state)).toBeUndefined();
  });

  it('keeps the complete landing flow available on a portrait phone', () => {
    setTouchPoints(5);
    setViewport(390, 844);
    render(<App store={storeFor(landing)} />);

    expect(screen.getByRole('heading', { name: 'NEON KNOCKOUT 3D' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Oda Kur' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Odaya Katıl' })).toBeVisible();
    expect(screen.queryByRole('dialog', { name: 'Telefonu yatay çevir' })).toBeNull();
  });

  it('keeps the match mounted under a portrait rotate prompt, then clears it in landscape', () => {
    setTouchPoints(5);
    setViewport(390, 844);
    const addListener = vi.spyOn(window, 'addEventListener');
    const removeListener = vi.spyOn(window, 'removeEventListener');
    const matchStore = storeFor({
      ...landing,
      screen: 'MATCH',
      match: matchSnapshot(),
      session: { playerId: 'p-local', roomCode: 'AB2Z', resumeToken: 'token' }
    });
    const view = render(<App store={matchStore} gameFactory={gameFactory} />);
    const resizeRegistration = addListener.mock.calls.find(([event]) => event === 'resize');

    expect(resizeRegistration).toBeDefined();
    expect(screen.getByRole('dialog', { name: 'Telefonu yatay çevir' })).toBeVisible();
    expect(screen.getByLabelText('Neon Knockout oyun alanı')).toBeInTheDocument();
    expect(gameFactory).toHaveBeenCalledOnce();

    setViewport(844, 390);
    act(() => window.dispatchEvent(new Event('resize')));
    expect(screen.queryByRole('dialog', { name: 'Telefonu yatay çevir' })).toBeNull();
    expect(gameFactory).toHaveBeenCalledOnce();

    view.unmount();
    expect(removeListener).toHaveBeenCalledWith('resize', resizeRegistration?.[1]);
  });

  it('connects the store, renders the landing flow, and disposes on unmount', () => {
    const store = storeFor(landing);
    const view = render(<App store={store} />);

    expect(store.actions.connect).toHaveBeenCalledOnce();
    expect(screen.getByRole('heading', { name: 'NEON KNOCKOUT 3D' })).toBeVisible();
    expect(screen.getByText('Bağlı')).toBeVisible();

    view.unmount();
    expect(store.dispose).toHaveBeenCalledOnce();
  });

  it('keeps match content visible when the transport is connected', () => {
    const matchStore = storeFor({
      ...landing,
      screen: 'MATCH',
      match: matchSnapshot(),
      session: { playerId: 'p-local', roomCode: 'AB2Z', resumeToken: 'token' }
    });
    render(<App store={matchStore} gameFactory={gameFactory} />);

    expect(screen.getByLabelText('Neon Knockout oyun alanı')).toBeVisible();
    expect(screen.getByRole('complementary', { name: 'Maç bilgileri' })).toBeVisible();
    expect(screen.getByLabelText('Kontroller')).toHaveTextContent('K');
    expect(screen.getByLabelText('Kontroller')).not.toHaveTextContent(/oklar|shift/i);
    expect(gameFactory).toHaveBeenCalledOnce();
    expect(screen.queryByRole('dialog', { name: 'Bağlantı kesildi' })).toBeNull();
  });

  it('keeps the match mounted under a reconnect overlay and retries through the store', () => {
    const store = storeFor({ ...landing, screen: 'MATCH', connectionState: 'disconnected', reconnectRemainingMs: 12_400 });
    render(<App store={store} gameFactory={gameFactory} />);

    expect(screen.getByRole('dialog', { name: 'Bağlantı kesildi' })).toHaveTextContent('13 saniye');
    screen.getByRole('button', { name: 'Yeniden Dene' }).click();
    expect(store.actions.connect).toHaveBeenCalledTimes(2);
  });

  it('keeps the match mounted while an authoritative opponent reservation counts down', () => {
    const store = storeFor({ ...landing, screen: 'MATCH', reconnectRemainingMs: 8_100 });
    render(<App store={store} gameFactory={gameFactory} />);

    expect(screen.getByRole('main').firstElementChild).not.toBeNull();
    expect(screen.getByRole('dialog', { name: 'Rakip bekleniyor' })).toHaveTextContent('9 saniye');
  });

  it('renders canonical results and wires result-ready, rematch, and lobby return', () => {
    const store = storeFor({
      ...landing,
      screen: 'RESULT',
      room: {
        roomCode: 'AB2Z', phase: 'RESULT', hostPlayerId: 'p-1', pauseRemainingMs: null, chatMessages: [],
        result: {
          winnerPlayerId: 'p-1',
          reason: 'TARGET_SCORE',
          players: [{
            role: 'FIGHTER', botDifficulty: null,
            playerId: 'p-1', name: 'Ada', chassis: 'RIFT', accent: 0, ready: false, connected: true,
            reconnectRemainingMs: null, resultStatus: 'WAITING',
            stats: { knockouts: 5, falls: 1, landedHits: 8, completedAttacks: 10 }
          }]
        },
        settings: DEFAULT_ROOM_SETTINGS,
        players: [{
          role: 'FIGHTER', botDifficulty: null,
          playerId: 'p-1', name: 'Ada', chassis: 'RIFT', accent: 0, ready: false, connected: true,
          reconnectRemainingMs: null, stats: { knockouts: 5, falls: 1, landedHits: 8, completedAttacks: 10 }
        }]
      },
      session: { playerId: 'p-1', roomCode: 'AB2Z', resumeToken: 'token' }
    });
    render(<App store={store} />);
    expect(screen.getByRole('heading', { name: 'Ada Kazandı' })).toBeVisible();
    screen.getByRole('button', { name: 'Tekrar Hazır' }).click();
    expect(store.actions.setResultReady).toHaveBeenCalledWith(true);
  });

  it('wires room settings and the single global leave room action through the store', () => {
    const store = storeFor({
      ...landing,
      screen: 'LOBBY',
      room: {
        roomCode: 'AB2Z', phase: 'LOBBY', hostPlayerId: 'p-1', pauseRemainingMs: null, chatMessages: [], result: null,
        settings: DEFAULT_ROOM_SETTINGS,
        players: [{
          role: 'FIGHTER', botDifficulty: null,
          playerId: 'p-1', name: 'Ada', chassis: 'RIFT', accent: 0, ready: false, connected: true,
          reconnectRemainingMs: null, stats: { knockouts: 0, falls: 0, landedHits: 0, completedAttacks: 0 }
        }]
      },
      session: { playerId: 'p-1', roomCode: 'AB2Z', resumeToken: 'token' }
    });
    render(<App store={store} />);

    fireEvent.change(screen.getByRole('combobox', { name: 'Kazanma hedefi' }), { target: { value: '7' } });
    expect(store.actions.setRoomSettings).toHaveBeenCalledWith({ durationMs: 120_000, knockoutTarget: 7 });
    expect(screen.getAllByRole('button', { name: 'Odadan Çık' })).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Odadan Çık' }));
    expect(store.actions.leaveRoom).toHaveBeenCalledOnce();
  });

  it('clears an invite route after the player leaves the room successfully', async () => {
    window.history.replaceState(null, '', '/room/AB2Z');
    let currentState: ClientState = {
      ...landing,
      screen: 'LOBBY',
      room: {
        roomCode: 'AB2Z', phase: 'LOBBY', hostPlayerId: 'p-1', pauseRemainingMs: null, chatMessages: [], result: null,
        settings: DEFAULT_ROOM_SETTINGS,
        players: [{
          role: 'FIGHTER', botDifficulty: null,
          playerId: 'p-1', name: 'Ada', chassis: 'RIFT', accent: 0, ready: false, connected: true,
          reconnectRemainingMs: null, stats: { knockouts: 0, falls: 0, landedHits: 0, completedAttacks: 0 }
        }]
      },
      session: { playerId: 'p-1', roomCode: 'AB2Z', resumeToken: 'token' }
    };
    const store = storeFor(currentState);
    store.getSnapshot = () => currentState;
    store.actions.leaveRoom = vi.fn(async () => {
      currentState = landing;
    });
    render(<App store={store} />);

    fireEvent.click(screen.getByRole('button', { name: 'Odadan Çık' }));

    await vi.waitFor(() => expect(window.location.pathname).toBe('/'));
    expect(store.actions.leaveRoom).toHaveBeenCalledOnce();
  });
});
