import { describe, expect, it, vi } from 'vitest';
import { ArenaInput, type ArenaInputSource } from './ArenaInput.js';
import { TouchInputSource, combineArenaInputSources } from './TouchInputSource.js';

function source(overrides: Partial<ArenaInputSource> = {}): ArenaInputSource {
  return {
    movement: () => ({ up: false, down: false, left: false, right: false, dash: false }),
    attack: () => ({ quick: false, heavy: false }),
    reset: () => undefined,
    ...overrides
  };
}

describe('TouchInputSource', () => {
  it('maps a clamped joystick vector to digital directions outside its dead zone', () => {
    const touch = new TouchInputSource(0.25);
    touch.setJoystick(0.2, -0.24);
    expect(touch.movement()).toEqual({ up: false, down: false, left: false, right: false, dash: false });

    touch.setJoystick(-0.8, 0.7);
    expect(touch.movement()).toEqual({ up: false, down: true, left: true, right: false, dash: false });

    touch.setJoystick(4, -3);
    expect(touch.movement()).toEqual({ up: true, down: false, left: false, right: true, dash: false });

    touch.setJoystick(Number.NaN, Number.POSITIVE_INFINITY);
    expect(touch.movement()).toEqual({ up: false, down: false, left: false, right: false, dash: false });
  });

  it('keeps quick, heavy, and dash held until pointer-safe setters release them', () => {
    const touch = new TouchInputSource();
    touch.setQuickHeld(true);
    touch.setHeavyHeld(true);
    touch.setDashHeld(true);
    expect(touch.attack()).toEqual({ quick: true, heavy: true });
    expect(touch.movement().dash).toBe(true);

    touch.setQuickHeld(false);
    touch.setHeavyHeld(false);
    touch.setDashHeld(false);
    expect(touch.attack()).toEqual({ quick: false, heavy: false });
    expect(touch.movement().dash).toBe(false);
  });

  it('lets ArenaInput own quick and dash rising edges while heavy spans press and release', () => {
    const touch = new TouchInputSource();
    const input = new ArenaInput(touch);
    touch.setQuickHeld(true);
    touch.setDashHeld(true);
    expect(input.sample(0, 0)).toMatchObject({ quick: true, heavy: false, dash: true });
    expect(input.sample(1, 17)).toMatchObject({ quick: false, heavy: false, dash: false });

    touch.setQuickHeld(false);
    touch.setDashHeld(false);
    touch.setHeavyHeld(true);
    expect(input.sample(2, 34)).toMatchObject({ quick: false, heavy: true, dash: false });
    expect(input.sample(3, 51)).toMatchObject({ quick: false, heavy: true, dash: false });
    touch.setHeavyHeld(false);
    expect(input.sample(4, 68)).toMatchObject({ quick: false, heavy: false, dash: false });
  });

  it('delivers a quick tap released between samples exactly once', () => {
    const touch = new TouchInputSource();
    const input = new ArenaInput(combineArenaInputSources(source(), touch));

    touch.setQuickHeld(true);
    touch.setQuickHeld(false);

    expect(input.sample(0, 0)).toMatchObject({ quick: true });
    expect(input.sample(1, 17)).toMatchObject({ quick: false });
  });

  it('delivers a dash tap released between samples exactly once', () => {
    const touch = new TouchInputSource();
    const input = new ArenaInput(combineArenaInputSources(source(), touch));

    touch.setDashHeld(true);
    touch.setDashHeld(false);

    expect(input.sample(0, 0)).toMatchObject({ dash: true });
    expect(input.sample(1, 17)).toMatchObject({ dash: false });
  });

  it('clears joystick and every held action on reset', () => {
    const touch = new TouchInputSource();
    const input = new ArenaInput(touch);
    touch.setJoystick(-1, -1);
    touch.setQuickHeld(true);
    touch.setHeavyHeld(true);
    touch.setDashHeld(true);
    touch.setQuickHeld(false);
    touch.setDashHeld(false);
    touch.reset();
    expect(touch.movement()).toEqual({ up: false, down: false, left: false, right: false, dash: false });
    expect(touch.attack()).toEqual({ quick: false, heavy: false });
    expect(input.sample(0, 0)).toMatchObject({ quick: false, heavy: false, dash: false });
  });
});

describe('combineArenaInputSources', () => {
  it('ORs movement and attack state from every source', () => {
    const combined = combineArenaInputSources(
      source({
        movement: () => ({ up: true, down: false, left: false, right: false, dash: false }),
        attack: () => ({ quick: true, heavy: false })
      }),
      source({
        movement: () => ({ up: false, down: false, left: false, right: true, dash: true }),
        attack: () => ({ quick: false, heavy: true })
      })
    );
    expect(combined.movement()).toEqual({ up: true, down: false, left: false, right: true, dash: true });
    expect(combined.attack()).toEqual({ quick: true, heavy: true });
  });

  it('resets and disposes every source exactly once', () => {
    const resetFirst = vi.fn();
    const resetSecond = vi.fn();
    const disposeFirst = vi.fn();
    const disposeSecond = vi.fn();
    const combined = combineArenaInputSources(
      source({ reset: resetFirst, dispose: disposeFirst }),
      source({ reset: resetSecond, dispose: disposeSecond })
    );
    combined.reset();
    combined.dispose?.();
    combined.dispose?.();
    expect(resetFirst).toHaveBeenCalledOnce();
    expect(resetSecond).toHaveBeenCalledOnce();
    expect(disposeFirst).toHaveBeenCalledOnce();
    expect(disposeSecond).toHaveBeenCalledOnce();
  });

  it('composes suspension subscriptions and removes all of them', () => {
    const firstListeners = new Set<() => void>();
    const secondListeners = new Set<() => void>();
    const first = source({
      onSuspend(listener) { firstListeners.add(listener); return () => firstListeners.delete(listener); }
    });
    const second = source({
      onSuspend(listener) { secondListeners.add(listener); return () => secondListeners.delete(listener); }
    });
    const combined = combineArenaInputSources(first, source(), second);
    const listener = vi.fn();
    const unsubscribe = combined.onSuspend?.(listener);
    for (const suspend of firstListeners) suspend();
    for (const suspend of secondListeners) suspend();
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe?.();
    unsubscribe?.();
    expect(firstListeners).toHaveLength(0);
    expect(secondListeners).toHaveLength(0);
  });
});
