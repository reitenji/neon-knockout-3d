import { describe, expect, it } from 'vitest';

import { ARENA, GAME } from '../../shared/constants.js';
import { FIGHTERS } from '../../shared/fighters.js';
import { DEFAULT_ROOM_SETTINGS } from '../../shared/roomSettings.js';
import { advancePlayers, chooseSafestSpawn, separateActivePlayers } from './movement.js';
import { createMatchState } from './state.js';

function createState() {
  const state = createMatchState(
    [
      { playerId: 'p2', name: 'Linus', chassis: 'BASTION', accent: 1 },
      { playerId: 'p1', name: 'Ada', chassis: 'RIFT', accent: 0 }
    ],
    0,
    DEFAULT_ROOM_SETTINGS
  );
  state.phase = 'REGULATION';
  return state;
}

describe('authoritative movement', () => {
  it('accelerates toward and caps at the configured ground speed before applying idle drag', () => {
    const state = createState();
    const player = state.players.p1;
    player.latestInput = { ...player.latestInput, moveX: 1, aimX: 1 };

    advancePlayers(state, 100);
    expect(player.velocity.x).toBe(GAME.groundAcceleration / 10);

    advancePlayers(state, 1_000);
    expect(player.velocity.x).toBe(FIGHTERS.RIFT.moveSpeed);

    player.latestInput = { ...player.latestInput, moveX: 0 };
    advancePlayers(state, 100);
    expect(player.velocity.x).toBeLessThan(FIGHTERS.RIFT.moveSpeed);
    expect(player.velocity.x).toBeGreaterThan(0);
  });

  it('pulls players outward at 360 px/s² and reduces off-platform steering to 45%', () => {
    const state = createState();
    const player = state.players.p1;
    player.position = { x: 640, y: 50 };
    player.latestInput = { ...player.latestInput, moveX: 1, moveY: 0, aimX: 1, aimY: 0 };

    advancePlayers(state, 100);

    expect(player.velocity.x).toBe(GAME.groundAcceleration * GAME.voidRecoverySteerMultiplier / 10);
    expect(player.velocity.y).toBe(-GAME.voidPullAcceleration / 10);
  });

  it('uses facing as the dash direction when the movement axes are zero', () => {
    const state = createState();
    const player = state.players.p1;
    player.facing = { x: 0, y: -1 };
    player.latestInput = { ...player.latestInput, moveX: 0, moveY: 0, dash: true };

    advancePlayers(state, 16);

    expect(player.velocity).toEqual({ x: 0, y: -FIGHTERS.RIFT.dashSpeed });
    expect(player.dashDirection).toEqual({ x: 0, y: -1 });
    expect(player.dashRemainingMs).toBe(FIGHTERS.RIFT.dashDurationMs);
    expect(player.dashInvulnerabilityRemainingMs).toBe(FIGHTERS.RIFT.dashInvulnerabilityMs);
    expect(player.dashCooldownRemainingMs).toBe(FIGHTERS.RIFT.dashCooldownMs);
  });

  it('expires the RIFT rush after its 160 ms duration', () => {
    const state = createState();
    const player = state.players.p1;
    player.latestInput = { ...player.latestInput, moveX: 1, dash: true };

    advancePlayers(state, 16);
    player.latestInput = { ...player.latestInput, dash: false };
    advancePlayers(state, FIGHTERS.RIFT.dashDurationMs - 1);
    expect(player.dashRemainingMs).toBe(1);

    advancePlayers(state, 1);
    expect(player.dashRemainingMs).toBe(0);
  });

  it('expires dash invulnerability after its first 100 ms', () => {
    const state = createState();
    const player = state.players.p1;
    player.latestInput = { ...player.latestInput, dash: true };

    advancePlayers(state, 16);
    player.latestInput = { ...player.latestInput, dash: false };
    advancePlayers(state, FIGHTERS.RIFT.dashInvulnerabilityMs - 1);
    expect(player.dashInvulnerabilityRemainingMs).toBe(1);

    advancePlayers(state, 1);
    expect(player.dashInvulnerabilityRemainingMs).toBe(0);
  });

  it('expires the RIFT cooldown after 1300 ms and permits a new rush', () => {
    const state = createState();
    const player = state.players.p1;
    player.latestInput = { ...player.latestInput, dash: true };

    advancePlayers(state, 16);
    player.latestInput = { ...player.latestInput, dash: false };
    advancePlayers(state, FIGHTERS.RIFT.dashCooldownMs);
    expect(player.dashCooldownRemainingMs).toBe(0);

    player.latestInput = { ...player.latestInput, dash: true };
    advancePlayers(state, 16);
    expect(player.dashRemainingMs).toBe(FIGHTERS.RIFT.dashDurationMs);
    expect(player.dashInvulnerabilityRemainingMs).toBe(FIGHTERS.RIFT.dashInvulnerabilityMs);
  });

  it('resets perfect-dodge consumption only when a new legal dash begins', () => {
    const state = createState();
    const player = state.players.p1;
    player.perfectDodgeConsumed = true;
    player.latestInput = { ...player.latestInput, dash: true };

    advancePlayers(state, 16);
    expect(player.perfectDodgeConsumed).toBe(false);

    player.perfectDodgeConsumed = true;
    player.latestInput = { ...player.latestInput, dash: false };
    advancePlayers(state, FIGHTERS.RIFT.dashCooldownMs);
    expect(player.perfectDodgeConsumed).toBe(true);

    player.latestInput = { ...player.latestInput, dash: true };
    advancePlayers(state, 16);
    expect(player.perfectDodgeConsumed).toBe(false);
  });

  it('separates active overlapping players in stable player-id order', () => {
    const state = createState();
    state.players.p1.position = { x: 640, y: 360 };
    state.players.p2.position = { x: 640, y: 360 };

    separateActivePlayers(state);

    expect(state.players.p1.position).toEqual({ x: 616, y: 360 });
    expect(state.players.p2.position).toEqual({ x: 664, y: 360 });
  });

  it('fully separates three players sharing a center within two passes', () => {
    const state = createMatchState(
      [
        { playerId: 'p3', name: 'Grace', chassis: 'PULSE', accent: 2 },
        { playerId: 'p1', name: 'Ada', chassis: 'RIFT', accent: 0 },
        { playerId: 'p2', name: 'Linus', chassis: 'BASTION', accent: 1 }
      ],
      0,
      DEFAULT_ROOM_SETTINGS
    );
    state.phase = 'REGULATION';
    for (const player of Object.values(state.players)) player.position = { x: 640, y: 360 };

    separateActivePlayers(state);

    const playerIds = Object.keys(state.players).sort();
    for (let leftIndex = 0; leftIndex < playerIds.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < playerIds.length; rightIndex += 1) {
        expect(
          Math.hypot(
            state.players[playerIds[rightIndex]].position.x - state.players[playerIds[leftIndex]].position.x,
            state.players[playerIds[rightIndex]].position.y - state.players[playerIds[leftIndex]].position.y
          )
        ).toBeGreaterThanOrEqual(GAME.collisionRadius * 2);
      }
    }
  });

  it('chooses the deterministic anchor farthest from active opponents', () => {
    const state = createState();
    state.players.p1.position = ARENA.spawnAnchors[0];
    state.players.p2.position = ARENA.spawnAnchors[1];

    expect(chooseSafestSpawn(state, 'p1')).toEqual(ARENA.spawnAnchors[6]);
  });

  it('replays the same fixture to the same serialized movement state', () => {
    const left = createState();
    const right = createState();
    for (const state of [left, right]) {
      state.players.p1.latestInput = { ...state.players.p1.latestInput, moveX: 1, moveY: 1 };
      state.players.p2.latestInput = { ...state.players.p2.latestInput, moveX: -1, moveY: 0 };
      advancePlayers(state, 16);
      separateActivePlayers(state);
    }

    expect(JSON.stringify(left)).toBe(JSON.stringify(right));
  });
});
