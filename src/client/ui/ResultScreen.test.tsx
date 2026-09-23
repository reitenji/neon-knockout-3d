import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ResultPlayer, ResultPlayerStatus, RoomPlayer } from '../../shared/model.js';
import { DEFAULT_ROOM_SETTINGS } from '../../shared/roomSettings.js';
import type { ClientState } from '../state/gameStore.js';
import { ResultScreen } from './ResultScreen.js';

function player(overrides: Partial<RoomPlayer> = {}): RoomPlayer {
  return {
    role: 'FIGHTER', botDifficulty: null,
    playerId: 'p-1', name: 'Ada', chassis: 'RIFT', accent: 0, ready: false, connected: true,
    reconnectRemainingMs: null,
    stats: { knockouts: 3, falls: 1, landedHits: 7, completedAttacks: 10 },
    ...overrides
  };
}

function resultPlayer(status: ResultPlayerStatus, overrides: Partial<ResultPlayer> = {}): ResultPlayer {
  return {
    ...player(),
    resultStatus: status,
    ...overrides
  };
}

function resultState(overrides: Partial<ClientState> = {}): ClientState {
  return {
    screen: 'RESULT', connectionState: 'connected',
    room: {
      roomCode: 'AB2Z', phase: 'RESULT', hostPlayerId: 'p-1', pauseRemainingMs: null, chatMessages: [],
      result: {
        winnerPlayerId: 'p-2',
        reason: 'TIME',
        players: [
          resultPlayer('WAITING'),
          resultPlayer('READY', { role: 'FIGHTER', botDifficulty: null, playerId: 'p-2', name: 'Zeynep', chassis: 'BASTION', accent: 1, ready: true, stats: { knockouts: 4, falls: 2, landedHits: 9, completedAttacks: 12 } }),
          resultPlayer('LEFT', { playerId: 'p-3', name: 'Linus', chassis: 'PULSE', accent: 2, connected: false, stats: { knockouts: 3, falls: 1, landedHits: 7, completedAttacks: 20 } }),
          resultPlayer('WAITING', { playerId: 'p-4', name: 'Grace', chassis: 'WRAITH', accent: 3, stats: { knockouts: 3, falls: 1, landedHits: 7, completedAttacks: 14 } })
        ]
      },
      settings: DEFAULT_ROOM_SETTINGS,
      players: [
        player(),
        player({ role: 'FIGHTER', botDifficulty: null, playerId: 'p-2', name: 'Zeynep', chassis: 'BASTION', accent: 1, ready: true, stats: { knockouts: 4, falls: 2, landedHits: 9, completedAttacks: 12 } }),
        player({ playerId: 'p-4', name: 'Grace', chassis: 'WRAITH', accent: 3, stats: { knockouts: 3, falls: 1, landedHits: 7, completedAttacks: 14 } })
      ]
    },
    match: null,
    session: { playerId: 'p-1', roomCode: 'AB2Z', resumeToken: 'a'.repeat(64) },
    pendingAction: null, lastError: null, errorAction: null, copyFeedback: 'idle', toasts: [],
    soundMuted: false, reconnectRemainingMs: null, ...overrides
  };
}
function renderResult(state = resultState(), overrides: Partial<Parameters<typeof ResultScreen>[0]> = {}) {
  const props: Parameters<typeof ResultScreen>[0] = {
    state,
    onSendChat: vi.fn(async () => true),
    onToggleReady: vi.fn(async () => undefined),
    onStart: vi.fn(async () => undefined),
    onReturnToLobby: vi.fn(async () => undefined),
    confirmReturn: vi.fn(() => true),
    ...overrides
  };
  return { ...render(<ResultScreen {...props} />), props };
}

describe('ResultScreen', () => {
  afterEach(cleanup);

  it('shows the canonical winner and ranks by KO, fewer falls, hits, then stable join order', () => {
    renderResult();
    expect(screen.getByRole('heading', { name: 'Zeynep Kazandı' })).toBeVisible();
    const rows = within(screen.getByRole('table', { name: 'Maç sonuçları' })).getAllByRole('row');
    expect(rows[1]).toHaveTextContent('Zeynep');
    expect(rows[2]).toHaveTextContent('Ada');
    expect(rows[3]).toHaveTextContent('Linus');
    expect(rows[4]).toHaveTextContent('Grace');
    expect(rows[1]).toHaveTextContent('75%');
    expect(rows[3]).toHaveTextContent('35%');
    expect(rows[1]).toHaveTextContent('Hazır');
    expect(rows[2]).toHaveTextContent('Bekliyor');
    expect(rows[3]).toHaveTextContent('Ayrıldı');
  });

  it('lets a connected non-host ready again without exposing host controls', () => {
    renderResult(resultState({ room: { ...resultState().room!, hostPlayerId: 'p-2' } }));
    expect(screen.getByRole('button', { name: 'Tekrar Hazır' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Lobiye Dön' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Maçı Başlat' })).toBeNull();
  });

  it('starts a rematch only when every connected player is result-ready', () => {
    const onStart = vi.fn(async () => undefined);
    const allReady = resultState().room!.players.map((candidate) => ({ ...candidate, ready: true }));
    renderResult(resultState({ room: { ...resultState().room!, players: allReady } }), { onStart });
    fireEvent.click(screen.getByRole('button', { name: 'Rövanşı Başlat' }));
    expect(onStart).toHaveBeenCalledOnce();
  });

  it('confirms lobby return only when somebody is rematch-ready', () => {
    const confirmReturn = vi.fn(() => true);
    const onReturnToLobby = vi.fn(async () => undefined);
    const readyPlayers = resultState().room!.players.map((candidate, index) => ({ ...candidate, ready: index === 1 }));
    const view = renderResult(resultState({ room: { ...resultState().room!, players: readyPlayers } }), { confirmReturn, onReturnToLobby });
    fireEvent.click(screen.getByRole('button', { name: 'Lobiye Dön' }));
    expect(confirmReturn).toHaveBeenCalledOnce();
    expect(onReturnToLobby).toHaveBeenCalledOnce();
    view.unmount();
    confirmReturn.mockClear();
    onReturnToLobby.mockClear();
    const noReadyPlayers = resultState().room!.players.map((candidate) => ({ ...candidate, ready: false }));
    renderResult(resultState({ room: { ...resultState().room!, players: noReadyPlayers } }), { confirmReturn, onReturnToLobby });
    fireEvent.click(screen.getByRole('button', { name: 'Lobiye Dön' }));
    expect(confirmReturn).not.toHaveBeenCalled();
    expect(onReturnToLobby).toHaveBeenCalledOnce();
  });
});
