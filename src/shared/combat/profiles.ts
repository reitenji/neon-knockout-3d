import type { AttackKind, Vec2 } from '../model.js';

export type AttackProfileId = 'quick-1' | 'quick-2' | 'quick-3' | 'heavy-melee';

export type AttackProfile = Readonly<{
  id: AttackProfileId;
  attack: AttackKind;
  windupMs: number;
  activeMs: number;
  recoveryMs: number;
  originOffset: Vec2;
  weaponPath: readonly Vec2[];
  thickness: number;
  reach: number;
  overloadGain: number | Readonly<{ minimum: number; maximum: number }>;
  baseImpulse: number | Readonly<{ minimum: number; maximum: number }>;
}>;

const vector = (x: number, y: number): Vec2 => Object.freeze({ x, y });

const profile = (value: AttackProfile): AttackProfile => Object.freeze({
  ...value,
  originOffset: vector(value.originOffset.x, value.originOffset.y),
  weaponPath: Object.freeze(value.weaponPath.map(({ x, y }) => vector(x, y))),
  overloadGain: typeof value.overloadGain === 'number'
    ? value.overloadGain
    : Object.freeze({ ...value.overloadGain }),
  baseImpulse: typeof value.baseImpulse === 'number'
    ? value.baseImpulse
    : Object.freeze({ ...value.baseImpulse }),
});

const QUICK_1 = profile({
  id: 'quick-1', attack: 'QUICK_1', windupMs: 70, activeMs: 60, recoveryMs: 100,
  originOffset: { x: 22, y: 0 },
  weaponPath: [{ x: 12, y: -32 }, { x: 36, y: -16 }, { x: 40, y: 8 }, { x: 20, y: 32 }],
  thickness: 12, reach: 75, overloadGain: 8, baseImpulse: 110,
});

const QUICK_2 = profile({
  id: 'quick-2', attack: 'QUICK_2', windupMs: 65, activeMs: 65, recoveryMs: 120,
  originOffset: { x: 22, y: 0 },
  weaponPath: [{ x: 20, y: 34 }, { x: 42, y: 14 }, { x: 38, y: -14 }, { x: 14, y: -34 }],
  thickness: 12, reach: 76, overloadGain: 10, baseImpulse: 150,
});

const QUICK_3 = profile({
  id: 'quick-3', attack: 'QUICK_3', windupMs: 115, activeMs: 70, recoveryMs: 205,
  originOffset: { x: 22, y: 0 },
  weaponPath: [{ x: 8, y: -42 }, { x: 46, y: -25 }, { x: 50, y: 8 }, { x: 32, y: 40 }],
  thickness: 16, reach: 89, overloadGain: 16, baseImpulse: 455,
});

const HEAVY = profile({
  id: 'heavy-melee', attack: 'HEAVY', windupMs: 110, activeMs: 90, recoveryMs: 320,
  originOffset: { x: 22, y: 0 },
  weaponPath: [{ x: 8, y: -45 }, { x: 48, y: -24 }, { x: 52, y: 0 }, { x: 48, y: 24 }, { x: 8, y: 45 }],
  thickness: 20, reach: 94, overloadGain: { minimum: 18, maximum: 32 }, baseImpulse: { minimum: 460, maximum: 760 },
});

export function profileForAttack(kind: AttackKind): AttackProfile {
  switch (kind) {
    case 'QUICK_1': return QUICK_1;
    case 'QUICK_2': return QUICK_2;
    case 'QUICK_3': return QUICK_3;
    case 'HEAVY': return HEAVY;
  }
}

function normalizedFacing(facing: Vec2): Vec2 {
  const length = Math.hypot(facing.x, facing.y);
  return length === 0 ? { x: 1, y: 0 } : { x: facing.x / length, y: facing.y / length };
}

function pathPoint(path: readonly Vec2[], progress: number): Vec2 {
  const clampedProgress = Math.max(0, Math.min(1, progress));
  const scaled = clampedProgress * (path.length - 1);
  const index = Math.min(path.length - 2, Math.floor(scaled));
  const portion = scaled - index;
  const from = path[index];
  const to = path[index + 1];
  return { x: from.x + (to.x - from.x) * portion, y: from.y + (to.y - from.y) * portion };
}

export function sampleWeaponPoint(origin: Vec2, facing: Vec2, profileValue: AttackProfile, activeProgress: number): Vec2 {
  const direction = normalizedFacing(facing);
  const point = pathPoint(profileValue.weaponPath, activeProgress);
  const localX = profileValue.originOffset.x + point.x;
  const localY = profileValue.originOffset.y + point.y;
  return {
    x: origin.x + localX * direction.x - localY * direction.y,
    y: origin.y + localX * direction.y + localY * direction.x,
  };
}
