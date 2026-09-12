import { describe, expect, it } from 'vitest';
import type { GameEvent } from '../../../shared/model.js';
import {
  GAME_AUDIO_ASSETS, GameAudio, detuneForEvent, type AudioPlayOptions, type GameAudioAdapter, type GameAudioCue
} from './GameAudio.js';

type PlayedCue = Readonly<{ cue: GameAudioCue; options: AudioPlayOptions }>;

class RecordingAudioAdapter implements GameAudioAdapter {
  readonly played: PlayedCue[] = [];
  gestureListener: (() => void) | null = null;
  unlocks = 0;
  stops = 0;
  destroys = 0;
  removedGestures = 0;

  onFirstGesture(listener: () => void): () => void {
    this.gestureListener = listener;
    return () => {
      this.removedGestures += 1;
      this.gestureListener = null;
    };
  }
  unlock(): void { this.unlocks += 1; }
  play(cue: GameAudioCue, options: AudioPlayOptions): void { this.played.push({ cue, options }); }
  stopAll(): void { this.stops += 1; }
  destroy(): void { this.destroys += 1; }

  gesture(): void { this.gestureListener?.(); }
}

function hit(eventId = 42, attack: 'QUICK_1' | 'HEAVY' = 'QUICK_1'): GameEvent {
  return {
    eventId, tick: 9, type: 'HIT', attackerId: 'a', targetId: 'b', attack,
    impactPosition: { x: 20, y: 30 }, impulse: 380, resultingOverload: 60
  };
}

describe('GameAudio', () => {
  it('waits for one user gesture, then layers deterministic attack and contact cues once per event ID', () => {
    const adapter = new RecordingAudioAdapter();
    const audio = new GameAudio(adapter);

    expect(audio.playEvent(hit())).toBe(true);
    expect(adapter.played).toEqual([]);

    adapter.gesture();
    adapter.gesture();
    expect(adapter.unlocks).toBe(1);
    expect(adapter.removedGestures).toBe(1);

    expect(audio.playEvent(hit(43))).toBe(true);
    expect(audio.playEvent(hit(43))).toBe(false);
    expect(adapter.played).toEqual([
      { cue: 'quick', options: { volume: 0.56, detune: detuneForEvent(43, 0) } },
      { cue: 'hit', options: { volume: 0.72, detune: detuneForEvent(43, 1) } }
    ]);
  });

  it('uses the heavy release layer for confirmed heavy hits', () => {
    const adapter = new RecordingAudioAdapter();
    const audio = new GameAudio(adapter);
    adapter.gesture();

    audio.playEvent(hit(12, 'HEAVY'));

    expect(adapter.played.map(({ cue }) => cue)).toEqual(['heavy-release', 'hit']);
  });

  it('stops every active sound immediately on mute and stays silent until unmuted', () => {
    const adapter = new RecordingAudioAdapter();
    const audio = new GameAudio(adapter);
    adapter.gesture();
    audio.playCue('dash', 5);

    audio.setMuted(true);
    audio.playEvent({
      eventId: 6, tick: 10, type: 'KNOCKOUT', attackerId: 'a', targetId: 'b',
      scoreAwardedTo: 'a', scores: { a: 1, b: 0 }
    });
    expect(adapter.stops).toBe(1);
    expect(adapter.played.map(({ cue }) => cue)).toEqual(['dash']);

    audio.setMuted(false);
    audio.playEvent({ eventId: 7, tick: 11, type: 'RESPAWN', playerId: 'b', position: { x: 10, y: 10 } });
    expect(adapter.played.at(-1)?.cue).toBe('respawn');
  });

  it('maps match phases and results to their dedicated cues', () => {
    const adapter = new RecordingAudioAdapter();
    const audio = new GameAudio(adapter);
    adapter.gesture();

    const events: GameEvent[] = [
      { eventId: 1, tick: 1, type: 'PHASE', phase: 'COUNTDOWN', remainingMs: 3_000 },
      { eventId: 2, tick: 2, type: 'PHASE', phase: 'SUDDEN_DEATH', remainingMs: 0 },
      { eventId: 3, tick: 3, type: 'RESULT', winnerPlayerId: 'a', reason: 'TARGET_SCORE', scores: { a: 5 } }
    ];
    for (const event of events) audio.playEvent(event);

    expect(adapter.played.map(({ cue }) => cue)).toEqual(['countdown', 'warning', 'victory']);
  });

  it('maps every counterplay event to its own deduplicated cue with stable event detune', () => {
    const adapter = new RecordingAudioAdapter();
    const audio = new GameAudio(adapter);
    adapter.gesture();
    const events: GameEvent[] = [
      {
        eventId: 20, tick: 5, type: 'CLASH', playerIds: ['a', 'b'], attackIds: [1, 2],
        impactPosition: { x: 20, y: 30 }, strength: 'QUICK'
      },
      {
        eventId: 21, tick: 5, type: 'PERFECT_DODGE', playerId: 'b', attackerId: 'a', attackId: 1,
        source: 'QUICK_1', projectileId: null, impactPosition: { x: 20, y: 30 }, refundedMs: 550
      },
      {
        eventId: 22, tick: 5, type: 'PULSE_SPAWN', projectileId: 3, ownerPlayerId: 'a',
        originatingAttackId: 4, position: { x: 20, y: 30 }
      },
      {
        eventId: 23, tick: 6, type: 'PULSE_BREAK', projectileId: 3, breakerPlayerId: 'b',
        breakerAttackId: 5, impactPosition: { x: 30, y: 30 }
      }
    ];
    for (const event of events) {
      expect(audio.playEvent(event)).toBe(true);
      expect(audio.playEvent(event)).toBe(false);
    }

    expect(adapter.played).toEqual([
      { cue: 'clash', options: { volume: 0.72, detune: detuneForEvent(20) } },
      { cue: 'perfect-dodge', options: { volume: 0.68, detune: detuneForEvent(21) } },
      { cue: 'pulse-spawn', options: { volume: 0.78, detune: detuneForEvent(22) } },
      { cue: 'pulse-break', options: { volume: 0.76, detune: detuneForEvent(23) } }
    ]);
    expect(GAME_AUDIO_ASSETS).toMatchObject({
      clash: '/assets/audio/clash.wav',
      'perfect-dodge': '/assets/audio/perfect-dodge.wav',
      'pulse-spawn': '/assets/audio/pulse-spawn.wav',
      'pulse-break': '/assets/audio/pulse-break.wav'
    });
  });

  it('coalesces simultaneous knockout events to one burst while preserving later knockout ticks', () => {
    const adapter = new RecordingAudioAdapter();
    const audio = new GameAudio(adapter);
    adapter.gesture();

    expect(audio.playEvent({
      eventId: 30, tick: 18, type: 'KNOCKOUT', attackerId: 'a', targetId: 'b',
      scoreAwardedTo: 'a', scores: { a: 2, b: 0 }
    })).toBe(true);
    expect(audio.playEvent({
      eventId: 31, tick: 18, type: 'KNOCKOUT', attackerId: 'c', targetId: 'd',
      scoreAwardedTo: 'c', scores: { a: 2, b: 0, c: 1, d: 0 }
    })).toBe(true);
    expect(audio.playEvent({
      eventId: 32, tick: 19, type: 'KNOCKOUT', attackerId: 'a', targetId: 'd',
      scoreAwardedTo: 'a', scores: { a: 3, b: 0, c: 1, d: 0 }
    })).toBe(true);

    expect(adapter.played).toEqual([
      { cue: 'knockout', options: { volume: 0.92, detune: detuneForEvent(30) } },
      { cue: 'knockout', options: { volume: 0.92, detune: detuneForEvent(32) } }
    ]);
  });

  it('removes the gesture listener, stops sound, and destroys owned sounds once on teardown', () => {
    const adapter = new RecordingAudioAdapter();
    const audio = new GameAudio(adapter);

    audio.dispose();
    audio.dispose();

    expect(adapter.removedGestures).toBe(1);
    expect(adapter.stops).toBe(1);
    expect(adapter.destroys).toBe(1);
    adapter.gesture();
    expect(adapter.unlocks).toBe(0);
    expect(audio.playCue('quick', 99)).toBe(false);
  });
});
