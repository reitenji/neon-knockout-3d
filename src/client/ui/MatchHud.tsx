import { FIGHTERS } from '../../shared/fighters.js';
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore, type CSSProperties } from 'react';
import { ACCENTS, GAME } from '../../shared/constants.js';
import type { MatchPhase, MatchPlayer, MatchSnapshot, PlayerNetworkStatus } from '../../shared/model.js';
import { matchTimingFor } from '../../shared/roomSettings.js';
import type { GamePresentationBridge } from '../game/GamePresentationBridge.js';
import { createHudSnapshotStore } from './HudSnapshotStore.js';

type MatchHudProps = Readonly<{
  bridge: GamePresentationBridge;
  localPlayerId: string;
  spectator?: boolean;
  botPlayerIds?: readonly string[];
}>;

const PHASE_LABELS: Readonly<Record<MatchPhase, string>> = {
  COUNTDOWN: 'GERİ SAYIM',
  REGULATION: 'DÖVÜŞ',
  PAUSED: 'BEKLEMEDE',
  SUDDEN_DEATH: 'SON VURUŞ',
  FINISHED: 'BİTTİ'
};

const SUDDEN_DEATH_ANNOUNCEMENT_MS = 1_100;

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function formatTime(remainingMs: number): string {
  const seconds = Math.max(0, Math.ceil(remainingMs / 1_000));
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

function phaseAnnouncement(snapshot: MatchSnapshot): Readonly<{ label: string; text: string }> | null {
  if (snapshot.phase === 'COUNTDOWN') {
    return { label: 'Geri sayım', text: String(Math.max(1, Math.ceil(snapshot.remainingMs / 1_000))) };
  }
  if (snapshot.phase === 'REGULATION' && snapshot.remainingMs > snapshot.settings.durationMs - 800) {
    return { label: 'Raunt başlangıcı', text: 'FIGHT' };
  }
  if (snapshot.phase === 'PAUSED') return { label: 'Raunt durumu', text: 'BEKLE' };
  return null;
}

function actionLabel(player: MatchPlayer): string {
  if (player.respawnRemainingMs > 0 || player.action.kind === 'RESPAWNING') {
    return `Geri dönüş ${Math.max(0.1, Math.ceil(player.respawnRemainingMs / 100) / 10).toFixed(1)} sn`;
  }
  if (player.hitstunRemainingMs > 0 || player.action.kind === 'HITSTUN') return 'Sarsıldı';
  if (player.dashRemainingMs > 0 || player.action.kind === 'DASH') return 'Dash aktif';
  if (player.action.chargeMs >= GAME.heavyMaxChargeMs) return 'PULSE READY';
  if (player.action.chargeMs > 0) {
    const charge = Math.round(clamp(player.action.chargeMs / GAME.heavyMaxChargeMs, 0, 1) * 100);
    return `ŞARJ ${charge}%`;
  }
  if (player.action.kind === 'HEAVY') return 'Ağır saldırı';
  if (player.action.kind?.startsWith('QUICK_')) return `Kombo ${player.action.comboStep}`;
  return 'Beklemede';
}

function meterStyle(progress: number): CSSProperties {
  return { '--meter-progress': clamp(progress, 0, 1) } as CSSProperties;
}

function useMatchSnapshot(bridge: GamePresentationBridge): MatchSnapshot | null {
  const store = useMemo(() => createHudSnapshotStore(bridge), [bridge]);
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}

function useConnection(bridge: GamePresentationBridge): boolean {
  const subscribe = useCallback(
    (notify: () => void) => bridge.subscribeConnected(() => notify()),
    [bridge]
  );
  const getSnapshot = useCallback(() => bridge.isConnected(), [bridge]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

function PhaseAnnouncement({
  announcement,
  variant = 'center'
}: Readonly<{
  announcement: Readonly<{ label: string; text: string }>;
  variant?: 'center' | 'sudden-death';
}>) {
  return (
    <strong
      key={`${announcement.label}-${announcement.text}`}
      className={variant === 'sudden-death'
        ? 'match-hud__announcement match-hud__announcement--sudden-death'
        : 'match-hud__announcement'}
      role="status"
      aria-label={announcement.label}
      aria-live="assertive"
    >
      {announcement.text}
    </strong>
  );
}

function SuddenDeathAnnouncement() {
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    const timeout = window.setTimeout(() => setVisible(false), SUDDEN_DEATH_ANNOUNCEMENT_MS);
    return () => window.clearTimeout(timeout);
  }, []);

  return visible ? (
    <div className="match-hud__announcement-slot">
      <PhaseAnnouncement
        announcement={{ label: 'Raunt durumu', text: 'SON VURUŞ' }}
        variant="sudden-death"
      />
    </div>
  ) : null;
}

function pingPresentation(network: PlayerNetworkStatus | undefined): Readonly<{
  pingLabel: string;
  tier: 'pending' | 'good' | 'medium' | 'high';
}> {
  const median = network?.medianMs === null || network?.medianMs === undefined
    ? null
    : Math.max(0, Math.round(network.medianMs));
  const tier = median === null
    ? 'pending'
    : median <= 20
      ? 'good'
      : median <= 80
        ? 'medium'
        : 'high';
  return {
    pingLabel: median === null ? 'Ping —' : `Ping ${median} ms`,
    tier
  };
}

function PlayerRoster({
  snapshot,
  localPlayerId,
  botPlayerIds
}: Readonly<{
  snapshot: MatchSnapshot;
  localPlayerId: string;
  botPlayerIds: readonly string[];
}>) {
  const ranking = [...snapshot.players].sort((left, right) => {
    const scoreDifference = (snapshot.scores[right.playerId] ?? 0) - (snapshot.scores[left.playerId] ?? 0);
    if (scoreDifference !== 0) return scoreDifference;
    return left.name.localeCompare(right.name, 'tr');
  });

  return (
    <section className="match-hud__roster" aria-label="Oyuncu listesi">
      <div className="match-hud__roster-heading">
        <span>OYUNCULAR</span>
        <span>KO</span>
        <span>PING</span>
      </div>
      <ol className="match-hud__ranking" aria-label="Oyuncu sıralaması">
        {ranking.map((player) => {
          const local = player.playerId === localPlayerId;
          const score = snapshot.scores[player.playerId] ?? 0;
          const ping = botPlayerIds.includes(player.playerId) ? { pingLabel: 'Bot', tier: 'pending' } : pingPresentation(snapshot.network[player.playerId]);
          const accentStyle = { '--player-accent': ACCENTS[player.accent] } as CSSProperties;
          return (
            <li key={player.playerId} className={local ? 'is-local' : undefined} style={accentStyle}>
              <span className="match-hud__swatch" aria-hidden="true" />
              <span className="match-hud__name">
                <span>{player.name}{local ? <small>Sen</small> : null}</span>
              </span>
              <strong className="match-hud__score" aria-label={`${player.name} skoru: ${score} knockout`}>
                {score}
              </strong>
              <span
                className={`match-hud__telemetry is-${ping.tier}`}
                aria-label={`${player.name} ağ telemetrisi: ${ping.pingLabel}`}
              >
                <span>{ping.pingLabel}</span>
              </span>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

function ControlsHint() {
  return (
    <div className="match-hud__controls" aria-label="Kontroller">
      <span><kbd>WASD</kbd><small>Hareket / yön</small></span>
      <span><kbd>J</kbd><small>Hızlı vur</small></span>
      <span><kbd>K</kbd><small>Yükle / vur</small></span>
      <span><kbd>Space</kbd><small>Yetenek</small></span>
    </div>
  );
}

export function MatchHud({ bridge, localPlayerId, spectator = false, botPlayerIds = [] }: MatchHudProps) {
  const snapshot = useMatchSnapshot(bridge);
  const connected = useConnection(bridge);
  const localPlayer = spectator ? null : snapshot?.players.find((player) => player.playerId === localPlayerId) ?? null;
  const announcement = snapshot ? phaseAnnouncement(snapshot) : null;
  const overload = localPlayer ? Math.round(clamp(localPlayer.overload, 0, GAME.maxOverload)) : 0;
  const dashProgress = localPlayer
    ? 1 - clamp(localPlayer.dashCooldownRemainingMs / FIGHTERS[localPlayer.chassis].dashCooldownMs, 0, 1)
    : 0;
  const matchTiming = snapshot ? matchTimingFor(snapshot.settings.durationMs) : null;
  const contractionWarning = snapshot?.phase === 'REGULATION' &&
    snapshot.remainingMs <= (matchTiming?.contractionWarningRemainingMs ?? 0) &&
    snapshot.remainingMs > (matchTiming?.contractionMinimumRemainingMs ?? 0);
  const pulseReady = Boolean(localPlayer && localPlayer.action.chargeMs >= GAME.heavyMaxChargeMs);

  return (
    <aside className="match-hud" aria-label="Maç bilgileri">
      {snapshot ? (
        <>
          <header className="match-hud__clock">
            <span>{PHASE_LABELS[snapshot.phase]}</span>
            {spectator ? <strong className="match-hud__spectator">Seyirci</strong> : null}
            <time role="timer" aria-label="Kalan süre" dateTime={`PT${Math.ceil(snapshot.remainingMs / 1_000)}S`}>
              {formatTime(snapshot.remainingMs)}
            </time>
            <strong className="match-hud__rule" aria-label="Kazanma hedefi">
              İlk {snapshot.settings.knockoutTarget} knockout
            </strong>
            {contractionWarning ? (
              <strong className="match-hud__contraction" role="status" aria-label="Arena daralma uyarısı">
                ARENA DARALIYOR
              </strong>
            ) : null}
          </header>

          <PlayerRoster
            snapshot={snapshot}
            localPlayerId={localPlayerId}
            botPlayerIds={botPlayerIds}
          />

          {localPlayer ? (
            <section className="match-hud__combat" aria-label="Yerel dövüş durumu">
              <div className="match-hud__overload">
                <span>OVERLOAD</span>
                <strong>{overload}%</strong>
                <div
                  className="match-hud__meter match-hud__meter--overload"
                  role="meter"
                  aria-label="Overload"
                  aria-valuemin={0}
                  aria-valuemax={GAME.maxOverload}
                  aria-valuenow={overload}
                  style={meterStyle(overload / GAME.maxOverload)}
                ><i /></div>
              </div>

              <div className="match-hud__ability">
                <span>{FIGHTERS[localPlayer.chassis].abilityName}</span>
                <strong>{localPlayer.dashRemainingMs > 0 ? 'Aktif' : localPlayer.dashCooldownRemainingMs > 0 ? `${(localPlayer.dashCooldownRemainingMs / 1_000).toFixed(1)} sn` : 'Hazır'}</strong>
                <div
                  className="match-hud__meter"
                  role="meter"
                  aria-label="Dash dolumu"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={Math.round(dashProgress * 100)}
                  style={meterStyle(dashProgress)}
                ><i /></div>
              </div>

              <div
                className={`match-hud__action ${pulseReady ? 'is-pulse-ready' : ''}`}
                role="status"
                aria-label="Aksiyon durumu"
              >
                <span>AKSİYON</span>
                <strong>{actionLabel(localPlayer)}</strong>
              </div>
            </section>
          ) : null}
        </>
      ) : (
        <p className="match-hud__loading" role="status">Arena hazırlanıyor…</p>
      )}

      <div
        className={`match-hud__connection ${connected ? 'is-connected' : 'is-disconnected'}`}
        role="status"
        aria-label="Bağlantı durumu"
        aria-live="polite"
      >
        <i aria-hidden="true" />
        {connected ? 'Bağlı' : 'Bağlantı kesildi'}
      </div>

      {!spectator ? <ControlsHint /> : null}

      {snapshot?.phase === 'SUDDEN_DEATH' ? <SuddenDeathAnnouncement /> : null}
      {snapshot?.phase !== 'SUDDEN_DEATH' && announcement ? <PhaseAnnouncement announcement={announcement} /> : null}
    </aside>
  );
}
