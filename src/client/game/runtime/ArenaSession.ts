import type { MatchPlayer, MatchSnapshot } from '../../../shared/model.js';
import type { GamePresentationBridge } from '../GamePresentationBridge.js';
import {
  PredictionBuffer,
  type PlayerPresentation,
  type ReconciliationResult
} from '../prediction.js';
import type { ArenaInput } from './ArenaInput.js';

const acceptsInput = (snapshot: MatchSnapshot): boolean =>
  snapshot.phase === 'REGULATION' || snapshot.phase === 'SUDDEN_DEATH';

const E2E_OBSERVER_LIMIT = 256;

type E2eInputObserver = {
  inputs: Array<Readonly<{
    sequence: number;
    sampledAtMs: number;
    viewTick: number;
    moveX: number;
    moveY: number;
    quick: boolean;
    heavy: boolean;
    dash: boolean;
  }>>;
  acceptedSnapshots: Array<Readonly<{
    tick: number;
    lastProcessedInputSeq: number;
    acceptedAtMs: number;
    transport: MatchSnapshot['network'][string]['transport'] | null;
    pingMs: number | null;
  }>>;
  reconciliations?: ReconciliationResult[];
};

export type ArenaSessionPresentationState = Readonly<{
  rollbackWindowFrames: number;
  targetTick: number | null;
}>;

const DEFAULT_PRESENTATION_STATE: ArenaSessionPresentationState = { rollbackWindowFrames: 4, targetTick: null };

function e2eObserver(): E2eInputObserver | null {
  const candidate = (globalThis as typeof globalThis & { __NEON_E2E_INPUT_OBSERVER__?: unknown })
    .__NEON_E2E_INPUT_OBSERVER__;
  if (
    typeof candidate !== 'object'
    || candidate === null
    || !Array.isArray((candidate as Partial<E2eInputObserver>).inputs)
    || !Array.isArray((candidate as Partial<E2eInputObserver>).acceptedSnapshots)
  ) return null;
  return candidate as E2eInputObserver;
}

function pushBounded<T>(values: T[], value: T): void {
  values.push(value);
  if (values.length > E2E_OBSERVER_LIMIT) values.splice(0, values.length - E2E_OBSERVER_LIMIT);
}

function playerById(snapshot: MatchSnapshot, playerId: string): MatchPlayer | null {
  return snapshot.players.find((player) => player.playerId === playerId) ?? null;
}

export class ArenaSession {
  private readonly prediction: PredictionBuffer;
  private readonly unsubscribers: Array<() => void> = [];
  private latestSnapshot: MatchSnapshot | null = null;
  private localPresentation: PlayerPresentation | null = null;
  private connected = false;
  private inputSequence = 0;
  private started = false;
  private disposed = false;

  constructor(
    private readonly bridge: GamePresentationBridge,
    private readonly localPlayerId: string,
    private readonly input: ArenaInput,
    private readonly now: () => number,
    private readonly onSnapshot: (snapshot: MatchSnapshot, receivedAtMs: number) => void = () => undefined,
    private readonly presentationState: () => ArenaSessionPresentationState = () => DEFAULT_PRESENTATION_STATE
  ) {
    this.prediction = new PredictionBuffer(localPlayerId);
  }

  start(): void {
    if (this.started || this.disposed) return;
    this.started = true;
    this.connected = this.bridge.isConnected();
    const initial = this.bridge.getSnapshot();
    if (initial) this.acceptSnapshot(initial);
    if (!this.connected) this.releaseHeldInput(true);
    this.unsubscribers.push(
      this.bridge.subscribeSnapshot((snapshot) => this.acceptSnapshot(snapshot)),
      this.bridge.subscribeConnected((connected) => this.acceptConnection(connected))
    );
  }

  step(elapsedMs: number): PlayerPresentation | null {
    if (!this.started || this.disposed || !this.connected || !this.latestSnapshot) return this.localPresentation;
    const localPlayer = playerById(this.latestSnapshot, this.localPlayerId);
    if (!localPlayer || !acceptsInput(this.latestSnapshot)) {
      this.releaseHeldInput(false);
      return this.localPresentation;
    }
    const sampledAtMs = this.now();
    const targetTick = this.presentationState().targetTick ?? this.latestSnapshot.tick;
    const viewTick = Math.max(0, Math.floor(targetTick));
    const sampledFrame = this.input.sample(this.inputSequence, sampledAtMs);
    if (!sampledFrame) return this.localPresentation;
    const sequence = this.bridge.reserveInputSequence?.(this.inputSequence) ?? this.inputSequence;
    this.inputSequence = sequence + 1;
    const frame = { ...sampledFrame, seq: sequence, viewTick };
    this.localPresentation = this.prediction.predict(
      frame,
      localPlayer,
      elapsedMs,
      this.latestSnapshot.platformProgress
    );
    this.bridge.sendInput(frame);
    const observer = e2eObserver();
    if (observer) {
      pushBounded(observer.inputs, {
        sequence: frame.seq,
        sampledAtMs,
        viewTick: frame.viewTick,
        moveX: frame.moveX,
        moveY: frame.moveY,
        quick: frame.quick,
        heavy: frame.heavy,
        dash: frame.dash
      });
    }
    return this.localPresentation;
  }

  getLocalPresentation(): PlayerPresentation | null {
    return this.localPresentation;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const unsubscribe of this.unsubscribers.splice(0)) unsubscribe();
    this.input.dispose();
    this.prediction.reset();
  }

  private acceptConnection(connected: boolean): void {
    if (connected === this.connected) return;
    this.connected = connected;
    if (!connected) this.releaseHeldInput(true);
  }

  private acceptSnapshot(snapshot: MatchSnapshot): void {
    this.latestSnapshot = snapshot;
    const acceptedAtMs = this.now();
    this.onSnapshot(snapshot, acceptedAtMs);
    const localPlayer = playerById(snapshot, this.localPlayerId);
    if (!localPlayer) {
      this.prediction.reset();
      this.bridge.publishRollbackFrames?.(null);
      this.localPresentation = null;
      return;
    }
    const observer = e2eObserver();
    if (observer) {
      pushBounded(observer.acceptedSnapshots, {
        tick: snapshot.tick,
        lastProcessedInputSeq: localPlayer.lastProcessedInputSeq,
        acceptedAtMs,
        transport: snapshot.network[this.localPlayerId]?.transport ?? null,
        pingMs: snapshot.network[this.localPlayerId]?.medianMs ?? null
      });
    }
    this.inputSequence = Math.max(this.inputSequence, localPlayer.lastProcessedInputSeq + 1);
    this.prediction.setRollbackWindow(this.presentationState().rollbackWindowFrames);
    const reconciliation = this.prediction.reconcile(
      localPlayer,
      snapshot.tick,
      1_000 / 60,
      snapshot.platformProgress
    );
    this.localPresentation = reconciliation.presentation;
    this.bridge.publishRollbackFrames?.(reconciliation.result.rollbackFrames);
    this.bridge.publishReconciliation?.(reconciliation.result);
    if (observer?.reconciliations) pushBounded(observer.reconciliations, reconciliation.result);
  }

  private releaseHeldInput(requireRelease: boolean): void {
    this.input.clearHeld(requireRelease);
    const localPlayer = this.latestSnapshot ? playerById(this.latestSnapshot, this.localPlayerId) : null;
    this.prediction.reset(localPlayer ?? undefined);
    this.bridge.publishRollbackFrames?.(localPlayer ? 0 : null);
    this.localPresentation = localPlayer
      ? {
          position: localPlayer.position,
          velocity: localPlayer.velocity,
          facing: localPlayer.facing,
          actionStart: null
        }
      : null;
  }
}
