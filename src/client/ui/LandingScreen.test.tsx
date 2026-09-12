import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ClientState } from '../state/gameStore.js';
import { LandingScreen } from './LandingScreen.js';

const landingState: ClientState = {
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

describe('LandingScreen', () => {
  afterEach(cleanup);

  it('submits the raw empty name so store validation can explain why room creation failed', () => {
    const create = vi.fn(async () => undefined);
    render(<LandingScreen state={landingState} onCreateRoom={create} onJoinRoom={async () => undefined} />);

    const createButton = screen.getByRole('button', { name: 'Oda Kur' });
    expect(createButton).toBeEnabled();
    fireEvent.click(createButton);
    expect(create).toHaveBeenCalledWith('');
  });

  it('submits incomplete join values so typed inline validation replaces a silent disabled action', () => {
    const join = vi.fn(async () => undefined);
    render(<LandingScreen state={landingState} onCreateRoom={async () => undefined} onJoinRoom={join} />);

    fireEvent.change(screen.getByLabelText('Oyuncu adı'), { target: { value: 'Ada' } });
    fireEvent.change(screen.getByLabelText('Oda kodu'), { target: { value: 'T' } });
    const joinButton = screen.getByRole('button', { name: 'Odaya Katıl' });
    expect(joinButton).toBeEnabled();
    fireEvent.click(joinButton);
    expect(join).toHaveBeenCalledWith('Ada', 'T');
  });

  it('keeps entered values after a rejected join', async () => {
    const join = vi.fn<(name: string, roomCode: string) => Promise<void>>(async () => undefined);

    function RejectedJoinHarness() {
      const [state, setState] = useState(landingState);
      return (
        <LandingScreen
          state={state}
          onCreateRoom={async () => undefined}
          onJoinRoom={async (name, roomCode) => {
            await join(name, roomCode);
            setState({
              ...state,
              lastError: { code: 'ROOM_NOT_FOUND', message: 'Oda bulunamadı.', recoverable: true },
              errorAction: 'join-room'
            });
          }}
        />
      );
    }

    render(<RejectedJoinHarness />);
    fireEvent.change(screen.getByLabelText('Oyuncu adı'), { target: { value: 'Ada' } });
    fireEvent.change(screen.getByLabelText('Oda kodu'), { target: { value: ' ab2z ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Odaya Katıl' }));

    await waitFor(() => expect(screen.getByText('Oda bulunamadı.')).toBeVisible());
    expect(join).toHaveBeenCalledWith('Ada', 'AB2Z');
    expect(screen.getByLabelText('Oyuncu adı')).toHaveValue('Ada');
    expect(screen.getByLabelText('Oda kodu')).toHaveValue('AB2Z');
  });

  it('keeps action labels stable and exposes a spinner while pending', () => {
    render(
      <LandingScreen
        state={{ ...landingState, pendingAction: 'join-room' }}
        onCreateRoom={async () => undefined}
        onJoinRoom={async () => undefined}
      />
    );

    const joinButton = screen.getByRole('button', { name: 'Odaya Katıl' });
    expect(joinButton).toBeDisabled();
    expect(joinButton).toHaveTextContent('Odaya Katıl');
    expect(joinButton.querySelector('.action-spinner')).not.toBeNull();
  });

  it('shows a rejected reconnect token on the landing screen', () => {
    render(
      <LandingScreen
        state={{
          ...landingState,
          lastError: {
            code: 'INVALID_RESUME_TOKEN',
            message: 'Yeniden bağlanma anahtarı geçersiz veya süresi dolmuş.',
            recoverable: true
          },
          errorAction: 'resume'
        }}
        onCreateRoom={async () => undefined}
        onJoinRoom={async () => undefined}
      />
    );

    expect(screen.getByRole('alert')).toHaveTextContent('Yeniden bağlanma anahtarı geçersiz veya süresi dolmuş.');
  });

  it('uses semantic form controls and the shared visible-focus treatment', () => {
    render(
      <LandingScreen state={landingState} onCreateRoom={async () => undefined} onJoinRoom={async () => undefined} />
    );

    expect(screen.getByRole('heading', { name: 'NEON KNOCKOUT 3D' })).toBeVisible();
    expect(screen.getByLabelText('Oyuncu adı')).toHaveClass('focus-ring');
    expect(screen.getByLabelText('Oda kodu')).toHaveClass('focus-ring');
    expect(screen.getByRole('button', { name: 'Oda Kur' })).toHaveClass('focus-ring');
    expect(screen.getByRole('button', { name: 'Odaya Katıl' })).toHaveClass('focus-ring');
  });

  it('shows only the invited room and player-name entry in invite mode', () => {
    render(
      <LandingScreen
        state={landingState}
        invitedRoomCode="AB2Z"
        onCreateRoom={async () => undefined}
        onJoinRoom={async () => undefined}
        onExitInvite={() => undefined}
      />
    );

    expect(screen.getByText(/oda daveti/i)).toBeVisible();
    expect(screen.getByText(/AB2Z/)).toBeVisible();
    expect(screen.getByLabelText('Oyuncu adı')).toBeVisible();
    expect(screen.queryByLabelText('Oda kodu')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Oda Kur' })).not.toBeInTheDocument();
  });

  it('joins the invited room with the entered player name', () => {
    const join = vi.fn(async () => undefined);
    render(
      <LandingScreen
        state={landingState}
        invitedRoomCode="AB2Z"
        onCreateRoom={async () => undefined}
        onJoinRoom={join}
        onExitInvite={() => undefined}
      />
    );

    fireEvent.change(screen.getByLabelText('Oyuncu adı'), { target: { value: 'Ada' } });
    fireEvent.click(screen.getByRole('button', { name: 'Odaya Katıl' }));

    expect(join).toHaveBeenCalledWith('Ada', 'AB2Z');
  });

  it('exits invite mode from the landing screen', () => {
    const exitInvite = vi.fn();
    render(
      <LandingScreen
        state={landingState}
        invitedRoomCode="AB2Z"
        onCreateRoom={async () => undefined}
        onJoinRoom={async () => undefined}
        onExitInvite={exitInvite}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Ana sayfaya dön' }));

    expect(exitInvite).toHaveBeenCalledOnce();
  });
});
