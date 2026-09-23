import { useRef, useState } from 'react';
import type { ClientState } from '../state/gameStore.js';

type TopBarProps = Readonly<{
  state: ClientState;
  onToggleSound: () => void;
  onLeaveRoom: () => Promise<void>;
  onKickPlayer: (playerId: string) => Promise<void>;
}>;

export function TopBar({ state, onToggleSound, onLeaveRoom, onKickPlayer }: TopBarProps) {
  const management = useRef<HTMLDetailsElement>(null);
  const [confirmPlayer, setConfirmPlayer] = useState<string | null>(null);
  const canManage = state.room !== null && state.session?.playerId === state.room.hostPlayerId;
  const removable = state.room?.players.filter(player => !player.botDifficulty && player.playerId !== state.room?.hostPlayerId) ?? [];
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
          import.meta.env.MODE === 'sites' ? 'İNTERNET DENEMESİ' : 'LAN ARENA'
        )}
      </span>

      <div className="top-bar__controls">
        {canManage && removable.length > 0 ? <details className="room-management" ref={management} onKeyDown={event => { if (event.key === 'Escape' && management.current) { management.current.open = false; management.current.querySelector('summary')?.focus(); setConfirmPlayer(null); } }}>
          <summary className="chrome-button focus-ring">Oyuncuları yönet</summary>
          <div className="room-management__panel" aria-label="Oyuncu yönetimi">
            <p>Çıkarılan oyuncunun mevcut oturumu kapanır.</p>
            {removable.map(player => <div className="room-management__player" key={player.playerId}>
              <span className="room-management__identity"><span title={player.name}>{player.name}</span>{player.role === 'SPECTATOR' ? <small>Seyirci</small> : null}</span>
              {confirmPlayer === player.playerId ? <span className="room-management__confirm">
                <button className="chrome-button focus-ring" disabled={state.pendingAction !== null} onClick={() => { void onKickPlayer(player.playerId).then(() => { setConfirmPlayer(null); management.current?.querySelector('summary')?.focus(); }); }}>Çıkarmayı onayla</button>
                <button className="chrome-button focus-ring" onClick={() => setConfirmPlayer(null)}>Vazgeç</button>
              </span> : <button className="chrome-button focus-ring" disabled={state.pendingAction !== null} aria-label={`${player.name} oyuncusunu çıkar`} onClick={() => setConfirmPlayer(player.playerId)}>Çıkar</button>}
            </div>)}
            {state.errorAction === 'kick' && state.lastError ? <p role="alert">{state.lastError.message}</p> : null}
          </div>
        </details> : null}
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
      </div>

      {leaveError ? <p className="top-bar__leave-error" role="alert">{leaveError.message}</p> : null}
    </header>
  );
}
