import type { Chassis } from '../../../shared/model.js';

export type MotionState = 'idle' | 'move' | 'quick-1' | 'quick-2' | 'quick-3' | 'heavy-charge' | 'heavy-release' | 'dash' | 'hit' | 'knockout' | 'respawn';
export type FighterMotion = Readonly<{ bob: number; lean: number; twist: number; leftArm: number; rightArm: number; elbow: number; leg: number; scale: number; opacity: number }>;
const clamp = (n: number) => Math.max(0, Math.min(1, n));
const ease = (n: number) => 1 - Math.pow(1 - clamp(n), 3);

/** Animation progress is supplied by the combat clock, never used to move hitboxes. */
export function fighterMotion(chassis: Chassis, state: MotionState, progress: number, speed: number, reducedMotion: boolean): FighterMotion {
  const t = clamp(progress);
  const wave = Math.sin(progress * Math.PI * 2);
  const floating = chassis === 'PULSE' || chassis === 'WRAITH';
  const heavy = chassis === 'BASTION';
  let bob = reducedMotion ? 0 : floating ? 3 + wave * 2 : wave * 0.55;
  let lean = speed * (heavy ? 0.07 : 0.14);
  let twist = 0;
  let leftArm = -0.12;
  let rightArm = -0.12;
  let elbow = -0.2;
  let leg = 0;
  let scale = 1;
  let opacity = 1;
  if (state === 'move') {
    leg = floating ? 0 : wave * (heavy ? 0.35 : 0.68) * speed;
    bob = reducedMotion ? 0 : floating ? bob : Math.abs(wave) * (heavy ? 1.1 : 2.2) * speed;
    leftArm += -leg * 0.65; rightArm += leg * 0.65;
    twist = floating ? wave * 0.04 : wave * 0.06 * speed;
  }
  if (state.startsWith('quick') || state === 'heavy-release') {
    const wind = t < 0.28 ? t / 0.28 : 1;
    const strike = t < 0.28 ? 0 : ease((t - 0.28) / 0.16);
    const settle = t > 0.55 ? ease((t - 0.55) / 0.45) : 0;
    const swing = (0.65 * wind - 2.4 * strike) * (1 - settle);
    const second = state === 'quick-2';
    const both = state === 'heavy-release' || state === 'quick-3';
    leftArm = second && !both ? -0.35 : swing;
    rightArm = second || both ? swing : -0.35;
    twist = (second ? -1 : 1) * (0.3 * wind - 0.65 * strike) * (1 - settle);
    lean = (-0.12 * wind + 0.32 * strike) * (1 - settle);
    elbow = -0.65 * (1 - strike) - 0.1;
    bob = both ? -2 * Math.sin(t * Math.PI) : 0;
  }
  if (state === 'heavy-charge') {
    lean = -0.13 * ease(t); twist = -0.18 * ease(t);
    leftArm = rightArm = -0.45 - 0.4 * t; elbow = -1.35;
    bob = -3 * t + (reducedMotion ? 0 : Math.sin(progress * 65) * t * 0.35);
  }
  if (state === 'dash') {
    lean = heavy ? -0.15 : 0.55;
    leftArm = rightArm = heavy ? -1.1 : 0.65;
    elbow = heavy ? -1.2 : -0.2;
    bob = heavy ? -3 : 2;
    if (chassis === 'WRAITH') opacity = 0.36;
  }
  if (state === 'hit') {
    const recoil = Math.sin(Math.PI * t) * (1 - t);
    lean = -recoil * 0.55; twist = recoil * 0.22;
    leftArm = rightArm = recoil * 0.8;
  }
  if (state === 'knockout') { bob = -t * 130; twist = t * 1.5; lean = t; scale = 1 - t * 0.75; opacity = 1 - t; }
  if (state === 'respawn') { bob = (1 - ease(t)) * 65; scale = 0.65 + 0.35 * ease(t); opacity = ease(t); }
  return { bob, lean, twist, leftArm, rightArm, elbow, leg, scale, opacity };
}
