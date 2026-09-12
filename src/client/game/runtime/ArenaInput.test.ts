import { afterEach, describe, expect, it, vi } from 'vitest';
import { ArenaInput, type ArenaInputSource } from './ArenaInput.js';

type Directions = 'up' | 'down' | 'left' | 'right';

function source(): ArenaInputSource & {
  movementHeld: Record<Directions | 'dash', boolean>;
  attackHeld: Record<'quick' | 'heavy', boolean>;
  suspend(): void;
} {
  const movementHeld = { up: false, down: false, left: false, right: false, dash: false };
  const attackHeld = { quick: false, heavy: false };
  const suspendListeners = new Set<() => void>();
  return {
    movementHeld, attackHeld,
    movement: () => ({ ...movementHeld }),
    attack: () => ({ ...attackHeld }),
    reset: vi.fn(),
    dispose: vi.fn(),
    onSuspend(listener) { suspendListeners.add(listener); return () => suspendListeners.delete(listener); },
    suspend() { for (const listener of suspendListeners) listener(); }
  };
}

function eventTarget(): Pick<Window, 'addEventListener' | 'removeEventListener'> & EventTarget {
  return new EventTarget() as Pick<Window, 'addEventListener' | 'removeEventListener'> & EventTarget;
}

describe('ArenaInput', () => {
  afterEach(() => vi.restoreAllMocks());

  it('uses normalized WASD for movement and aim, retains released aim, and starts facing right', () => {
    const controls = source();
    const input = new ArenaInput(controls);
    expect(input.sample(0, 0)).toMatchObject({ aimX: 1, aimY: 0, moveX: 0, moveY: 0 });
    controls.movementHeld.up = true;
    controls.movementHeld.right = true;
    const diagonal = input.sample(1, 17)!;
    expect(diagonal.moveX).toBeCloseTo(Math.SQRT1_2);
    expect(diagonal.moveY).toBeCloseTo(-Math.SQRT1_2);
    expect(diagonal.aimX).toBeCloseTo(Math.SQRT1_2);
    expect(diagonal.aimY).toBeCloseTo(-Math.SQRT1_2);
    controls.movementHeld.up = false;
    controls.movementHeld.right = false;
    expect(input.sample(2, 34)).toMatchObject({ moveX: 0, moveY: 0, aimX: diagonal.aimX, aimY: diagonal.aimY });
  });

  it('emits one quick on each J rising edge and never repeats while WASD changes', () => {
    const controls = source();
    const input = new ArenaInput(controls);
    controls.movementHeld.left = true;
    controls.attackHeld.quick = true;
    expect(input.sample(0, 0)).toMatchObject({ quick: true, aimX: -1, aimY: 0 });
    controls.movementHeld.left = false;
    controls.movementHeld.down = true;
    expect(input.sample(1, 17)).toMatchObject({ quick: false, aimX: 0, aimY: 1 });
    controls.attackHeld.quick = false;
    input.sample(2, 34);
    controls.attackHeld.quick = true;
    expect(input.sample(3, 51)?.quick).toBe(true);
  });

  it('holds K to charge, steers through WASD, retains aim, and emits the existing heavy fall on release', () => {
    const controls = source();
    const input = new ArenaInput(controls);
    controls.attackHeld.heavy = true;
    controls.movementHeld.up = true;
    expect(input.sample(0, 0)).toMatchObject({ aimX: 0, aimY: -1, quick: false, heavy: true });
    controls.movementHeld.up = false;
    controls.movementHeld.right = true;
    expect(input.sample(1, 17)).toMatchObject({ aimX: 1, aimY: 0, quick: false, heavy: true });
    controls.movementHeld.right = false;
    expect(input.sample(2, 34)).toMatchObject({ aimX: 1, aimY: 0, quick: false, heavy: true });
    controls.attackHeld.heavy = false;
    expect(input.sample(3, 51)).toMatchObject({ aimX: 1, aimY: 0, quick: false, heavy: false });
  });

  it('never synthesizes a quick when J is pressed during K or carried through K release', () => {
    const controls = source();
    const input = new ArenaInput(controls);
    controls.movementHeld.left = true;
    controls.attackHeld.heavy = true;
    expect(input.sample(0, 0)).toMatchObject({ heavy: true, quick: false, aimX: -1 });
    controls.attackHeld.quick = true;
    expect(input.sample(1, 17)).toMatchObject({ heavy: true, quick: false });
    controls.attackHeld.heavy = false;
    expect(input.sample(2, 34)).toMatchObject({ heavy: false, quick: false, aimX: -1 });
    controls.attackHeld.quick = false;
    input.sample(3, 51);
    controls.attackHeld.quick = true;
    expect(input.sample(4, 68)).toMatchObject({ quick: true, heavy: false, aimX: -1 });
  });

  it('emits dash only on its rising edge and caps samples at sixty hertz', () => {
    const controls = source();
    const input = new ArenaInput(controls);
    controls.movementHeld.dash = true;
    expect(input.sample(0, 0)?.dash).toBe(true);
    expect(input.sample(1, 16)).toBeNull();
    expect(input.sample(1, 17)?.dash).toBe(false);
    controls.movementHeld.dash = false;
    input.sample(2, 34);
    controls.movementHeld.dash = true;
    expect(input.sample(3, 51)?.dash).toBe(true);
  });

  it('suppresses gameplay after blur, hidden visibility, and shutdown until every physical key releases', () => {
    const controls = source();
    const windowTarget = eventTarget();
    const documentTarget = eventTarget() as EventTarget & { visibilityState: DocumentVisibilityState };
    Object.defineProperty(documentTarget, 'visibilityState', { configurable: true, value: 'hidden' });
    const shutdownListeners = new Set<() => void>();
    const input = new ArenaInput(controls, {
      windowTarget, documentTarget,
      onShutdown(listener) { shutdownListeners.add(listener); return () => shutdownListeners.delete(listener); }
    });
    controls.movementHeld.right = true;
    controls.attackHeld.quick = true;
    windowTarget.dispatchEvent(new Event('blur'));
    expect(input.sample(0, 0)).toMatchObject({ moveX: 0, moveY: 0, quick: false, heavy: false, dash: false });
    controls.attackHeld.heavy = true;
    expect(input.sample(1, 17)).toMatchObject({ moveX: 0, moveY: 0, quick: false, heavy: false, dash: false });
    controls.attackHeld.quick = false;
    expect(input.sample(2, 34)).toMatchObject({ moveX: 0, moveY: 0, quick: false, heavy: false, dash: false });
    documentTarget.dispatchEvent(new Event('visibilitychange'));
    for (const listener of shutdownListeners) listener();
    controls.movementHeld.right = false;
    controls.attackHeld.heavy = false;
    input.sample(3, 51);
    controls.movementHeld.up = true;
    controls.attackHeld.quick = true;
    expect(input.sample(4, 68)).toMatchObject({ moveX: 0, moveY: -1, aimX: 0, aimY: -1, quick: true, heavy: false });
    input.dispose();
    expect(controls.dispose).toHaveBeenCalledOnce();
    expect(shutdownListeners).toHaveLength(0);
  });

  it('waits for raw keyup when an input source resets a held flag during blur', () => {
    const controls = source();
    const windowTarget = eventTarget();
    const documentTarget = eventTarget() as EventTarget & { visibilityState: DocumentVisibilityState };
    Object.defineProperty(documentTarget, 'visibilityState', { configurable: true, value: 'visible' });
    const input = new ArenaInput(controls, {
      windowTarget, documentTarget, onShutdown: () => () => undefined
    });
    controls.attackHeld.quick = true;
    windowTarget.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyJ' }));
    windowTarget.dispatchEvent(new Event('blur'));
    expect(controls.reset).toHaveBeenCalledOnce();
    controls.attackHeld.quick = false;
    windowTarget.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyK' }));
    expect(input.sample(0, 0)).toMatchObject({ quick: false, heavy: false });
    controls.attackHeld.heavy = true;
    expect(input.sample(1, 17)).toMatchObject({ quick: false, heavy: false });
    windowTarget.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyJ' }));
    expect(input.sample(2, 34)).toMatchObject({ quick: false, heavy: false });
    controls.attackHeld.heavy = false;
    windowTarget.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyK' }));
    input.sample(3, 51);
    controls.movementHeld.right = true;
    controls.attackHeld.quick = true;
    windowTarget.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyJ' }));
    expect(input.sample(4, 68)).toMatchObject({ quick: true, aimX: 1 });
    input.dispose();
    input.dispose();
    windowTarget.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyJ' }));
    expect(controls.dispose).toHaveBeenCalledOnce();
  });

  it('gates input across scene suspension until raw keys release and unsubscribes on disposal', () => {
    const controls = source();
    const windowTarget = eventTarget();
    const documentTarget = eventTarget() as EventTarget & { visibilityState: DocumentVisibilityState };
    Object.defineProperty(documentTarget, 'visibilityState', { configurable: true, value: 'visible' });
    const input = new ArenaInput(controls, { windowTarget, documentTarget, onShutdown: () => () => undefined });
    controls.attackHeld.heavy = true;
    windowTarget.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyK' }));
    controls.suspend();
    controls.attackHeld.heavy = false;
    controls.movementHeld.up = true;
    windowTarget.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW' }));
    expect(input.sample(0, 0)).toMatchObject({ moveX: 0, moveY: 0, quick: false, heavy: false });
    windowTarget.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyK' }));
    expect(input.sample(1, 17)).toMatchObject({ moveX: 0, moveY: 0, quick: false, heavy: false });
    controls.movementHeld.up = false;
    windowTarget.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyW' }));
    input.sample(2, 34);
    expect(controls.reset).toHaveBeenCalledOnce();
    input.dispose();
    controls.suspend();
    expect(controls.reset).toHaveBeenCalledTimes(2);
  });

  it('ignores raw arrow and Shift keydown events across lifecycle resets', () => {
    const controls = source();
    const windowTarget = eventTarget();
    const documentTarget = eventTarget() as EventTarget & { visibilityState: DocumentVisibilityState };
    Object.defineProperty(documentTarget, 'visibilityState', { configurable: true, value: 'visible' });
    const input = new ArenaInput(controls, { windowTarget, documentTarget, onShutdown: () => () => undefined });
    for (const code of ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'ShiftLeft', 'ShiftRight']) {
      windowTarget.dispatchEvent(new KeyboardEvent('keydown', { code }));
    }
    windowTarget.dispatchEvent(new Event('blur'));
    controls.movementHeld.left = true;
    controls.attackHeld.quick = true;
    expect(input.sample(0, 0)).toMatchObject({ moveX: -1, aimX: -1, quick: true, heavy: false });
    input.dispose();
  });

});
