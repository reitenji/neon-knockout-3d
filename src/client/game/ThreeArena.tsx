import { FIGHTERS } from '../../shared/fighters.js';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { GamePresentationBridge, NeonGameFactory } from './GamePresentationBridge.js';
import { scopeBridgeToPlayer } from './GamePresentationBridge.js';
import { TouchInputSource } from './runtime/TouchInputSource.js';
import { MatchHud } from '../ui/MatchHud.js';
import { TouchControls } from '../ui/TouchControls.js';

type ThreeArenaProps = Readonly<{
  bridge: GamePresentationBridge;
  localPlayerId: string;
  createGame?: NeonGameFactory;
  reducedMotion?: boolean;
}>;

export function ThreeArena({
  bridge,
  localPlayerId,
  createGame,
  reducedMotion
}: ThreeArenaProps) {
  const [renderError, setRenderError] = useState(false);
  const parentRef = useRef<HTMLDivElement>(null);
  const touchInput = useMemo(() => new TouchInputSource(), []);
  const scopedBridge = useMemo(
    () => scopeBridgeToPlayer(bridge, localPlayerId, touchInput),
    [bridge, localPlayerId, touchInput]
  );
  const prefersReducedMotion = reducedMotion ?? (
    window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
  );

  useEffect(() => {
    const parent = parentRef.current;
    if (!parent) return;
    let disposed = false;
    let game: ReturnType<NeonGameFactory> | null = null;
    const mount = async (): Promise<void> => {
      const factory = createGame ?? (await import('./three/createThreeGame.js')).createThreeGame;
      if (disposed) return;
      game = factory(parent, scopedBridge, { reducedMotion: prefersReducedMotion });
    };
    void mount().catch(() => { if (!disposed) setRenderError(true); });
    return () => {
      disposed = true;
      game?.destroy(true);
      game = null;
    };
  }, [createGame, prefersReducedMotion, scopedBridge]);

  return (
    <section className="screen game-screen" aria-label="Neon Knockout maçı">
      <div
        ref={parentRef}
        className="game-stage tech-frame"
        role="img"
        aria-label="Neon Knockout oyun alanı"
        onContextMenu={(event) => event.preventDefault()}
      />
      {renderError ? <p className="render-error" role="alert">3D sahne açılamadı. Tarayıcıda donanım hızlandırmayı etkinleştirip sayfayı yenile.</p> : null}
      <MatchHud bridge={scopedBridge} localPlayerId={localPlayerId} />
      <TouchControls source={touchInput} abilityName={FIGHTERS[bridge.getSnapshot()?.players.find((player) => player.playerId === localPlayerId)?.chassis ?? 'RIFT'].abilityName} />
    </section>
  );
}
