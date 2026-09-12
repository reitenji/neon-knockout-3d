import type { GameEvent, InputFrame, MatchSnapshot } from '../../shared/model.js';
import type { ArenaInputSource } from './runtime/ArenaInput.js';
import type { ReconciliationResult } from './prediction.js';

export interface GamePresentationBridge {
  readonly inputSource?: ArenaInputSource;
  getSnapshot(): MatchSnapshot | null;
  getPresentationDelayMs?(): number | null;
  getRollbackFrames?(): number | null;
  isConnected(): boolean;
  publishPresentationDelay?(delayMs: number): void;
  publishRollbackFrames?(frames: number | null): void;
  publishReconciliation?(result: ReconciliationResult): void;
  publishBufferUnderrun?(bufferUnderrun: boolean): void;
  publishExtrapolatedFrames?(frames: number): void;
  subscribeSnapshot(listener: (snapshot: MatchSnapshot) => void): () => void;
  subscribePresentationDelay?(listener: (delayMs: number | null) => void): () => void;
  subscribeRollbackFrames?(listener: (frames: number | null) => void): () => void;
  subscribeConnected(listener: (connected: boolean) => void): () => void;
  subscribeEvent(listener: (event: GameEvent) => void): () => void;
  subscribeMuted(listener: (muted: boolean) => void): () => void;
  reserveInputSequence?(minimum: number): number;
  sendInput(frame: InputFrame): void;
}

export type NeonGameFactory = (
  parent: HTMLElement,
  bridge: GamePresentationBridge,
  options?: Readonly<{ reducedMotion?: boolean }>
) => { destroy(removeCanvas?: boolean): void };

const LOCAL_PLAYER_ID = Symbol('localPlayerId');

type PresentationTelemetry = {
  delayMs: number | null;
  delayListeners: Set<(delayMs: number | null) => void>;
  rollbackFrames: number | null;
  rollbackListeners: Set<(frames: number | null) => void>;
};

type ScopedBridge = GamePresentationBridge & { readonly [LOCAL_PLAYER_ID]?: string };

export function scopeBridgeToPlayer(
  bridge: GamePresentationBridge,
  localPlayerId: string,
  inputSource: ArenaInputSource | undefined = bridge.inputSource
): GamePresentationBridge {
  const presentationTelemetry: PresentationTelemetry = {
    delayMs: null,
    delayListeners: new Set(),
    rollbackFrames: null,
    rollbackListeners: new Set()
  };
  return Object.assign(Object.create(bridge) as ScopedBridge, {
    [LOCAL_PLAYER_ID]: localPlayerId,
    ...(inputSource ? { inputSource } : {}),
    getPresentationDelayMs: () => presentationTelemetry.delayMs,
    getRollbackFrames: () => presentationTelemetry.rollbackFrames,
    publishPresentationDelay: (delayMs: number) => {
      if (presentationTelemetry.delayMs === delayMs) return;
      presentationTelemetry.delayMs = delayMs;
      for (const listener of presentationTelemetry.delayListeners) listener(delayMs);
    },
    publishRollbackFrames: (frames: number | null) => {
      if (presentationTelemetry.rollbackFrames === frames) return;
      presentationTelemetry.rollbackFrames = frames;
      for (const listener of presentationTelemetry.rollbackListeners) listener(frames);
    },
    subscribePresentationDelay: (listener: (delayMs: number | null) => void) => {
      presentationTelemetry.delayListeners.add(listener);
      return () => presentationTelemetry.delayListeners.delete(listener);
    },
    subscribeRollbackFrames: (listener: (frames: number | null) => void) => {
      presentationTelemetry.rollbackListeners.add(listener);
      return () => presentationTelemetry.rollbackListeners.delete(listener);
    }
  });
}

export function localPlayerIdFromBridge(bridge: GamePresentationBridge): string | null {
  return (bridge as ScopedBridge)[LOCAL_PLAYER_ID] ?? null;
}
