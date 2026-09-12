import type { Vec2 } from './model.js';

export { CHASSIS } from './model.js';

const freezePoint = (point: Vec2): Readonly<Vec2> => Object.freeze(point);

const freezePoints = (points: readonly Vec2[]): readonly Readonly<Vec2>[] =>
  Object.freeze(points.map((point) => freezePoint(point)));

export const ACCENTS = Object.freeze([
  '#6EE7F2',
  '#FF8A5B',
  '#9EF25B',
  '#F6D743',
  '#FF5FA2',
  '#7CB8FF',
  '#B78CFF',
  '#F4F7FB'
]);

export const GAME = Object.freeze({
  tickRate: 60,
  snapshotRate: 60,
  countdownMs: 3_000,
  regulationMs: 120_000,
  contractionWarningRemainingMs: 78_000,
  contractionStartRemainingMs: 75_000,
  contractionMinimumRemainingMs: 40_000,
  targetScore: 5,
  minPlayers: 2,
  reconnectGraceMs: 20_000,
  maxPlayers: 8,
  maxInputFramesPerSecond: 60,
  inputRateLimitPerSecond: 90,
  maxPingMs: 2_000,
  collisionRadius: 24,
  maxGroundSpeed: 330,
  groundAcceleration: 2_400,
  groundDrag: 1_950,
  dashSpeed: 760,
  dashDurationMs: 140,
  dashInvulnerabilityMs: 100,
  dashCooldownMs: 1_100,
  perfectDodgeRefundMs: 550,
  quickClashRecoil: 90,
  heavyClashRecoil: 150,
  maxOverload: 150,
  knockoutToControlMs: 600,
  respawnProtectionMs: 650,
  reconnectWarpMs: 180,
  voidRecoverySteerMultiplier: 0.45,
  voidPullAcceleration: 360,
  knockoutDistance: 80,
  quickBufferMs: 120,
  heavyMaxChargeMs: 450,
  heavyChargeMoveMultiplier: 0.55,
  heavyWindupMs: 110,
  heavyActiveMs: 90,
  heavyRecoveryMs: 320,
  pulseSpeed: 900,
  pulseLifetimeMs: 400,
  pulseRadius: 18,
  pulseOverloadGain: 14,
  pulseBaseImpulse: 340,
  quickCombo: Object.freeze([
    Object.freeze({
      step: 1,
      overloadGain: 8,
      baseImpulse: 110,
      windupMs: 70,
      activeMs: 60,
      recoveryMs: 100
    }),
    Object.freeze({
      step: 2,
      overloadGain: 10,
      baseImpulse: 150,
      windupMs: 65,
      activeMs: 65,
      recoveryMs: 120
    }),
    Object.freeze({
      step: 3,
      overloadGain: 16,
      baseImpulse: 455,
      windupMs: 115,
      activeMs: 70,
      recoveryMs: 205
    })
  ]),
  heavyAttack: Object.freeze({
    minOverloadGain: 18,
    maxOverloadGain: 32,
    minImpulse: 460,
    maxImpulse: 760
  })
});

export const ARENA = Object.freeze({
  width: 1_280,
  height: 720,
  regulationVertices: freezePoints([
    { x: 230, y: 90 },
    { x: 1050, y: 90 },
    { x: 1140, y: 180 },
    { x: 1140, y: 540 },
    { x: 1050, y: 630 },
    { x: 230, y: 630 },
    { x: 140, y: 540 },
    { x: 140, y: 180 }
  ]),
  minimumVertices: freezePoints([
    { x: 330, y: 150 },
    { x: 950, y: 150 },
    { x: 1020, y: 220 },
    { x: 1020, y: 500 },
    { x: 950, y: 570 },
    { x: 330, y: 570 },
    { x: 260, y: 500 },
    { x: 260, y: 220 }
  ]),
  spawnAnchors: freezePoints([
    { x: 640, y: 190 },
    { x: 860, y: 260 },
    { x: 930, y: 360 },
    { x: 860, y: 470 },
    { x: 640, y: 540 },
    { x: 420, y: 470 },
    { x: 350, y: 360 },
    { x: 420, y: 260 }
  ])
});
