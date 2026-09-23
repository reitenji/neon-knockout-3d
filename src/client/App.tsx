import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import type { NeonGameFactory } from './game/GamePresentationBridge.js';
import { ThreeArena } from './game/ThreeArena.js';
import {
  INVITE_DISMISSED_HISTORY_STATE,
  inviteRoomCodeFromPath,
  resumeRoomPreferenceFromLocation
} from './inviteRoute.js';
import { createArenaBridge, selectSelfPlayer, type GameStore } from './state/gameStore.js';
import { useGameStore } from './state/useGameStore.js';
import { LandingScreen } from './ui/LandingScreen.js';
import { LobbyScreen } from './ui/LobbyScreen.js';
import { ConnectionOverlay } from './ui/ConnectionOverlay.js';
import { ResultScreen } from './ui/ResultScreen.js';
import { ToastRegion } from './ui/ToastRegion.js';
import { TopBar } from './ui/TopBar.js';

type AppProps = Readonly<{
  store: GameStore;
  gameFactory?: NeonGameFactory;
}>;

function viewportNeedsRotation(): boolean {
  const touchCapable = (window.matchMedia?.('(pointer: coarse)').matches ?? false) || navigator.maxTouchPoints > 0;
  return touchCapable && window.innerHeight > window.innerWidth;
}

function subscribeToViewport(listener: () => void): () => void {
  window.addEventListener('resize', listener);
  window.addEventListener('orientationchange', listener);
  return () => {
    window.removeEventListener('resize', listener);
    window.removeEventListener('orientationchange', listener);
  };
}

function usePortraitViewport(): boolean {
  return useSyncExternalStore(subscribeToViewport, viewportNeedsRotation, () => false);
}

export function App({ store, gameFactory }: AppProps) {
  const state = useGameStore(store);
  const spectator = selectSelfPlayer(state)?.role === 'SPECTATOR';
  const portraitViewport = usePortraitViewport();
  const arenaBridge = useMemo(() => createArenaBridge(store), [store]);
  const [inviteRoomCode, setInviteRoomCode] = useState(() => inviteRoomCodeFromPath(window.location.pathname));

  useEffect(() => {
    store.actions.connect();
    return () => store.dispose();
  }, [store]);

  useEffect(() => {
    const syncInviteRoute = (): void => setInviteRoomCode(inviteRoomCodeFromPath(window.location.pathname));
    window.addEventListener('popstate', syncInviteRoute);
    return () => window.removeEventListener('popstate', syncInviteRoute);
  }, []);

  useEffect(() => {
    if (
      state.session !== null &&
      resumeRoomPreferenceFromLocation(window.location.pathname, window.history.state) === null
    ) {
      window.history.replaceState(null, '', window.location.href);
    }
  }, [state.session]);

  const clearInviteRoute = (): void => {
    window.history.replaceState(INVITE_DISMISSED_HISTORY_STATE, '', '/');
    setInviteRoomCode(null);
  };

  const leaveRoom = async (): Promise<void> => {
    await store.actions.leaveRoom();
    if (store.getSnapshot().session === null) clearInviteRoute();
  };

  return (
    <div className={`app-shell${state.screen === 'MATCH' ? ' app-shell--match' : ''}${spectator ? ' app-shell--spectator' : ''}`}>
      <TopBar state={state} onToggleSound={store.actions.toggleSound} onLeaveRoom={leaveRoom} onKickPlayer={store.actions.kickPlayer} />

      <main className="app-main">
        {state.screen === 'LANDING' ? (
          <LandingScreen
            state={state}
            invitedRoomCode={inviteRoomCode}
            onCreateRoom={store.actions.createRoom}
            onJoinRoom={store.actions.joinRoom}
            onExitInvite={clearInviteRoute}
          />
        ) : null}

        {state.screen === 'LOBBY' ? (
          <LobbyScreen
            state={state}
            onSetRole={store.actions.setRole}
            onAddBot={store.actions.addBot}
            onUpdateBot={store.actions.updateBot}
            onSendChat={store.actions.sendChat}
            onRemoveBot={store.actions.removeBot}
            onSetChassis={store.actions.setChassis}
            onToggleReady={store.actions.setReady}
            onSetRoomSettings={store.actions.setRoomSettings}
            onStart={store.actions.startMatch}
            onCopyRoomCode={store.actions.copyRoomCode}
          />
        ) : null}

        {state.screen === 'MATCH' ? (
          <>
            <ThreeArena
              bridge={arenaBridge}
              localPlayerId={state.session?.playerId ?? ''}
              spectator={spectator}
              botPlayerIds={state.room?.players.filter((player) => player.botDifficulty !== null).map((player) => player.playerId)}
              createGame={gameFactory}
            />
            {portraitViewport ? (
              <section
                className="rotate-prompt"
                role="dialog"
                aria-modal="true"
                aria-labelledby="rotate-prompt-title"
              >
                <div className="rotate-prompt__device" aria-hidden="true"><span /></div>
                <h1 id="rotate-prompt-title">Telefonu yatay çevir</h1>
                <p>Arena ve dokunmatik kontroller yatay ekranda kullanılır.</p>
              </section>
            ) : null}
            {(state.connectionState !== 'connected' && state.connectionState !== 'idle') || state.reconnectRemainingMs !== null ? (
              <ConnectionOverlay
                connectionState={state.connectionState}
                remainingMs={state.reconnectRemainingMs}
                onRetry={store.actions.connect}
              />
            ) : null}
          </>
        ) : null}
        {state.screen === 'RESULT' ? (
          <ResultScreen
            state={state}
            onToggleReady={store.actions.setResultReady}
            onStart={store.actions.startMatch}
            onReturnToLobby={store.actions.returnToLobby}
          />
        ) : null}
      </main>

      <ToastRegion toasts={state.toasts} onDismiss={store.actions.dismissToast} />
    </div>
  );
}
