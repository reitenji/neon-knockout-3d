import { CharacterPreview } from '../game/three/CharacterPreview.js';
import { CHASSIS, type Chassis, type RoomPlayer } from '../../shared/model.js';
import { ACCENTS } from '../../shared/constants.js';
import {
  KNOCKOUT_TARGET_OPTIONS,
  MATCH_DURATION_OPTIONS,
  type KnockoutTarget,
  type MatchDurationMs,
  type RoomSettings
} from '../../shared/roomSettings.js';
import { selectCanStart, selectSelfPlayer, type ClientState } from '../state/gameStore.js';
import { LanSharePanel } from './LanSharePanel.js';

type LobbyScreenProps = Readonly<{
  state: ClientState;
  onSetChassis: (chassis: Chassis) => Promise<void>;
  onToggleReady: (ready: boolean) => Promise<void>;
  onSetRoomSettings: (settings: RoomSettings) => Promise<void>;
  onStart: () => Promise<void>;
  onCopyRoomCode: () => Promise<void>;
}>;

function ActionMark({ pending, idle }: Readonly<{ pending: boolean; idle: string }>) {
  return pending ? <span className="action-spinner" aria-hidden="true" /> : <span aria-hidden="true">{idle}</span>;
}

function ChassisSilhouette({ chassis }: Readonly<{ chassis: Chassis }>) {
  const path = {
    RIFT: 'M8 2h8l3 5-4 3 3 10H6l3-10-4-3z',
    BASTION: 'M4 4l5-2h6l5 2-2 7v9H6v-9z',
    PULSE: 'M12 2l8 6-5 2 3 10H6l3-10-5-2z',
    WRAITH: 'M6 3l6-2 6 2 3 7-5 10H8L3 10zm6 4-3 4 3 4 3-4z'
  }[chassis];
  return (
    <svg className="chassis-silhouette" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d={path} />
    </svg>
  );
}

function PlayerRow({ player, hostPlayerId }: Readonly<{ player: RoomPlayer; hostPlayerId: string }>) {
  const status = player.connected ? (player.ready ? 'Hazır' : 'Bekliyor') : 'Bağlantı bekleniyor';
  const statusClass = !player.connected ? 'is-disconnected' : player.ready ? 'is-ready' : 'is-waiting';
  return (
    <li className={`player-row ${statusClass}`}>
      <span className="player-row__identity">
        <span className="player-accent" style={{ backgroundColor: ACCENTS[player.accent] }} aria-hidden="true" />
        <strong>{player.name}</strong>
        {player.playerId === hostPlayerId ? <span className="host-crown" role="img" aria-label="Oda sahibi">♛</span> : null}
      </span>
      <span className="player-row__chassis">{player.chassis}</span>
      <span className="player-row__status"><span className="status-light" aria-hidden="true" />{status}</span>
    </li>
  );
}

export function LobbyScreen({
  state,
  onSetChassis,
  onToggleReady,
  onSetRoomSettings,
  onStart,
  onCopyRoomCode
}: LobbyScreenProps) {
  if (!state.room) return null;
  const { room } = state;
  const selfPlayer = selectSelfPlayer(state);
  const isHost = selfPlayer?.playerId === room.hostPlayerId;
  const anyPending = state.pendingAction !== null;
  const lobbyError = ['chassis', 'ready', 'settings', 'start'].includes(state.errorAction ?? '')
    ? state.lastError
    : null;

  const updateDuration = (durationMs: MatchDurationMs): void => {
    void onSetRoomSettings({ durationMs, knockoutTarget: room.settings.knockoutTarget });
  };

  const updateKnockoutTarget = (knockoutTarget: KnockoutTarget): void => {
    void onSetRoomSettings({ durationMs: room.settings.durationMs, knockoutTarget });
  };

  return (
    <section className="screen screen--lobby" aria-label="Oda lobisi">
      <div className="lobby-frame tech-frame">
        <header className={`lobby-room${isHost ? ' lobby-room--with-share' : ''}`}>
          <div className="lobby-room__primary">
            <span className="eyebrow">ODA</span>
            <strong className="room-code" data-testid="room-code">{room.roomCode}</strong>
            <button className="chrome-button copy-button focus-ring" type="button" aria-label="Kodu Kopyala" onClick={() => void onCopyRoomCode()}>
              <span>Kodu Kopyala</span>
              <span className={`copy-button__mark is-${state.copyFeedback}`} aria-hidden="true">
                {state.copyFeedback === 'copied' ? '✓' : state.copyFeedback === 'failed' ? '!' : '⧉'}
              </span>
            </button>
          </div>
          {isHost ? <LanSharePanel roomCode={room.roomCode} /> : null}
        </header>

        <CharacterPreview selected={selfPlayer?.chassis ?? 'RIFT'} />

        <fieldset className="chassis-picker" disabled={!selfPlayer || anyPending}>
          <legend>Gövdeni seç</legend>
          <div className="chassis-picker__options">
            {CHASSIS.map((chassis) => {
              const selected = selfPlayer?.chassis === chassis;
              return (
                <button
                  key={chassis}
                  className={`chassis-option focus-ring${selected ? ' is-selected' : ''}`}
                  type="button"
                  aria-label={`${chassis} gövdesini seç`}
                  aria-pressed={selected}
                  disabled={!selfPlayer || anyPending || selected}
                  onClick={() => void onSetChassis(chassis)}
                >
                  <ChassisSilhouette chassis={chassis} />
                  <span>{chassis}</span>
                </button>
              );
            })}
          </div>
        </fieldset>

        <fieldset
          className="room-settings"
          disabled={!selfPlayer || !isHost || anyPending}
          aria-busy={state.pendingAction === 'settings'}
        >
          <legend>Oda Ayarları</legend>
          <div className="room-settings__controls">
            <label className="room-settings__field">
              <span>Maç süresi</span>
              <select
                className="focus-ring"
                value={room.settings.durationMs}
                onChange={(event) => updateDuration(Number(event.currentTarget.value) as MatchDurationMs)}
              >
                {MATCH_DURATION_OPTIONS.map((durationMs) => (
                  <option key={durationMs} value={durationMs}>
                    {durationMs === 90_000 ? '90 sn' : durationMs === 120_000 ? '2 dk' : '3 dk'}
                  </option>
                ))}
              </select>
            </label>
            <label className="room-settings__field">
              <span>Kazanma hedefi</span>
              <select
                className="focus-ring"
                value={room.settings.knockoutTarget}
                onChange={(event) => updateKnockoutTarget(Number(event.currentTarget.value) as KnockoutTarget)}
              >
                {KNOCKOUT_TARGET_OPTIONS.map((knockoutTarget) => (
                  <option key={knockoutTarget} value={knockoutTarget}>
                    {knockoutTarget} knockout
                  </option>
                ))}
              </select>
            </label>
          </div>
        </fieldset>

        <ul className="player-list player-list--ffa" aria-label="Oyuncular">
          {room.players.map((candidate) => <PlayerRow key={candidate.playerId} player={candidate} hostPlayerId={room.hostPlayerId} />)}
        </ul>

        <div className="lobby-feedback">
          {lobbyError ? <p className="inline-error" role="alert">{lobbyError.message}</p> : null}
        </div>

        <footer className="lobby-actions">
          {selfPlayer ? (
            <button
              className="command-button command-button--cyan focus-ring"
              type="button"
              disabled={anyPending}
              aria-busy={state.pendingAction === 'ready'}
              onClick={() => void onToggleReady(!selfPlayer.ready)}
            >
              <span>{selfPlayer.ready ? 'Hazır Değilim' : 'Hazırım'}</span>
              <ActionMark pending={state.pendingAction === 'ready'} idle={selfPlayer.ready ? '×' : '✓'} />
            </button>
          ) : null}
          {isHost ? (
            <button
              className="command-button command-button--amber focus-ring"
              type="button"
              disabled={!selectCanStart(state) || anyPending}
              aria-busy={state.pendingAction === 'start'}
              onClick={() => void onStart()}
            >
              <span>Maçı Başlat</span>
              <ActionMark pending={state.pendingAction === 'start'} idle="→" />
            </button>
          ) : null}
        </footer>
      </div>
    </section>
  );
}
