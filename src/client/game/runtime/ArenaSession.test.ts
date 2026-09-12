import { afterEach, describe, expect, it } from 'vitest';
import type { GameEvent, InputFrame, MatchPlayer, MatchSnapshot } from '../../../shared/model.js';
import { DEFAULT_ROOM_SETTINGS } from '../../../shared/roomSettings.js';
import type { GamePresentationBridge } from '../GamePresentationBridge.js';
import type { ReconciliationResult } from '../prediction.js';
import { ArenaInput, type ArenaInputSource } from './ArenaInput.js';
import { ArenaSession } from './ArenaSession.js';

const idleAction = {
  kind: null, phase: 'IDLE', comboStep: 0, chargeMs: 0, charging: false,
  attackId: null, profileId: null, lockedFacing: null, activeProgress: 0, hitTargetIds: []
} as const;

function player(overrides: Partial<MatchPlayer> = {}): MatchPlayer {
  return { playerId: 'p-local', name: 'Ada', chassis: 'RIFT', accent: 0, position: { x: 100, y: 100 }, velocity: { x: 0, y: 0 }, facing: { x: 0, y: -1 }, overload: 0, lastProcessedInputSeq: -1, action: idleAction, dashRemainingMs: 0, dashCooldownRemainingMs: 0, hitstunRemainingMs: 0, respawnRemainingMs: 0, protectionRemainingMs: 0, stats: { knockouts: 0, falls: 0, landedHits: 0, completedAttacks: 0 }, ...overrides };
}

function snapshot(local = player()): MatchSnapshot {
  return {
    tick: 1,
    phase: 'REGULATION',
    remainingMs: 100_000,
    platformProgress: 0,
    settings: DEFAULT_ROOM_SETTINGS,
    scores: { 'p-local': 0 },
    network: { 'p-local': { currentMs: null, medianMs: null, jitterMs: null, transport: 'websocket' } },
    players: [local],
    pulses: [],
    winnerPlayerId: null,
    resultReason: null
  };
}

class Bridge implements GamePresentationBridge {
  connected = true;
  current: MatchSnapshot | null = snapshot();
  private nextInputSequence = 0;
  readonly sent: InputFrame[] = [];
  readonly rollbackFrames: Array<number | null> = [];
  readonly reconciliations: ReconciliationResult[] = [];
  readonly snapshotListeners = new Set<(value: MatchSnapshot) => void>();
  readonly connectionListeners = new Set<(value: boolean) => void>();
  readonly eventListeners = new Set<(value: GameEvent) => void>();
  readonly mutedListeners = new Set<(value: boolean) => void>();
  getSnapshot = (): MatchSnapshot | null => this.current;
  isConnected = (): boolean => this.connected;
  subscribeSnapshot = (listener: (value: MatchSnapshot) => void): (() => void) => { this.snapshotListeners.add(listener); return () => this.snapshotListeners.delete(listener); };
  subscribeConnected = (listener: (value: boolean) => void): (() => void) => { this.connectionListeners.add(listener); listener(this.connected); return () => this.connectionListeners.delete(listener); };
  subscribeEvent = (listener: (value: GameEvent) => void): (() => void) => { this.eventListeners.add(listener); return () => this.eventListeners.delete(listener); };
  subscribeMuted = (listener: (value: boolean) => void): (() => void) => { this.mutedListeners.add(listener); return () => this.mutedListeners.delete(listener); };
  publishRollbackFrames = (frames: number | null): void => { this.rollbackFrames.push(frames); };
  publishReconciliation = (result: ReconciliationResult): void => { this.reconciliations.push(result); };
  reserveInputSequence = (minimum: number): number => {
    const sequence = Math.max(this.nextInputSequence, minimum);
    this.nextInputSequence = sequence + 1;
    return sequence;
  };
  sendInput = (frame: InputFrame): void => { this.sent.push(frame); };
  setConnected(connected: boolean): void { this.connected = connected; for (const listener of this.connectionListeners) listener(connected); }
}

function controls(): ArenaInputSource & { movementHeld: Record<'up' | 'down' | 'left' | 'right' | 'dash', boolean>; attackHeld: Record<'quick' | 'heavy', boolean> } {
  const movementHeld = { up: false, down: false, left: false, right: false, dash: false };
  const attackHeld = { quick: false, heavy: false };
  return {
    movementHeld, attackHeld, movement: () => ({ ...movementHeld }), attack: () => ({ ...attackHeld }),
    reset() {},
    dispose() {}
  };
}

describe('ArenaSession', () => {
  afterEach(() => {
    delete (globalThis as typeof globalThis & { __NEON_E2E_INPUT_OBSERVER__?: unknown })
      .__NEON_E2E_INPUT_OBSERVER__;
  });

  it('records sampled inputs and authoritative reconciliation while leaving rendered presentation to the scene observer', () => {
    const observer = {
      inputs: [] as unknown[],
      acceptedSnapshots: [] as unknown[],
      reconciliations: [] as unknown[],
      localPresentations: [] as unknown[]
    };
    (globalThis as typeof globalThis & { __NEON_E2E_INPUT_OBSERVER__?: typeof observer })
      .__NEON_E2E_INPUT_OBSERVER__ = observer;
    const bridge = new Bridge();
    bridge.current = snapshot(player({ position: { x: 640, y: 360 } }));
    const source = controls();
    let now = 10;
    const session = new ArenaSession(bridge, 'p-local', new ArenaInput(source), () => now);
    session.start();

    source.movementHeld.right = true;
    now = 20;
    session.step(16);
    bridge.current = {
      ...snapshot(player({ position: { x: 640, y: 360 }, lastProcessedInputSeq: 0 })),
      tick: 2
    };
    now = 35;
    for (const listener of bridge.snapshotListeners) listener(bridge.current);

    expect(observer.inputs).toContainEqual(expect.objectContaining({
      sequence: 0, sampledAtMs: 20, viewTick: 1, moveX: 1, quick: false, dash: false
    }));
    expect(observer.acceptedSnapshots).toContainEqual(expect.objectContaining({
      tick: 2,
      lastProcessedInputSeq: 0,
      acceptedAtMs: 35,
      transport: 'websocket',
      pingMs: null
    }));
    expect(observer.localPresentations).toEqual([]);
    expect(observer.reconciliations).toContainEqual(expect.objectContaining({
      authoritativeTick: 2,
      rollbackFrames: 0,
      hardSnap: false
    }));
    expect((observer.reconciliations as ReconciliationResult[]).at(1)?.correctionDistancePx)
      .toBeCloseTo(0.6144, 10);

    for (let index = 0; index < 300; index += 1) {
      now += 1;
      bridge.current = { ...snapshot(player({ lastProcessedInputSeq: index })), tick: index + 3 };
      for (const listener of bridge.snapshotListeners) listener(bridge.current);
    }
    expect(observer.acceptedSnapshots).toHaveLength(256);
  });

  it('clears countdown-held combat without forcing a fresh release when regulation begins', () => {
    const bridge = new Bridge();
    bridge.current = { ...snapshot(), phase: 'COUNTDOWN' };
    const source = controls();
    let now = 0;
    const session = new ArenaSession(bridge, 'p-local', new ArenaInput(source), () => now);
    session.start();

    source.attackHeld.quick = true;
    source.movementHeld.right = true;
    session.step(16);
    expect(bridge.sent).toHaveLength(0);

    bridge.current = snapshot(player({ lastProcessedInputSeq: -1 }));
    for (const listener of bridge.snapshotListeners) listener(bridge.current);
    now += 17;
    session.step(16);

    expect(bridge.sent.at(-1)).toMatchObject({ quick: true, moveX: 1, aimX: 1, aimY: 0 });
  });

  it('keeps input sequences monotonic when the arena remounts for a rematch', () => {
    const bridge = new Bridge();
    let now = 0;
    const firstSession = new ArenaSession(bridge, 'p-local', new ArenaInput(controls()), () => now);
    firstSession.start();
    firstSession.step(16);
    firstSession.dispose();

    bridge.current = snapshot(player({ lastProcessedInputSeq: -1 }));
    now += 17;
    const rematchSession = new ArenaSession(bridge, 'p-local', new ArenaInput(controls()), () => now);
    rematchSession.start();
    rematchSession.step(16);

    expect(bridge.sent.map((frame) => frame.seq)).toEqual([0, 1]);
  });

  it('stops immediately on disconnect and suppresses held keyboard combat through reconnect until release', () => {
    const bridge = new Bridge();
    const source = controls();
    let now = 0;
    const session = new ArenaSession(bridge, 'p-local', new ArenaInput(source), () => now);
    session.start();
    source.movementHeld.right = true;
    source.attackHeld.heavy = true;
    expect(session.step(16)!.position.x).toBeGreaterThan(100);
    expect(bridge.sent.at(-1)?.heavy).toBe(true);
    bridge.setConnected(false);
    expect(session.getLocalPresentation()?.position).toEqual({ x: 100, y: 100 });
    now += 17;
    session.step(16);
    expect(bridge.sent).toHaveLength(1);
    bridge.setConnected(true);
    now += 17;
    session.step(16);
    expect(bridge.sent.at(-1)?.heavy).toBe(false);
    source.movementHeld.right = false;
    source.attackHeld.heavy = false;
    now += 17;
    session.step(16);
    source.movementHeld.right = true;
    source.attackHeld.heavy = true;
    now += 17;
    session.step(16);
    expect(bridge.sent.at(-1)?.heavy).toBe(true);
  });

  it('publishes the local replay span as rollback frames on each authoritative snapshot', () => {
    const bridge = new Bridge();
    const source = controls();
    let now = 0;
    const session = new ArenaSession(bridge, 'p-local', new ArenaInput(source), () => now);
    session.start();

    source.movementHeld.right = true;
    now += 16;
    session.step(16);
    expect(bridge.rollbackFrames.at(-1)).toBe(0);

    bridge.current = snapshot(player({ lastProcessedInputSeq: -1 }));
    for (const listener of bridge.snapshotListeners) listener(bridge.current);
    expect(bridge.rollbackFrames.at(-1)).toBe(1);

    bridge.current = snapshot(player({ lastProcessedInputSeq: 0 }));
    for (const listener of bridge.snapshotListeners) listener(bridge.current);
    expect(bridge.rollbackFrames.at(-1)).toBe(0);
  });

  it('uses the current presentation rollback budget and returns idle rollback to zero within two accepted snapshots', () => {
    const bridge = new Bridge();
    bridge.current = snapshot(player({ position: { x: 640, y: 360 } }));
    const source = controls();
    let now = 0;
    const session = new ArenaSession(
      bridge,
      'p-local',
      new ArenaInput(source),
      () => now,
      () => undefined,
      () => ({ rollbackWindowFrames: 2, targetTick: null })
    );
    session.start();

    for (let index = 0; index < 5; index += 1) {
      now += 17;
      session.step(16);
    }
    bridge.current = {
      ...snapshot(player({ position: { x: 640, y: 360 }, lastProcessedInputSeq: -1 })),
      tick: 2
    };
    for (const listener of bridge.snapshotListeners) listener(bridge.current);
    expect(bridge.rollbackFrames.at(-1)).toBe(2);
    expect(bridge.reconciliations.at(-1)).toEqual({
      authoritativeTick: 2,
      rollbackFrames: 2,
      correctionDistancePx: 0,
      hardSnap: false
    });

    bridge.current = {
      ...snapshot(player({ position: { x: 640, y: 360 }, lastProcessedInputSeq: 4 })),
      tick: 3
    };
    for (const listener of bridge.snapshotListeners) listener(bridge.current);
    expect(bridge.rollbackFrames.at(-1)).toBe(0);
    expect(bridge.reconciliations.at(-1)).toEqual({
      authoritativeTick: 3,
      rollbackFrames: 0,
      correctionDistancePx: 0,
      hardSnap: false
    });
  });

  it('uses the newest accepted authoritative tick before a presentation target has been sampled', () => {
    const bridge = new Bridge();
    bridge.current = { ...snapshot(), tick: 37 };
    const session = new ArenaSession(
      bridge,
      'p-local',
      new ArenaInput(controls()),
      () => 0,
      () => undefined,
      () => ({ rollbackWindowFrames: 4, targetTick: null })
    );
    session.start();

    session.step(16);

    expect(bridge.sent).toHaveLength(1);
    expect(bridge.sent[0]?.viewTick).toBe(37);
  });

  it('sends the clamped integer presentation target in the same sampled input frame', () => {
    const bridge = new Bridge();
    let targetTick = 12.9;
    let now = 0;
    const session = new ArenaSession(
      bridge,
      'p-local',
      new ArenaInput(controls()),
      () => now,
      () => undefined,
      () => ({ rollbackWindowFrames: 4, targetTick })
    );
    session.start();

    session.step(16);
    targetTick = -1.2;
    now = 17;
    session.step(16);

    expect(bridge.sent.map((frame) => frame.viewTick)).toEqual([12, 0]);
  });

  it('subscribes once, disposes connection and snapshot listeners, and never sends after disposal', () => {
    const bridge = new Bridge();
    const session = new ArenaSession(bridge, 'p-local', new ArenaInput(controls()), () => 0);
    session.start();
    session.start();
    expect(bridge.connectionListeners).toHaveLength(1);
    expect(bridge.snapshotListeners).toHaveLength(1);
    session.dispose();
    session.dispose();
    expect(bridge.connectionListeners).toHaveLength(0);
    expect(bridge.snapshotListeners).toHaveLength(0);
    session.step(16);
    expect(bridge.sent).toHaveLength(0);
  });
});
