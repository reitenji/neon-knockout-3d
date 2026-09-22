import { describe, expect, it } from 'vitest';
import { ARENA, GAME } from '../../shared/constants.js';
import { FIGHTERS } from '../../shared/fighters.js';
import { profileForAttack } from '../../shared/combat/profiles.js';
import { DEFAULT_ROOM_SETTINGS } from '../../shared/roomSettings.js';
import type { RoomSettings } from '../../shared/roomSettings.js';
import type { AttackKind, InputFrame, Vec2 } from '../../shared/model.js';
import { advanceCombatTimers } from './combat.js';
import { spawnNeonPulse } from './projectiles.js';
import { forceKnockout, resumePausedMatch, setMatchPaused, setPlayerConnected, snapshotMatch, stepMatch } from './simulation.js';
import { createMatchState, type AttackRuntime, type MatchState } from './state.js';
import { CombatFrameHistory } from './CombatFrameHistory.js';

const idle = (seq: number, overrides: Partial<InputFrame> = {}): InputFrame => ({
  seq, viewTick: 0, moveX: 0, moveY: 0, aimX: 1, aimY: 0, quick: false, heavy: false, dash: false, ...overrides
});
const seeds = () => [
  { playerId: 'p1', name: 'Ada', accent: 0 as const, chassis: 'RIFT' as const },
  { playerId: 'p2', name: 'Linus', accent: 1 as const, chassis: 'BASTION' as const }
];
function regulationState(settings: RoomSettings = DEFAULT_ROOM_SETTINGS): MatchState {
  const state = createMatchState(seeds(), 0, settings);
  state.phase = 'REGULATION';
  return state;
}

function activeAttack(
  state: MatchState,
  playerId: string,
  attackId: number,
  kind: AttackKind,
  facing: Vec2
): AttackRuntime {
  const profile = profileForAttack(kind);
  const attack: AttackRuntime = {
    attackId,
    viewTick: state.tick,
    kind,
    profileId: profile.id,
    phase: 'ACTIVE',
    phaseRemainingMs: profile.activeMs,
    phaseElapsedMs: 0,
    previousActiveProgress: 0,
    lockedFacing: facing,
    chargeMs: kind === 'HEAVY' ? GAME.heavyMaxChargeMs : 0,
    hitPlayerIds: new Set(),
    resolvedPlayerIds: new Set()
  };
  state.players[playerId].attack = attack;
  return attack;
}

describe('authoritative match simulation', () => {
  it('binds input viewTick to the attack and resolves its retained target pose through simulation', () => {
    const state = regulationState();
    state.players.p1.position = { x: 600, y: 360 };
    state.players.p2.position = { x: 650, y: 360 };
    const history = new CombatFrameHistory();
    history.capture(state);
    state.players.p2.position = { x: 900, y: 360 };

    expect(stepMatch(state, new Map([['p1', idle(0, { quick: true, viewTick: 0 })]]), 0, history)).toEqual([]);
    expect(state.players.p1.attack?.viewTick).toBe(0);
    const events = stepMatch(
      state,
      new Map([['p1', idle(1, { viewTick: 1 })]]),
      GAME.quickCombo[0].windupMs + GAME.quickCombo[0].activeMs,
      history
    );

    expect(events).toEqual([expect.objectContaining({ type: 'HIT', attackerId: 'p1', targetId: 'p2' })]);
  });

  it('snapshots scores as a record and connected players in stable order', () => {
    const snapshot = snapshotMatch(createMatchState(seeds().reverse(), 0, DEFAULT_ROOM_SETTINGS));
    expect(snapshot).toMatchObject({ tick: 0, phase: 'COUNTDOWN', remainingMs: GAME.countdownMs, scores: { p1: 0, p2: 0 } });
    expect(snapshot.players.map((player) => player.playerId)).toEqual(['p1', 'p2']);
    expect(snapshot.settings).toEqual(DEFAULT_ROOM_SETTINGS);
  });

  it('freezes the match-owned settings copy and isolates caller and snapshot mutations', () => {
    let callerSettings: RoomSettings = { durationMs: 90_000, knockoutTarget: 3 };
    const originalCallerSettings = callerSettings;
    const state = createMatchState(seeds(), 0, callerSettings);
    const snapshot = snapshotMatch(state);

    callerSettings = { durationMs: 180_000, knockoutTarget: 10 };
    (originalCallerSettings as { durationMs: number }).durationMs = 120_000;
    (snapshot.settings as { knockoutTarget: number }).knockoutTarget = 10;

    expect(callerSettings).toEqual({ durationMs: 180_000, knockoutTarget: 10 });
    expect(Object.isFrozen(state.settings)).toBe(true);
    expect(state.settings).toEqual({ durationMs: 90_000, knockoutTarget: 3 });
  });

  it('unlocks regulation after countdown without applying gameplay in that countdown step', () => {
    const state = createMatchState(seeds(), 0, DEFAULT_ROOM_SETTINGS);
    const original = state.players.p1.position;
    const events = stepMatch(state, new Map([['p1', idle(0, { moveX: 1 })]]), GAME.countdownMs);
    expect(state.phase).toBe('REGULATION');
    expect(state.players.p1.position).toEqual(original);
    expect(events).toContainEqual(expect.objectContaining({ type: 'PHASE', phase: 'REGULATION' }));
  });

  it('accepts only newer finite inputs and normalizes movement and aim', () => {
    const state = regulationState();
    stepMatch(state, new Map([['p1', idle(4, { moveX: 2, moveY: 2, aimX: 3, aimY: 4 })]]), 0);
    expect(state.players.p1.latestInput.seq).toBe(4);
    expect(state.players.p1.latestInput.moveX).toBeCloseTo(Math.SQRT1_2, 12);
    expect(state.players.p1.latestInput.moveY).toBeCloseTo(Math.SQRT1_2, 12);
    expect(state.players.p1.latestInput.aimX).toBeCloseTo(0.6, 12);
    expect(state.players.p1.latestInput.aimY).toBeCloseTo(0.8, 12);
    stepMatch(state, new Map([['p1', idle(3, { moveX: -1 })]]), 0);
    stepMatch(state, new Map([['p1', idle(5, { aimX: Number.NaN })]]), 0);
    expect(state.players.p1.latestInput.seq).toBe(4);
  });

  it('emits monotonic event IDs and ticks for ordered hits and knockouts', () => {
    const state = regulationState();
    state.players.p1.position = { x: 600, y: 360 };
    state.players.p2.position = { x: 650, y: 360 };
    stepMatch(state, new Map([['p1', idle(0, { quick: true })]]), 0);
    const events = [
      ...stepMatch(
        state,
        new Map([['p1', idle(1)]]),
        GAME.quickCombo[0].windupMs + GAME.quickCombo[0].activeMs
      ),
      ...forceKnockout(state, 'p1', 'p2')
    ];
    expect(events.map((event) => event.type)).toEqual(['HIT', 'KNOCKOUT']);
    expect(events.map((event) => event.eventId)).toEqual([1, 2]);
    expect(events[0].tick).toBeLessThanOrEqual(events[1].tick);
  });

  it('resolves the terminal active sweep slice when the same 60 Hz step enters recovery', () => {
    const state = regulationState();
    state.players.p1.position = { x: 600, y: 360 };
    state.players.p2.position = { x: 642, y: 392 };
    stepMatch(state, new Map([['p1', idle(0, { quick: true })]]), 0);
    advanceCombatTimers(state, GAME.quickCombo[0].windupMs + 50);

    const events = stepMatch(state, new Map([['p1', idle(1)]]), 1_000 / 60);

    expect(state.players.p1.attack?.phase).toBe('RECOVERY');
    expect(events).toEqual([expect.objectContaining({ type: 'HIT', attackerId: 'p1', targetId: 'p2' })]);
  });

  it('allows an attack on the exact step an active dash expires', () => {
    const state = regulationState();
    state.players.p1.dashRemainingMs = 1;
    const events = stepMatch(state, new Map([['p1', idle(0, { quick: true })]]), 1);
    expect(events).toEqual([]);
    expect(state.players.p1.attack?.kind).toBe('QUICK_1');
  });

  it('does not turn a held dash during a committed attack into a delayed dash', () => {
    const state = regulationState();
    stepMatch(state, new Map([['p1', idle(0, { heavy: true })]]), GAME.heavyMaxChargeMs);
    stepMatch(state, new Map([['p1', idle(1)]]), 0);
    stepMatch(state, new Map([['p1', idle(2, { dash: true })]]), GAME.heavyWindupMs);
    stepMatch(state, new Map([['p1', idle(3, { dash: true })]]), GAME.heavyActiveMs);
    stepMatch(state, new Map([['p1', idle(4, { dash: true })]]), GAME.heavyRecoveryMs);
    expect(state.players.p1.dashRemainingMs).toBe(0);

    stepMatch(state, new Map([['p1', idle(5)]]), 0);
    stepMatch(state, new Map([['p1', idle(6, { dash: true })]]), 0);
    expect(state.players.p1.dashRemainingMs).toBe(FIGHTERS.RIFT.dashDurationMs);
  });

  it('credits the last opponent inside four seconds and never credits a self-fall', () => {
    const credited = regulationState();
    credited.players.p2.lastAttackerId = 'p1';
    credited.players.p2.lastAttackerAtMs = credited.nowMs - 4_000;
    credited.players.p2.position = { x: 640, y: 0 };
    expect(stepMatch(credited, new Map(), 0)).toContainEqual(expect.objectContaining({
      type: 'KNOCKOUT', targetId: 'p2', scoreAwardedTo: 'p1', scores: { p1: 1, p2: 0 }
    }));
    const selfFall = regulationState();
    selfFall.players.p2.position = { x: 640, y: 0 };
    expect(stepMatch(selfFall, new Map(), 0)).toContainEqual(expect.objectContaining({
      type: 'KNOCKOUT', attackerId: null, targetId: 'p2', scoreAwardedTo: null
    }));
    expect(selfFall.scores).toEqual({ p1: 0, p2: 0 });
    expect(selfFall.players.p2.stats.falls).toBe(1);
  });

  it('expires knockout credit after four seconds', () => {
    const state = regulationState();
    state.players.p2.lastAttackerId = 'p1';
    state.players.p2.lastAttackerAtMs = state.nowMs - 4_001;
    state.players.p2.position = { x: 640, y: 0 };
    expect(stepMatch(state, new Map(), 0)).toContainEqual(expect.objectContaining({ type: 'KNOCKOUT', scoreAwardedTo: null }));
  });

  it('resolves every simultaneous knockout before selecting the stable target-score winner', () => {
    const state = createMatchState([
      { playerId: 'z-scorer', name: 'Zoe', accent: 3, chassis: 'WRAITH' },
      { playerId: 'p2', name: 'Linus', accent: 1, chassis: 'BASTION' },
      { playerId: 'a-scorer', name: 'Ada', accent: 0, chassis: 'RIFT' },
      { playerId: 'p1', name: 'Grace', accent: 2, chassis: 'PULSE' }
    ], 0, DEFAULT_ROOM_SETTINGS);
    state.phase = 'REGULATION';
    state.scores['z-scorer'] = GAME.targetScore - 1;
    state.scores['a-scorer'] = GAME.targetScore - 1;
    state.players.p1.position = { x: 500, y: 0 };
    state.players.p1.lastAttackerId = 'z-scorer';
    state.players.p1.lastAttackerAtMs = state.nowMs;
    state.players.p2.position = { x: 780, y: 0 };
    state.players.p2.lastAttackerId = 'a-scorer';
    state.players.p2.lastAttackerAtMs = state.nowMs;

    const events = stepMatch(state, new Map(), 0);

    expect(events.map((event) => event.type)).toEqual(['KNOCKOUT', 'KNOCKOUT', 'RESULT']);
    expect(events.map((event) => event.eventId)).toEqual([1, 2, 3]);
    expect(events[0]).toMatchObject({ targetId: 'p1', scoreAwardedTo: 'z-scorer' });
    expect(events[1]).toMatchObject({ targetId: 'p2', scoreAwardedTo: 'a-scorer' });
    expect(events[2]).toMatchObject({ winnerPlayerId: 'a-scorer', reason: 'TARGET_SCORE' });
    expect(state.scores['z-scorer']).toBe(GAME.targetScore);
    expect(state.scores['a-scorer']).toBe(GAME.targetScore);
    expect(state.players.p2.stats.falls).toBe(1);
    expect(state.players.p2.respawnRemainingMs).toBe(GAME.knockoutToControlMs);
  });

  it('does not credit a recent attacker knocked out earlier in the same boundary phase', () => {
    const state = regulationState();
    state.players.p1.position = { x: 500, y: 0 };
    state.players.p2.position = { x: 780, y: 0 };
    state.players.p2.lastAttackerId = 'p1';
    state.players.p2.lastAttackerAtMs = state.nowMs;

    const events = stepMatch(state, new Map(), 0);

    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ type: 'KNOCKOUT', targetId: 'p1', scoreAwardedTo: null });
    expect(events[1]).toMatchObject({ type: 'KNOCKOUT', targetId: 'p2', scoreAwardedTo: null });
    expect(events.map((event) => event.eventId)).toEqual([1, 2]);
    expect(state.scores).toEqual({ p1: 0, p2: 0 });
    expect(state.players.p1.stats.knockouts).toBe(0);
  });

  it('returns control at exactly 600 ms with a deterministic spawn and 650 ms protection', () => {
    const state = regulationState();
    forceKnockout(state, 'p1', 'p2');
    expect(GAME.knockoutToControlMs).toBe(600);
    expect(stepMatch(state, new Map(), 599)).toEqual([]);
    const events = stepMatch(state, new Map(), 1);
    expect(events).toContainEqual(expect.objectContaining({ type: 'RESPAWN', playerId: 'p2' }));
    expect(state.players.p2.position).toEqual(ARENA.spawnAnchors[3]);
    expect(state.players.p2.overload).toBe(0);
    expect(state.players.p2.protectionRemainingMs).toBe(GAME.respawnProtectionMs);
  });

  it('does not decrement a knockout timer on the same tick that creates it', () => {
    const state = regulationState();
    state.players.p2.position = { x: 640, y: 0 };

    const events = stepMatch(state, new Map(), 100);

    expect(events).toContainEqual(expect.objectContaining({ type: 'KNOCKOUT', targetId: 'p2' }));
    expect(state.players.p2.respawnRemainingMs).toBe(600);
    expect(stepMatch(state, new Map(), 599)).toEqual([]);
    expect(stepMatch(state, new Map(), 1)).toContainEqual(expect.objectContaining({ type: 'RESPAWN', playerId: 'p2' }));
  });

  it.each([
    [90_000, 58_500, 56_250, 30_000],
    [120_000, 78_000, 75_000, 40_000],
    [180_000, 117_000, 112_500, 60_000]
  ] as const)(
    'seeds %i ms regulation and contracts at its warning, start, and minimum milestones',
    (durationMs, warningAt, startsAt, minimumAt) => {
      const state = createMatchState(seeds(), 0, { durationMs, knockoutTarget: 5 });
      state.phase = 'REGULATION';
      expect(state.remainingMs).toBe(durationMs);
      expect(snapshotMatch(state).settings).toEqual({ durationMs, knockoutTarget: 5 });

      state.remainingMs = warningAt;
      stepMatch(state, new Map(), 0);
      expect(state.contraction).toBe(0);
      state.remainingMs = startsAt;
      stepMatch(state, new Map(), 0);
      expect(state.contraction).toBe(0);
      state.remainingMs = (startsAt + minimumAt) / 2;
      stepMatch(state, new Map(), 0);
      expect(state.contraction).toBeCloseTo(0.5, 8);
      state.remainingMs = minimumAt;
      stepMatch(state, new Map(), 0);
      expect(state.contraction).toBe(1);
    }
  );

  it.each([3, 5, 7, 10] as const)('finishes exactly at the configured knockout target %i', (knockoutTarget) => {
    const state = regulationState({ durationMs: DEFAULT_ROOM_SETTINGS.durationMs, knockoutTarget });
    state.scores.p1 = knockoutTarget - 1;
    expect(stepMatch(state, new Map(), 0).some((event) => event.type === 'RESULT')).toBe(false);

    const events = forceKnockout(state, 'p1', 'p2');

    expect(events.map((event) => event.type)).toEqual(['KNOCKOUT', 'RESULT']);
    expect(events.at(-1)).toMatchObject({ type: 'RESULT', winnerPlayerId: 'p1', reason: 'TARGET_SCORE' });
  });

  it('finishes regulation for a unique timed leader', () => {
    const state = regulationState();
    state.scores = { p1: 2, p2: 1 };
    state.remainingMs = 1;
    expect(stepMatch(state, new Map(), 1)).toContainEqual(expect.objectContaining({ type: 'RESULT', winnerPlayerId: 'p1', reason: 'TIME' }));
  });

  it('enters sudden death for tied leaders and ends on the next unique score', () => {
    const state = regulationState();
    state.scores = { p1: 2, p2: 2 };
    state.remainingMs = 1;
    expect(stepMatch(state, new Map(), 1)).toContainEqual(expect.objectContaining({ type: 'PHASE', phase: 'SUDDEN_DEATH' }));
    expect(state.contraction).toBe(1);
    expect(forceKnockout(state, 'p1', 'p2')).toContainEqual(expect.objectContaining({ type: 'RESULT', winnerPlayerId: 'p1', reason: 'SUDDEN_DEATH' }));
  });

  it('resets overload after a self-fall without changing either score', () => {
    const state = regulationState();
    state.players.p2.overload = 120;
    state.players.p2.position = { x: 640, y: 0 };

    expect(stepMatch(state, new Map(), 0)).toContainEqual(expect.objectContaining({
      type: 'KNOCKOUT', targetId: 'p2', scoreAwardedTo: null
    }));
    expect(state.scores).toEqual({ p1: 0, p2: 0 });
    stepMatch(state, new Map(), 600);
    expect(state.players.p2.overload).toBe(0);
    expect(state.scores).toEqual({ p1: 0, p2: 0 });
  });

  it('spawns one full-charge pulse after movement from the separated owner position', () => {
    const state = regulationState();
    const owner = state.players.p1;
    owner.position = { x: 500, y: 360 };
    state.players.p2.position = { x: 900, y: 360 };
    owner.latestInput = idle(0, { moveX: 1, aimX: 1, heavy: true });
    owner.chargeMs = GAME.heavyMaxChargeMs;
    owner.charging = true;
    owner.previousHeavy = true;
    stepMatch(state, new Map([['p1', idle(1, { moveX: 1, aimX: 1, heavy: false })]]), 0);

    const events = stepMatch(state, new Map([['p1', idle(2, { moveX: 1, aimX: 1 })]]), GAME.heavyWindupMs);

    expect(events).toEqual([expect.objectContaining({ type: 'PULSE_SPAWN', ownerPlayerId: 'p1' })]);
    expect(Object.values(state.pulses)).toHaveLength(1);
    expect(state.pulses[1].position.x).toBeCloseTo(owner.position.x + 74 + GAME.pulseSpeed * GAME.heavyWindupMs / 1_000, 8);
    expect(state.pulses[1].position.y).toBeCloseTo(owner.position.y, 8);

    stepMatch(state, new Map([['p1', idle(3)]]), 0);
    expect(Object.values(state.pulses)).toHaveLength(1);
  });

  it('clears every pulse when a result finishes the match', () => {
    const state = regulationState();
    const attack = activeAttack(state, 'p1', 1, 'HEAVY', { x: 1, y: 0 });
    spawnNeonPulse(state, state.players.p1, attack);
    state.scores.p1 = GAME.targetScore - 1;

    const events = forceKnockout(state, 'p1', 'p2');

    expect(events.map((event) => event.type)).toEqual(['KNOCKOUT', 'RESULT']);
    expect(state.phase).toBe('FINISHED');
    expect(state.pulses).toEqual({});
  });

  it('resolves one contact on the final lifetime-clamped pulse segment before expiry cleanup', () => {
    const state = regulationState();
    state.players.p1.position = { x: 300, y: 360 };
    state.players.p2.position = { x: 650, y: 360 };
    const attack = activeAttack(state, 'p1', 1, 'HEAVY', { x: 1, y: 0 });
    const pulse = spawnNeonPulse(state, state.players.p1, attack)!.pulse;
    pulse.position = { x: 600, y: 360 };
    pulse.previousPosition = { x: 600, y: 360 };
    pulse.velocity = { x: 900, y: 0 };
    pulse.remainingMs = 10;

    const expiryEvents = stepMatch(state, new Map(), 10);
    const nextEvents = stepMatch(state, new Map(), 10);

    expect(expiryEvents).toEqual([expect.objectContaining({
      type: 'HIT', attackerId: 'p1', targetId: 'p2', attack: 'NEON_PULSE'
    })]);
    expect(nextEvents.some((event) => event.type === 'HIT')).toBe(false);
    expect(state.players.p2.overload).toBe(14);
    expect(state.pulses).toEqual({});
  });

  it('purges an expired pulse after its final segment finds no contact', () => {
    const state = regulationState();
    state.players.p1.position = { x: 300, y: 360 };
    state.players.p2.position = { x: 900, y: 360 };
    const attack = activeAttack(state, 'p1', 1, 'HEAVY', { x: 1, y: 0 });
    const pulse = spawnNeonPulse(state, state.players.p1, attack)!.pulse;
    pulse.position = { x: 600, y: 360 };
    pulse.previousPosition = { x: 600, y: 360 };
    pulse.velocity = { x: 900, y: 0 };
    pulse.remainingMs = 10;

    expect(stepMatch(state, new Map(), 10)).toEqual([]);
    expect(pulse.position).toEqual({ x: 609, y: 360 });
    expect(pulse.remainingMs).toBe(0);
    expect(state.pulses).toEqual({});
  });

  it('emits CLASH, PULSE_BREAK, PERFECT_DODGE, HIT, KNOCKOUT, RESULT in phase order with stable IDs', () => {
    const playerIds = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7', 'p8', 'p9', 'p10'];
    const state = createMatchState(playerIds.map((playerId, index) => ({
      playerId, name: playerId, chassis: 'RIFT' as const, accent: (index % 8) as 0
    })), 0, DEFAULT_ROOM_SETTINGS);
    state.phase = 'REGULATION';
    for (const player of Object.values(state.players)) player.position = { x: 1_000, y: 600 };

    state.players.p1.position = { x: 400, y: 300 };
    state.players.p2.position = { x: 480, y: 300 };
    activeAttack(state, 'p1', 1, 'HEAVY', { x: 1, y: 0 });
    activeAttack(state, 'p2', 2, 'HEAVY', { x: -1, y: 0 });

    state.players.p3.position = { x: 600, y: 200 };
    activeAttack(state, 'p3', 3, 'QUICK_1', { x: 1, y: 0 });
    const breakPulse = spawnNeonPulse(state, state.players.p4, activeAttack(state, 'p4', 4, 'HEAVY', { x: 1, y: 0 }))!.pulse;
    state.players.p4.attack = null;
    breakPulse.position = { x: 550, y: 200 };
    breakPulse.previousPosition = { x: 550, y: 200 };
    breakPulse.velocity = { x: 900, y: 0 };

    const dodgePulse = spawnNeonPulse(state, state.players.p5, activeAttack(state, 'p5', 5, 'HEAVY', { x: 1, y: 0 }))!.pulse;
    state.players.p5.attack = null;
    dodgePulse.position = { x: 700, y: 350 };
    dodgePulse.previousPosition = { x: 700, y: 350 };
    dodgePulse.velocity = { x: 900, y: 0 };
    state.players.p6.position = { x: 750, y: 350 };
    state.players.p6.dashInvulnerabilityRemainingMs = 100;
    state.players.p6.dashCooldownRemainingMs = 900;

    const hitPulse = spawnNeonPulse(state, state.players.p7, activeAttack(state, 'p7', 6, 'HEAVY', { x: 1, y: 0 }))!.pulse;
    state.players.p7.attack = null;
    hitPulse.position = { x: 700, y: 480 };
    hitPulse.previousPosition = { x: 700, y: 480 };
    hitPulse.velocity = { x: 900, y: 0 };
    state.players.p8.position = { x: 750, y: 480 };

    state.players.p9.position = { x: 640, y: 0 };
    state.players.p9.lastAttackerId = 'p10';
    state.players.p9.lastAttackerAtMs = state.nowMs;
    state.scores.p10 = GAME.targetScore - 1;
    state.nextEventId = 1;

    const events = stepMatch(state, new Map(), GAME.heavyActiveMs);

    expect(events.map((event) => event.type)).toEqual([
      'CLASH', 'PULSE_BREAK', 'PERFECT_DODGE', 'HIT', 'KNOCKOUT', 'RESULT'
    ]);
    expect(events.map((event) => event.eventId)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('finishes immediately at the target score', () => {
    const state = regulationState();
    state.scores.p1 = GAME.targetScore - 1;
    const events = forceKnockout(state, 'p1', 'p2');
    expect(events.map((event) => event.type)).toEqual(['KNOCKOUT', 'RESULT']);
    expect(events.map((event) => event.eventId)).toEqual([1, 2]);
    expect(events[1]).toMatchObject({ winnerPlayerId: 'p1', reason: 'TARGET_SCORE' });
  });

  it('preserves combat liabilities across a reconnect and resolves an imminent knockout', () => {
    const state = regulationState();
    const player = state.players.p2;
    player.overload = 73;
    player.stats = { knockouts: 2, falls: 3, landedHits: 4, completedAttacks: 5 };
    player.position = { x: 640, y: 0 };
    player.velocity = { x: 0, y: -900 };
    player.hitstunRemainingMs = 250;
    player.lastAttackerId = 'p1';
    player.lastAttackerAtMs = state.nowMs;
    expect(setPlayerConnected(state, 'p2', false)).toEqual([]);
    expect(snapshotMatch(state).players.map(({ playerId }) => playerId)).toEqual(['p1']);
    expect(setPlayerConnected(state, 'p2', true)).toEqual([]);
    expect(player).toMatchObject({
      position: { x: 640, y: 0 },
      velocity: { x: 0, y: -900 },
      hitstunRemainingMs: 250,
      respawnRemainingMs: 0
    });

    const events = stepMatch(state, new Map(), 0);

    expect(events).toContainEqual(expect.objectContaining({
      type: 'KNOCKOUT', attackerId: 'p1', targetId: 'p2', scoreAwardedTo: 'p1'
    }));
    expect(state.scores.p1).toBe(1);
    expect(player.stats).toEqual({ knockouts: 2, falls: 4, landedHits: 4, completedAttacks: 5 });
    expect(player.respawnRemainingMs).toBe(GAME.knockoutToControlMs);
  });

  it('freezes every combat clock while paused and resumes the prior phase', () => {
    const state = regulationState();
    state.players.p1.hitstunRemainingMs = 500;
    const paused = setMatchPaused(state, 8_000);
    const before = snapshotMatch(state);
    expect(stepMatch(state, new Map(), 1_000)).toEqual([]);
    expect(snapshotMatch(state)).toEqual(before);
    const resumed = resumePausedMatch(state);
    expect(paused).toContainEqual(expect.objectContaining({ type: 'PHASE', phase: 'PAUSED' }));
    expect(resumed).toContainEqual(expect.objectContaining({ type: 'PHASE', phase: 'REGULATION' }));
  });

  it('replays identical inputs to identical final state and ordered events', () => {
    const replay = () => {
      const state = regulationState();
      state.players.p1.position = { x: 600, y: 360 };
      state.players.p2.position = { x: 650, y: 360 };
      const events = [
        ...stepMatch(state, new Map([['p1', idle(0, { quick: true })]]), 0),
        ...stepMatch(state, new Map([['p1', idle(1)]]), 130),
        ...forceKnockout(state, 'p1', 'p2'),
        ...stepMatch(state, new Map(), 700)
      ];
      return JSON.stringify({ state, events });
    };
    expect(replay()).toBe(replay());
  });
});
