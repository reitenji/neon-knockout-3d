import { LobbyChat } from './LobbyChat.js';
import type { ResultPlayer } from '../../shared/model.js';
import { selectCanStart, selectSelfPlayer, type ClientState } from '../state/gameStore.js';

type ResultScreenProps = Readonly<{
  state: ClientState;
  onSendChat: (text: string) => Promise<boolean>;
  onToggleReady: (ready: boolean) => Promise<void>;
  onStart: () => Promise<void>;
  onReturnToLobby: () => Promise<void>;
  confirmReturn?: () => boolean;
}>;

type RankedPlayer = Readonly<{ player: ResultPlayer; joinOrder: number }>;

function rankPlayers(players: readonly ResultPlayer[]): readonly ResultPlayer[] {
  return players
    .map((player, joinOrder): RankedPlayer => ({ player, joinOrder }))
    .sort((left, right) =>
      right.player.stats.knockouts - left.player.stats.knockouts ||
      left.player.stats.falls - right.player.stats.falls ||
      right.player.stats.landedHits - left.player.stats.landedHits ||
      left.joinOrder - right.joinOrder
    )
    .map(({ player }) => player);
}

function accuracy(player: ResultPlayer): number {
  if (player.stats.completedAttacks === 0) return 0;
  return Math.min(100, Math.round(player.stats.landedHits / player.stats.completedAttacks * 100));
}

export function ResultScreen({ state, onSendChat, onToggleReady, onStart, onReturnToLobby, confirmReturn }: ResultScreenProps) {
  if (!state.room || state.room.phase !== 'RESULT') return null;
  const { room } = state;
  const self = selectSelfPlayer(state);
  const isHost = self?.playerId === room.hostPlayerId;
  const resultPlayers = room.result?.players ?? [];
  const winner = resultPlayers.find((player) => player.playerId === room.result?.winnerPlayerId) ?? null;
  const anyReady = room.players.some((player) => player.connected && player.role === 'FIGHTER' && player.botDifficulty === null && player.ready);
  const fighters = room.players.filter(player => player.connected && player.role === 'FIGHTER');
  const readyCount = fighters.filter(player => player.ready).length;
  const resultReason = room.result ? { TARGET_SCORE: 'Hedef skora ulaşıldı', TIME: 'Süre doldu', SUDDEN_DEATH: 'Ani ölüm tamamlandı', NO_CONTEST: 'Maç geçersiz sayıldı' }[room.result.reason] : '';
  const anyPending = state.pendingAction !== null;
  const resultError = ['result-ready', 'start', 'return-lobby'].includes(state.errorAction ?? '') ? state.lastError : null;

  const returnToLobby = (): void => {
    const approved = !anyReady || (confirmReturn ?? (() => window.confirm('Hazır oyuncular var. Lobiye dönülsün mü?')))();
    if (approved) void onReturnToLobby();
  };

  return (
    <section className="screen screen--result" aria-labelledby="result-title">
      <div className="result-frame tech-frame">
        <header className="result-heading">
          <p className="eyebrow">MAÇ SONUCU</p>
          {self?.role === 'SPECTATOR' ? <p>Seyirci</p> : null}
          <h1 id="result-title">{winner ? `${winner.name} Kazandı` : 'Kazanan Yok'}</h1>
          <p className="result-heading__detail">{resultReason}</p>
        </header>

        <div className="result-content">
          <div className="result-standings">
            <h2>Skor tablosu</h2>
            <table className="result-table" aria-label="Maç sonuçları">
              <thead><tr><th>Sıra</th><th>Oyuncu</th><th>KO</th><th>Düşüş</th><th>İsabet</th><th>Başarı</th><th>Lobi</th></tr></thead>
              <tbody>
                {rankPlayers(resultPlayers).map((player, index) => (
                  <tr
                    key={player.playerId}
                    className={`${player.playerId === room.result?.winnerPlayerId ? 'is-winner ' : ''}${player.resultStatus === 'LEFT' ? 'has-left' : ''}`.trim() || undefined}
                  >
                    <td>{index + 1}</td><th scope="row" title={player.name}>{player.name}</th><td>{player.stats.knockouts}</td>
                    <td>{player.stats.falls}</td><td>{player.stats.landedHits}</td><td>{accuracy(player)}%</td>
                    <td>
                      <span className={`result-status result-status--${player.resultStatus.toLowerCase()}`}>
                        {player.resultStatus === 'READY' ? 'Hazır' : player.resultStatus === 'LEFT' ? 'Ayrıldı' : 'Bekliyor'}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="result-rematch" aria-live="polite">
              <strong>{readyCount}/{fighters.length} oyuncu rövanşa hazır</strong>
              <p>{self?.role === 'SPECTATOR' ? 'Oyuncuların hazır olmasını bekliyorsun.' : self?.ready ? 'Hazırsın. Diğer oyuncuları bekleyebilirsin.' : 'Bir tur daha oynamak için hazır olduğunu belirt.'}</p>
            </div>
          </div>
          <LobbyChat
            title="Oda sohbeti"
            messages={room.chatMessages ?? []}
            onSend={onSendChat}
            disabled={anyPending || state.connectionState !== 'connected' || !self?.connected}
            error={state.errorAction === 'chat' ? state.lastError?.message : undefined}
          />
        </div>

        {resultError ? <p className="inline-error" role="alert">{resultError.message}</p> : null}

        <footer className="result-actions">
          {self?.connected && self.role === 'FIGHTER' ? (
            <button
              className="command-button command-button--cyan focus-ring"
              type="button"
              disabled={anyPending}
              aria-busy={state.pendingAction === 'result-ready'}
              onClick={() => void onToggleReady(!self.ready)}
            >
              {self.ready ? 'Tekrar Hazır Değilim' : 'Tekrar Hazır'}
            </button>
          ) : null}
          {isHost && selectCanStart(state) ? (
            <button className="command-button command-button--amber focus-ring" type="button" disabled={anyPending} onClick={() => void onStart()}>
              Rövanşı Başlat
            </button>
          ) : null}
          {isHost ? <button className="chrome-button focus-ring" type="button" disabled={anyPending} onClick={returnToLobby}>Lobiye Dön</button> : null}
        </footer>
      </div>
    </section>
  );
}
