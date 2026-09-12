import { describe, expect, it } from 'vitest';
import { GAME } from './constants.js';
import { advanceKinematics, normalizeAim, normalizeAxes } from './kinematics.js';

describe('shared kinematics', () => {
  it('normalizes diagonal movement without changing an in-range axis vector', () => {
    expect(normalizeAxes(3, 4)).toEqual({ x: 0.6, y: 0.8 });
    expect(normalizeAxes(0.6, -0.8)).toEqual({ x: 0.6, y: -0.8 });
  });

  it('retains the previous facing for zero aim', () => {
    expect(normalizeAim(0, 0, { x: 0, y: -1 })).toEqual({ x: 0, y: -1 });
    expect(normalizeAim(6, 8, { x: 1, y: 0 })).toEqual({ x: 0.6, y: 0.8 });
  });

  it('accelerates and integrates position with semi-implicit Euler', () => {
    const next = advanceKinematics(
      { position: { x: 0, y: 0 }, velocity: { x: 0, y: 0 }, facing: { x: 1, y: 0 } },
      { moveX: 1, moveY: 0, aimX: 0, aimY: 1 },
      100,
      { moveSpeed: GAME.maxGroundSpeed, dashVelocity: null, steeringScale: 1, voidPull: { x: 0, y: 0 } }
    );

    expect(next.facing).toEqual({ x: 0, y: 1 });
    expect(next.velocity).toEqual({ x: GAME.groundAcceleration / 10, y: 0 });
    expect(next.position).toEqual({ x: GAME.groundAcceleration / 100, y: 0 });
  });

  it('uses dash velocity and void pull after ground movement', () => {
    const next = advanceKinematics(
      { position: { x: 0, y: 0 }, velocity: { x: 0, y: 0 }, facing: { x: 1, y: 0 } },
      { moveX: 0, moveY: 0, aimX: 0, aimY: 0 },
      100,
      { moveSpeed: GAME.maxGroundSpeed, dashVelocity: { x: GAME.dashSpeed, y: 0 }, steeringScale: 1, voidPull: { x: 0, y: GAME.voidPullAcceleration } }
    );

    expect(next.velocity).toEqual({ x: GAME.dashSpeed, y: GAME.voidPullAcceleration / 10 });
    expect(next.position).toEqual({ x: GAME.dashSpeed / 10, y: GAME.voidPullAcceleration / 100 });
  });
});
