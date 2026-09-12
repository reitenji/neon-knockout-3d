import { describe, expect, it } from 'vitest';

import { PredictionBuffer } from '../../client/game/prediction.js';
import type { Chassis, InputFrame } from '../../shared/model.js';
import { DEFAULT_ROOM_SETTINGS } from '../../shared/roomSettings.js';
import { advanceCombatTimers, startActions } from './combat.js';
import { buildActiveAttackShapes, resolveSurvivingContacts } from './combatResolution.js';
import { snapshotMatch, stepMatch } from './simulation.js';
import { createMatchState, type MatchState } from './state.js';

const idle = (seq: number, overrides: Partial<InputFrame> = {}): InputFrame => ({
  seq,
  viewTick: 0,
  moveX: 0,
  moveY: 0,
  aimX: 1,
  aimY: 0,
  quick: false,
  heavy: false,
  dash: false,
  ...overrides
});

function regulationState(
  seeds: readonly Readonly<{ playerId: string; name: string; chassis: Chassis; accent: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 }>[]
): MatchState {
  const state = createMatchState(seeds, 0, DEFAULT_ROOM_SETTINGS);
  state.phase = 'REGULATION';
  return state;
}

describe('distinct fighter abilities', () => {
  it('moves BASTION, PULSE, WRAITH, and RIFT different literal distances while prediction agrees', () => {
    const chassis = ['BASTION', 'PULSE', 'WRAITH', 'RIFT'] as const;
    const state = regulationState(chassis.map((fighter, index) => ({
      playerId: fighter,
      name: fighter,
      chassis: fighter,
      accent: index as 0 | 1 | 2 | 3
    })));
    const startingPositions = {
      BASTION: { x: 300, y: 220 },
      PULSE: { x: 300, y: 310 },
      WRAITH: { x: 300, y: 410 },
      RIFT: { x: 300, y: 500 }
    } as const;
    for (const fighter of chassis) state.players[fighter].position = startingPositions[fighter];
    const canonical = Object.fromEntries(snapshotMatch(state).players.map((player) => [player.playerId, player]));
    const inputs = new Map(chassis.map((fighter) => [fighter, idle(0, { moveX: 1 })]));
    const predictions = Object.fromEntries(chassis.map((fighter) => [
      fighter,
      new PredictionBuffer(fighter).predict(inputs.get(fighter)!, canonical[fighter], 1_000)
    ]));

    stepMatch(state, inputs, 1_000);

    expect(chassis.map((fighter) => state.players[fighter].position.x - startingPositions[fighter].x))
      .toEqual([275, 315, 340, 350]);
    for (const fighter of chassis) {
      expect(predictions[fighter].position.x).toBeCloseTo(state.players[fighter].position.x, 10);
      expect(predictions[fighter].position.y).toBeCloseTo(state.players[fighter].position.y, 10);
    }
  });

  it.each([
    ['RIFT', 160, 100, 1_300, 900],
    ['BASTION', 250, 0, 1_700, 420],
    ['PULSE', 140, 80, 1_800, 650],
    ['WRAITH', 210, 190, 1_550, 780]
  ] as const)(
    'starts the %s Space ability with its authoritative snapshot timers and matching prediction',
    (chassis, durationMs, invulnerabilityMs, cooldownMs, dashSpeed) => {
      const state = regulationState([{ playerId: 'fighter', name: chassis, chassis, accent: 0 }]);
      state.players.fighter.position = { x: 300, y: 360 };
      const canonical = snapshotMatch(state).players[0]!;
      const input = idle(0, { moveX: 1, dash: true });
      const predicted = new PredictionBuffer('fighter').predict(input, canonical, 16);

      stepMatch(state, new Map([['fighter', input]]), 16);

      const snapshot = snapshotMatch(state).players[0]!;
      expect(snapshot.dashRemainingMs).toBe(durationMs);
      expect(state.players.fighter.dashInvulnerabilityRemainingMs).toBe(invulnerabilityMs);
      expect(snapshot.dashCooldownRemainingMs).toBe(cooldownMs);
      expect(snapshot.velocity.x).toBe(dashSpeed);
      expect(predicted.position.x).toBeCloseTo(snapshot.position.x, 10);
      expect(predicted.position.y).toBeCloseTo(snapshot.position.y, 10);
      expect(predicted.velocity).toEqual(snapshot.velocity);
    }
  );

  it('applies one PULSE burst credit to every eligible target and rejects held, protected, invulnerable, respawning, and stunned effects', () => {
    const state = regulationState([
      { playerId: 'pulse', name: 'Pulse', chassis: 'PULSE', accent: 0 },
      { playerId: 'rift-hit', name: 'Rift hit', chassis: 'RIFT', accent: 1 },
      { playerId: 'bastion-hit', name: 'Bastion hit', chassis: 'BASTION', accent: 2 },
      { playerId: 'protected', name: 'Protected', chassis: 'WRAITH', accent: 3 },
      { playerId: 'invulnerable', name: 'Invulnerable', chassis: 'WRAITH', accent: 4 },
      { playerId: 'respawning', name: 'Respawning', chassis: 'PULSE', accent: 5 },
      { playerId: 'stunned', name: 'Stunned', chassis: 'PULSE', accent: 6 }
    ]);
    state.players.pulse.position = { x: 640, y: 360 };
    state.players['rift-hit'].position = { x: 700, y: 360 };
    state.players['bastion-hit'].position = { x: 640, y: 440 };
    state.players.protected.position = { x: 640, y: 280 };
    state.players.invulnerable.position = { x: 580, y: 360 };
    state.players.respawning.position = { x: 900, y: 500 };
    state.players.stunned.position = { x: 900, y: 220 };
    state.players.protected.protectionRemainingMs = 100;
    state.players.invulnerable.dashInvulnerabilityRemainingMs = 100;
    state.players.invulnerable.dashCooldownRemainingMs = 1_550;
    state.players.respawning.respawnRemainingMs = 100;
    state.players.stunned.hitstunRemainingMs = 100;
    const dashers = new Map([
      ['pulse', idle(0, { dash: true })],
      ['respawning', idle(0, { dash: true })],
      ['stunned', idle(0, { dash: true })]
    ]);

    const events = stepMatch(state, dashers, 0);

    expect(events.filter((event) => event.type === 'HIT')).toEqual([
      expect.objectContaining({ type: 'HIT', attackerId: 'pulse', targetId: 'bastion-hit', attack: 'NEON_PULSE', resultingOverload: 8 }),
      expect.objectContaining({ type: 'HIT', attackerId: 'pulse', targetId: 'rift-hit', attack: 'NEON_PULSE', resultingOverload: 8 })
    ]);
    expect(events).toContainEqual(expect.objectContaining({
      type: 'PERFECT_DODGE', playerId: 'invulnerable', attackerId: 'pulse', source: 'NEON_PULSE', refundedMs: 550
    }));
    expect(state.players.pulse.stats.landedHits).toBe(1);
    expect(state.players['rift-hit'].velocity.x).toBeCloseTo(260 * 1.08, 10);
    expect(state.players['bastion-hit'].velocity.y).toBeCloseTo(260 * 1.08 * 0.65, 10);
    expect(state.players.protected.overload).toBe(0);
    expect(state.players.invulnerable.overload).toBe(0);
    expect(state.players.invulnerable.dashCooldownRemainingMs).toBe(1_000);
    expect(state.players.respawning.dashRemainingMs).toBe(0);
    expect(state.players.stunned.dashRemainingMs).toBe(0);

    const heldEvents = stepMatch(state, new Map([['pulse', idle(1, { dash: true })]]), 0);
    expect(heldEvents.filter((event) => event.type === 'HIT' || event.type === 'PERFECT_DODGE')).toEqual([]);
    expect(state.players.pulse.stats.landedHits).toBe(1);
  });

  it('cancels only the accepted offensive PULSE dash owner\'s spawn protection', () => {
    const state = regulationState([
      { playerId: 'pulse', name: 'Pulse', chassis: 'PULSE', accent: 0 },
      { playerId: 'target', name: 'Target', chassis: 'BASTION', accent: 1 },
      { playerId: 'rift', name: 'Rift', chassis: 'RIFT', accent: 2 }
    ]);
    state.players.pulse.position = { x: 640, y: 360 };
    state.players.target.position = { x: 700, y: 360 };
    state.players.rift.position = { x: 900, y: 360 };
    state.players.pulse.protectionRemainingMs = 100;
    state.players.rift.protectionRemainingMs = 100;

    const events = stepMatch(state, new Map([
      ['pulse', idle(0, { dash: true })],
      ['rift', idle(0, { dash: true })]
    ]), 0);

    expect(events).toContainEqual(expect.objectContaining({
      type: 'HIT', attackerId: 'pulse', targetId: 'target', attack: 'NEON_PULSE'
    }));
    expect(state.players.pulse.protectionRemainingMs).toBe(0);
    expect(state.players.rift.protectionRemainingMs).toBe(100);

    const blocked = regulationState([
      { playerId: 'pulse', name: 'Pulse', chassis: 'PULSE', accent: 0 }
    ]);
    blocked.players.pulse.protectionRemainingMs = 100;
    blocked.players.pulse.dashCooldownRemainingMs = 1;
    stepMatch(blocked, new Map([['pulse', idle(0, { dash: true })]]), 0);
    expect(blocked.players.pulse.protectionRemainingMs).toBe(100);
  });

  it.each([
    ['RIFT', false, 302.4],
    ['PULSE', false, 302.4],
    ['WRAITH', false, 338.688],
    ['BASTION', false, 196.56],
    ['BASTION', true, 90.72]
  ] as const)('applies %s incoming knockback at its chassis multiplier (armored: %s)', (chassis, armored, expectedImpulse) => {
    const state = regulationState([
      { playerId: 'attacker', name: 'Attacker', chassis: 'RIFT', accent: 0 },
      { playerId: 'target', name: 'Target', chassis, accent: 1 }
    ]);
    state.players.attacker.position = { x: 600, y: 360 };
    state.players.target.position = { x: 650, y: 360 };
    state.players.target.dashRemainingMs = armored ? 1 : 0;
    state.players.attacker.latestInput = idle(0, { quick: true });
    startActions(state);
    const combat = advanceCombatTimers(state, 130);

    const events = resolveSurvivingContacts(state, buildActiveAttackShapes(state, combat.activeSlices));

    expect(events).toEqual([expect.objectContaining({
      type: 'HIT', attackerId: 'attacker', targetId: 'target', attack: 'QUICK_1'
    })]);
    expect(events[0]).toMatchObject({ type: 'HIT' });
    if (events[0]?.type === 'HIT') expect(events[0].impulse).toBeCloseTo(expectedImpulse, 10);
    expect(state.players.target.velocity.x).toBeCloseTo(expectedImpulse, 10);
  });
});
