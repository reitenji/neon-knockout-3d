import { describe, expect, it } from 'vitest';

import { GAME } from '../../shared/constants.js';
import { DEFAULT_ROOM_SETTINGS } from '../../shared/roomSettings.js';
import { buildActiveAttackShapes, resolveMeleeInteractions } from './combatResolution.js';
import { advanceCombatTimers, startActions } from './combat.js';
import { createMatchState, type MatchState, type MutableMatchPlayer } from './state.js';

const input = (seq: number, overrides: Partial<MutableMatchPlayer['latestInput']> = {}) => ({
  seq, viewTick: 0, moveX: 0, moveY: 0, aimX: 1, aimY: 0, quick: false, heavy: false, dash: false, ...overrides
});

function createState(): MatchState {
  const state = createMatchState([
    { playerId: 'p3', name: 'Grace', chassis: 'PULSE', accent: 2 },
    { playerId: 'p1', name: 'Ada', chassis: 'RIFT', accent: 0 },
    { playerId: 'p2', name: 'Linus', chassis: 'RIFT', accent: 1 }
  ], 7, DEFAULT_ROOM_SETTINGS);
  state.phase = 'REGULATION';
  state.players.p1.position = { x: 600, y: 360 };
  state.players.p2.position = { x: 650, y: 360 };
  state.players.p3.position = { x: 660, y: 360 };
  return state;
}

function beginQuick(state: MatchState, playerId = 'p1'): void {
  state.players[playerId].latestInput = input(0, { quick: true });
  startActions(state);
}

function advanceAndResolve(state: MatchState, stepMs: number) {
  const { activeSlices } = advanceCombatTimers(state, stepMs);
  return resolveMeleeInteractions(state, buildActiveAttackShapes(state, activeSlices));
}

describe('authoritative combat', () => {
  it.each([
    { step: 1, kind: 'QUICK_1', windup: 70, active: 60, recovery: 100 },
    { step: 2, kind: 'QUICK_2', windup: 65, active: 65, recovery: 120 },
    { step: 3, kind: 'QUICK_3', windup: 115, active: 70, recovery: 205 }
  ] as const)('uses the exact windup, active, and recovery windows for quick step $step', ({ step, kind, windup, active, recovery }) => {
    const state = createState();
    const player = state.players.p1;
    player.comboStep = (step - 1) as 0 | 1 | 2;
    beginQuick(state);
    expect(player.attack).toMatchObject({ kind, phase: 'WINDUP', phaseRemainingMs: windup });
    advanceCombatTimers(state, windup - 1);
    expect(player.attack).toMatchObject({ phase: 'WINDUP', phaseRemainingMs: 1 });
    advanceCombatTimers(state, 1);
    expect(player.attack).toMatchObject({ phase: 'ACTIVE', phaseRemainingMs: active });
    advanceCombatTimers(state, active);
    expect(player.attack).toMatchObject({ phase: 'RECOVERY', phaseRemainingMs: recovery });
    advanceCombatTimers(state, recovery);
    startActions(state);
    expect(player.attack).toBeNull();
  });

  it('buffers a combo only from recovery and advances no further than quick step three', () => {
    const state = createState();
    const player = state.players.p1;
    beginQuick(state);
    player.latestInput = input(1);
    startActions(state);
    advanceCombatTimers(state, GAME.quickCombo[0].windupMs);
    player.latestInput = input(2, { quick: true });
    startActions(state);
    expect(player.bufferedQuick).toBe(false);
    player.latestInput = input(3);
    startActions(state);
    advanceCombatTimers(state, GAME.quickCombo[0].activeMs);
    player.latestInput = input(4, { quick: true });
    startActions(state);
    expect(player.bufferedQuick).toBe(true);
    player.latestInput = input(5);
    advanceCombatTimers(state, GAME.quickCombo[0].recoveryMs);
    startActions(state);
    expect(player.attack?.kind).toBe('QUICK_2');
    player.comboStep = 3;
    player.attack = null;
    player.previousQuick = false;
    player.latestInput = input(6, { quick: true });
    startActions(state);
    const attack = player.attack as MutableMatchPlayer['attack'];
    expect(attack?.kind).toBe('QUICK_1');
  });

  it('hits each target crossed by the visible sweep once per attack in stable-id order', () => {
    const state = createState();
    state.players.p2.position = { x: 642, y: 360 };
    state.players.p3.position = { x: 642, y: 360 };
    beginQuick(state);
    const timers = advanceCombatTimers(
      state,
      GAME.quickCombo[0].windupMs + GAME.quickCombo[0].activeMs
    );
    const shapes = buildActiveAttackShapes(state, timers.activeSlices);
    const first = resolveMeleeInteractions(state, shapes);
    const repeated = resolveMeleeInteractions(state, shapes);
    expect(first.map((event) => event.type === 'HIT' ? event.targetId : '')).toEqual(['p2', 'p3']);
    expect(repeated).toEqual([]);
    expect(state.players.p1.stats.landedHits).toBe(1);
  });

  it('rejects a hurt circle just outside the visible swept capsule', () => {
    const state = createState();
    state.players.p2.position = { x: 642, y: 423 };
    state.players.p3.connected = false;
    beginQuick(state);
    expect(advanceAndResolve(
      state,
      GAME.quickCombo[0].windupMs + GAME.quickCombo[0].activeMs
    )).toEqual([]);
  });

  it('rejects spawn protection while dash invulnerability emits perfect-dodge feedback', () => {
    const state = createState();
    state.players.p2.position = { x: 642, y: 360 };
    state.players.p3.position = { x: 642, y: 360 };
    state.players.p3.dashCooldownRemainingMs = 900;
    beginQuick(state);
    state.players.p2.protectionRemainingMs = GAME.respawnProtectionMs;
    state.players.p3.dashInvulnerabilityRemainingMs = 1;
    expect(advanceAndResolve(
      state,
      GAME.quickCombo[0].windupMs + GAME.quickCombo[0].activeMs
    )).toEqual([expect.objectContaining({
      type: 'PERFECT_DODGE', playerId: 'p3', attackerId: 'p1', refundedMs: 550
    })]);
    expect(state.players.p2.overload).toBe(0);
    expect(state.players.p3.overload).toBe(0);
  });

  it('cancels spawn protection before the protected player starts an attack', () => {
    const state = createState();
    const player = state.players.p1;
    player.protectionRemainingMs = GAME.respawnProtectionMs;
    beginQuick(state);
    expect(player.attack?.kind).toBe('QUICK_1');
    expect(player.protectionRemainingMs).toBe(0);
  });

  it('captures the latest normalized aim when an attack starts', () => {
    const state = createState();
    const player = state.players.p1;
    player.facing = { x: 1, y: 0 };
    player.latestInput = input(0, { aimX: 0, aimY: -1, quick: true });
    startActions(state);
    expect(player.attack?.lockedFacing).toEqual({ x: 0, y: -1 });
  });

  it('releases every positive heavy hold as melee, and caps full charge at 450 ms', () => {
    const minimum = createState();
    minimum.players.p1.latestInput = input(0, { heavy: true });
    advanceCombatTimers(minimum, 1);
    startActions(minimum);
    minimum.players.p1.latestInput = input(1);
    startActions(minimum);
    expect(minimum.players.p1.attack).toMatchObject({ kind: 'HEAVY', chargeMs: 1 });
    const maximum = createState();
    maximum.players.p1.latestInput = input(0, { heavy: true });
    advanceCombatTimers(maximum, GAME.heavyMaxChargeMs + 500);
    startActions(maximum);
    maximum.players.p1.latestInput = input(1);
    startActions(maximum);
    expect(GAME.heavyMaxChargeMs).toBe(450);
    expect(maximum.players.p1.attack).toMatchObject({ kind: 'HEAVY', chargeMs: 450 });
  });

  it('lets dash cancel only an uncommitted charge', () => {
    const state = createState();
    const player = state.players.p1;
    player.latestInput = input(0, { heavy: true });
    advanceCombatTimers(state, 1);
    startActions(state);
    expect(player.charging).toBe(true);
    player.latestInput = input(1, { heavy: true, dash: true });
    startActions(state);
    expect(player.chargeMs).toBe(0);
    expect(player.charging).toBe(false);
    player.previousHeavy = true;
    player.latestInput = input(2);
    player.chargeMs = GAME.heavyMaxChargeMs;
    startActions(state);
    expect(player.attack?.kind).toBe('HEAVY');
    player.latestInput = input(3, { dash: true });
    startActions(state);
    expect(player.attack?.kind).toBe('HEAVY');
    expect(player.previousDash).toBe(true);
  });

  it('does not precharge a held heavy button during a committed attack timeline', () => {
    const state = createState();
    const player = state.players.p1;
    player.previousHeavy = true;
    player.chargeMs = GAME.heavyMaxChargeMs;
    player.latestInput = input(1);
    startActions(state);
    player.latestInput = input(2, { heavy: true });
    advanceCombatTimers(state, GAME.heavyWindupMs + GAME.heavyActiveMs + GAME.heavyRecoveryMs);
    expect(player.attack).toBeNull();
    expect(player.chargeMs).toBe(0);
  });

  it('applies exact overload impulse and the 90 ms minimum hitstun', () => {
    const state = createState();
    state.players.p3.connected = false;
    state.players.p2.position = { x: 642, y: 360 };
    beginQuick(state);
    const events = advanceAndResolve(
      state,
      GAME.quickCombo[0].windupMs + GAME.quickCombo[0].activeMs
    );
    const expectedImpulse = 110 * 1.08;
    expect(events).toContainEqual(expect.objectContaining({
      type: 'HIT', attackerId: 'p1', targetId: 'p2', attack: 'QUICK_1',
      resultingOverload: 8, impulse: expectedImpulse
    }));
    expect(state.players.p2.velocity.x).toBeCloseTo(expectedImpulse, 8);
    expect(state.players.p2.hitstunRemainingMs).toBe(90);
  });

  it.each([
    { startingOverload: 42, resultingOverload: 50, multiplier: 1.5 },
    { startingOverload: 92, resultingOverload: 100, multiplier: 2 }
  ])(
    'adds $resultingOverload percent knockback at $resultingOverload percent overload',
    ({ startingOverload, resultingOverload, multiplier }) => {
      const state = createState();
      state.players.p3.connected = false;
      state.players.p2.position = { x: 642, y: 360 };
      state.players.p2.overload = startingOverload;
      beginQuick(state);

      const events = advanceAndResolve(
        state,
        GAME.quickCombo[0].windupMs + GAME.quickCombo[0].activeMs
      );

      expect(events).toContainEqual(expect.objectContaining({
        type: 'HIT',
        resultingOverload,
        impulse: 110 * multiplier
      }));
      expect(state.players.p2.velocity.x).toBeCloseTo(110 * multiplier, 8);
    }
  );

  it('caps overload and applies the exact 230 ms maximum hitstun for a full heavy', () => {
    const state = createState();
    state.players.p3.connected = false;
    state.players.p2.position = { x: 648, y: 360 };
    state.players.p2.overload = GAME.maxOverload;
    const attacker = state.players.p1;
    attacker.previousHeavy = true;
    attacker.chargeMs = GAME.heavyMaxChargeMs;
    attacker.latestInput = input(1);
    startActions(state);
    const events = advanceAndResolve(state, GAME.heavyWindupMs + GAME.heavyActiveMs);
    expect(events).toContainEqual(expect.objectContaining({
      type: 'HIT', attack: 'HEAVY', impulse: 760 * 2.5, resultingOverload: 150
    }));
    expect(state.players.p2.hitstunRemainingMs).toBe(230);
  });
});
