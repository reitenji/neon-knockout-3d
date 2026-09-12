import type { ClientState } from '../state/gameStore.js';

type TopBarProps = Readonly<{
  state: ClientState;
  onToggleSound: () => void;
  onLeaveRoom: () => Promise<void>;
}>;

export function TopBar({ state, onToggleSound, onLeaveRoom }: TopBarProps) {
  const connected = state.connectionState === 'connected';
  const canLeaveRoom = state.screen !== 'LANDING' && state.room !== null && state.session !== null;
  const leavePending = state.pendingAction === 'leave-room';
  const leaveError = state.errorAction === 'leave-room' ? state.lastError : null;

  return (
    <header className="top-bar">
      <span className="top-bar__mark">NEON <strong>KNOCKOUT 3D</strong></span>

      <span className="top-bar__context">
        {state.room ? (
          <>
            <span>ODA</span>
            <strong>{state.room.roomCode}</strong>
          </>
        ) : (
          'LAN ARENA'
        )}
      </span>

      <span className="top-bar__controls">
        {canLeaveRoom ? (
          <button
            className="chrome-button top-bar__leave focus-ring"
            type="button"
            disabled={state.pendingAction !== null}
            aria-busy={leavePending}
            onClick={() => void onLeaveRoom()}
          >
            Odadan Çık
          </button>
        ) : null}
        <span className={`connection-state ${connected ? 'is-connected' : 'is-connecting'}`} role="status">
          <span className="status-light" aria-hidden="true" />
          {connected ? 'Bağlı' : 'Bağlantı kuruluyor'}
        </span>
        <button
          className="sound-button focus-ring"
          type="button"
          aria-pressed={!state.soundMuted}
          onClick={onToggleSound}
        >
          <span aria-hidden="true">{state.soundMuted ? '◖' : '◕'}</span>
          {state.soundMuted ? 'Ses kapalı' : 'Ses açık'}
        </button>
      </span>

      {leaveError ? <p className="top-bar__leave-error" role="alert">{leaveError.message}</p> : null}
    </header>
  );
}
