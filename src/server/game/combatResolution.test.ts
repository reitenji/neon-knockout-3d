import { describe, expect, it } from 'vitest';

import { GAME } from '../../shared/constants.js';
import { profileForAttack } from '../../shared/combat/profiles.js';
import { DEFAULT_ROOM_SETTINGS } from '../../shared/roomSettings.js';
import type { AttackKind, Vec2 } from '../../shared/model.js';
import {
  buildActiveAttackShapes,
  resolveClashesAndPulseBreaks,
  resolveMeleeInteractions,
  resolveSurvivingContacts,
  type ActiveAttackShape,
  type ActiveAttackSlice
} from './combatResolution.js';
import { advanceCombatTimers, startActions } from './combat.js';
import { advancePulses, spawnNeonPulse } from './projectiles.js';
import { snapshotMatch } from './simulation.js';
import { createMatchState, type AttackRuntime, type MatchState } from './state.js';
import { CombatFrameHistory } from './CombatFrameHistory.js';

function createState(): MatchState {
  const state = createMatchState([
    { playerId: 'p4', name: 'Katherine', chassis: 'WRAITH', accent: 3 },
    { playerId: 'p2', name: 'Linus', chassis: 'RIFT', accent: 1 },
    { playerId: 'p1', name: 'Ada', chassis: 'RIFT', accent: 0 },
    { playerId: 'p3', name: 'Grace', chassis: 'PULSE', accent: 2 }
  ], 7, DEFAULT_ROOM_SETTINGS);
  state.phase = 'REGULATION';
  state.players.p1.position = { x: 580, y: 360 };
  state.players.p2.position = { x: 650, y: 360 };
  state.players.p3.position = { x: 720, y: 360 };
  state.players.p4.connected = false;
  return state;
}

function attack(
  state: MatchState,
  playerId: string,
  attackId: number,
  kind: AttackKind,
  lockedFacing: Vec2 = { x: 1, y: 0 },
  chargeMs = kind === 'HEAVY' ? GAME.heavyMaxChargeMs : 0
): AttackRuntime {
  const profile = profileForAttack(kind);
  const runtime: AttackRuntime = {
    attackId,
    viewTick: state.tick,
    kind,
    profileId: profile.id,
    phase: 'ACTIVE',
    phaseRemainingMs: profile.activeMs,
    phaseElapsedMs: 0,
    previousActiveProgress: 0,
    lockedFacing,
    chargeMs,
    hitPlayerIds: new Set(),
    resolvedPlayerIds: new Set()
  };
  state.players[playerId].attack = runtime;
  return runtime;
}

function capturedHistory(state: MatchState, tick: number): CombatFrameHistory {
  state.tick = tick;
  const history = new CombatFrameHistory();
  history.capture(state);
  return history;
}

function shape(
  playerId: string,
  runtime: AttackRuntime,
  from: Vec2,
  to: Vec2,
  radius = 6
): ActiveAttackShape {
  return {
    playerId,
    attackId: runtime.attackId,
    kind: runtime.kind,
    capsule: { from, to, radius }
  };
}

describe('shared-shape melee resolution', () => {
  it('uses an eligible retained target pose only after current-pose contact misses, and resolves it once', () => {
    const state = createState();
    const history = capturedHistory(state, 6);
    state.tick = 10;
    state.players.p2.position = { x: 900, y: 360 };
    const runtime = attack(state, 'p1', 1, 'QUICK_1');
    runtime.viewTick = 6;
    const sweep = shape('p1', runtime, { x: 600, y: 360 }, { x: 640, y: 360 });

    expect(resolveSurvivingContacts(state, [sweep], history)).toEqual([
      expect.objectContaining({
        type: 'HIT',
        attackerId: 'p1',
        targetId: 'p2',
        impactPosition: { x: 626, y: 360 }
      })
    ]);
    expect(resolveSurvivingContacts(state, [sweep], history)).toEqual([]);
    expect(runtime.hitPlayerIds).toEqual(new Set(['p2']));
  });

  it('does not extend contact to a claimed tick that has fallen out of retained history', () => {
    const state = createState();
    const history = capturedHistory(state, 1);
    state.players.p2.position = { x: 900, y: 360 };
    for (let tick = 2; tick <= 13; tick += 1) {
      state.tick = tick;
      history.capture(state);
    }
    const runtime = attack(state, 'p1', 1, 'QUICK_1');
    runtime.viewTick = 1;

    expect(resolveSurvivingContacts(state, [
      shape('p1', runtime, { x: 620, y: 340 }, { x: 660, y: 380 })
    ], history)).toEqual([]);
    expect(state.players.p2.overload).toBe(0);
  });

  it.each([
    ['protection', (state: MatchState, active: boolean) => { state.players.p2.protectionRemainingMs = active ? 1 : 0; }],
    ['dash invulnerability', (state: MatchState, active: boolean) => {
      state.players.p2.dashInvulnerabilityRemainingMs = active ? 1 : 0;
    }],
    ['respawn', (state: MatchState, active: boolean) => { state.players.p2.respawnRemainingMs = active ? 1 : 0; }],
    ['disconnect', (state: MatchState, active: boolean) => { state.players.p2.connected = !active; }]
  ])('blocks rewind-created contact when %s exists in either current or historical state', (_name, setIneligible) => {
    for (const side of ['historical', 'current'] as const) {
      const state = createState();
      if (side === 'historical') setIneligible(state, true);
      const history = capturedHistory(state, 6);
      setIneligible(state, side === 'current');
      state.tick = 10;
      state.players.p2.position = { x: 900, y: 360 };
      const runtime = attack(state, 'p1', 1, 'QUICK_1');
      runtime.viewTick = 6;

      expect(resolveSurvivingContacts(state, [
        shape('p1', runtime, { x: 620, y: 340 }, { x: 660, y: 380 })
      ], history), side).toEqual([]);
      expect(state.players.p2.overload, side).toBe(0);
    }
  });

  it('keeps an eligible current-pose hit authoritative even when the historical pose was protected', () => {
    const state = createState();
    state.players.p2.protectionRemainingMs = 1;
    const history = capturedHistory(state, 6);
    state.players.p2.protectionRemainingMs = 0;
    state.tick = 10;
    const runtime = attack(state, 'p1', 1, 'QUICK_1');
    runtime.viewTick = 6;

    expect(resolveSurvivingContacts(state, [
      shape('p1', runtime, { x: 620, y: 340 }, { x: 660, y: 380 })
    ], history)).toEqual([expect.objectContaining({ type: 'HIT', targetId: 'p2' })]);
  });

  it('allows simultaneous rewind-created melee hits to land once each', () => {
    const state = createState();
    const history = capturedHistory(state, 6);
    state.tick = 10;
    state.players.p1.position = { x: 400, y: 360 };
    state.players.p2.position = { x: 900, y: 360 };
    const left = attack(state, 'p1', 1, 'QUICK_1');
    const right = attack(state, 'p2', 2, 'QUICK_1', { x: -1, y: 0 });
    left.viewTick = 6;
    right.viewTick = 6;

    const events = resolveSurvivingContacts(state, [
      shape('p1', left, { x: 620, y: 340 }, { x: 660, y: 380 }),
      shape('p2', right, { x: 600, y: 340 }, { x: 560, y: 380 })
    ], history);

    expect(events).toEqual([
      expect.objectContaining({ type: 'HIT', attackerId: 'p1', targetId: 'p2' }),
      expect.objectContaining({ type: 'HIT', attackerId: 'p2', targetId: 'p1' })
    ]);
    expect(left.hitPlayerIds).toEqual(new Set(['p2']));
    expect(right.hitPlayerIds).toEqual(new Set(['p1']));
  });

  it('never uses combat history for neon pulse contact', () => {
    const state = createState();
    const history = capturedHistory(state, 6);
    state.tick = 10;
    state.players.p2.position = { x: 900, y: 360 };
    state.players.p3.position = { x: 1_000, y: 360 };
    const origin = attack(state, 'p1', 1, 'HEAVY');
    origin.viewTick = 6;
    const pulse = spawnNeonPulse(state, state.players.p1, origin)!.pulse;
    pulse.previousPosition = { x: 600, y: 360 };
    pulse.position = { x: 700, y: 360 };

    expect(resolveSurvivingContacts(state, [], history)).toEqual([]);
    expect(state.pulses).toHaveProperty('1');
  });

  it('rejects an associated capsule on the next tick even while the same attack remains live', () => {
    const state = createState();
    state.players.p1.position = { x: 600, y: 360 };
    state.players.p2.position = { x: 800, y: 360 };
    const runtime = attack(state, 'p1', 1, 'QUICK_1');
    const [staleShape] = buildActiveAttackShapes(state, [{
      playerId: 'p1', attack: runtime, previousProgress: 0, currentProgress: 1, enteredActive: true
    }]);

    state.tick += 1;
    state.players.p2.position = { x: 642, y: 360 };

    expect(state.players.p1.attack).toBe(runtime);
    expect(resolveMeleeInteractions(state, [staleShape])).toEqual([]);
    expect(state.players.p2.overload).toBe(0);
  });

  it('rejects an associated capsule from another match with coincident attack identity', () => {
    const origin = createState();
    origin.players.p1.position = { x: 600, y: 360 };
    const originAttack = attack(origin, 'p1', 1, 'QUICK_1');
    const [foreignShape] = buildActiveAttackShapes(origin, [{
      playerId: 'p1', attack: originAttack, previousProgress: 0, currentProgress: 1, enteredActive: true
    }]);

    const other = createState();
    other.players.p1.position = { x: 600, y: 360 };
    other.players.p2.position = { x: 642, y: 360 };
    attack(other, 'p1', 1, 'QUICK_1');

    expect(resolveMeleeInteractions(other, [foreignShape])).toEqual([]);
    expect(other.players.p2.overload).toBe(0);
  });

  it('resolves a manual unassociated shape against its matching live runtime', () => {
    const state = createState();
    const runtime = attack(state, 'p1', 1, 'QUICK_1');
    const manualShape = shape('p1', runtime, { x: 620, y: 340 }, { x: 660, y: 380 });

    expect(resolveMeleeInteractions(state, [manualShape])).toEqual([
      expect.objectContaining({ type: 'HIT', attackerId: 'p1', targetId: 'p2' })
    ]);
  });

  it('resolves a full active slice after a large step expires its runtime without leaking it', () => {
    const state = createState();
    state.players.p1.position = { x: 600, y: 360 };
    state.players.p2.position = { x: 642, y: 360 };
    state.players.p1.latestInput = { ...state.players.p1.latestInput, quick: true };
    startActions(state);

    const timers = advanceCombatTimers(
      state,
      GAME.quickCombo[0].windupMs +
        GAME.quickCombo[0].activeMs +
        GAME.quickCombo[0].recoveryMs
    );
    const shapes = buildActiveAttackShapes(state, timers.activeSlices);

    expect(timers.activeSlices).toEqual([
      expect.objectContaining({ playerId: 'p1', previousProgress: 0, currentProgress: 1 })
    ]);
    expect(shapes).toHaveLength(1);
    expect(state.players.p1.attack).toBeNull();
    expect(state.players.p1.stats.completedAttacks).toBe(1);
    expect(resolveMeleeInteractions(state, shapes)).toEqual([
      expect.objectContaining({ type: 'HIT', attackerId: 'p1', targetId: 'p2' })
    ]);
    expect(resolveMeleeInteractions(state, shapes)).toEqual([]);
    expect(state.players.p1.stats.completedAttacks).toBe(1);
    expect(snapshotMatch(state).players.find(({ playerId }) => playerId === 'p1')?.action).toMatchObject({
      kind: null,
      attackId: null,
      hitTargetIds: []
    });

    state.tick += 1;
    state.players.p3.position = { x: 642, y: 360 };
    expect(resolveMeleeInteractions(state, shapes)).toEqual([]);
    expect(state.players.p3.overload).toBe(0);
  });

  it('lands a visible swept-capsule contact and rejects a one-pixel near miss', () => {
    const hitState = createState();
    const hitAttack = attack(hitState, 'p1', 1, 'QUICK_1');
    const visible = shape('p1', hitAttack, { x: 620, y: 340 }, { x: 660, y: 380 });

    expect(resolveMeleeInteractions(hitState, [visible])).toEqual([
      expect.objectContaining({ type: 'HIT', attackerId: 'p1', targetId: 'p2' })
    ]);

    const missState = createState();
    missState.players.p2.position = { x: 660, y: 411 };
    const missAttack = attack(missState, 'p1', 1, 'QUICK_1');
    const nearMiss = shape('p1', missAttack, { x: 620, y: 340 }, { x: 660, y: 380 });

    expect(resolveMeleeInteractions(missState, [nearMiss])).toEqual([]);
    expect(missState.players.p2.overload).toBe(0);
  });

  it('reports melee hit contact on the defender boundary instead of the center', () => {
    const state = createState();
    const runtime = attack(state, 'p1', 1, 'QUICK_1');

    expect(resolveMeleeInteractions(state, [
      shape('p1', runtime, { x: 600, y: 360 }, { x: 640, y: 360 })
    ])).toEqual([
      expect.objectContaining({
        type: 'HIT',
        attackerId: 'p1',
        targetId: 'p2',
        impactPosition: { x: 626, y: 360 }
      })
    ]);
  });

  it('resolves one target once per attack and every overlapping target in stable player-id order', () => {
    const state = createState();
    state.players.p3.position = { x: 650, y: 360 };
    state.players.p4.connected = true;
    state.players.p4.position = { x: 650, y: 360 };
    const runtime = attack(state, 'p1', 1, 'QUICK_1');
    const sweep = shape('p1', runtime, { x: 620, y: 340 }, { x: 660, y: 380 });

    const first = resolveMeleeInteractions(state, [sweep]);
    const repeated = resolveMeleeInteractions(state, [sweep]);

    expect(first.map((event) => event.type === 'HIT' ? event.targetId : '')).toEqual(['p2', 'p3', 'p4']);
    expect(repeated).toEqual([]);
    expect([...runtime.resolvedPlayerIds].sort()).toEqual(['p2', 'p3', 'p4']);
    expect([...runtime.hitPlayerIds].sort()).toEqual(['p2', 'p3', 'p4']);
    expect(state.players.p1.stats.landedHits).toBe(1);
  });

  it('cancels quick/quick before hurt circles with opposite 90-unit recoil and no hit effects', () => {
    const state = createState();
    const left = attack(state, 'p1', 2, 'QUICK_1');
    const right = attack(state, 'p2', 1, 'QUICK_2');
    const events = resolveMeleeInteractions(state, [
      shape('p1', left, { x: 640, y: 340 }, { x: 660, y: 380 }),
      shape('p2', right, { x: 660, y: 340 }, { x: 640, y: 380 })
    ]);

    expect(events).toEqual([expect.objectContaining({
      type: 'CLASH', playerIds: ['p2', 'p1'], attackIds: [1, 2], strength: 'QUICK'
    })]);
    expect(left.phase).toBe('RECOVERY');
    expect(right.phase).toBe('RECOVERY');
    expect(state.players.p1.velocity).toEqual({ x: -90, y: 0 });
    expect(state.players.p2.velocity).toEqual({ x: 90, y: 0 });
    expect(state.players.p1.overload).toBe(0);
    expect(state.players.p2.overload).toBe(0);
    expect(state.players.p1.hitstunRemainingMs).toBe(0);
    expect(state.players.p2.hitstunRemainingMs).toBe(0);
  });

  it('lets heavy break quick while heavy remains active without clash recoil or hitstun', () => {
    const state = createState();
    const quick = attack(state, 'p1', 2, 'QUICK_1');
    const heavy = attack(state, 'p2', 1, 'HEAVY');
    const events = resolveMeleeInteractions(state, [
      shape('p1', quick, { x: 640, y: 340 }, { x: 660, y: 380 }),
      shape('p2', heavy, { x: 660, y: 340 }, { x: 640, y: 380 }, 10)
    ]);

    expect(events[0]).toMatchObject({
      type: 'CLASH', playerIds: ['p2', 'p1'], attackIds: [1, 2], strength: 'HEAVY'
    });
    expect(heavy.phase).toBe('ACTIVE');
    expect(quick.phase).toBe('RECOVERY');
    expect(state.players.p1.velocity).toEqual({ x: 0, y: 0 });
    expect(state.players.p2.velocity).toEqual({ x: 0, y: 0 });
    expect(state.players.p1.hitstunRemainingMs).toBe(0);
    expect(state.players.p2.hitstunRemainingMs).toBe(0);
  });

  it('cancels heavy/heavy with opposite 150-unit recoil and no overload or hitstun', () => {
    const state = createState();
    const left = attack(state, 'p1', 1, 'HEAVY');
    const right = attack(state, 'p2', 2, 'HEAVY');
    const events = resolveMeleeInteractions(state, [
      shape('p2', right, { x: 660, y: 340 }, { x: 640, y: 380 }, 10),
      shape('p1', left, { x: 640, y: 340 }, { x: 660, y: 380 }, 10)
    ]);

    expect(events).toEqual([expect.objectContaining({ type: 'CLASH', strength: 'HEAVY' })]);
    expect(left.phase).toBe('RECOVERY');
    expect(right.phase).toBe('RECOVERY');
    expect(state.players.p1.velocity).toEqual({ x: -150, y: 0 });
    expect(state.players.p2.velocity).toEqual({ x: 150, y: 0 });
    expect(state.players.p1.overload).toBe(0);
    expect(state.players.p2.overload).toBe(0);
    expect(state.players.p1.hitstunRemainingMs).toBe(0);
    expect(state.players.p2.hitstunRemainingMs).toBe(0);
  });

  it('cancels an uncommitted heavy charge only after a confirmed normal hit', () => {
    const state = createState();
    state.players.p2.chargeMs = 1;
    state.players.p2.charging = true;
    const runtime = attack(state, 'p1', 1, 'QUICK_1');

    expect(resolveMeleeInteractions(state, [
      shape('p1', runtime, { x: 620, y: 340 }, { x: 660, y: 380 })
    ])).toEqual([expect.objectContaining({ type: 'HIT', targetId: 'p2' })]);
    expect(state.players.p2.chargeMs).toBe(0);
    expect(state.players.p2.charging).toBe(false);
  });

  it.each([
    { chargeMs: 0, resultingOverload: 18, impulse: 460 * 1.18 },
    { chargeMs: 225, resultingOverload: 25, impulse: 610 * 1.25 },
    { chargeMs: 450, resultingOverload: 32, impulse: 760 * 1.32 }
  ])('scales heavy impact continuously from zero through $chargeMs ms', ({ chargeMs, resultingOverload, impulse }) => {
    const state = createState();
    const runtime = attack(state, 'p1', 1, 'HEAVY', { x: 1, y: 0 }, chargeMs);

    expect(resolveMeleeInteractions(state, [
      shape('p1', runtime, { x: 620, y: 340 }, { x: 660, y: 380 }, 10)
    ])).toEqual([expect.objectContaining({
      type: 'HIT', attack: 'HEAVY', resultingOverload, impulse
    })]);
  });

  it('refunds exactly 550 ms only for the first avoided attack of a dash and resolves every contact', () => {
    const state = createState();
    state.players.p2.dashInvulnerabilityRemainingMs = 1;
    state.players.p2.dashCooldownRemainingMs = 900;
    const first = attack(state, 'p1', 1, 'QUICK_1');
    const second = attack(state, 'p3', 2, 'QUICK_2', { x: -1, y: 0 });
    const shapes = [
      shape('p3', second, { x: 674, y: 360 }, { x: 680, y: 360 }),
      shape('p1', first, { x: 620, y: 360 }, { x: 626, y: 360 })
    ];

    const events = resolveMeleeInteractions(state, shapes);
    const repeated = resolveMeleeInteractions(state, shapes);

    expect(events).toEqual([expect.objectContaining({
      type: 'PERFECT_DODGE', playerId: 'p2', attackerId: 'p1', attackId: 1,
      source: 'QUICK_1', projectileId: null, refundedMs: 550
    })]);
    expect(repeated).toEqual([]);
    expect(state.players.p2.dashCooldownRemainingMs).toBe(350);
    expect(state.players.p2.perfectDodgeConsumed).toBe(true);
    expect(first.resolvedPlayerIds.has('p2')).toBe(true);
    expect(second.resolvedPlayerIds.has('p2')).toBe(true);
    expect(first.hitPlayerIds.size).toBe(0);
    expect(second.hitPlayerIds.size).toBe(0);
  });

  it.each([
    ['east', { x: 1, y: 0 }, { x: 34, y: -32 }, { x: 42, y: 32 }],
    ['south-east', { x: Math.SQRT1_2, y: Math.SQRT1_2 }, { x: 46.6690476, y: 1.4142136 }, { x: 7.0710678, y: 52.3259018 }],
    ['south', { x: 0, y: 1 }, { x: 32, y: 34 }, { x: -32, y: 42 }],
    ['south-west', { x: -Math.SQRT1_2, y: Math.SQRT1_2 }, { x: -1.4142136, y: 46.6690476 }, { x: -52.3259018, y: 7.0710678 }],
    ['west', { x: -1, y: 0 }, { x: -34, y: 32 }, { x: -42, y: -32 }],
    ['north-west', { x: -Math.SQRT1_2, y: -Math.SQRT1_2 }, { x: -46.6690476, y: -1.4142136 }, { x: -7.0710678, y: -52.3259018 }],
    ['north', { x: 0, y: -1 }, { x: -32, y: -34 }, { x: 32, y: -42 }],
    ['north-east', { x: Math.SQRT1_2, y: -Math.SQRT1_2 }, { x: 1.4142136, y: -46.6690476 }, { x: 52.3259018, y: -7.0710678 }]
  ] as const)('builds the quick sweep from immutable locked facing toward %s', (_name, facing, from, to) => {
    const state = createState();
    state.players.p1.position = { x: 0, y: 0 };
    const runtime = attack(state, 'p1', 1, 'QUICK_1', facing);
    state.players.p1.latestInput = { ...state.players.p1.latestInput, aimX: -facing.x, aimY: -facing.y };
    const slice: ActiveAttackSlice = {
      playerId: 'p1', attack: runtime, previousProgress: 0, currentProgress: 1, enteredActive: true
    };

    const [built] = buildActiveAttackShapes(state, [slice]);

    expect(built.capsule.from.x).toBeCloseTo(from.x, 6);
    expect(built.capsule.from.y).toBeCloseTo(from.y, 6);
    expect(built.capsule.to.x).toBeCloseTo(to.x, 6);
    expect(built.capsule.to.y).toBeCloseTo(to.y, 6);
  });

  it('breaks an intersecting pulse before any fighter contact and consumes it once', () => {
    const state = createState();
    const breaker = attack(state, 'p2', 4, 'QUICK_1', { x: -1, y: 0 });
    const origin = attack(state, 'p1', 3, 'HEAVY');
    const pulse = spawnNeonPulse(state, state.players.p1, origin)!.pulse;
    pulse.previousPosition = { x: 620, y: 360 };
    pulse.position = { x: 680, y: 360 };
    state.players.p3.position = { x: 650, y: 360 };
    const breakerShape = shape('p2', breaker, { x: 650, y: 330 }, { x: 650, y: 390 });

    const clashEvents = resolveClashesAndPulseBreaks(state, [breakerShape]);
    const contactEvents = resolveSurvivingContacts(state, [breakerShape]);

    expect(clashEvents).toEqual([expect.objectContaining({
      type: 'PULSE_BREAK', projectileId: 1, breakerPlayerId: 'p2', breakerAttackId: 4
    })]);
    expect(contactEvents.some((event) => event.type === 'HIT' && event.attack === 'NEON_PULSE')).toBe(false);
    expect(state.pulses).toEqual({});
  });

  it('consumes a surviving pulse on the nearest eligible travel contact, then stable player ID', () => {
    const nearest = createState();
    const nearestAttack = attack(nearest, 'p1', 1, 'HEAVY');
    const nearestPulse = spawnNeonPulse(nearest, nearest.players.p1, nearestAttack)!.pulse;
    nearestPulse.previousPosition = { x: 600, y: 360 };
    nearestPulse.position = { x: 800, y: 360 };
    nearest.players.p2.position = { x: 710, y: 360 };
    nearest.players.p3.position = { x: 650, y: 360 };

    expect(resolveSurvivingContacts(nearest, [])).toEqual([
      expect.objectContaining({ type: 'HIT', attack: 'NEON_PULSE', targetId: 'p3' })
    ]);
    expect(nearest.pulses).toEqual({});

    const tied = createState();
    const tiedAttack = attack(tied, 'p1', 1, 'HEAVY');
    const tiedPulse = spawnNeonPulse(tied, tied.players.p1, tiedAttack)!.pulse;
    tiedPulse.previousPosition = { x: 600, y: 360 };
    tiedPulse.position = { x: 800, y: 360 };
    tied.players.p2.position = { x: 670, y: 360 };
    tied.players.p3.position = { x: 670, y: 360 };

    expect(resolveSurvivingContacts(tied, [])).toEqual([
      expect.objectContaining({ type: 'HIT', attack: 'NEON_PULSE', targetId: 'p2' })
    ]);
  });

  it('shares melee hit deduplication and consumes on the first still-valid pulse target', () => {
    const state = createState();
    const origin = attack(state, 'p1', 1, 'HEAVY');
    origin.hitPlayerIds.add('p2');
    const pulse = spawnNeonPulse(state, state.players.p1, origin)!.pulse;
    pulse.previousPosition = { x: 600, y: 360 };
    pulse.position = { x: 800, y: 360 };
    state.players.p2.position = { x: 640, y: 360 };
    state.players.p3.position = { x: 700, y: 360 };

    const events = resolveSurvivingContacts(state, []);

    expect(pulse.hitPlayerIds).toBe(origin.hitPlayerIds);
    expect(events).toEqual([expect.objectContaining({
      type: 'HIT', attackerId: 'p1', targetId: 'p3', attack: 'NEON_PULSE'
    })]);
    expect([...origin.hitPlayerIds].sort()).toEqual(['p2', 'p3']);
    expect(state.pulses).toEqual({});
  });

  it('does not let the originating melee attack hit a target already consumed by its pulse', () => {
    const state = createState();
    const origin = attack(state, 'p1', 1, 'HEAVY');
    const pulse = spawnNeonPulse(state, state.players.p1, origin)!.pulse;
    pulse.previousPosition = { x: 600, y: 360 };
    pulse.position = { x: 700, y: 360 };
    state.players.p2.position = { x: 650, y: 360 };

    expect(resolveSurvivingContacts(state, [])).toEqual([
      expect.objectContaining({ type: 'HIT', targetId: 'p2', attack: 'NEON_PULSE' })
    ]);
    const overloadAfterPulse = state.players.p2.overload;

    expect(resolveSurvivingContacts(state, [
      shape('p1', origin, { x: 620, y: 340 }, { x: 680, y: 380 }, 10)
    ])).toEqual([]);
    expect(state.players.p2.overload).toBe(overloadAfterPulse);
  });

  it('consumes a pulse at the first dash-invulnerable contact and refunds once per dash', () => {
    const state = createState();
    const origin = attack(state, 'p1', 7, 'HEAVY');
    const pulse = spawnNeonPulse(state, state.players.p1, origin)!.pulse;
    pulse.previousPosition = { x: 600, y: 360 };
    pulse.position = { x: 800, y: 360 };
    state.players.p2.position = { x: 650, y: 360 };
    state.players.p2.dashInvulnerabilityRemainingMs = 50;
    state.players.p2.dashCooldownRemainingMs = 900;

    const events = resolveSurvivingContacts(state, []);

    expect(events).toEqual([expect.objectContaining({
      type: 'PERFECT_DODGE', playerId: 'p2', attackerId: 'p1', attackId: 7,
      source: 'NEON_PULSE', projectileId: 1, refundedMs: 550
    })]);
    expect(state.players.p2.dashCooldownRemainingMs).toBe(350);
    expect(state.players.p2.perfectDodgeConsumed).toBe(true);
    expect(origin.hitPlayerIds.size).toBe(0);
    expect(state.pulses).toEqual({});

    const second = spawnNeonPulse(state, state.players.p1, attack(state, 'p1', 8, 'HEAVY'))!.pulse;
    second.previousPosition = { x: 600, y: 360 };
    second.position = { x: 800, y: 360 };
    expect(resolveSurvivingContacts(state, [])).toEqual([]);
    expect(state.players.p2.dashCooldownRemainingMs).toBe(350);
    expect(state.pulses).toEqual({});
  });

  it('uses the continuous pulse capsule rather than its endpoint for contacts', () => {
    const state = createState();
    const origin = attack(state, 'p1', 1, 'HEAVY');
    const pulse = spawnNeonPulse(state, state.players.p1, origin)!.pulse;
    pulse.position = { x: 600, y: 360 };
    pulse.previousPosition = { x: 600, y: 360 };
    pulse.velocity = { x: 900, y: 0 };
    state.players.p2.position = { x: 680, y: 360 };
    state.players.p3.position = { x: 900, y: 360 };

    advancePulses(state, 200);

    expect(pulse.position).toEqual({ x: 780, y: 360 });
    expect(resolveSurvivingContacts(state, [])).toEqual([
      expect.objectContaining({ type: 'HIT', targetId: 'p2', attack: 'NEON_PULSE' })
    ]);
  });

  it('reports neon pulse hit contact on the defender boundary instead of the center', () => {
    const state = createState();
    const origin = attack(state, 'p1', 1, 'HEAVY');
    const pulse = spawnNeonPulse(state, state.players.p1, origin)!.pulse;
    pulse.previousPosition = { x: 600, y: 360 };
    pulse.position = { x: 800, y: 360 };
    state.players.p2.position = { x: 680, y: 372 };

    expect(resolveSurvivingContacts(state, [])).toEqual([
      expect.objectContaining({
        type: 'HIT',
        targetId: 'p2',
        attack: 'NEON_PULSE',
        impactPosition: { x: 680, y: 348 }
      })
    ]);
  });
});
