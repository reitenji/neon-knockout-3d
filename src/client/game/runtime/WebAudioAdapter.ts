import { GAME_AUDIO_ASSETS, type AudioPlayOptions, type GameAudioAdapter, type GameAudioCue } from './GameAudio.js';

export class WebAudioAdapter implements GameAudioAdapter {
  private context: AudioContext | null = null;
  private buffers = new Map<GameAudioCue, AudioBuffer>();
  private sources = new Set<AudioBufferSourceNode>();
  private destroyed = false;
  private readonly removers = new Set<() => void>();

  onFirstGesture(listener: () => void): () => void {
    const remove = (): void => { window.removeEventListener('pointerdown', gesture); window.removeEventListener('keydown', gesture); this.removers.delete(remove); };
    const gesture = (): void => { remove(); listener(); };
    window.addEventListener('pointerdown', gesture);
    window.addEventListener('keydown', gesture);
    this.removers.add(remove);
    if (navigator.userActivation?.hasBeenActive) queueMicrotask(() => { if (!this.destroyed) gesture(); });
    return remove;
  }

  unlock(): void {
    if (this.destroyed) return;
    try {
      this.context ??= new AudioContext();
      const context = this.context;
      void context.resume().catch(() => undefined);
      for (const [cue, path] of Object.entries(GAME_AUDIO_ASSETS)) {
        void fetch(path).then((response) => response.arrayBuffer()).then((data) => context.decodeAudioData(data))
          .then((buffer) => { if (!this.destroyed) this.buffers.set(cue as GameAudioCue, buffer); }).catch(() => undefined);
      }
    } catch { /* Audio is optional; gameplay remains available without an audio device. */ }
  }

  play(cue: GameAudioCue, options: AudioPlayOptions): void {
    const context = this.context;
    const buffer = this.buffers.get(cue);
    if (!context || !buffer || this.destroyed || context.state !== 'running') return;
    const source = context.createBufferSource();
    const gain = context.createGain();
    source.buffer = buffer;
    source.detune.value = options.detune;
    gain.gain.value = options.volume * 0.6;
    source.connect(gain).connect(context.destination);
    this.sources.add(source);
    source.onended = () => { source.disconnect(); gain.disconnect(); this.sources.delete(source); };
    source.start();
  }

  stopAll(): void { for (const source of this.sources) source.stop(); this.sources.clear(); }
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    for (const remove of this.removers) remove();
    this.stopAll();
    void this.context?.close().catch(() => undefined);
    this.buffers.clear();
  }
}
