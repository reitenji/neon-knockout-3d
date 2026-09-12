import { describe, expect, it } from 'vitest';
import { CHASSIS, BOT_DIFFICULTIES, type PlayerAccent } from '../../shared/model.js';
import { matchInputSchema } from '../../shared/protocol.js';
import { DEFAULT_ROOM_SETTINGS } from '../../shared/roomSettings.js';
import { BotController } from './botController.js';
import { createMatchState } from './state.js';
import { snapshotMatch, stepMatch } from './simulation.js';

function arena() {
  const state = createMatchState(CHASSIS.map((chassis, i) => ({ playerId: `p${i}`, name: chassis, chassis, accent: i as PlayerAccent })), 0, DEFAULT_ROOM_SETTINGS);
  state.phase = 'REGULATION';
  return state;
}

describe('bot decisions through ordinary inputs', () => {
  it.each(BOT_DIFFICULTIES)('%s supplies bounded increasing inputs for all fighters through real combat', difficulty => {
    const state = arena();
    const bots = CHASSIS.map((_, i) => new BotController(`p${i}`, difficulty, 4));
    let quickCount = 0;
    for (let tick = 0; tick < 900; tick++) {
      const snapshot = snapshotMatch(state);
      const inputs = bots.map((bot, i) => {
        const frame = bot.nextInput(snapshot);
        expect(matchInputSchema.safeParse(frame).success).toBe(true);
        expect(frame.seq).toBe(tick);
        if (frame.quick) quickCount++;
        return [`p${i}`, frame] as const;
      });
      stepMatch(state, new Map(inputs), 1000 / 60);
    }
    expect(quickCount).toBeGreaterThan(0);
    expect(Object.values(state.players).reduce((sum, p) => sum + p.stats.landedHits, 0)).toBeGreaterThan(0);
  });

  it('waits for observation latency before responding to a newly visible opponent', () => {
    const state = arena();
    state.players.p0.position = { x: 600, y: 360 };
    state.players.p1.position = { x: 655, y: 360 };
    const bot = new BotController('p0', 'EASY', 1);
    for (let tick = 0; tick < 18; tick++) {
      state.tick = tick;
      expect(bot.nextInput(snapshotMatch(state))).toMatchObject({ quick: false, heavy: false, dash: false, moveX: 0, moveY: 0 });
    }
  });

  it('steers inward near the ledge rather than chasing its target into the void', () => {
    const state = arena();
    state.players.p0.position = { x: 1130, y: 360 };
    state.players.p0.velocity = { x: 300, y: 0 };
    state.players.p1.position = { x: 1200, y: 360 };
    const bot = new BotController('p0', 'HARD', 1);
    expect(bot.nextInput(snapshotMatch(state))).toMatchObject({ moveX: -1, moveY: 0, quick: false, heavy: false });
  });
});
