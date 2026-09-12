import { GAME } from '../../../shared/constants.js';
import { normalizeAxes } from '../../../shared/kinematics.js';
import type { InputFrame, Vec2 } from '../../../shared/model.js';

type HeldMovement = Readonly<{ up: boolean; down: boolean; left: boolean; right: boolean; dash: boolean }>;
type HeldAttack = Readonly<{ quick: boolean; heavy: boolean }>;

export interface ArenaInputSource {
  movement(): HeldMovement;
  attack(): HeldAttack;
  consumePressEdges?(): Readonly<{ quick: boolean; dash: boolean }>;
  reset(): void;
  dispose?(): void;
  onSuspend?(listener: () => void): () => void;
}

export type ArenaInputLifecycle = Readonly<{
  windowTarget: Pick<Window, 'addEventListener' | 'removeEventListener'>;
  documentTarget: Pick<Document, 'addEventListener' | 'removeEventListener' | 'visibilityState'>;
  onShutdown(listener: () => void): () => void;
}>;

type SampledArenaInput = Omit<InputFrame, 'viewTick'>;

const INPUT_STEP_MS = 1_000 / GAME.maxInputFramesPerSecond;
const GAMEPLAY_CODE_TO_KEY = new Map([
  ['KeyW', 'moveUp'], ['KeyA', 'moveLeft'], ['KeyS', 'moveDown'], ['KeyD', 'moveRight'], ['Space', 'dash'],
  ['KeyJ', 'quick'], ['KeyK', 'heavy']
]);
type GameplayKey = 'moveUp' | 'moveDown' | 'moveLeft' | 'moveRight' | 'dash' | 'quick' | 'heavy';

export class ArenaInput {
  private lastSampleAtMs = Number.NEGATIVE_INFINITY;
  private lastAttackFacing: Vec2 = { x: 1, y: 0 };
  private previousQuick = false;
  private previousHeavy = false;
  private previousDash = false;
  private suppressHeldUntilRelease = false;
  private disposed = false;
  private readonly rawHeldCodes = new Set<string>();
  private readonly blockedRawCodes = new Set<string>();
  private readonly blockedSourceKeys = new Set<GameplayKey>();
  private readonly removeLifecycle: Array<() => void> = [];

  constructor(private readonly source: ArenaInputSource, lifecycle?: ArenaInputLifecycle) {
    const clear = (): void => this.clearHeld();
    const removeSuspend = source.onSuspend?.(clear);
    if (removeSuspend) this.removeLifecycle.push(removeSuspend);
    if (!lifecycle) return;
    const keyDown = (event: Event): void => this.recordRawKeyDown((event as KeyboardEvent).code);
    const keyUp = (event: Event): void => this.recordRawKeyUp((event as KeyboardEvent).code);
    const clearWhenHidden = (): void => {
      if (lifecycle.documentTarget.visibilityState === 'hidden') clear();
    };
    lifecycle.windowTarget.addEventListener('blur', clear);
    lifecycle.windowTarget.addEventListener('keydown', keyDown);
    lifecycle.windowTarget.addEventListener('keyup', keyUp);
    lifecycle.documentTarget.addEventListener('visibilitychange', clearWhenHidden);
    this.removeLifecycle.push(
      () => lifecycle.windowTarget.removeEventListener('blur', clear),
      () => lifecycle.windowTarget.removeEventListener('keydown', keyDown),
      () => lifecycle.windowTarget.removeEventListener('keyup', keyUp),
      () => lifecycle.documentTarget.removeEventListener('visibilitychange', clearWhenHidden),
      lifecycle.onShutdown(clear)
    );
  }

  sample(seq: number, nowMs: number): SampledArenaInput | null {
    if (nowMs - this.lastSampleAtMs + Number.EPSILON < INPUT_STEP_MS) return null;
    this.lastSampleAtMs = nowMs;
    const movementHeld = this.source.movement();
    const attackHeld = this.source.attack();
    if (this.suppressHeldUntilRelease && !this.releaseGateIsOpen(movementHeld, attackHeld)) {
      return this.idleFrame(seq);
    }
    this.suppressHeldUntilRelease = false;
    const pressEdges = this.source.consumePressEdges?.() ?? { quick: false, dash: false };

    const movement = normalizeAxes(
      Number(movementHeld.right) - Number(movementHeld.left),
      Number(movementHeld.down) - Number(movementHeld.up)
    );
    const movementDirection = movement.x === 0 && movement.y === 0 ? null : movement;
    const quick = (pressEdges.quick || (attackHeld.quick && !this.previousQuick)) &&
      !attackHeld.heavy && !this.previousHeavy;
    const heavy = attackHeld.heavy;
    const dash = pressEdges.dash || (movementHeld.dash && !this.previousDash);
    const aim = movementDirection ?? this.lastAttackFacing;

    if (movementDirection) this.lastAttackFacing = movementDirection;
    this.previousQuick = attackHeld.quick;
    this.previousHeavy = attackHeld.heavy;
    this.previousDash = movementHeld.dash;

    return { seq, moveX: movement.x, moveY: movement.y, aimX: aim.x, aimY: aim.y, quick, heavy, dash };
  }

  clearHeld(requireRelease = true): void {
    const movementHeld = this.source.movement();
    const attackHeld = this.source.attack();
    if (requireRelease) {
      for (const code of this.rawHeldCodes) this.blockedRawCodes.add(code);
      for (const key of heldSourceKeys(movementHeld, attackHeld)) {
        if (!hasRawHeldKey(this.rawHeldCodes, key)) this.blockedSourceKeys.add(key);
      }
    } else {
      this.blockedRawCodes.clear();
      this.blockedSourceKeys.clear();
    }
    if (requireRelease) this.source.reset();
    this.previousQuick = false;
    this.previousHeavy = false;
    this.previousDash = false;
    this.suppressHeldUntilRelease = requireRelease &&
      (this.blockedRawCodes.size > 0 || this.blockedSourceKeys.size > 0);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.clearHeld();
    for (const remove of this.removeLifecycle.splice(0)) remove();
    this.source.dispose?.();
  }

  private idleFrame(seq: number): SampledArenaInput {
    return { seq, moveX: 0, moveY: 0, aimX: this.lastAttackFacing.x, aimY: this.lastAttackFacing.y, quick: false, heavy: false, dash: false };
  }

  private recordRawKeyDown(code: string): void {
    if (!GAMEPLAY_CODE_TO_KEY.has(code)) return;
    this.rawHeldCodes.add(code);
    if (this.suppressHeldUntilRelease) this.blockedRawCodes.add(code);
  }

  private recordRawKeyUp(code: string): void {
    this.rawHeldCodes.delete(code);
    this.blockedRawCodes.delete(code);
  }

  private releaseGateIsOpen(movementHeld: HeldMovement, attackHeld: HeldAttack): boolean {
    for (const key of this.blockedSourceKeys) {
      if (!isSourceKeyHeld(key, movementHeld, attackHeld)) this.blockedSourceKeys.delete(key);
    }
    return this.blockedRawCodes.size === 0 && this.blockedSourceKeys.size === 0;
  }
}

function heldSourceKeys(movement: HeldMovement, attack: HeldAttack): GameplayKey[] {
  return [
    ...(movement.up ? ['moveUp' as const] : []), ...(movement.down ? ['moveDown' as const] : []),
    ...(movement.left ? ['moveLeft' as const] : []), ...(movement.right ? ['moveRight' as const] : []),
    ...(movement.dash ? ['dash' as const] : []), ...(attack.quick ? ['quick' as const] : []),
    ...(attack.heavy ? ['heavy' as const] : [])
  ];
}

function hasRawHeldKey(codes: ReadonlySet<string>, key: GameplayKey): boolean {
  return [...codes].some((code) => GAMEPLAY_CODE_TO_KEY.get(code) === key);
}

function isSourceKeyHeld(key: GameplayKey, movement: HeldMovement, attack: HeldAttack): boolean {
  return ({ moveUp: movement.up, moveDown: movement.down, moveLeft: movement.left, moveRight: movement.right, dash: movement.dash, quick: attack.quick, heavy: attack.heavy } as Record<GameplayKey, boolean>)[key];
}
