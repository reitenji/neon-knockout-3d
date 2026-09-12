import { useState } from 'react';
import { CharacterPreview } from '../game/three/CharacterPreview.js';
import { CHASSIS, type BotDifficulty, type PlayerRole, type Chassis, type RoomPlayer } from '../../shared/model.js';
import { ACCENTS, GAME } from '../../shared/constants.js';
import {
  KNOCKOUT_TARGET_OPTIONS,
  MATCH_DURATION_OPTIONS,
  type KnockoutTarget,
  type MatchDurationMs,
  type RoomSettings
} from '../../shared/roomSettings.js';
import { selectCanStart, selectSelfPlayer, type ClientState } from '../state/gameStore.js';
import { LanSharePanel } from './LanSharePanel.js';
import { RoomSharePanel } from './RoomSharePanel.js';

type LobbyScreenProps = Readonly<{
  state: ClientState;
  onSetRole: (role: PlayerRole) => Promise<void>;
  onAddBot: (chassis: Chassis, difficulty: BotDifficulty) => Promise<void>;
  onUpdateBot: (playerId: string, chassis: Chassis, difficulty: BotDifficulty) => Promise<void>;
  onRemoveBot: (playerId: string) => Promise<void>;
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
  const status = player.connected ? (player.role === 'SPECTATOR' ? 'Seyirci' : player.ready ? 'Hazır' : 'Bekliyor') : 'Bağlantı bekleniyor';
  const statusClass = !player.connected ? 'is-disconnected' : player.ready ? 'is-ready' : 'is-waiting';
  return (
    <li className={`player-row ${statusClass}`}>
      <span className="player-row__identity">
        <span className="player-accent" style={{ backgroundColor: ACCENTS[player.accent] }} aria-hidden="true" />
        <strong>{player.name}</strong>
        {player.playerId === hostPlayerId ? <span className="host-crown" role="img" aria-label="Oda sahibi">♛</span> : null}
      </span>
      <span className="player-row__chassis">{player.role === 'FIGHTER' ? player.chassis : '—'}{player.botDifficulty ? ` · Bot · ${DIFFICULTY_LABELS[player.botDifficulty]}` : ''}</span>
      <span className="player-row__status"><span className="status-light" aria-hidden="true" />{status}</span>
    </li>
  );
}

const DIFFICULTY_LABELS: Record<BotDifficulty, string> = { EASY: 'Kolay', NORMAL: 'Normal', HARD: 'Zor' };

export function LobbyScreen({
  state,
  onSetRole,
  onAddBot,
  onUpdateBot,
  onRemoveBot,
  onSetChassis,
  onToggleReady,
  onSetRoomSettings,
  onStart,
  onCopyRoomCode
}: LobbyScreenProps) {
  const [botChassis, setBotChassis] = useState<Chassis>('RIFT');
  const [botDifficulty, setBotDifficulty] = useState<BotDifficulty>('NORMAL');
  if (!state.room) return null;
  const { room } = state;
  const selfPlayer = selectSelfPlayer(state);
  const isHost = selfPlayer?.playerId === room.hostPlayerId;
  const isSites = import.meta.env.MODE === 'sites';
  const spectator = selfPlayer?.role === 'SPECTATOR';
  const fighters = room.players.filter((player) => player.role === 'FIGHTER');
  const spectators = room.players.filter((player) => player.role === 'SPECTATOR');
  const anyPending = state.pendingAction !== null;
  const lobbyError = ['role', 'bot-add', 'bot-update', 'bot-remove', 'chassis', 'ready', 'settings', 'start'].includes(state.errorAction ?? '')
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
        <header className={`lobby-room${isHost || isSites ? ' lobby-room--with-share' : ''}`}>
          <div className="lobby-room__primary">
            <span className="eyebrow">ODA</span>
            <strong className="room-code" data-testid="room-code">{room.roomCode}</strong>
            {!isSites ? <button className="chrome-button copy-button focus-ring" type="button" aria-label="Kodu Kopyala" onClick={() => void onCopyRoomCode()}>
              <span>Kodu Kopyala</span>
              <span className={`copy-button__mark is-${state.copyFeedback}`} aria-hidden="true">
                {state.copyFeedback === 'copied' ? '✓' : state.copyFeedback === 'failed' ? '!' : '⧉'}
              </span>
            </button> : null}
          </div>
          {isSites ? <RoomSharePanel key={room.roomCode} roomCode={room.roomCode} />
            : isHost ? <LanSharePanel roomCode={room.roomCode} /> : null}
        </header>

        <label className="room-settings__field lobby-role">
          <span>Katılım</span>
          <select className="focus-ring" value={selfPlayer?.role ?? 'FIGHTER'} disabled={!selfPlayer || anyPending}
            onChange={(event) => void onSetRole(event.currentTarget.value as PlayerRole)}>
            <option value="FIGHTER" disabled={spectator && fighters.length >= GAME.maxPlayers}>Oyuncu</option>
            <option value="SPECTATOR" disabled={!spectator && spectators.length >= 8}>Seyirci</option>
          </select>
        </label>

        {!spectator ? <>
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

        </> : null}

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

        {isHost ? (
          <fieldset className="room-settings bot-manager" disabled={anyPending}>
            <legend>Botlar</legend>
            <div className="bot-manager__add">
              <label className="room-settings__field"><span>Bot gövdesi</span>
                <select className="focus-ring" value={botChassis} onChange={(event) => setBotChassis(event.currentTarget.value as Chassis)}>
                  {CHASSIS.map((chassis) => <option key={chassis}>{chassis}</option>)}
                </select>
              </label>
              <label className="room-settings__field"><span>Bot zorluğu</span>
                <select className="focus-ring" value={botDifficulty} onChange={(event) => setBotDifficulty(event.currentTarget.value as BotDifficulty)}>
                  {Object.entries(DIFFICULTY_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                </select>
              </label>
              <button className="chrome-button focus-ring" type="button" disabled={anyPending || fighters.length >= GAME.maxPlayers}
                aria-busy={state.pendingAction === 'bot-add'} onClick={() => void onAddBot(botChassis, botDifficulty)}>Bot Ekle</button>
            </div>
          </fieldset>
        ) : null}

        <section className="lobby-roster" aria-label="Oda katılımcıları">
          <p className="lobby-roster__count">Oyuncular {fighters.length}/{GAME.maxPlayers} · Seyirciler {spectators.length}/8</p>
          <ul className="player-list player-list--ffa" aria-label="Oyuncular">
            {fighters.map((candidate) => (
              <li key={candidate.playerId} className="lobby-roster__entry">
                <ul className="lobby-roster__identity"><PlayerRow player={candidate} hostPlayerId={room.hostPlayerId} /></ul>
                {isHost && candidate.botDifficulty ? (
                  <div className="bot-manager__edit">
                    <label className="room-settings__field"><span>{candidate.name} gövdesi</span>
                      <select className="focus-ring" disabled={anyPending} value={candidate.chassis}
                        onChange={(event) => void onUpdateBot(candidate.playerId, event.currentTarget.value as Chassis, candidate.botDifficulty!)}>
                        {CHASSIS.map((chassis) => <option key={chassis}>{chassis}</option>)}
                      </select>
                    </label>
                    <label className="room-settings__field"><span>{candidate.name} zorluğu</span>
                      <select className="focus-ring" disabled={anyPending} value={candidate.botDifficulty}
                        onChange={(event) => void onUpdateBot(candidate.playerId, candidate.chassis, event.currentTarget.value as BotDifficulty)}>
                        {Object.entries(DIFFICULTY_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                      </select>
                    </label>
                    <button className="chrome-button focus-ring" type="button" disabled={anyPending}
                      aria-label={`${candidate.name} botunu kaldır`} onClick={() => void onRemoveBot(candidate.playerId)}>Kaldır</button>
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
          {spectators.length ? <ul className="player-list" aria-label="Seyirciler">
            {spectators.map((candidate) => <PlayerRow key={candidate.playerId} player={candidate} hostPlayerId={room.hostPlayerId} />)}
          </ul> : null}
        </section>

        <div className="lobby-feedback">
          {lobbyError ? <p className="inline-error" role="alert">{lobbyError.message}</p> : null}
        </div>

        <footer className="lobby-actions">
          {selfPlayer && !spectator ? (
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
