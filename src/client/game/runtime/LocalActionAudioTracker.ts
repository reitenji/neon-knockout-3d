import type { MatchAction } from '../../../shared/model.js';
import type { GameAudioCue } from './GameAudio.js';

type ActionKind = Exclude<MatchAction['kind'], null>;
type PendingPrediction = {
  token: number;
  kind: ActionKind;
  chargeMs: number;
  heavyReleased: boolean;
};

function isQuick(kind: MatchAction['kind']): kind is 'QUICK_1' | 'QUICK_2' | 'QUICK_3' {
  return kind === 'QUICK_1' || kind === 'QUICK_2' || kind === 'QUICK_3';
}

export class LocalActionAudioTracker {
  private nextPredictionToken = 1;
  private currentPrediction: PendingPrediction | null = null;
  private readonly pendingPredictions: PendingPrediction[] = [];
  private lastPresentedAttackId: number | null = null;

  private startCue(kind: ActionKind): GameAudioCue | null {
    if (isQuick(kind)) return 'quick';
    if (kind === 'DASH') return 'dash';
    if (kind === 'HEAVY') return 'heavy-charge';
    return null;
  }

  consume(action: MatchAction | null): readonly GameAudioCue[] {
    const cues: GameAudioCue[] = [];
    const kind = action?.kind ?? null;
    const attackId = action?.attackId ?? null;

    if (attackId !== null) {
      if (attackId === this.lastPresentedAttackId) return cues;
      this.lastPresentedAttackId = attackId;

      const pendingIndex = this.pendingPredictions.findIndex((prediction) => prediction.kind === kind);
      const pending = pendingIndex >= 0
        ? this.pendingPredictions.splice(pendingIndex, 1)[0] ?? null
        : null;
      if (!pending && kind !== null) {
        const cue = kind === 'HEAVY' && !action?.charging ? 'heavy-release' : this.startCue(kind);
        if (cue) cues.push(cue);
      } else if (
        kind === 'HEAVY' &&
        !action?.charging &&
        pending &&
        !pending.heavyReleased
      ) {
        cues.push('heavy-release');
      }
      if (pending && this.currentPrediction?.token === pending.token) this.currentPrediction = null;
      return cues;
    }

    if (kind === null) {
      if (this.currentPrediction?.kind === 'HEAVY' && !this.currentPrediction.heavyReleased) {
        const index = this.pendingPredictions.findIndex(
          (prediction) => prediction.token === this.currentPrediction?.token
        );
        if (index >= 0) this.pendingPredictions.splice(index, 1);
      }
      this.currentPrediction = null;
      return cues;
    }

    if (!this.currentPrediction || this.currentPrediction.kind !== kind) {
      if (this.currentPrediction?.kind === 'HEAVY' && !this.currentPrediction.heavyReleased) {
        const index = this.pendingPredictions.findIndex(
          (prediction) => prediction.token === this.currentPrediction?.token
        );
        if (index >= 0) this.pendingPredictions.splice(index, 1);
      }
      this.currentPrediction = {
        token: this.nextPredictionToken++,
        kind,
        chargeMs: action?.chargeMs ?? 0,
        heavyReleased: false
      };
      if (isQuick(kind) || kind === 'HEAVY') this.pendingPredictions.push(this.currentPrediction);
      const cue = this.startCue(kind);
      if (cue) cues.push(cue);
    }

    if (kind === 'HEAVY' && this.currentPrediction) {
      this.currentPrediction.chargeMs = Math.max(this.currentPrediction.chargeMs, action?.chargeMs ?? 0);
      if (!action?.charging && !this.currentPrediction.heavyReleased &&
        this.currentPrediction.chargeMs > 0) {
        cues.push('heavy-release');
        this.currentPrediction.heavyReleased = true;
      }
    }
    return cues;
  }

  reset(): void {
    this.nextPredictionToken = 1;
    this.currentPrediction = null;
    this.pendingPredictions.length = 0;
    this.lastPresentedAttackId = null;
  }
}
