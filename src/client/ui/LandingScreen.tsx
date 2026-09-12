import { useState, type FormEvent } from 'react';
import type { PlayerRole } from '../../shared/model.js';
import type { ClientState } from '../state/gameStore.js';

type LandingScreenProps = Readonly<{
  state: ClientState;
  invitedRoomCode?: string | null;
  onCreateRoom: (name: string) => Promise<void>;
  onJoinRoom: (name: string, roomCode: string, role?: PlayerRole) => Promise<void>;
  onExitInvite?: () => void;
}>;

function ActionMark({ pending, idle }: Readonly<{ pending: boolean; idle: string }>) {
  return pending ? <span className="action-spinner" aria-hidden="true" /> : <span aria-hidden="true">{idle}</span>;
}

function networkMessage(): string {
  if (import.meta.env.MODE === 'sites') return 'İnternet bağlantısı denemesi: farklı ağlardan katılabilirsiniz; her ağda çalışmayabilir. Odayı kuran kişinin sekmesi kapanırsa maç biter.';
  const loopbackHosts = new Set(['localhost', '127.0.0.1']);
  if (loopbackHosts.has(window.location.hostname)) {
    return 'Misafirler localhost yerine bu bilgisayarın LAN adresini açmalı; localhost sadece bu cihazda çalışır.';
  }
  return `Ağ adresi: ${window.location.origin}`;
}

export function LandingScreen({
  state,
  invitedRoomCode = null,
  onCreateRoom,
  onJoinRoom,
  onExitInvite
}: LandingScreenProps) {
  const [playerName, setPlayerName] = useState('');
  const [role, setRole] = useState<PlayerRole>('FIGHTER');
  const [roomCode, setRoomCode] = useState('');
  const anyPending = state.pendingAction !== null;
  const createPending = state.pendingAction === 'create-room';
  const joinPending = state.pendingAction === 'join-room';
  const inlineError =
    state.errorAction === 'create-room' || state.errorAction === 'join-room' || state.errorAction === 'resume'
      ? state.lastError
      : null;

  const inviteMode = invitedRoomCode !== null;

  const submitPrimary = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (anyPending) return;
    if (invitedRoomCode) void (role === 'SPECTATOR' ? onJoinRoom(playerName, invitedRoomCode, role) : onJoinRoom(playerName, invitedRoomCode));
    else void onCreateRoom(playerName);
  };

  const submitJoin = (): void => {
    if (anyPending) return;
    void (role === 'SPECTATOR' ? onJoinRoom(playerName, roomCode, role) : onJoinRoom(playerName, roomCode));
  };

  return (
    <section className="screen screen--landing" aria-labelledby="landing-title">
      <div className="landing-frame tech-frame">
        <div className="landing-frame__energy" aria-hidden="true">
          <span />
        </div>

        <div className="landing-heading">
          <p className="eyebrow">{import.meta.env.MODE === 'sites' ? 'İNTERNET DENEMESİ' : 'LAN ARENA'}</p>
          <h1 id="landing-title">NEON KNOCKOUT <span className="title-3d">3D</span></h1>
        </div>

        <form
          className={`landing-form${inviteMode ? ' landing-form--invite' : ''}`}
          onSubmit={submitPrimary}
          noValidate
        >
          {inviteMode ? (
            <div className="landing-invite" aria-label={`${invitedRoomCode} oda daveti`}>
              <span>Oda daveti</span>
              <strong>{invitedRoomCode}</strong>
              <small>Adını gir, oyuncu veya seyirci olarak katıl.</small>
            </div>
          ) : null}

          <label className="field field--cyan">
            <span>Oyuncu adı</span>
            <input
              className="focus-ring"
              value={playerName}
              onChange={(event) => setPlayerName(event.target.value)}
              placeholder="Adın"
              autoComplete="nickname"
              maxLength={32}
              aria-invalid={inlineError?.code === 'INVALID_NAME'}
              aria-describedby={inlineError ? 'landing-error' : undefined}
            />
          </label>

          {!inviteMode ? (
            <>
              <button
                className="command-button command-button--cyan focus-ring"
                type="submit"
                disabled={anyPending}
                aria-busy={createPending}
              >
                <span>Oda Kur</span>
                <ActionMark pending={createPending} idle="+" />
              </button>

              <div className="landing-divider" aria-hidden="true" />

              <label className="field field--amber">
                <span>Oda kodu</span>
                <input
                  className="focus-ring room-code-input"
                  value={roomCode}
                  onChange={(event) => setRoomCode(event.target.value.normalize('NFKC').trim().toUpperCase().slice(0, 4))}
                  inputMode="text"
                  autoComplete="off"
                  maxLength={4}
                  aria-invalid={inlineError?.code === 'INVALID_ROOM_CODE' || inlineError?.code === 'ROOM_NOT_FOUND'}
                  aria-describedby={inlineError ? 'landing-error' : undefined}
                />
              </label>
            </>
          ) : null}

          <label className="room-settings__field landing-role">
            <span>Katılma biçimi</span>
            <select className="focus-ring" value={role} disabled={anyPending} onChange={(event) => setRole(event.currentTarget.value as PlayerRole)}>
              <option value="FIGHTER">Oyuncu</option>
              <option value="SPECTATOR">Seyirci</option>
            </select>
          </label>

          <button
            className="command-button command-button--amber focus-ring"
            type={inviteMode ? 'submit' : 'button'}
            disabled={anyPending}
            aria-busy={joinPending}
            onClick={inviteMode ? undefined : submitJoin}
          >
            <span>Odaya Katıl</span>
            <ActionMark pending={joinPending} idle="→" />
          </button>

          <div className="landing-feedback">
            {inlineError ? (
              <p className="inline-error" id="landing-error" role="alert">
                {inlineError.message}
              </p>
            ) : null}
            {inlineError?.code === 'ACK_TIMEOUT' ? (
              <p className="landing-network landing-network--warning">
                Aynı Wi-Fi, guest/AP isolation kapalı olması ve tarayıcının yerel ağ izni kontrol edilmeli.
              </p>
            ) : null}
          </div>

          {inviteMode ? (
            <button
              className="landing-invite-exit focus-ring"
              type="button"
              disabled={anyPending}
              onClick={onExitInvite}
            >
              Ana sayfaya dön
            </button>
          ) : null}
        </form>

        <p className="landing-network" data-testid="network-origin">{networkMessage()}</p>
        <p className="landing-tagline">{import.meta.env.MODE === 'sites' ? 'Oda kodunu paylaş, doğrudan bağlantıyı dene' : 'Aynı ağdaki arkadaşlarınla oyna'}</p>
      </div>
    </section>
  );
}
