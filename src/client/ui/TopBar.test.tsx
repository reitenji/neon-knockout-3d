import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RoomPhase, RoomState } from '../../shared/model.js';
import { DEFAULT_ROOM_SETTINGS } from '../../shared/roomSettings.js';
import type { ClientState } from '../state/gameStore.js';
import { TopBar } from './TopBar.js';

function state(overrides: Partial<ClientState> = {}): ClientState {
  return {
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
    reconnectRemainingMs: null,
    ...overrides
  };
}

function room(phase: RoomPhase): RoomState {
  return {
    roomCode: 'AB2Z',
    phase,
    hostPlayerId: 'p-1',
    pauseRemainingMs: null, chatMessages: [],
    result: phase === 'RESULT' ? { winnerPlayerId: 'p-1', reason: 'TIME', players: [] } : null,
    settings: DEFAULT_ROOM_SETTINGS,
    players: []
  };
}

const session = { playerId: 'p-1', roomCode: 'AB2Z', resumeToken: 'a'.repeat(64) } as const;

describe('TopBar', () => {
  afterEach(cleanup);

  it.each([
    ['LOBBY', 'LOBBY'],
    ['MATCH', 'MATCH'],
    ['RESULT', 'RESULT']
  ] as const)('shows exactly one leave room action on the %s screen', (screenName, roomPhase) => {
    render(
      <TopBar
        state={state({ screen: screenName, room: room(roomPhase), session })}
        onKickPlayer={vi.fn(async () => undefined)}
        onToggleSound={vi.fn()}
        onLeaveRoom={vi.fn(async () => undefined)}
      />
    );

    expect(screen.getAllByRole('button', { name: 'Odadan Çık' })).toHaveLength(1);
    expect(screen.getByText('AB2Z')).toBeVisible();
  });

  it('calls the leave room action exactly once per click', () => {
    const onLeaveRoom = vi.fn(async () => undefined);
    const onToggleSound = vi.fn();
    render(
      <TopBar
        state={state({ screen: 'LOBBY', room: room('LOBBY'), session })}
        onKickPlayer={vi.fn(async () => undefined)}
        onToggleSound={onToggleSound}
        onLeaveRoom={onLeaveRoom}
      />
    );

    expect(screen.getByText('AB2Z')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Odadan Çık' }));
    expect(onLeaveRoom).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button', { name: 'Ses açık' }));
    expect(onToggleSound).toHaveBeenCalledOnce();
  });

  it.each([
    ['settings', 'false'],
    ['leave-room', 'true']
  ] as const)('disables leave room while %s is pending', (pendingAction, ariaBusy) => {
    const onLeaveRoom = vi.fn(async () => undefined);
    render(
      <TopBar
        state={state({ screen: 'LOBBY', room: room('LOBBY'), session, pendingAction })}
        onKickPlayer={vi.fn(async () => undefined)}
        onToggleSound={vi.fn()}
        onLeaveRoom={onLeaveRoom}
      />
    );

    const leave = screen.getByRole('button', { name: 'Odadan Çık' });
    expect(leave).toBeDisabled();
    expect(leave).toHaveAttribute('aria-busy', ariaBusy);
    fireEvent.click(leave);
    expect(onLeaveRoom).not.toHaveBeenCalled();
  });

  it('shows a recoverable leave room failure beside the global action', () => {
    render(
      <TopBar
        state={state({
          screen: 'LOBBY',
          room: room('LOBBY'),
          session,
          lastError: { code: 'ROOM_LEAVE_FAILED', message: 'Odadan çıkılamadı. Tekrar dene.', recoverable: true },
          errorAction: 'leave-room'
        })}
        onKickPlayer={vi.fn(async () => undefined)}
        onToggleSound={vi.fn()}
        onLeaveRoom={vi.fn(async () => undefined)}
      />
    );

    expect(screen.getByRole('alert')).toHaveTextContent('Odadan çıkılamadı. Tekrar dene.');
    expect(screen.getByRole('button', { name: 'Odadan Çık' })).toBeEnabled();
  });

  it('hides leave room on landing and when either room identity is missing', () => {
    const renderTopBar = (clientState: ClientState) => render(
      <TopBar onKickPlayer={vi.fn(async () => undefined)} state={clientState} onToggleSound={vi.fn()} onLeaveRoom={vi.fn(async () => undefined)} />
    );

    const view = renderTopBar(state({ screen: 'LANDING', room: room('LOBBY'), session }));
    expect(screen.queryByRole('button', { name: 'Odadan Çık' })).toBeNull();
    view.unmount();
    renderTopBar(state({ screen: 'LOBBY', room: room('LOBBY'), session: null }));
    expect(screen.queryByRole('button', { name: 'Odadan Çık' })).toBeNull();
    cleanup();
    renderTopBar(state({ screen: 'LOBBY', room: null, session }));
    expect(screen.queryByRole('button', { name: 'Odadan Çık' })).toBeNull();
  });
});
