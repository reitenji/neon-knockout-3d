import { GAME } from './constants.js';
import type { InputFrame, Vec2 } from './model.js';

export type KinematicState = Readonly<{
  position: Vec2;
  velocity: Vec2;
  facing: Vec2;
}>;

export type KinematicOptions = Readonly<{
  moveSpeed: number;
  dashVelocity: Vec2 | null;
  steeringScale: number;
  voidPull: Vec2;
}>;

const AIM_EPSILON = 0.000001;

function magnitude(x: number, y: number): number {
  return Math.hypot(x, y);
}

function accelerateTowards(current: Vec2, target: Vec2, maximumChange: number): Vec2 {
  const deltaX = target.x - current.x;
  const deltaY = target.y - current.y;
  const distance = magnitude(deltaX, deltaY);

  if (distance === 0 || distance <= maximumChange) return target;

  const scale = maximumChange / distance;
  return { x: current.x + deltaX * scale, y: current.y + deltaY * scale };
}

export function normalizeAxes(x: number, y: number): Vec2 {
  const length = magnitude(x, y);
  if (length <= 1 || length === 0) return { x, y };
  return { x: x / length, y: y / length };
}

export function normalizeAim(x: number, y: number, previous: Vec2): Vec2 {
  const length = magnitude(x, y);
  if (length <= AIM_EPSILON) return previous;
  return { x: x / length, y: y / length };
}

export function advanceKinematics(
  state: KinematicState,
  input: Pick<InputFrame, 'moveX' | 'moveY' | 'aimX' | 'aimY'>,
  elapsedMs: number,
  options: KinematicOptions
): KinematicState {
  const elapsedSeconds = elapsedMs / 1_000;
  const movement = normalizeAxes(input.moveX, input.moveY);
  const hasGroundInput = movement.x !== 0 || movement.y !== 0;
  const facing = normalizeAim(input.aimX, input.aimY, state.facing);
  let velocity = state.velocity;

  if (hasGroundInput) {
    const target = {
      x: movement.x * options.moveSpeed,
      y: movement.y * options.moveSpeed
    };
    velocity = accelerateTowards(
      velocity,
      target,
      GAME.groundAcceleration * options.steeringScale * elapsedSeconds
    );
  } else {
    const dragFactor = Math.exp((-GAME.groundDrag / options.moveSpeed) * elapsedSeconds);
    velocity = { x: velocity.x * dragFactor, y: velocity.y * dragFactor };
  }

  if (options.dashVelocity !== null) velocity = options.dashVelocity;

  velocity = {
    x: velocity.x + options.voidPull.x * elapsedSeconds,
    y: velocity.y + options.voidPull.y * elapsedSeconds
  };

  return {
    position: {
      x: state.position.x + velocity.x * elapsedSeconds,
      y: state.position.y + velocity.y * elapsedSeconds
    },
    velocity,
    facing
  };
}
