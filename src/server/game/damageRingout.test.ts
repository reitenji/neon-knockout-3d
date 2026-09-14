import { describe, expect, it } from 'vitest';
import { CHASSIS, type Chassis, type InputFrame } from '../../shared/model.js';
import { DEFAULT_ROOM_SETTINGS } from '../../shared/roomSettings.js';
import { advanceCombatTimers, startActions } from './combat.js';
import { buildActiveAttackShapes, resolveSurvivingContacts } from './combatResolution.js';
import { closestPointOnPolygon, distance, platformExitPoint } from './geometry.js';
import { platformAt } from './movement.js';
import { stepMatch } from './simulation.js';
import { createMatchState } from './state.js';

const input: InputFrame = { seq: 0, viewTick: 0, moveX: 0, moveY: 0, aimX: 1, aimY: 0, quick: false, heavy: false, dash: false };
function jab(chassis: Chassis, damage: number, armored = false) {
  const state = createMatchState([
    { playerId: 'a', name: 'A', chassis: 'RIFT', accent: 0 },
    { playerId: 'b', name: 'B', chassis, accent: 1 }
  ], 0, DEFAULT_ROOM_SETTINGS);
  state.phase = 'REGULATION';
  state.players.a.position = { x: 150, y: 360 };
  state.players.b.position = { x: 202, y: 360 };
  state.players.b.overload = damage;
  state.players.b.dashRemainingMs = armored ? 500 : 0;
  state.players.b.dashCooldownRemainingMs = 0;
  state.players.a.latestInput = { ...input, quick: true };
  startActions(state);
  const combat = advanceCombatTimers(state, 130);
  const events = resolveSurvivingContacts(state, buildActiveAttackShapes(state, combat.activeSlices));
  state.players.a.attack = null;
  return { state, hit: events.find(e => e.type === 'HIT')! };
}

describe('damage danger and exact-edge ringouts', () => {
  it('keeps early jabs gentle, grows faster after 100%, and caps at 250%', () => {
    const impulses = [0, 92, 192, 241, 249].map(damage => jab('RIFT', damage).hit.impulse);
    expect(impulses[0]).toBeCloseTo(118.8);
    expect(impulses[1]).toBe(220);
    expect(impulses[2]).toBeGreaterThan(400);
    expect(impulses[3]).toBeGreaterThan(impulses[2]!);
    expect(impulses[4]).toBe(11000);
    expect(jab('RIFT', 249).state.players.b.overload).toBe(250);
  });

  it.each(CHASSIS)('a critical jab launches %s across the arena even while bracing or trying to dash back', chassis => {
    const { state, hit } = jab(chassis, 250, true);
    expect(hit.impulse).toBe(11000);
    expect(state.players.b.dashRemainingMs).toBe(0);
    expect(state.players.b.respawnRemainingMs).toBe(0); // Travel first; never a KO at the hit position.
    let knockedOut = false;
    for (let tick = 0; tick < 60; tick++) {
      const events = stepMatch(state, new Map([
        ['a', { ...input, seq: tick + 1 }],
        ['b', { ...input, seq: tick + 1, moveX: -1, dash: tick % 2 === 0 }]
      ]), 1000 / 60);
      if (events.some(e => e.type === 'KNOCKOUT' && e.targetId === 'b')) { knockedOut = true; break; }
    }
    expect(knockedOut).toBe(true);
    expect(state.players.b.position).toEqual({ x: 1140, y: 360 });
    expect(state.scores.a).toBe(1);
    for (let tick = 0; tick < 40; tick++) stepMatch(state, new Map(), 1000 / 60);
    expect(state.players.b.overload).toBe(0);
  });

  it.each([0, 0.5, 1])('anchors fast falls at flat and diagonal edges during contraction %s', contraction => {
    const vertices = platformAt(contraction).vertices;
    for (let index = 0; index < vertices.length; index++) {
      const v = vertices[index]!, next = vertices[(index + 1) % vertices.length]!;
      const edge = { x: (v.x + next.x) / 2, y: (v.y + next.y) / 2 };
      const center = { x: 640, y: 360 };
      const far = { x: center.x + (edge.x - center.x) * 3, y: center.y + (edge.y - center.y) * 3 };
      const exit = platformExitPoint(center, far, vertices);
      expect(distance(exit, edge)).toBeLessThan(0.00001);
      expect(distance(exit, closestPointOnPolygon(exit, vertices))).toBeLessThan(0.00001);
    }
  });

  it('falls as soon as movement crosses the platform edge, with no extra void strip', () => {
    const { state } = jab('RIFT', 0);
    state.players.b.position = { x: 1139.9, y: 360 };
    state.players.b.velocity = { x: 350, y: 0 };
    const events = stepMatch(state, new Map(), 16);
    expect(events).toContainEqual(expect.objectContaining({ type: 'KNOCKOUT', targetId: 'b' }));
    expect(state.players.b.position.x).toBe(1140);
  });
});
