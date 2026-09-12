import type { Chassis } from '../../../shared/model.js';

export type MotionState = 'idle' | 'move' | 'quick-1' | 'quick-2' | 'quick-3' | 'heavy-charge' | 'heavy-release' | 'dash' | 'hit' | 'knockout' | 'respawn';
export type FighterMotion = Readonly<{
  bob: number; lean: number; twist: number; roll: number; shift: number;
  leftArm: number; rightArm: number; leftSweep: number; rightSweep: number;
  elbow: number; rightElbow: number; leg: number; scale: number; opacity: number;
}>;
const clamp = (n: number) => Math.max(0, Math.min(1, n));
const ease = (n: number) => 1 - Math.pow(1 - clamp(n), 3);

/** Progress is visual only; 0.44 starts contact and 0.55 starts recovery. */
export function fighterMotion(chassis: Chassis, state: MotionState, progress: number, speed: number, reducedMotion: boolean): FighterMotion {
  const t = clamp(progress);
  const wave = Math.sin(progress * Math.PI * 2);
  const floating = chassis === 'PULSE' || chassis === 'WRAITH' || chassis === 'NOVA';
  const bulky = chassis === 'BASTION' || chassis === 'TITAN';
  let bob = reducedMotion ? 0 : floating ? 3 + wave * 1.5 : -1.5;
  let lean = speed * (bulky ? 0.035 : 0.07);
  let twist = 0, roll = 0, shift = 0;
  let leftArm = -0.22, rightArm = -0.22, leftSweep = -0.08, rightSweep = 0.08;
  let elbow = -0.65, rightElbow = -0.65, leg = 0, scale = 1, opacity = 1;
  if (state === 'move') {
    leg = floating ? 0 : wave * (bulky ? 0.3 : 0.55);
    bob = reducedMotion ? 0 : floating ? bob : -2 + Math.abs(wave) * 0.7;
    leftArm -= leg * 0.5; rightArm += leg * 0.5;
    twist = wave * (floating ? 0.06 : 0.035);
  }
  if (state.startsWith('quick') || state === 'heavy-release') {
    const strong = state === 'heavy-release' || state === 'quick-3';
    const second = state === 'quick-2';
    const sign = second ? -1 : 1;
    const load = ease(t / 0.28);
    const drive = ease((t - 0.28) / 0.16);
    const recovery = 1 - ease((t - 0.55) / 0.45);
    const power = strong ? 1.35 : 1;
    // Every chassis has its own strike path, guard and transfer of body weight.
    if (chassis === 'RIFT') {
      const strike = (0.35 * load - 1.95 * drive) * recovery;
      leftArm = second ? -0.65 : strike; rightArm = second ? strike : -0.65;
      elbow = second ? -1.15 : (-1.2 + drive) * recovery;
      rightElbow = second ? (-1.2 + drive) * recovery : -1.15;
      twist = sign * (0.38 * load - 0.8 * drive) * recovery * power;
      leftSweep = -0.15 - 0.25 * drive * recovery;
      rightSweep = 0.15 + 0.25 * drive * recovery;
      lean = (-0.07 * load + 0.18 * drive) * recovery * power;
      shift = 4 * drive * recovery * power;
      bob = -2 - 1.5 * load * recovery;
    } else if (chassis === 'BASTION') {
      const punch = (-0.5 * load - 0.9 * drive) * recovery;
      leftArm = second ? -0.8 : punch; rightArm = second ? punch : -0.8;
      elbow = second ? -1.3 : (-1.7 + 1.55 * drive) * recovery;
      rightElbow = second ? (-1.7 + 1.55 * drive) * recovery : -1.3;
      twist = sign * (0.19 * load - 0.42 * drive) * recovery * power;
      lean = (-0.08 * load + 0.2 * drive) * recovery;
      shift = (-2 * load + 7 * drive) * recovery * power;
      bob = -3 - (strong ? 3 : 1) * load * recovery;
      if (strong) { leftArm = rightArm = punch - 0.2; elbow = rightElbow = (-1.7 + 1.55 * drive) * recovery; }
    } else if (chassis === 'PULSE') {
      leftArm = (-1.05 * load - 0.6 * drive) * recovery;
      rightArm = (strong ? leftArm : -0.65 * load * recovery);
      elbow = (-1.1 * load + 0.95 * drive) * recovery;
      rightElbow = strong ? elbow : -1.25;
      leftSweep = -0.35 * load * recovery; rightSweep = 0.35 * load * recovery;
      // Emitters aim forward; recoil kicks the chest back after discharge.
      lean = (0.12 * load - 0.36 * drive) * recovery * power;
      shift = -5 * drive * recovery * power;
      bob = 3 + 4 * drive * recovery * power;
      twist = second ? -0.16 * recovery : 0.16 * recovery;
    } else if (chassis === 'WRAITH') {
      leftArm = (-0.65 * load - 0.6 * drive) * recovery;
      rightArm = second ? leftArm : -0.5;
      leftSweep = sign * (0.95 * load - 1.5 * drive) * recovery * power;
      rightSweep = -sign * (0.7 * load - 1.2 * drive) * recovery * power;
      elbow = -1.1 * recovery; rightElbow = -0.95 * recovery;
      twist = sign * (0.65 * load - 1.3 * drive) * recovery * power;
      roll = sign * -0.2 * drive * recovery;
      lean = 0.14 * drive * recovery;
      bob = 2 - 3 * load * recovery;
      shift = 3 * drive * recovery;
    }
    if (chassis === 'EMBER') {
      leftArm = rightArm = (-0.9 * load - 0.7 * drive) * recovery;
      elbow = rightElbow = (-1.5 * load + 1.35 * drive) * recovery;
      lean = 0.26 * drive * recovery * power; shift = 6 * drive * recovery;
      twist = sign * 0.28 * recovery; bob = -3 * load * recovery;
    } else if (chassis === 'VOLT') {
      leftArm = second ? -0.7 : -1.8 * drive * recovery;
      rightArm = second ? -1.8 * drive * recovery : -0.7;
      elbow = rightElbow = -0.4 * recovery;
      lean = 0.3 * drive * recovery; twist = sign * -0.95 * drive * recovery;
      roll = sign * 0.12 * recovery; shift = 8 * drive * recovery * power; bob = -2;
    } else if (chassis === 'TITAN') {
      leftArm = rightArm = (-2.6 * load + 1.2 * drive) * recovery;
      elbow = rightElbow = -0.45 * recovery;
      lean = (-0.15 * load + 0.3 * drive) * recovery * power;
      bob = -5 * drive * recovery; shift = 2 * drive * recovery;
    } else if (chassis === 'NOVA') {
      leftArm = rightArm = -1.4 * drive * recovery;
      leftSweep = -0.9 * load * recovery; rightSweep = 0.9 * load * recovery;
      elbow = rightElbow = -0.7 * recovery;
      twist = sign * 0.4 * drive * recovery; lean = -0.22 * drive * recovery;
      bob = 5 + 3 * drive * recovery; shift = -3 * drive * recovery * power;
    }
    if (strong && chassis === 'RIFT') { leftArm -= 0.2 * recovery; rightArm = -1.5 * drive * recovery; }
  }
  if (state === 'heavy-charge') {
    const load = ease(t);
    lean = -0.09 * load; twist = (chassis === 'WRAITH' ? 0.65 : -0.22) * load;
    leftArm = -0.55 - 0.6 * load; rightArm = bulky || floating ? leftArm : -0.6;
    elbow = rightElbow = -1.5;
    leftSweep = -0.25 * load; rightSweep = 0.25 * load;
    bob = -4 * load; shift = -2 * load;
  }
  if (state === 'dash') {
    lean = bulky ? -0.12 : 0.4;
    leftArm = rightArm = bulky ? -1.1 : 0.65;
    elbow = rightElbow = bulky ? -1.2 : -0.2;
    bob = bulky ? -3 : 2;
    if (chassis === 'WRAITH') opacity = 0.36;
  }
  if (state === 'hit') {
    const recoil = Math.sin(Math.PI * t) * (1 - t);
    lean = -recoil * 0.4; leftArm = rightArm = recoil * 0.8;
  }
  if (state === 'knockout') { bob = -t * 130; twist = t * 1.5; lean = t; scale = 1 - t * 0.75; opacity = 1 - t; }
  if (state === 'respawn') { bob = (1 - ease(t)) * 65; scale = 0.65 + 0.35 * ease(t); opacity = ease(t); }
  return { bob, lean, twist, roll, shift, leftArm, rightArm, leftSweep, rightSweep, elbow, rightElbow, leg, scale, opacity };
}

export function blendMotion(from: FighterMotion, to: FighterMotion, amount: number): FighterMotion {
  const result = { ...to };
  for (const key of Object.keys(to) as Array<keyof FighterMotion>) result[key] = from[key] + (to[key] - from[key]) * clamp(amount);
  return result;
}
