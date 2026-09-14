import * as THREE from 'three';
import { GAME } from '../../../shared/constants.js';
import type { MatchAction, MatchPlayer, MatchPulse, MatchSnapshot, Vec2 } from '../../../shared/model.js';
import { localPlayerIdFromBridge, type GamePresentationBridge, type NeonGameFactory } from '../GamePresentationBridge.js';
import { SnapshotTimeline, extrapolateRemotePlayer, interpolateRemotePlayer } from '../prediction.js';
import { ArenaInput } from '../runtime/ArenaInput.js';
import { createDomInputSource } from '../runtime/DomInputSource.js';
import { combineArenaInputSources } from '../runtime/TouchInputSource.js';
import { ArenaSession } from '../runtime/ArenaSession.js';
import { GameAudio } from '../runtime/GameAudio.js';
import { WebAudioAdapter } from '../runtime/WebAudioAdapter.js';
import { LocalActionAudioTracker } from '../runtime/LocalActionAudioTracker.js';
import { AttackTelegraphTracker } from '../runtime/attackTelegraphTracker.js';
import { createFighterView, type FighterView, type ChargeIndicatorState } from './FighterView.js';
import { createPulseView, type PulseView } from './PulseView.js';
import { createArenaWorld } from './ArenaWorld.js';
import { CombatEffects } from './CombatEffects.js';
const INPUT_STEP_MS = 1_000 / 60;

function playerById(snapshot: MatchSnapshot, playerId: string): MatchPlayer | null {
  return snapshot.players.find((player) => player.playerId === playerId) ?? null;
}

function pulseById(snapshot: MatchSnapshot, projectileId: number): MatchPulse | null {
  return snapshot.pulses.find((pulse) => pulse.projectileId === projectileId) ?? null;
}

function interpolatePulse(previous: MatchPulse, current: MatchPulse, alpha: number): MatchPulse {
  const progress = Math.max(0, Math.min(1, alpha));
  return {
    ...current,
    position: {
      x: previous.position.x + (current.position.x - previous.position.x) * progress,
      y: previous.position.y + (current.position.y - previous.position.y) * progress
    },
    remainingMs: previous.remainingMs + (current.remainingMs - previous.remainingMs) * progress
  };
}

function chargeIndicator(
  player: MatchPlayer,
  presentationFacing: Vec2,
  predictedAction: MatchAction | null
): ChargeIndicatorState | null {
  const predictedCharge = predictedAction && predictedAction.chargeMs > 0 &&
    (predictedAction.kind === null || predictedAction.kind === 'HEAVY')
    ? predictedAction
    : null;
  const action = predictedCharge ?? player.action;
  if (action.chargeMs <= 0 || (action.kind !== null && action.kind !== 'HEAVY')) return null;
  const releasedFacing = action.kind === 'HEAVY' && !action.charging ? action.lockedFacing : null;
  return {
    facing: releasedFacing ?? presentationFacing,
    progress: Math.max(0, Math.min(1, action.chargeMs / GAME.heavyMaxChargeMs)),
    pulseReady: action.chargeMs >= GAME.heavyMaxChargeMs
  };
}

type E2eTimelineObserver = Readonly<{
  inputs?: Array<Readonly<{
    sequence: number;
    sampledAtMs: number;
  }>>;
  acceptedSnapshots?: unknown[];
  reconciliations?: unknown[];
  localPresentations?: Array<Readonly<{
    inputSequence: number;
    sampledAtMs: number;
    renderedAtMs: number;
    actionKind: string | null;
    positionX: number;
    positionY: number;
  }>>;
  timelineSamples?: Array<Readonly<{
    sampledAtMs: number;
    targetTick: number | null;
    delayFrames: number;
    rollbackFrames: number;
    extrapolatedFrames: number;
    bufferUnderrun: boolean;
    transport: string | null;
    pingMs: number | null;
  }>>;
}>;

function e2eObserver(): E2eTimelineObserver | null {
  const candidate = (globalThis as typeof globalThis & { __NEON_E2E_INPUT_OBSERVER__?: unknown })
    .__NEON_E2E_INPUT_OBSERVER__;
  if (typeof candidate !== 'object' || candidate === null) return null;
  return candidate as E2eTimelineObserver;
}

function pushBounded<T>(values: T[], value: T, limit = 256): void {
  values.push(value);
  if (values.length > limit) values.splice(0, values.length - limit);
}

export class ThreeGame {
  private readonly localPlayerId: string | null;
  private readonly timeline = new SnapshotTimeline();
  private readonly views = new Map<string, FighterView>();
  private readonly pulseViews = new Map<number, PulseView>();
  private readonly activePlayerIds = new Set<string>();
  private readonly activePulseIds = new Set<number>();
  private readonly retiredPulseIds = new Set<number>();
  private readonly consumedEventIds = new Set<number>();
  private readonly localActionAudio = new LocalActionAudioTracker();
  private readonly attackTelegraphs = new AttackTelegraphTracker();
  private readonly unsubscribers: Array<() => void> = [];
  private readonly renderer: THREE.WebGLRenderer;
  private readonly world = createArenaWorld();
  private readonly effects: CombatEffects;
  private readonly resizeObserver: ResizeObserver;
  private session: ArenaSession;
  private gameAudio: GameAudio;
  private localCueSequence = 0;
  private resultPresented = false;
  private cleaned = false;
  private raf = 0;
  private latestAcceptedSnapshotTick: number | null = null;
  private latestAcceptedSnapshot: MatchSnapshot | null = null;
  private latestAcceptedSnapshotAtMs: number | null = null;
  private presentationTargetTick: number | null = null;
  private connected: boolean;

  constructor(private readonly parent: HTMLElement, private readonly bridge: GamePresentationBridge, private readonly reducedMotion: boolean) {
    this.localPlayerId = localPlayerIdFromBridge(bridge);
    this.connected = bridge.isConnected();
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.2;
    this.renderer.domElement.className = 'game-canvas';
    this.renderer.domElement.dataset.renderer = 'three';
    parent.append(this.renderer.domElement);
    this.effects = new CombatEffects(this.world.scene, reducedMotion);
    this.gameAudio = new GameAudio(new WebAudioAdapter());
    const keyboard = createDomInputSource();
    const source = bridge.inputSource ? combineArenaInputSources(keyboard, bridge.inputSource) : keyboard;
    const input = new ArenaInput(source, { windowTarget: window, documentTarget: document, onShutdown: () => () => undefined });
    this.session = new ArenaSession(bridge, this.localPlayerId ?? '', input, () => performance.now(),
      (snapshot, now) => this.acceptTimelineSnapshot(snapshot, now),
      () => ({ rollbackWindowFrames: this.timeline.rollbackWindowFrames(), targetTick: this.presentationTargetTick }));
    this.session.start();
    this.unsubscribers.push(bridge.subscribeConnected((connected) => this.acceptConnection(connected)), bridge.subscribeEvent((event) => {
      if (this.consumedEventIds.has(event.eventId)) return;
      this.consumedEventIds.add(event.eventId);
      if (event.type === 'PULSE_BREAK' || (event.type === 'PERFECT_DODGE' && event.projectileId !== null)) {
        this.retiredPulseIds.add(event.projectileId!); this.destroyPulseView(event.projectileId!);
      }
      if (event.type === 'RESULT') { this.resultPresented = true; this.clearPulseViews(); }
      const snapshot = bridge.getSnapshot();
      if (snapshot) {
        this.effects.ingest(event, snapshot);
        if (event.type === 'HIT') {
          const attacker = snapshot.players.find(player => player.playerId === event.attackerId);
          if (attacker) {
            this.views.get(event.targetId)?.contact(event, attacker.position);
            this.views.get(event.attackerId)?.contact(event, attacker.position);
          }
        }
      }
      this.gameAudio.playEvent(event);
    }), bridge.subscribeMuted((muted) => this.gameAudio.setMuted(muted)));
    const resize = (): void => {
      const { width, height } = parent.getBoundingClientRect();
      this.renderer.setSize(Math.max(1, width), Math.max(1, height));
      this.world.resize(width, height);
    };
    this.resizeObserver = new ResizeObserver(resize); this.resizeObserver.observe(parent); resize();
    const frame = (): void => {
      if (this.cleaned) return;
      this.session.step(INPUT_STEP_MS);
      if (this.connected) this.renderPresentation(performance.now());
      this.effects.update(performance.now());
      this.renderer.render(this.world.scene, this.world.camera);
      this.renderer.domElement.dataset.fighters = String(this.views.size);
      this.raf = requestAnimationFrame(frame);
    };
    this.raf = requestAnimationFrame(frame);
  }

  private acceptTimelineSnapshot(snapshot: MatchSnapshot, receivedAtMs: number): void {
    if (!this.connected) return;
    if (this.latestAcceptedSnapshotTick !== null && snapshot.tick <= this.latestAcceptedSnapshotTick) return;
    this.timeline.push(snapshot, receivedAtMs);
    this.latestAcceptedSnapshotTick = snapshot.tick;
    this.latestAcceptedSnapshot = snapshot;
    this.latestAcceptedSnapshotAtMs = receivedAtMs;
  }

  private acceptConnection(connected: boolean): void {
    if (this.connected === connected) return;
    this.connected = connected;
    if (connected) return;
    this.timeline.clear();
    this.latestAcceptedSnapshotTick = null;
    this.latestAcceptedSnapshot = null;
    this.latestAcceptedSnapshotAtMs = null;
    this.presentationTargetTick = null;
  }

  private renderPresentation(nowMs: number): void {
    const localNetwork = this.localPlayerId === null || this.latestAcceptedSnapshot === null
      ? null
      : this.latestAcceptedSnapshot.network[this.localPlayerId] ?? null;
    this.timeline.updateNetwork({
      medianRttMs: localNetwork?.medianMs ?? null,
      transportJitterMs: localNetwork?.jitterMs ?? null,
      arrivalJitterMs: this.timeline.arrivalJitterMs(),
      bufferUnderrun: this.timeline.bufferUnderrun(),
      sampledAtMs: this.latestAcceptedSnapshotAtMs ?? nowMs
    });
    const sample = this.timeline.sample(nowMs);
    this.presentationTargetTick = sample.targetTick;
    this.bridge.publishPresentationDelay?.(this.timeline.delayMs());
    this.bridge.publishBufferUnderrun?.(sample.bufferUnderrun);
    this.bridge.publishExtrapolatedFrames?.(sample.extrapolatedFrames);
    const observer = e2eObserver();
    if (observer?.timelineSamples) {
      pushBounded(observer.timelineSamples, {
        sampledAtMs: nowMs,
        targetTick: sample.targetTick,
        delayFrames: sample.delayFrames,
        rollbackFrames: this.timeline.rollbackWindowFrames(),
        extrapolatedFrames: sample.extrapolatedFrames,
        bufferUnderrun: sample.bufferUnderrun,
        transport: localNetwork?.transport ?? null,
        pingMs: localNetwork?.medianMs ?? null
      });
    }
    const frame = sample.frame;
    if (!frame) return;
    this.world.update(frame.current.platformProgress);
    const localPresentation = this.session?.getLocalPresentation() ?? null;
    this.reconcilePulses(frame.previous, frame.current, frame.alpha);
    const activeIds = this.activePlayerIds;
    activeIds.clear();
    for (const currentPlayer of frame.current.players) {
      activeIds.add(currentPlayer.playerId);
      const isLocal = currentPlayer.playerId === this.localPlayerId;
      const view = this.views.get(currentPlayer.playerId) ?? this.addView(currentPlayer, isLocal);
      const previousPlayer = playerById(frame.previous, currentPlayer.playerId) ?? currentPlayer;
      if (isLocal && localPresentation) {
        const telegraph = this.attackTelegraphs.telegraph(
          currentPlayer.playerId,
          previousPlayer,
          currentPlayer,
          localPresentation.actionStart,
          localPresentation.facing,
          nowMs,
          true
        );
        const canPresentLocalAction = (frame.current.phase === 'REGULATION' || frame.current.phase === 'SUDDEN_DEATH') &&
          currentPlayer.hitstunRemainingMs <= 0 && currentPlayer.respawnRemainingMs <= 0;
        if (canPresentLocalAction) {
          for (const cue of this.localActionAudio.consume(localPresentation.actionStart)) {
            this.gameAudio?.playCue(cue, ++this.localCueSequence);
          }
        } else {
          this.localActionAudio.reset();
        }
        view.apply(
          currentPlayer,
          localPresentation.position,
          localPresentation.facing,
          localPresentation.actionStart,
          telegraph,
          chargeIndicator(currentPlayer, localPresentation.facing, localPresentation.actionStart)
        );
        const latestInput = observer?.inputs?.at(-1);
        if (observer?.localPresentations && latestInput) {
          pushBounded(observer.localPresentations, {
            inputSequence: latestInput.sequence,
            sampledAtMs: latestInput.sampledAtMs,
            renderedAtMs: nowMs,
            actionKind: localPresentation.actionStart?.kind ?? null,
            positionX: localPresentation.position.x,
            positionY: localPresentation.position.y
          });
        }
        continue;
      }
      const telegraph = this.attackTelegraphs.telegraph(
        currentPlayer.playerId,
        previousPlayer,
        currentPlayer,
        null,
        currentPlayer.facing,
        nowMs,
        false
      );
      const position = !isLocal && sample.extrapolatedFrames > 0
        ? extrapolateRemotePlayer(currentPlayer, sample.extrapolatedFrames)
        : interpolateRemotePlayer(previousPlayer, currentPlayer, frame.alpha);
      view.apply(
        currentPlayer,
        position,
        currentPlayer.facing,
        null,
        telegraph,
        chargeIndicator(currentPlayer, currentPlayer.facing, null)
      );
    }
    for (const [playerId, view] of this.views) {
      if (activeIds.has(playerId)) continue;
      view.destroy();
      this.views.delete(playerId);
    }
    this.attackTelegraphs.prune(activeIds);
  }

  private addView(player: MatchPlayer, isLocal: boolean): FighterView {
    const view = createFighterView(this.world.scene, this.world.camera, this.parent, player, isLocal, this.reducedMotion);
    this.views.set(player.playerId, view);
    return view;
  }

  private reconcilePulses(previousSnapshot: MatchSnapshot, snapshot: MatchSnapshot, alpha: number): void {
    const activeIds = this.activePulseIds;
    activeIds.clear();
    if (this.resultPresented || snapshot.phase === 'FINISHED' || snapshot.winnerPlayerId !== null) {
      this.clearPulseViews();
      return;
    }
    for (const pulse of snapshot.pulses) {
      if (this.retiredPulseIds.has(pulse.projectileId)) continue;
      activeIds.add(pulse.projectileId);
      const previousPulse = pulseById(previousSnapshot, pulse.projectileId);
      const presentation = previousPulse ? interpolatePulse(previousPulse, pulse, alpha) : pulse;
      const existing = this.pulseViews.get(pulse.projectileId);
      if (existing) existing.apply(presentation);
      else this.pulseViews.set(pulse.projectileId, createPulseView(this.world.scene, presentation));
    }
    for (const projectileId of this.pulseViews.keys()) {
      if (!activeIds.has(projectileId)) this.destroyPulseView(projectileId);
    }
  }

  private destroyPulseView(projectileId: number): void {
    const view = this.pulseViews.get(projectileId);
    if (!view) return;
    view.destroy();
    this.pulseViews.delete(projectileId);
  }

  private clearPulseViews(): void {
    for (const view of this.pulseViews.values()) view.destroy();
    this.pulseViews.clear();
  }

  destroy(): void {
    if (this.cleaned) return;
    this.cleaned = true;
    cancelAnimationFrame(this.raf);
    this.resizeObserver.disconnect();
    this.unsubscribers.splice(0).forEach((unsubscribe) => unsubscribe());
    this.session.dispose(); this.timeline.clear(); this.gameAudio.dispose(); this.effects.dispose();
    for (const view of this.views.values()) view.destroy();
    this.views.clear(); this.clearPulseViews(); this.world.dispose();
    this.renderer.dispose(); this.renderer.forceContextLoss(); this.renderer.domElement.remove();
  }
}

export const createThreeGame: NeonGameFactory = (parent, bridge, options) => new ThreeGame(parent, bridge, options?.reducedMotion ?? false);
