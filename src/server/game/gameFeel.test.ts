import { describe, expect, it } from 'vitest';
import { PredictionBuffer } from '../../client/game/prediction.js';
import { CHASSIS, type GameEvent, type InputFrame } from '../../shared/model.js';
import { DEFAULT_ROOM_SETTINGS } from '../../shared/roomSettings.js';
import { createMatchState } from './state.js';
import { snapshotMatch, stepMatch } from './simulation.js';

const input = (seq: number, overrides: Partial<InputFrame> = {}): InputFrame => ({
  seq, viewTick: 0, moveX: 0, moveY: 0, aimX: 1, aimY: 0, quick: false, heavy: false, dash: false, ...overrides
});
function match() {
  const state = createMatchState([
    { playerId: 'a', name: 'A', chassis: 'RIFT', accent: 0 },
    { playerId: 'b', name: 'B', chassis: 'RIFT', accent: 1 }
  ], 0, DEFAULT_ROOM_SETTINGS);
  state.phase = 'REGULATION';
  state.players.a.position = { x: 500, y: 360 };
  state.players.b.position = { x: 552, y: 360 };
  return state;
}

describe('grounded combat feel', () => {
  it.each(CHASSIS)('%s stops voluntarily without a long sliding tail and agrees with prediction', chassis => {
    const state = match();
    state.players.a.chassis = chassis;
    state.players.b.position = { x: 1000, y: 500 };
    const prediction = new PredictionBuffer('a');
    let canonical = snapshotMatch(state).players[0]!;
    for (let frame = 0; frame < 40; frame++) {
      const next = input(frame, { moveX: frame < 20 ? 1 : 0 });
      const predicted = prediction.predict(next, canonical, 1000 / 60);
      stepMatch(state, new Map([['a', next]]), 1000 / 60);
      canonical = snapshotMatch(state).players[0]!;
      expect(predicted.position.x).toBeCloseTo(canonical.position.x, 6);
    }
    expect(state.players.a.velocity.x).toBe(0);
  });

  it('keeps the first jab close while the combo finisher launches', () => {
    const displacement = (comboStep: 0 | 2) => {
      const state = match(); state.players.a.comboStep = comboStep;
      const events: GameEvent[] = [];
      for (let frame = 0; frame < 24; frame++) {
        events.push(...stepMatch(state, new Map([['a', input(frame, { quick: frame === 0 })]]), 1000 / 60));
      }
      expect(events.filter(e => e.type === 'HIT')).toHaveLength(1);
      return state.players.b.position.x - 552;
    };
    const jab = displacement(0); const finisher = displacement(2);
    expect(jab).toBeLessThan(30);
    expect(finisher).toBeGreaterThan(jab * 3);
  });

  it('lets a correctly buffered three-hit sequence connect before launching the opponent', () => {
    const state = match(); const hits: string[] = [];
    for (let frame = 0; frame < 65; frame++) {
      const events = stepMatch(state, new Map([['a', input(frame, { quick: [0, 9, 24].includes(frame) })]]), 1000 / 60);
      for (const event of events) if (event.type === 'HIT' && event.attackerId === 'a') hits.push(event.attack);
    }
    expect(hits).toEqual(['QUICK_1', 'QUICK_2', 'QUICK_3']);
  });

  it('allows an inward edge recovery with Space and consumes the normal cooldown', () => {
    const state = match(); state.players.a.position = { x: 1130, y: 360 };
    state.players.a.velocity = { x: 280, y: 0 };
    const events: GameEvent[] = [];
    for (let frame = 0; frame < 20; frame++) {
      events.push(...stepMatch(state, new Map([['a', input(frame, { moveX: -1, aimX: -1, dash: frame === 0 || frame === 15 })]]), 1000 / 60));
    }
    expect(state.players.a.position.x).toBeLessThan(1050);
    expect(state.players.a.dashRemainingMs).toBe(0);
    expect(state.players.a.dashCooldownRemainingMs).toBeGreaterThan(0);
    expect(events.some(e => e.type === 'KNOCKOUT' && e.targetId === 'a')).toBe(false);
  });
});
