import { describe, expect, it } from 'vitest';
import { profileForAttack, sampleWeaponPoint } from './profiles.js';

describe('shared attack profiles', () => {
  it('defines every authored combat stat exactly', () => {
    expect(profileForAttack('QUICK_1')).toMatchObject({
      id: 'quick-1', attack: 'QUICK_1', windupMs: 70, activeMs: 60, recoveryMs: 100,
      originOffset: { x: 22, y: 0 }, weaponPath: [{ x: 12, y: -32 }, { x: 36, y: -16 }, { x: 40, y: 8 }, { x: 20, y: 32 }],
      thickness: 12, reach: 75, overloadGain: 8, baseImpulse: 110,
    });
    expect(profileForAttack('QUICK_2')).toMatchObject({
      id: 'quick-2', attack: 'QUICK_2', windupMs: 65, activeMs: 65, recoveryMs: 120,
      originOffset: { x: 22, y: 0 }, weaponPath: [{ x: 20, y: 34 }, { x: 42, y: 14 }, { x: 38, y: -14 }, { x: 14, y: -34 }],
      thickness: 12, reach: 76, overloadGain: 10, baseImpulse: 150,
    });
    expect(profileForAttack('QUICK_3')).toMatchObject({
      id: 'quick-3', attack: 'QUICK_3', windupMs: 115, activeMs: 70, recoveryMs: 205,
      originOffset: { x: 22, y: 0 }, weaponPath: [{ x: 8, y: -42 }, { x: 46, y: -25 }, { x: 50, y: 8 }, { x: 32, y: 40 }],
      thickness: 16, reach: 89, overloadGain: 16, baseImpulse: 455,
    });
    expect(profileForAttack('HEAVY')).toMatchObject({
      id: 'heavy-melee', attack: 'HEAVY', windupMs: 110, activeMs: 90, recoveryMs: 320,
      originOffset: { x: 22, y: 0 }, weaponPath: [{ x: 8, y: -45 }, { x: 48, y: -24 }, { x: 52, y: 0 }, { x: 48, y: 24 }, { x: 8, y: 45 }],
      thickness: 20, reach: 94, overloadGain: { minimum: 18, maximum: 32 }, baseImpulse: { minimum: 460, maximum: 760 },
    });
  });

  it('keeps every sampled weapon point within its declared reach', () => {
    const origin = { x: 100, y: 200 };
    const facing = { x: 1, y: 0 };

    for (const attack of ['QUICK_1', 'QUICK_2', 'QUICK_3', 'HEAVY'] as const) {
      const profile = profileForAttack(attack);
      for (const progress of [0, 0.25, 0.5, 0.75, 1]) {
        const point = sampleWeaponPoint(origin, facing, profile, progress);
        expect(Math.hypot(point.x - origin.x, point.y - origin.y) + profile.thickness / 2).toBeLessThanOrEqual(profile.reach);
      }
    }
  });
});
