import type { GameEvent } from '../../../shared/model.js';

export const GAME_AUDIO_CUES = [
  'quick', 'heavy-charge', 'heavy-release', 'hit', 'dash', 'clash', 'perfect-dodge', 'pulse-spawn', 'pulse-break',
  'knockout', 'respawn', 'countdown', 'warning', 'victory'
] as const;

export type GameAudioCue = (typeof GAME_AUDIO_CUES)[number];
export type AudioPlayOptions = Readonly<{ volume: number; detune: number }>;

export const GAME_AUDIO_ASSETS: Readonly<Record<GameAudioCue, string>> = Object.freeze({
  quick: '/assets/audio/quick.wav',
  'heavy-charge': '/assets/audio/heavy-charge.wav',
  'heavy-release': '/assets/audio/heavy-release.wav',
  hit: '/assets/audio/hit.wav',
  dash: '/assets/audio/dash.wav',
  clash: '/assets/audio/clash.wav',
  'perfect-dodge': '/assets/audio/perfect-dodge.wav',
  'pulse-spawn': '/assets/audio/pulse-spawn.wav',
  'pulse-break': '/assets/audio/pulse-break.wav',
  knockout: '/assets/audio/knockout.wav',
  respawn: '/assets/audio/respawn.wav',
  countdown: '/assets/audio/countdown.wav',
  warning: '/assets/audio/warning.wav',
  victory: '/assets/audio/victory.wav'
});

export interface GameAudioAdapter {
  onFirstGesture(listener: () => void): () => void;
  unlock(): void;
  play(cue: GameAudioCue, options: AudioPlayOptions): void;
  stopAll(): void;
  destroy(): void;
}

export function detuneForEvent(eventId: number, layer = 0): number {
  const stableId = Math.max(0, Math.trunc(eventId));
  const stableLayer = Math.max(0, Math.trunc(layer));
  return ((stableId * 29 + stableLayer * 17) % 81) - 40;
}

export class GameAudio {
  private readonly consumedEventIds = new Set<number>();
  private removeGestureListener: (() => void) | null;
  private muted: boolean;
  private unlocked = false;
  private disposed = false;
  private lastKnockoutTick: number | null = null;

  constructor(
    private readonly adapter: GameAudioAdapter,
    options: Readonly<{ muted?: boolean }> = {}
  ) {
    this.muted = options.muted ?? false;
    this.removeGestureListener = adapter.onFirstGesture(() => this.unlock());
  }

  setMuted(muted: boolean): void {
    if (this.disposed || muted === this.muted) return;
    this.muted = muted;
    if (muted) this.adapter.stopAll();
  }

  playEvent(event: GameEvent): boolean {
    if (this.disposed || this.consumedEventIds.has(event.eventId)) return false;
    this.consumedEventIds.add(event.eventId);
    if (!this.canPlay()) return true;

    if (event.type === 'HIT') {
      const attackCue: GameAudioCue = event.attack === 'HEAVY' ? 'heavy-release' : 'quick';
      this.play(attackCue, event.eventId, 0, event.attack === 'HEAVY' ? 0.76 : 0.56);
      this.play('hit', event.eventId, 1, event.attack === 'HEAVY' ? 0.86 : 0.72);
    } else if (event.type === 'CLASH') {
      this.play('clash', event.eventId, 0, 0.72);
    } else if (event.type === 'PERFECT_DODGE') {
      this.play('perfect-dodge', event.eventId, 0, 0.68);
    } else if (event.type === 'PULSE_SPAWN') {
      this.play('pulse-spawn', event.eventId, 0, 0.78);
    } else if (event.type === 'PULSE_BREAK') {
      this.play('pulse-break', event.eventId, 0, 0.76);
    } else if (event.type === 'KNOCKOUT') {
      if (this.lastKnockoutTick === event.tick) return true;
      this.lastKnockoutTick = event.tick;
      this.play('knockout', event.eventId, 0, 0.92);
    } else if (event.type === 'RESPAWN') {
      this.play('respawn', event.eventId, 0, 0.66);
    } else if (event.type === 'PHASE' && event.phase === 'COUNTDOWN') {
      this.play('countdown', event.eventId, 0, 0.62);
    } else if (event.type === 'PHASE' && event.phase === 'SUDDEN_DEATH') {
      this.play('warning', event.eventId, 0, 0.76);
    } else if (event.type === 'RESULT' && event.winnerPlayerId !== null) {
      this.play('victory', event.eventId, 0, 0.82);
    }
    return true;
  }

  playCue(cue: GameAudioCue, eventId: number, layer = 0): boolean {
    if (!this.canPlay()) return false;
    this.play(cue, eventId, layer, 0.64);
    return true;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.removeGestureListener?.();
    this.removeGestureListener = null;
    this.adapter.stopAll();
    this.adapter.destroy();
    this.consumedEventIds.clear();
    this.lastKnockoutTick = null;
  }

  private unlock(): void {
    if (this.disposed || this.unlocked) return;
    this.removeGestureListener?.();
    this.removeGestureListener = null;
    this.adapter.unlock();
    this.unlocked = true;
  }

  private canPlay(): boolean { return !this.disposed && this.unlocked && !this.muted; }

  private play(cue: GameAudioCue, eventId: number, layer: number, volume: number): void {
    this.adapter.play(cue, { volume, detune: detuneForEvent(eventId, layer) });
  }
}
