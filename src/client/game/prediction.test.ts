import { describe, expect, it } from 'vitest';
import type { InputFrame, MatchPlayer, MatchSnapshot } from '../../shared/model.js';
import { DEFAULT_ROOM_SETTINGS } from '../../shared/roomSettings.js';
import {
  LOCAL_CORRECTION_SNAP_DISTANCE,
  REMOTE_SNAP_DISTANCE,
  PredictionBuffer,
  SnapshotTimeline,
  extrapolateRemotePlayer,
  interpolateRemotePlayer
} from './prediction.js';

const idleAction = {
  kind: null, phase: 'IDLE', comboStep: 0, chargeMs: 0, charging: false,
  attackId: null, profileId: null, lockedFacing: null, activeProgress: 0, hitTargetIds: []
} as const;

function player(overrides: Partial<MatchPlayer> = {}): MatchPlayer {
  return {
    playerId: 'p-1', name: 'Ada', chassis: 'RIFT', accent: 0,
    position: { x: 100, y: 100 }, velocity: { x: 0, y: 0 }, facing: { x: 1, y: 0 }, overload: 0,
    lastProcessedInputSeq: -1, action: idleAction, dashRemainingMs: 0, dashCooldownRemainingMs: 0,
    hitstunRemainingMs: 0, respawnRemainingMs: 0, protectionRemainingMs: 0,
    stats: { knockouts: 0, falls: 0, landedHits: 0, completedAttacks: 0 },
    ...overrides
  };
}

function frame(seq: number, overrides: Partial<InputFrame> = {}): InputFrame {
  return { seq, viewTick: 0, moveX: 0, moveY: 0, aimX: 1, aimY: 0, quick: false, heavy: false, dash: false, ...overrides };
}

function snapshot(tick: number, players: readonly MatchPlayer[]): MatchSnapshot {
  return {
    tick, phase: 'REGULATION', remainingMs: 100_000, platformProgress: 0,
    settings: DEFAULT_ROOM_SETTINGS,
    scores: Object.fromEntries(players.map((value) => [value.playerId, 0])),
    network: Object.fromEntries(players.map((value) => [
      value.playerId,
      { currentMs: null, medianMs: null, jitterMs: null, transport: 'websocket' as const }
    ])),
    players, pulses: [],
    winnerPlayerId: null, resultReason: null
  };
}

describe('PredictionBuffer', () => {
  it('replays unacknowledged movement through shared kinematics and reconciles position, velocity, and facing', () => {
    const prediction = new PredictionBuffer('p-1');
    const canonical = player();
    const first = prediction.predict(frame(0, { moveX: 1, aimX: 0, aimY: -1 }), canonical, 16);
    const second = prediction.predict(frame(1, { moveX: 1, aimX: 0, aimY: -1 }), canonical, 16);

    expect(second.position.x).toBeGreaterThan(first.position.x);
    expect(second.velocity.x).toBeGreaterThan(first.velocity.x);
    expect(second.facing).toEqual({ x: 0, y: -1 });

    const reconciled = prediction.reconcile(player({ lastProcessedInputSeq: 0 }), 7, 16);
    expect(prediction.pendingSequences()).toEqual([1]);
    expect(prediction.rollbackFrames()).toBe(1);
    expect(reconciled.presentation.position.x).toBeGreaterThan(100);
    expect(reconciled.presentation.facing).toEqual({ x: 0, y: -1 });
    expect(reconciled.result).toMatchObject({ authoritativeTick: 7, rollbackFrames: 1 });
  });

  it('predicts only local action starts and never invents hit, knockout, overload, or score state', () => {
    const prediction = new PredictionBuffer('p-1');
    const presentation = prediction.predict(frame(0, { quick: true }), player(), 16);
    expect(presentation.actionStart).toEqual({
      ...idleAction, kind: 'QUICK_1', phase: 'WINDUP', comboStep: 1
    });
    expect(presentation).not.toHaveProperty('scores');
    expect(presentation).not.toHaveProperty('overload');
    expect(presentation).not.toHaveProperty('hit');
    expect(presentation).not.toHaveProperty('pulse');
    expect(presentation).not.toHaveProperty('pulses');
    expect(presentation).not.toHaveProperty('clash');
    expect(presentation).not.toHaveProperty('perfectDodge');
    expect(presentation).not.toHaveProperty('events');
    expect(presentation).not.toHaveProperty('knockout');
  });

  it('starts local heavy-charge presentation while the right button is held without predicting an outcome', () => {
    const prediction = new PredictionBuffer('p-1');
    const presentation = prediction.predict(frame(0, { heavy: true }), player(), 100);
    expect(presentation.actionStart).toEqual({
      ...idleAction, kind: 'HEAVY', phase: 'WINDUP', chargeMs: 100, charging: true
    });
    expect(presentation).not.toHaveProperty('scores');
    expect(presentation).not.toHaveProperty('hit');
  });

  it('steers a held charge through all eight aim directions', () => {
    const directions = [
      { input: [1, 0], expected: { x: 1, y: 0 } },
      { input: [1, 1], expected: { x: Math.SQRT1_2, y: Math.SQRT1_2 } },
      { input: [0, 1], expected: { x: 0, y: 1 } },
      { input: [-1, 1], expected: { x: -Math.SQRT1_2, y: Math.SQRT1_2 } },
      { input: [-1, 0], expected: { x: -1, y: 0 } },
      { input: [-1, -1], expected: { x: -Math.SQRT1_2, y: -Math.SQRT1_2 } },
      { input: [0, -1], expected: { x: 0, y: -1 } },
      { input: [1, -1], expected: { x: Math.SQRT1_2, y: -Math.SQRT1_2 } }
    ] as const;

    for (const [index, direction] of directions.entries()) {
      const prediction = new PredictionBuffer('p-1');
      const presentation = prediction.predict(frame(index, {
        heavy: true,
        aimX: direction.input[0],
        aimY: direction.input[1]
      }), player(), 180);

      expect(presentation.facing.x, `${direction.input[0]},${direction.input[1]} x`)
        .toBeCloseTo(direction.expected.x, 10);
      expect(presentation.facing.y, `${direction.input[0]},${direction.input[1]} y`)
        .toBeCloseTo(direction.expected.y, 10);
    }
  });

  it('retains the last valid charge aim when a later aim sample is neutral', () => {
    const prediction = new PredictionBuffer('p-1');

    prediction.predict(frame(0, { heavy: true, aimX: 0, aimY: -1 }), player(), 180);
    const retained = prediction.predict(frame(1, { heavy: true, aimX: 0, aimY: 0 }), player(), 16);

    expect(retained.facing).toEqual({ x: 0, y: -1 });
  });

  it('keeps a predicted quick committed so a following dash is not predicted', () => {
    const prediction = new PredictionBuffer('p-1');
    const canonical = player({ position: { x: 640, y: 360 } });

    expect(prediction.predict(frame(0, { quick: true }), canonical, 16).actionStart?.kind).toBe('QUICK_1');
    const afterQuick = prediction.predict(frame(1, { dash: true }), canonical, 16);

    expect(afterQuick.actionStart).toBeNull();
    expect(afterQuick.velocity.x).not.toBe(760);
  });

  it('accumulates held heavy across frames and slows movement from the first observed charge', () => {
    const prediction = new PredictionBuffer('p-1');
    const canonical = player({ position: { x: 640, y: 360 } });

    const firstCharge = prediction.predict(frame(0, { moveX: 1, heavy: true }), canonical, 1);
    const continuedCharge = prediction.predict(frame(1, { moveX: -1, heavy: true }), canonical, 224);

    expect(firstCharge.actionStart?.chargeMs).toBe(1);
    expect(firstCharge.velocity.x).toBeCloseTo(1.32, 5);
    expect(continuedCharge.actionStart?.chargeMs).toBe(225);
  });

  it('lets dash cancel an uncommitted heavy charge and restarts charge from zero after dash', () => {
    const prediction = new PredictionBuffer('p-1');
    const canonical = player({ position: { x: 640, y: 360 } });

    prediction.predict(frame(0, { heavy: true }), canonical, 100);
    const dash = prediction.predict(frame(1, { heavy: true, dash: true }), canonical, 16);
    const restartedCharge = prediction.predict(frame(2, { heavy: true }), canonical, 160);

    expect(dash.actionStart?.kind).toBe('DASH');
    expect(restartedCharge.actionStart).toEqual({
      ...idleAction, kind: 'HEAVY', phase: 'WINDUP', chargeMs: 160, charging: true
    });
  });

  it('commits a minimum heavy on release and blocks a following dash', () => {
    const prediction = new PredictionBuffer('p-1');
    const canonical = player({ position: { x: 640, y: 360 } });

    prediction.predict(frame(0, { heavy: true }), canonical, 1);
    const release = prediction.predict(frame(1), canonical, 16);
    const afterRelease = prediction.predict(frame(2, { dash: true }), canonical, 16);

    expect(release.actionStart).toEqual({
      ...idleAction,
      kind: 'HEAVY',
      phase: 'WINDUP',
      chargeMs: 1,
      lockedFacing: { x: 1, y: 0 }
    });
    expect(afterRelease.actionStart).toBeNull();
    expect(afterRelease.velocity.x).not.toBe(760);
  });

  it('locks release facing to the last valid charge aim while later input turns elsewhere', () => {
    const prediction = new PredictionBuffer('p-1');
    const canonical = player({ position: { x: 640, y: 360 } });

    prediction.predict(frame(0, { heavy: true, aimX: 0, aimY: -1 }), canonical, 180);
    const release = prediction.predict(frame(1, { aimX: 0, aimY: 0 }), canonical, 16);
    const afterRelease = prediction.predict(frame(2, { aimX: -1, aimY: 0 }), canonical, 16);

    expect(release.facing).toEqual({ x: 0, y: -1 });
    expect(release.actionStart?.lockedFacing).toEqual({ x: 0, y: -1 });
    expect(afterRelease.facing).toEqual({ x: 0, y: -1 });
    expect(afterRelease.actionStart).toBeNull();
  });

  it('keeps a one-millisecond release committed instead of discarding it', () => {
    const prediction = new PredictionBuffer('p-1');
    const canonical = player({ position: { x: 640, y: 360 } });

    prediction.predict(frame(0, { heavy: true, aimX: 0, aimY: -1 }), canonical, 1);
    const release = prediction.predict(frame(1, { aimX: 1, aimY: 0 }), canonical, 16);
    const quick = prediction.predict(frame(2, { quick: true, aimX: 1, aimY: 0 }), canonical, 16);

    expect(release.actionStart).toMatchObject({ kind: 'HEAVY', chargeMs: 1, lockedFacing: { x: 1, y: 0 } });
    expect(quick.actionStart).toBeNull();
  });

  it('commits a positive authoritative charge when its release is replayed', () => {
    const prediction = new PredictionBuffer('p-1');
    const charging = player({
      position: { x: 640, y: 360 },
      action: { ...idleAction, chargeMs: 1, charging: true }
    });

    prediction.reconcile(charging, 1, 16);
    const release = prediction.predict(frame(0), charging, 16);
    const quick = prediction.predict(frame(1, { quick: true }), charging, 16);

    expect(release.actionStart).toMatchObject({ kind: 'HEAVY', chargeMs: 1 });
    expect(quick.actionStart).toBeNull();
  });

  it('presents one authoritative attack ID once across unchanged reconciliation snapshots', () => {
    const prediction = new PredictionBuffer('p-1');
    const committed = player({
      action: {
        ...idleAction,
        kind: 'QUICK_1',
        phase: 'WINDUP',
        comboStep: 1,
        attackId: 41,
        profileId: 'quick-1',
        lockedFacing: { x: 1, y: 0 }
      }
    });

    expect(prediction.reconcile(committed, 1, 16).presentation.actionStart?.attackId).toBe(41);
    expect(prediction.reconcile(committed, 2, 16).presentation.actionStart).toBeNull();
  });

  it('does not predict dash or attack starts while canonical state forbids acting', () => {
    const blockedPlayers = [
      player({ dashCooldownRemainingMs: 100 }),
      player({ dashRemainingMs: 100, velocity: { x: 760, y: 0 } }),
      player({ hitstunRemainingMs: 100, action: { ...idleAction, kind: 'HITSTUN' } }),
      player({ respawnRemainingMs: 100, action: { ...idleAction, kind: 'RESPAWNING' } }),
      player({ action: { ...idleAction, kind: 'QUICK_1', phase: 'ACTIVE', comboStep: 1 } })
    ];

    for (const blocked of blockedPlayers) {
      const prediction = new PredictionBuffer('p-1');
      const result = prediction.predict(
        frame(0, { moveX: 1, quick: true, heavy: true, dash: true }),
        blocked,
        16
      );
      expect(result.actionStart, blocked.action.kind ?? 'COOLDOWN').toBeNull();
    }
  });

  it('advances canonical dash cooldown before allowing a later fresh dash edge', () => {
    const prediction = new PredictionBuffer('p-1');
    const coolingDown = player({ position: { x: 640, y: 360 }, dashCooldownRemainingMs: 20 });

    expect(prediction.predict(frame(0, { dash: true }), coolingDown, 16).actionStart).toBeNull();
    expect(prediction.predict(frame(1), coolingDown, 16).actionStart).toBeNull();
    const started = prediction.predict(frame(2, { dash: true }), coolingDown, 16);

    expect(started.actionStart).toEqual({ ...idleAction, kind: 'DASH', phase: 'ACTIVE' });
    expect(started.velocity.x).toBe(900);
  });

  it('uses reduced steering and outward void pull when predicting outside the contracted platform', () => {
    const prediction = new PredictionBuffer('p-1');
    const outside = player({ position: { x: 640, y: 50 }, facing: { x: 1, y: 0 } });

    const result = prediction.predict(frame(0, { moveX: 1 }), outside, 100, 0);

    expect(result.velocity.x).toBeCloseTo(108, 5);
    expect(result.velocity.y).toBeCloseTo(-36, 5);
    expect(result.position).toEqual({ x: 650.8, y: 46.4 });
  });

  it('never predicts movement past a respawn timer without a canonical spawn snapshot', () => {
    const prediction = new PredictionBuffer('p-1');
    const respawning = player({
      position: { x: 640, y: 360 },
      respawnRemainingMs: 10,
      action: { ...idleAction, kind: 'RESPAWNING' }
    });

    expect(prediction.predict(frame(0, { moveX: 1 }), respawning, 16).position).toEqual({ x: 640, y: 360 });
    expect(prediction.predict(frame(1, { moveX: 1 }), respawning, 16).position).toEqual({ x: 640, y: 360 });
  });

  it('clamps the active rollback window to two through ten replay frames', () => {
    const lowBudget = new PredictionBuffer('p-1');
    const highBudget = new PredictionBuffer('p-1');
    const canonical = player({ position: { x: 640, y: 360 } });
    for (let seq = 0; seq < 12; seq += 1) {
      lowBudget.predict(frame(seq), canonical, 16);
      highBudget.predict(frame(seq), canonical, 16);
    }

    lowBudget.setRollbackWindow(0);
    highBudget.setRollbackWindow(99);

    expect(lowBudget.reconcile(canonical, 20, 16).result.rollbackFrames).toBe(2);
    expect(lowBudget.pendingSequences()).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    expect(highBudget.reconcile(canonical, 20, 16).result.rollbackFrames).toBe(10);
    expect(highBudget.pendingSequences()).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  });

  it('keeps normal continuous pending history at twelve newest frames', () => {
    const prediction = new PredictionBuffer('p-1');
    const canonical = player({ position: { x: 640, y: 360 } });

    for (let seq = 0; seq < 13; seq += 1) prediction.predict(frame(seq, { moveX: 1 }), canonical, 16);

    expect(prediction.pendingSequences()).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  });

  it('compacts only obsolete movement while retaining action edges and an in-window heavy contribution', () => {
    const prediction = new PredictionBuffer('p-1');
    const canonical = player({ position: { x: 640, y: 360 } });
    const overrides: Record<number, Partial<InputFrame>> = {
      1: { quick: true },
      3: { dash: true },
      9: { heavy: true },
      10: { heavy: true }
    };
    for (let seq = 0; seq < 16; seq += 1) {
      prediction.predict(frame(seq, { moveX: 1, ...overrides[seq] }), canonical, 16);
    }

    expect(prediction.pendingSequences()).toEqual([1, 3, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
  });

  it('temporarily exceeds twelve records for a realistic unacknowledged edge burst', () => {
    const prediction = new PredictionBuffer('p-1');
    const canonical = player({ position: { x: 640, y: 360 } });
    const overrides: Record<number, Partial<InputFrame>> = {
      0: { quick: true },
      2: { dash: true },
      4: { heavy: true },
      5: { heavy: true },
      8: { quick: true },
      10: { dash: true },
      12: { heavy: true },
      13: { heavy: true },
      16: { quick: true },
      18: { dash: true },
      20: { heavy: true },
      21: { heavy: true },
      24: { quick: true }
    };
    for (let seq = 0; seq < 25; seq += 1) {
      prediction.predict(frame(seq, { moveX: 1, ...overrides[seq] }), canonical, 16);
    }

    expect(prediction.pendingSequences()).toEqual([0, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 21, 22, 23, 24]);
  });

  it('replays only the active sequence suffix and reports exactly the four processed records', () => {
    const prediction = new PredictionBuffer('p-1');
    const committed = player({
      position: { x: 640, y: 360 },
      action: { ...idleAction, kind: 'QUICK_1', phase: 'ACTIVE', comboStep: 1 }
    });
    const overrides: Record<number, Partial<InputFrame>> = {
      0: { quick: true },
      2: { dash: true },
      4: { heavy: true },
      5: { heavy: true },
      8: { quick: true },
      10: { dash: true },
      12: { heavy: true },
      13: { heavy: true },
      16: { quick: true },
      18: { dash: true },
      20: { heavy: true },
      21: { heavy: true },
      24: { quick: true }
    };
    for (let seq = 0; seq < 25; seq += 1) {
      prediction.predict(frame(seq, { moveX: 1, ...overrides[seq] }), committed, 10);
    }
    prediction.setRollbackWindow(4);

    const reconciled = prediction.reconcile(committed, 45, 10);

    expect(prediction.pendingSequences()).toEqual([
      0, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 21, 22, 23, 24
    ]);
    expect(reconciled.result.rollbackFrames).toBe(4);
    expect(reconciled.presentation.velocity).toEqual({ x: 96, y: 0 });
  });

  it('preserves the hand-derived heavy charge contributed by the active ten-frame suffix', () => {
    const prediction = new PredictionBuffer('p-1');
    const canonical = player({ position: { x: 640, y: 360 } });
    const edgeBurst: Record<number, Partial<InputFrame>> = {
      0: { quick: true },
      2: { dash: true },
      4: { heavy: true },
      5: { heavy: true },
      8: { quick: true },
      10: { dash: true },
      12: { heavy: true },
      13: { heavy: true },
      16: { quick: true },
      18: { dash: true },
      20: { heavy: true },
      21: { heavy: true },
      24: { quick: true }
    };
    for (let seq = 0; seq < 25; seq += 1) {
      prediction.predict(frame(seq, edgeBurst[seq]), canonical, 10);
    }
    for (let seq = 25; seq < 40; seq += 1) {
      prediction.predict(frame(seq, { heavy: true }), canonical, 10);
    }
    prediction.predict(frame(40), canonical, 10);
    prediction.setRollbackWindow(10);

    const reconciled = prediction.reconcile(canonical, 46, 10);

    expect(reconciled.result.rollbackFrames).toBe(10);
    expect(reconciled.presentation.actionStart).toEqual({
      ...idleAction,
      kind: 'HEAVY',
      phase: 'WINDUP',
      chargeMs: 90,
      lockedFacing: { x: 1, y: 0 }
    });
  });

  it('drops acknowledgements before replaying retained inputs in monotonic sequence order', () => {
    const prediction = new PredictionBuffer('p-1');
    const canonical = player({ position: { x: 640, y: 360 } });
    prediction.predict(frame(0, { aimX: 1, aimY: 0 }), canonical, 16);
    prediction.predict(frame(1, { aimX: -1, aimY: 0 }), canonical, 16);
    prediction.predict(frame(2, { aimX: 0, aimY: -1 }), canonical, 16);

    const reconciled = prediction.reconcile(
      player({ position: { x: 640, y: 360 }, lastProcessedInputSeq: 0 }),
      44,
      16
    );

    expect(prediction.pendingSequences()).toEqual([1, 2]);
    expect(reconciled.presentation.facing).toEqual({ x: 0, y: -1 });
    expect(reconciled.result.rollbackFrames).toBe(2);
  });

  it('measures an ordinary correction before applying the existing thirty-five-percent blend', () => {
    const prediction = new PredictionBuffer('p-1');
    const canonical = player({ position: { x: 640, y: 360 } });
    prediction.predict(frame(0, { moveX: 1 }), canonical, 16);

    const reconciled = prediction.reconcile(
      player({ position: { x: 680, y: 360 }, lastProcessedInputSeq: 0 }),
      9,
      16
    );

    expect(reconciled.result).toMatchObject({
      authoritativeTick: 9,
      rollbackFrames: 0,
      hardSnap: false
    });
    expect(reconciled.result.correctionDistancePx).toBeCloseTo(39.3856, 8);
    expect(reconciled.presentation.position.x).toBeCloseTo(654.39936, 8);
    expect(reconciled.presentation.position.y).toBe(360);
  });

  it('hard-snaps an inclusive 160-pixel local correction', () => {
    const prediction = new PredictionBuffer('p-1');
    prediction.predict(frame(0), player(), 0);

    const reconciled = prediction.reconcile(
      player({
        position: { x: 100 + LOCAL_CORRECTION_SNAP_DISTANCE, y: 100 },
        lastProcessedInputSeq: 0
      }),
      10,
      16
    );

    expect(reconciled.result).toEqual({
      authoritativeTick: 10,
      rollbackFrames: 0,
      correctionDistancePx: 160,
      hardSnap: true
    });
    expect(reconciled.presentation.position).toEqual({ x: 260, y: 100 });
  });

  it('hard-snaps both entry into respawn and ring-out recovery below the distance threshold', () => {
    const respawning = player({
      position: { x: 120, y: 100 },
      lastProcessedInputSeq: 0,
      respawnRemainingMs: 500,
      action: { ...idleAction, kind: 'RESPAWNING' }
    });
    const enteringRespawn = new PredictionBuffer('p-1');
    enteringRespawn.predict(frame(0), player(), 0);
    const entered = enteringRespawn.reconcile(respawning, 11, 16);

    const recovering = new PredictionBuffer('p-1');
    recovering.predict(frame(0), player({
      respawnRemainingMs: 500,
      action: { ...idleAction, kind: 'RESPAWNING' }
    }), 0);
    const recovered = recovering.reconcile(
      player({ position: { x: 120, y: 100 }, lastProcessedInputSeq: 0 }),
      12,
      16
    );

    expect(entered.result).toEqual({
      authoritativeTick: 11,
      rollbackFrames: 0,
      correctionDistancePx: 20,
      hardSnap: true
    });
    expect(entered.presentation.position).toEqual({ x: 120, y: 100 });
    expect(recovered.result).toEqual({
      authoritativeTick: 12,
      rollbackFrames: 0,
      correctionDistancePx: 20,
      hardSnap: true
    });
    expect(recovered.presentation.position).toEqual({ x: 120, y: 100 });
  });
});

describe('SnapshotTimeline', () => {
  it('retains the newest sixteen authoritative ticks and ignores duplicate or older ticks', () => {
    const timeline = new SnapshotTimeline();
    for (let tick = 1; tick <= 17; tick += 1) {
      timeline.push(snapshot(tick, [player({ position: { x: tick, y: 100 } })]), tick * 10);
    }
    timeline.push(snapshot(17, [player({ position: { x: 999, y: 100 } })]), 180);
    timeline.push(snapshot(16, [player({ position: { x: 998, y: 100 } })]), 190);

    const retained = Reflect.get(timeline, 'samples') as Array<{ snapshot: MatchSnapshot }>;
    expect(retained.map(({ snapshot }) => snapshot.tick)).toEqual([
      2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17
    ]);
    expect(retained.at(-1)?.snapshot.players[0]?.position.x).toBe(17);
  });

  it('derives a five-frame delay from transport and accepted-arrival jitter', () => {
    const timeline = new SnapshotTimeline();
    timeline.updateNetwork({
      medianRttMs: 50,
      transportJitterMs: 4,
      arrivalJitterMs: 34,
      bufferUnderrun: false,
      sampledAtMs: 1_000
    });

    const sampled = timeline.sample(1_000);
    expect(sampled.delayFrames).toBe(5);
    expect(timeline.delayMs()).toBeCloseTo(83.3333333333, 8);
    expect(timeline.rollbackWindowFrames()).toBe(7);
  });

  it('interpolates continuously around newestTick minus delayFrames', () => {
    const timeline = new SnapshotTimeline();
    const tickMs = 1_000 / 60;
    const tick8 = snapshot(8, [player({ position: { x: 80, y: 100 } })]);
    const tick9 = snapshot(9, [player({ position: { x: 90, y: 100 } })]);
    const tick10 = snapshot(10, [player({ position: { x: 100, y: 100 } })]);
    timeline.push(tick8, 1_000);
    timeline.push(tick9, 1_000 + tickMs);
    timeline.push(tick10, 1_000 + tickMs * 2);

    const sampled = timeline.sample(1_000 + tickMs * 2.5);
    expect(sampled).toMatchObject({
      frame: { previous: tick9, current: tick10 },
      targetTick: 9,
      delayFrames: 1,
      extrapolatedFrames: 0,
      bufferUnderrun: false
    });
    expect(sampled.frame?.alpha).toBeCloseTo(0.5, 10);
  });

  it('exposes the current authoritative tick when render progress lands exactly on it', () => {
    const timeline = new SnapshotTimeline();
    const tickMs = 1_000 / 60;
    timeline.push(snapshot(9, [player()]), 1_000);
    timeline.push(snapshot(10, [player()]), 1_000 + tickMs);

    const sampled = timeline.sample(1_000 + tickMs * 2);
    expect(sampled.targetTick).toBe(10);
    expect(sampled.frame?.current.tick).toBe(10);
    expect(sampled.frame?.alpha).toBeCloseTo(1, 10);
  });

  it('never decreases its selected authoritative target tick when delay rises', () => {
    const timeline = new SnapshotTimeline();
    const tickMs = 1_000 / 60;
    for (let tick = 8; tick <= 12; tick += 1) {
      timeline.push(snapshot(tick, [player()]), 1_000 + (tick - 8) * tickMs);
    }
    const before = timeline.sample(1_000 + tickMs * 4.5);

    timeline.updateNetwork({
      medianRttMs: 80,
      transportJitterMs: 50,
      arrivalJitterMs: 0,
      bufferUnderrun: false,
      sampledAtMs: 2_000
    });
    const after = timeline.sample(1_000 + tickMs * 4.5);

    expect(before.targetTick).toBe(11);
    expect(after.targetTick).toBe(11);
    expect(after.frame?.alpha).toBeCloseTo(0.5, 10);
  });

  it.each(['REGULATION', 'SUDDEN_DEATH'] as const)(
    'extrapolates remote velocity for two ticks during %s, then holds',
    (phase) => {
      const timeline = new SnapshotTimeline();
      const tickMs = 1_000 / 60;
      const authority = {
        ...snapshot(10, [player({
          position: { x: 100, y: 100 },
          velocity: { x: 600, y: -300 }
        })]),
        phase
      };
      timeline.push(authority, 1_000);

      const atTwoTicks = timeline.sample(1_000 + tickMs * 3);
      const afterTwoTicks = timeline.sample(1_000 + tickMs * 8);
      expect(atTwoTicks.extrapolatedFrames).toBeCloseTo(2, 10);
      expect(afterTwoTicks.extrapolatedFrames).toBeCloseTo(2, 10);
      expect(extrapolateRemotePlayer(authority.players[0]!, afterTwoTicks.extrapolatedFrames)).toEqual({
        x: 120,
        y: 90
      });
    }
  );

  it('holds instead of extrapolating outside regulation or sudden death', () => {
    const timeline = new SnapshotTimeline();
    const authority = { ...snapshot(10, [player()]), phase: 'PAUSED' as const };
    timeline.push(authority, 1_000);

    const sampled = timeline.sample(2_000);
    expect(sampled.extrapolatedFrames).toBe(0);
    expect(sampled.bufferUnderrun).toBe(true);
  });

  it('clears samples, policy, arrival jitter, and render-target state', () => {
    const timeline = new SnapshotTimeline();
    timeline.push(snapshot(1, [player()]), 1_000);
    timeline.push(snapshot(2, [player()]), 1_100);
    timeline.push(snapshot(3, [player()]), 1_117);
    timeline.updateNetwork({
      medianRttMs: 80,
      transportJitterMs: 50,
      arrivalJitterMs: timeline.arrivalJitterMs(),
      bufferUnderrun: true,
      sampledAtMs: 1_117
    });
    timeline.sample(1_250);

    timeline.clear();

    expect(timeline.sample(1_250)).toEqual({
      frame: null,
      targetTick: null,
      delayFrames: 1,
      extrapolatedFrames: 0,
      bufferUnderrun: false
    });
    expect(timeline.delayMs()).toBeCloseTo(16.6666666667, 8);
    expect(timeline.arrivalJitterMs()).toBe(0);
  });

  it('interpolates ordinary remote movement but snaps at the threshold and on respawn', () => {
    const previous = player({ position: { x: 100, y: 100 } });
    const nearby = player({ position: { x: 140, y: 120 } });
    expect(interpolateRemotePlayer(previous, nearby, 0.5)).toEqual({ x: 120, y: 110 });
    const far = player({ position: { x: 100 + REMOTE_SNAP_DISTANCE, y: 100 } });
    expect(interpolateRemotePlayer(previous, far, 0.1)).toEqual(far.position);
    const respawn = player({
      position: { x: 120, y: 100 },
      respawnRemainingMs: 500,
      action: { ...idleAction, kind: 'RESPAWNING' }
    });
    expect(interpolateRemotePlayer(previous, respawn, 0.1)).toEqual(respawn.position);
  });
});
